/**
 * Kimi host: one SSH-tunnelled connection to a remote Kimi Web service.
 *
 * Orchestrates, for one paired host:
 * - discovers the endpoint over SSH (`discoverKimiEndpoint`: Perch's
 *   local-agent-service `--agent kimi` starts or reuses the service, or the
 *   token is read from the remote `server.token` for an unmanaged one),
 * - opens a loopback forward (its own transport, never the RACP tunnel
 *   manager's pi-host supervisor),
 * - polls `GET /api/v1/sessions` (busy cadence) and each open session's
 *   snapshot, feeding the `KimiEventBridge`,
 * - registers one `KimiBackend` per session in the shared `BackendRouter`.
 *
 * The token lives only inside the `KimiClient` closure; nothing returns it.
 */
import { makeRemoteSessionId, type BackendRouter } from "../backend-router.js";
import { reserveLocalPort, type SshTransport } from "../ssh-transport.js";
import type { SessionSummary } from "@pi-desktop/shared";
import { IPC } from "@pi-desktop/shared";
import {
  createKimiClient, discoverKimiEndpoint, KimiBridgeError,
  type KimiClient, type KimiEndpoint, type KimiSession, type KimiSnapshot,
} from "./kimi-client.js";
import { createKimiEventBridge, type KimiEventBridge } from "./kimi-event-bridge.js";
import { createKimiBackend } from "./kimi-session-backend.js";

