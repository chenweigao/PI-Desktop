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
import { createKimiBackend, kimiPermissionCapability } from "./kimi-session-backend.js";

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
  /** List remote directories over SSH (the Kimi service has no browse endpoint). */
  browse(path?: string): Promise<{ path: string; parent?: string; entries: { name: string; path: string }[] }>;
  createSession(input: { cwd: string; model?: string; permissionMode?: string; title?: string }): Promise<KimiSession>;
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
  // Per-session "was busy/pending last poll" so a just-settled session is read
  // once more (its final snapshot) instead of being skipped on the idle row.
  const lastActive = new Map<string, boolean>();
  // Per-session last-seen updated_at: a turn that ran between polls bumps it,
  // so a short turn is read even when the list row is idle on both polls.
  const lastSeenUpdatedAt = new Map<string, string>();
  // Kimi carries the model on the next prompt; shared across every backend
  // registered for this host so a create-time model and a later switch agree.
  const sessionModels = new Map<string, string>();
  // Per-session permission choice (manual/yolo/auto), sent on each prompt.
  const sessionPermissions = new Map<string, string>();
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
    // The Kimi service port comes from the host's SSH metadata (a real value
    // the user can edit), not a hardcoded constant.
    const servicePort = options.ssh.remotePort > 1 ? options.ssh.remotePort : undefined;
    endpoint = await discover((cmd, o) => transport!.exec(cmd, o), servicePort);
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

  // Session ids with a router backend registered by this host; released on
  // close and reconciled when a session vanishes from the inventory.
  const registeredSessions = new Set<string>();

  function unregisterSessionBackend(hostSessionId: string): void {
    if (!registeredSessions.delete(hostSessionId)) return;
    options.router.unregisterBackend(makeRemoteSessionId(options.hostKey, hostSessionId));
    bridge.forgetSession(hostSessionId);
  }

  function registerSessionBackend(hostSessionId: string): void {
    if (!client) return;
    registeredSessions.add(hostSessionId);
    options.router.registerBackend(
      makeRemoteSessionId(options.hostKey, hostSessionId),
      createKimiBackend({ hostKey: options.hostKey, client, sessionModels, sessionPermissions, log }),
    );
  }

  /** The sessions list pages by before_id; read every page so sessions past
   * the first page still get a router backend and polling. */
  async function listAllSessions(live: NonNullable<typeof client>): Promise<KimiSession[]> {
    const all: KimiSession[] = [];
    let before: string | undefined;
    for (;;) {
      // kimi web 2.4 pages the sessions list with limit/before (the id of the
      // last row), not the messages endpoint's page_size/before_id.
      const page = (await live.get("/api/v1/sessions", {
        limit: 100, includeArchived: "true",
        ...(before ? { before } : {}),
      })) as { items?: KimiSession[]; has_more?: boolean };
      const items = page.items ?? [];
      all.push(...items);
      if (!page.has_more || items.length === 0) return all;
      before = items[items.length - 1].id;
    }
  }

  async function pollOnce(): Promise<boolean> {
    if (closed || !client) return false;
    let anyBusy = false;
    try {
      const sessions = await listAllSessions(client);
      sessionCache = sessions;
      failures = 0;
      connected = true;
      const ids = sessions.map((s) => s.id).join("");
      if (ids !== lastInventoryKey) {
        lastInventoryKey = ids;
        options.emit(IPC.event.sessionsChanged, { reason: "kimi.sessions.changed" });
      }
      // A session deleted remotely leaves no final snapshot: clear its cards
      // and release its backend.
      const liveIds = new Set(sessions.map((s) => s.id));
      for (const known of [...lastSeenSeq.keys()]) {
        if (!liveIds.has(known)) {
          lastSeenSeq.delete(known);
          unregisterSessionBackend(known);
          options.emit(IPC.event.remoteInteractions, {
            kind: "snapshot",
            sessionId: makeRemoteSessionId(options.hostKey, known),
            permissions: [],
            asks: [],
          });
        }
      }
      for (const session of sessions) {
        const hostSessionId = session.id;
        const running = session.main_turn_active ?? session.busy ?? false;
        if (running || (session.pending_interaction && session.pending_interaction !== "none")) anyBusy = true;
        const known = lastSeenSeq.get(hostSessionId);
        if (known === undefined) registerSessionBackend(hostSessionId);
        // Skip a snapshot only when nothing observable changed: not busy, no
        // pending interaction, we already hold a snapshot baseline, the session
        // was idle last time, AND the list row's updated_at is unchanged. A
        // turn that started and finished between polls bumps updated_at, so it
        // is read even though the list row is idle on both polls.
        const wasActive = lastActive.get(hostSessionId) === true;
        const updatedAt = session.updated_at ?? "";
        const wasUpdated = lastSeenUpdatedAt.get(hostSessionId) !== undefined
          && lastSeenUpdatedAt.get(hostSessionId) !== updatedAt;
        if (!running && (session.pending_interaction ?? "none") === "none" && known !== undefined && !wasActive && !wasUpdated) {
          continue;
        }
        const snapshot = (await client.get(`/api/v1/sessions/${encodeURIComponent(hostSessionId)}/snapshot`)) as KimiSnapshot;
        const seq = snapshot.as_of_seq ?? 0;
        if (snapshot.session && (snapshot.session.main_turn_active ?? snapshot.session.busy)) anyBusy = true;
        lastSeenSeq.set(hostSessionId, seq);
        lastSeenUpdatedAt.set(hostSessionId, updatedAt);
        bridge.applySnapshot(hostSessionId, snapshot);
        // Track the post-read activity: only a session that is idle AND was
        // idle last time is skippable next round.
        lastActive.set(hostSessionId, running || ((session.pending_interaction ?? "none") !== "none"));
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
      // The first poll must succeed for the host to count as connected; a bad
      // token or a dead service must not surface as online.
      await pollOnce();
      if (!connected) {
        await closeClient();
        throw Object.assign(new Error("kimi host did not answer its first poll"), { errorCode: "AGENT_UNAVAILABLE" });
      }
      schedulePoll(true);
    },
    async close() {
      closed = true;
      connected = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      for (const hostSessionId of [...registeredSessions]) unregisterSessionBackend(hostSessionId);
      await closeClient();
      sessionCache = [];
      lastSeenSeq.clear();
    },
    isConnected: () => connected && !closed,
    async sessions() {
      const { client: live } = assertLive();
      sessionCache = await listAllSessions(live);
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
        // Pending next-message choice wins over the last applied one.
        remotePermission: kimiPermissionCapability(
          sessionPermissions.get(session.id) ?? session.agent_config?.permission_mode,
        ),
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
    async browse(path) {
      const buildTransport = options.buildTransport;
      if (!buildTransport) throw Object.assign(new Error("kimi host is not connected"), { errorCode: "AGENT_UNAVAILABLE" });
      const transport = buildTransport();
      // No path: the remote home directory via a bare cd. A path must be
      // absolute; the service has no browse endpoint, so this lists over SSH.
      const useHome = !path;
      if (!useHome && (!path!.startsWith("/") || path!.includes("\0"))) {
        throw Object.assign(new Error("browse path must be an absolute remote directory"), { errorCode: "INVALID_ARGUMENT" });
      }
      const command = useHome
        ? `cd && pwd && ls -1Ap 2>/dev/null | grep '/$' | head -200`
        : `cd -- '${path!.replace(/'/g, "'\\''")}' && pwd && ls -1Ap 2>/dev/null | grep '/$' | head -200`;
      const result = await transport.exec(command, { timeoutMs: 15_000 });
      if (result.code !== 0) {
        throw Object.assign(
          new Error(`remote directory is not readable: ${result.stderr.trim().slice(-200) || `exit ${result.code}`}`),
          { errorCode: "REMOTE_BROWSE_FAILED" },
        );
      }
      const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const resolved = lines[0];
      if (!resolved || !resolved.startsWith("/")) {
        throw Object.assign(new Error("remote browse returned no directory"), { errorCode: "REMOTE_BROWSE_FAILED" });
      }
      const entries = lines.slice(1).map((name) => {
        const clean = name.replace(/\/$/, "");
        return { name: clean, path: `${resolved.replace(/\/$/, "")}/${clean}` };
      });
      const parent = resolved === "/" ? undefined : resolved.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
      return { path: resolved, ...(parent ? { parent } : {}), entries };
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
      // The model and permission mode are per-prompt fields on Kimi; chosen
      // values are recorded on the session's backend for the next prompt. PI's
      // placeholder ("ask"/"inherit") means "the runtime default" — Kimi's is
      // manual — and must not be forwarded as a literal mode.
      const requestedPermission = input.permissionMode === "ask" || input.permissionMode === "inherit"
        ? undefined
        : input.permissionMode;
      if (input.model || requestedPermission) {
        const backend = createKimiBackend({ hostKey: options.hostKey, client: live, sessionModels, sessionPermissions, log });
        await backend.invoke(IPC.invoke.sessionConfigure, [
          { sessionId: makeRemoteSessionId(options.hostKey, created.id) },
          { ...(input.model ? { modelId: input.model } : {}), ...(requestedPermission ? { permissionMode: requestedPermission } : {}) },
        ]);
      }
      sessionCache = [created, ...sessionCache.filter((s) => s.id !== created.id)];
      await pollOnce();
      return created;
    },
  };
}