export type KimiHostOptions = {
  hostKey: string;
  label: string;
  router: BackendRouter;
  ssh: { host: string; port?: number; user?: string; identityFile?: string; remotePort: number };
  sshSecret?: string;
  emit: (channel: string, payload: unknown) => void;
  buildTransport?: () => SshTransport;
  discoverEndpoint?: (exec: (cmd: string, o?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>) => Promise<KimiEndpoint>;
  pollMs?: { busy: number; idle: number };
  failureThreshold?: number;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export interface KimiHost {
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  sessions(): Promise<KimiSession[]>;
  summaries(): SessionSummary[];
  models(): Promise<Array<{ id: string; provider: string; name: string; agent: string }>>;
  createSession(input: { cwd: string; model?: string; title?: string }): Promise<KimiSession>;
}

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

export function createKimiHost(options: KimiHostOptions): KimiHost {
  const log = options.log ?? (() => undefined);
  const pollMs = { busy: options.pollMs?.busy ?? 400, idle: options.pollMs?.idle ?? 2000 };
  const failureThreshold = options.failureThreshold ?? 3;
  const bridge: KimiEventBridge = createKimiEventBridge({ hostKey: options.hostKey, emit: options.emit, log });

  let endpoint: KimiEndpoint | null = null;
  let client: KimiClient | null = null;
  let transport: SshTransport | null = null;
  let forward: { localPort: number; close(): Promise<void> } | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let connected = false;
  let failures = 0;
  let sessionCache: KimiSession[] = [];
  let lastInventoryKey = "";
  const lastSeenSeq = new Map<string, number>();
  // Kimi carries the model on the next prompt; shared across every backend
  // registered for this host so a create-time model and a later switch agree.
  const sessionModels = new Map<string, string>();
  let rediscovering: Promise<void> | null = null;

  const assertLive = (): { client: KimiClient } => {
    if (closed || !client || !connected) {
      throw Object.assign(new Error("kimi host is not connected"), { errorCode: "AGENT_UNAVAILABLE" });
    }
    return { client };
  };

  async function openForward(port: number): Promise<{ localPort: number }> {
    if (!transport) throw Object.assign(new Error("kimi transport unavailable"), { errorCode: "AGENT_UNAVAILABLE" });
    const localPort = await reserveLocalPort();
    forward = await transport.forward({ localPort, remoteHost: "127.0.0.1", remotePort: port });
    return { localPort: forward.localPort };
  }

  async function openClient(): Promise<void> {
    const buildTransport = options.buildTransport;
    if (!buildTransport) throw Object.assign(new Error("no ssh transport for kimi host"), { errorCode: "INVALID_ARGUMENT" });
    transport = buildTransport();
    const discover = options.discoverEndpoint ?? discoverKimiEndpoint;
    endpoint = await discover((cmd, o) => transport!.exec(cmd, o));
    const { localPort } = await openForward(endpoint.port);
    const ep = endpoint;
    client = createKimiClient({
      localBaseUrl: () => `http://127.0.0.1:${localPort}`,
      endpoint: () => ep,
      log,
    });
  }

  async function closeClient(): Promise<void> {
    const f = forward;
    forward = null;
    if (f) await f.close().catch((error: unknown) => log("warn", "kimi forward close failed", { error: String(error) }));
    transport?.dispose();
    transport = null;
    client = null;
  }

  async function rediscover(): Promise<void> {
    if (rediscovering) return rediscovering;
    rediscovering = (async () => {
      await closeClient();
      await openClient();
      lastSeenSeq.clear();
    })().finally(() => { rediscovering = null; });
    return rediscovering;
  }

  function registerSessionBackend(hostSessionId: string): void {
    if (!client) return;
    options.router.registerBackend(
      makeRemoteSessionId(options.hostKey, hostSessionId),
      createKimiBackend({ hostKey: options.hostKey, client, sessionModels, log }),
    );
  }

  async function pollOnce(): Promise<boolean> {
    if (closed || !client) return false;
    let anyBusy = false;
    try {
      const list = (await client.get("/api/v1/sessions", { page_size: 100, include_archive: "true" })) as { items?: KimiSession[] };
      const sessions = list.items ?? [];
      sessionCache = sessions;
      failures = 0;
      connected = true;
      const ids = sessions.map((s) => s.id).join("");
      if (ids !== lastInventoryKey) {
        lastInventoryKey = ids;
        options.emit(IPC.event.sessionsChanged, { reason: "kimi.sessions.changed" });
      }
      for (const session of sessions) {
        const hostSessionId = session.id;
        const running = session.main_turn_active ?? session.busy ?? false;
        if (running || (session.pending_interaction && session.pending_interaction !== "none")) anyBusy = true;
        const known = lastSeenSeq.get(hostSessionId);
        if (known === undefined) registerSessionBackend(hostSessionId);
        // A Kimi session carries no revision on the list row; poll the snapshot
        // for any session that is busy, pending, or never snapshotted.
        if (!running && (session.pending_interaction ?? "none") === "none" && known !== undefined) {
          continue;
        }
        const snapshot = (await client.get(`/api/v1/sessions/${encodeURIComponent(hostSessionId)}/snapshot`)) as KimiSnapshot;
        const seq = snapshot.as_of_seq ?? 0;
        if (snapshot.session && (snapshot.session.main_turn_active ?? snapshot.session.busy)) anyBusy = true;
        lastSeenSeq.set(hostSessionId, seq);
        bridge.applySnapshot(hostSessionId, snapshot);
      }
    } catch (error) {
      if (error instanceof KimiBridgeError && error.errorCode === "KIMI_AUTH_STALE" && !closed) {
        try { await rediscover(); } catch (e) { log("warn", "kimi endpoint re-discovery failed", { error: String(e) }); }
        return true;
      }
      failures += 1;
      log("warn", "kimi poll failed", { hostKey: options.hostKey, failures, error: String(error) });
      if (failures >= failureThreshold) connected = false;
    }
    return anyBusy;
  }

  function schedulePoll(busy: boolean): void {
    if (closed) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { void pollOnce().then(schedulePoll).catch(() => schedulePoll(false)); }, busy ? pollMs.busy : pollMs.idle);
    pollTimer.unref?.();
  }

  return {
    async connect() {
      await openClient();
      closed = false;
      await pollOnce();
      connected = true;
      schedulePoll(true);
    },
    async close() {
      closed = true;
      connected = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      await closeClient();
      sessionCache = [];
      lastSeenSeq.clear();
    },
    isConnected: () => connected && !closed,
    async sessions() {
      const { client: live } = assertLive();
      const list = (await live.get("/api/v1/sessions", { page_size: 100, include_archive: "true" })) as { items?: KimiSession[] };
      sessionCache = list.items ?? [];
      return sessionCache;
    },
    summaries() {
      return sessionCache.map((session): SessionSummary => ({
        id: makeRemoteSessionId(options.hostKey, session.id),
        title: session.title ?? "",
        source: "remote",
        remoteHostKey: options.hostKey,
        remoteHostLabel: options.label,
        remoteProjectId: session.metadata?.cwd ?? "",
        remoteWorkspaceLabel: session.metadata?.cwd ? basename(session.metadata.cwd) : "",
        remoteAgent: "kimi",
        mode: "agent",
        permissionMode: "ask",
        thinkingLevel: "off",
        ...(session.agent_config?.model ? { modelId: session.agent_config.model } : {}),
        messageCount: 0,
        updatedAt: session.updated_at ?? new Date().toISOString(),
        createdAt: session.updated_at ?? new Date().toISOString(),
        capabilities: {
          canPrompt: connected, canStop: connected, canRefresh: connected,
          canConfigureModel: connected,
          canAttach: false, canSteer: false,
          canEditMessages: false, canUseLocalTools: false, canUseTerminal: false,
          canReadWorkspace: false,
        },
        ...(connected ? {} : { readOnlyReason: "REMOTE_HOST_DISCONNECTED" }),
      }));
    },
    async models() {
      const { client: live } = assertLive();
      const catalog = (await live.get("/api/v1/models")) as { items?: Array<{ model: string; provider: string; display_name?: string }> };
      return (catalog.items ?? []).map((item) => ({
        id: item.model, provider: item.provider, name: item.display_name ?? item.model, agent: "kimi",
      }));
    },
    async createSession(input) {
      const { client: live } = assertLive();
      if (!input.cwd.startsWith("/")) {
        throw Object.assign(new Error("kimi session cwd must be a remote absolute path"), { errorCode: "INVALID_ARGUMENT" });
      }
      const created = (await live.post("/api/v1/sessions", {
        metadata: { cwd: input.cwd },
        ...(input.title ? { title: input.title } : {}),
      })) as KimiSession;
      registerSessionBackend(created.id);
      // The model is a per-prompt field on Kimi; a chosen model is recorded on
      // the session's backend for the next prompt.
      if (input.model) {
        const backend = createKimiBackend({ hostKey: options.hostKey, client: live, sessionModels, log });
        await backend.invoke(IPC.invoke.sessionConfigure, [{ sessionId: makeRemoteSessionId(options.hostKey, created.id) }, { modelId: input.model }]);
      }
      sessionCache = [created, ...sessionCache.filter((s) => s.id !== created.id)];
      await pollOnce();
      return created;
    },
  };
}
