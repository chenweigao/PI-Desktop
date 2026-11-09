/**
 * Perch host: one SSH-tunnelled connection to a remote Perch native bridge.
 *
 * This is the orchestrator that wires the pieces together for one paired
 * host:
 * - discovers the bridge endpoint over SSH (`discoverPerchEndpoint`),
 * - opens a loopback forward through the shared `SshTunnelManager`,
 * - polls `GET /sessions` (busy cadence) and each open session's snapshot
 *   (idle `?revision=` short-circuit) and feeds the `PerchEventBridge`,
 * - registers one `PerchBackend` per open session in the shared
 *   `BackendRouter`, so renderer IPC for `remote:<hostKey>:<sid>` lands here.
 *
 * Connection honesty: consecutive poll failures mark the host disconnected
 * (the boot reports it and `ensureReady` reconnects); a 401 (stale token
 * after a bridge restart) triggers one endpoint re-discovery + tunnel rebuild
 * inside the poll loop, so a restarted service is rejoined without a user
 * round-trip. The bridge token lives only inside the `PerchClient` closure;
 * nothing in this module returns it.
 */
import { makeRemoteSessionId, type BackendRouter } from "../backend-router.js";
import type { SshTunnelManager } from "../ssh-tunnel.js";
import { reserveLocalPort, type SshTransport } from "../ssh-transport.js";
import { IPC } from "@pi-desktop/shared";
import type { RacpProjectSummary, RemoteHostBrowseProjectsResult, SessionSummary } from "@pi-desktop/shared";
import {
  createPerchClient, discoverPerchEndpoint, PerchBridgeError,
  type PerchClient, type PerchEndpoint,
} from "./perch-client.js";
import { createPerchEventBridge, type PerchEventBridge } from "./perch-event-bridge.js";
import { createPerchBackend } from "./perch-session-backend.js";
import type { PerchSessionSummary } from "./perch-client.js";

export type PerchHostOptions = {
  hostKey: string;
  label: string;
  router: BackendRouter;
  tunnels: SshTunnelManager;
  ssh: { host: string; port?: number; user?: string; identityFile?: string; remotePort: number };
  sshSecret?: string;
  emit: (channel: string, payload: unknown) => void;
  buildTransport?: () => SshTransport;
  discoverEndpoint?: (exec: (cmd: string, o?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>) => Promise<PerchEndpoint>;
  pollMs?: { busy: number; idle: number };
  /** Consecutive poll failures before the host reports disconnected. */
  failureThreshold?: number;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export interface PerchHost {
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  sessions(): Promise<PerchSessionSummary[]>;
  /** Renderer-shaped summaries of the cached session inventory. */
  summaries(): SessionSummary[];
  /** Distinct session cwds as project entries (Perch has no project registry). */
  projects(): Promise<RacpProjectSummary[]>;
  /** List remote directories over SSH (the bridge has no browse endpoint). */
  browse(path?: string): Promise<RemoteHostBrowseProjectsResult>;
  /** Combined model catalog; each entry names the runtime (`agent`) that can serve it. */
  models(): Promise<PerchModelEntry[]>;
  setModel(hostSessionId: string, model: string, provider: string): Promise<unknown>;
  createSession(input: { cwd: string; provider?: string; model?: string; permissionMode?: string; title?: string }): Promise<PerchSessionSummary>;
}

export type PerchModelEntry = {
  id: string; provider: string; name: string;
  contextWindow?: number; thinking?: string[]; agent: string;
};

/** Runtimes the Perch native bridge actually serves (perch NATIVE-AGENTS). */
export const PERCH_PROVIDERS = new Set(["omp", "qoder", "qoderintl", "dsh", "codex", "claude"]);

/** Map a PI permission mode onto each runtime's create-time modes. */
export function perchPermissionModeFor(provider: string, value: string | undefined): string {
  if (provider === "omp") {
    if (value === "write" || value === "yolo" || value === "always-ask") return value;
    if (value === "auto") return "write";
    return "always-ask";
  }
  if (provider === "codex") {
    if (value === "read-only" || value === "workspace-ask" || value === "workspace-auto" || value === "full-access") return value;
    return "workspace-ask";
  }
  if (provider === "dsh") return "runtime-managed";
  if (value === "default" || value === "acceptEdits" || value === "plan" || value === "dontAsk" || value === "auto" || value === "bypassPermissions") return value;
  return "default";
}

/** Back-compat alias: OMP-only mapping used by the first adapter version. */
export function perchPermissionMode(value: string | undefined): "always-ask" | "write" | "yolo" {
  return perchPermissionModeFor("omp", value) as "always-ask" | "write" | "yolo";
}

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

export function createPerchHost(options: PerchHostOptions): PerchHost {
  const log = options.log ?? (() => undefined);
  const pollMs = { busy: options.pollMs?.busy ?? 400, idle: options.pollMs?.idle ?? 2000 };
  const failureThreshold = options.failureThreshold ?? 3;
  const bridge: PerchEventBridge = createPerchEventBridge({ hostKey: options.hostKey, emit: options.emit, log });

  let endpoint: PerchEndpoint | null = null;
  let client: PerchClient | null = null;
  let transport: SshTransport | null = null;
  let forward: { localPort: number; close(): Promise<void> } | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let connected = false;
  let failures = 0;
  let sessionCache: PerchSessionSummary[] = [];
  // Session-scoped allow: allow-session remembers the tool; the bridge
  // auto-approves later identical-tool requests on the same session.
  const sessionAllowedTools = new Map<string, Set<string>>();
  let lastInventoryKey = "";
  const lastSeenRevision = new Map<string, number>();
  let rediscovering: Promise<void> | null = null;

  const assertLive = (): { client: PerchClient } => {
    if (closed || !client || !connected) {
      throw Object.assign(new Error("perch host is not connected"), { errorCode: "AGENT_UNAVAILABLE" });
    }
    return { client };
  };

  /**
   * Open a raw loopback forward to the discovered bridge port. This must NOT
   * go through SshTunnelManager.open: that manager runs the pi-host
   * supervisor (ensureRemoteHostReady) which probes for a RACP host that a
   * Perch bridge is not. Perch owns its own transport + forward lifecycle.
   */
  async function openForward(port: number): Promise<{ localPort: number }> {
    if (!transport) throw Object.assign(new Error("perch transport unavailable"), { errorCode: "AGENT_UNAVAILABLE" });
    const localPort = await reserveLocalPort();
    forward = await transport.forward({ localPort, remoteHost: "127.0.0.1", remotePort: port });
    return { localPort: forward.localPort };
  }

  async function openClient(): Promise<void> {
    const buildTransport = options.buildTransport;
    if (!buildTransport) throw Object.assign(new Error("no ssh transport for perch host"), { errorCode: "INVALID_ARGUMENT" });
    transport = buildTransport();
    const discover = options.discoverEndpoint ?? discoverPerchEndpoint;
    endpoint = await discover((cmd, o) => transport!.exec(cmd, o));
    const { localPort } = await openForward(endpoint.port);
    const ep = endpoint;
    client = createPerchClient({
      localBaseUrl: () => `http://127.0.0.1:${localPort}`,
      endpoint: () => ep,
      log,
    });
  }

  async function closeClient(): Promise<void> {
    const f = forward;
    forward = null;
    if (f) await f.close().catch((error: unknown) => log("warn", "perch forward close failed", { error: String(error) }));
    transport?.dispose();
    transport = null;
    client = null;
  }

  /** Rebuild endpoint + forward + client after a bridge restart (401). */
  async function rediscover(): Promise<void> {
    if (rediscovering) return rediscovering;
    rediscovering = (async () => {
      await closeClient();
      await openClient();
      // New service generation: revisions restarted, so the diff baselines
      // must not leak into the new epoch.
      lastSeenRevision.clear();
    })().finally(() => { rediscovering = null; });
    return rediscovering;
  }

  function registerSessionBackend(hostSessionId: string): void {
    if (!client) return;
    const liveClient = client;
    options.router.registerBackend(
      makeRemoteSessionId(options.hostKey, hostSessionId),
      createPerchBackend({
        hostKey: options.hostKey, client: liveClient, log,
        sessionAllowedTools,
        listModels: () => liveClient.get("/models").then((c) => ((c as { models?: Array<{ id: string; provider: string; agent: string }> }).models ?? [])),
      }),
    );
  }

  async function pollOnce(): Promise<boolean> {
    if (closed || !client) return false;
    let anyBusy = false;
    try {
      const list = (await client.get("/sessions")) as { sessions?: PerchSessionSummary[] };
      const sessions = list.sessions ?? [];
      sessionCache = sessions;
      failures = 0;
      connected = true;
      // Notify the renderer when the session inventory changes (a new session
      // created elsewhere, one archived/deleted, or the first sighting after
      // connect): without this the sidebar only updates on a manual refresh.
      const ids = sessions.map((s) => s.id).join("");
      if (ids !== lastInventoryKey) {
        lastInventoryKey = ids;
        options.emit(IPC.event.sessionsChanged, { reason: "perch.sessions.changed" });
      }
      for (const session of sessions) {
        const hostSessionId = session.id;
        if (session.busy || (session.pending ?? 0) > 0) anyBusy = true;
        // Registration and the diff baseline are separate concerns: a session
        // we have never seen (including an idle one recovered after a bridge
        // restart) must still be snapshotted once, or its state never reaches
        // the renderer.
        const known = lastSeenRevision.get(hostSessionId);
        if (known === undefined) {
          registerSessionBackend(hostSessionId);
        }
        if (known !== undefined && !session.busy && (session.pending ?? 0) === 0 && session.revision === known) {
          continue;
        }
        const snapshot = (await client.get(`/sessions/${encodeURIComponent(hostSessionId)}`)) as PerchSessionSummary & { revision?: number };
        if (snapshot.busy || (snapshot.pending ?? 0) > 0) anyBusy = true;
        lastSeenRevision.set(hostSessionId, snapshot.revision ?? session.revision);
        // Auto-approve tools this session already allowed: answer them before
        // the bridge surfaces a card, so an allowed tool never re-asks. A failed
        // answer is logged, not swallowed silently, and the card still surfaces
        // (the snapshot still carries the interaction).
        const allowed = sessionAllowedTools.get(hostSessionId);
        if (allowed?.size && client) {
          for (const interaction of (snapshot as { interactions?: Array<{ id: string; method?: string; title?: string; options?: string[] }> }).interactions ?? []) {
            const toolName = interaction.title?.match(/^Allow tool:\s*([^\n]+)/)?.[1]?.trim();
            if (!toolName || !allowed.has(toolName)) continue;
            try {
              if (interaction.method === "select") {
                const option = interaction.options?.find((o) => /^approve$/i.test(o));
                if (!option) continue; // no single-use approve: leave the card
                await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/answer`, { id: interaction.id, value: option });
              } else if (interaction.method === "confirm") {
                await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/answer`, { id: interaction.id, allow: true });
              }
            } catch (error) {
              log("warn", "auto-approve failed; the card stays visible", { hostSessionId, id: interaction.id, error: String(error) });
            }
          }
        }
        bridge.applySnapshot(hostSessionId, snapshot as never);
      }
    } catch (error) {
      if (error instanceof PerchBridgeError && error.errorCode === "PERCH_AUTH_STALE" && !closed) {
        // Bridge restarted: token minted per service start. Re-discover once,
        // then let the next poll ride the fresh endpoint.
        try { await rediscover(); } catch (e) { log("warn", "perch endpoint re-discovery failed", { error: String(e) }); }
        return true; // stay on the busy cadence to recover promptly
      }
      failures += 1;
      log("warn", "perch poll failed", { hostKey: options.hostKey, failures, error: String(error) });
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
        throw Object.assign(new Error("perch host did not answer its first poll"), { errorCode: "AGENT_UNAVAILABLE" });
      }
      schedulePoll(true);
    },
    async close() {
      closed = true;
      connected = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      await closeClient();
      sessionCache = [];
      lastSeenRevision.clear();
    },
    isConnected: () => connected && !closed,
    async sessions() {
      const { client: live } = assertLive();
      const list = (await live.get("/sessions")) as { sessions?: PerchSessionSummary[] };
      sessionCache = list.sessions ?? [];
      return sessionCache;
    },
    summaries() {
      return sessionCache.map((session): SessionSummary => ({
        id: makeRemoteSessionId(options.hostKey, session.id),
        title: session.title,
        source: "remote",
        remoteHostKey: options.hostKey,
        remoteHostLabel: options.label,
        remoteProjectId: session.cwd,
        remoteWorkspaceLabel: basename(session.cwd),
        remoteAgent: session.provider,
        mode: "agent",
        permissionMode: "ask",
        thinkingLevel: "off",
        // The real remote model so the composer shows it (e.g. kimi-k3), not a
        // generic placeholder.
        ...(session.model ? { modelId: session.model } : {}),
        ...(session.provider_id ? { providerId: session.provider_id } : {}),
        messageCount: 0,
        updatedAt: new Date((session.updated ?? 0) * 1000).toISOString(),
        createdAt: new Date((session.updated ?? 0) * 1000).toISOString(),
        capabilities: {
          canPrompt: connected, canStop: connected, canRefresh: connected,
          // OMP/Qoder/Codex/Claude all accept a model switch while idle.
          canConfigureModel: connected,
          canAttach: false, canSteer: false,
          canEditMessages: false, canUseLocalTools: false, canUseTerminal: false,
          canReadWorkspace: false,
        },
        ...(connected ? {} : { readOnlyReason: "REMOTE_HOST_DISCONNECTED" }),
      }));
    },
    async projects() {
      const { client: live } = assertLive();
      const list = (await live.get("/sessions")) as { sessions?: PerchSessionSummary[] };
      const seen = new Map<string, RacpProjectSummary>();
      for (const session of list.sessions ?? []) {
        if (!seen.has(session.cwd)) {
          seen.set(session.cwd, { id: session.cwd, label: basename(session.cwd), archived: false });
        }
      }
      return [...seen.values()];
    },
    async browse(path) {
      const buildTransport = options.buildTransport;
      if (!buildTransport) throw Object.assign(new Error("perch host is not connected"), { errorCode: "AGENT_UNAVAILABLE" });
      const transport = buildTransport();
      // No path: the remote home directory. `cd` with no arguments resolves
      // $HOME inside the remote shell; quoting "$HOME" locally would send the
      // literal string. A path must be absolute; anything else is rejected
      // before it reaches a shell.
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
        throw Object.assign(new Error("perch session cwd must be a remote absolute path"), { errorCode: "INVALID_ARGUMENT" });
      }
      const provider = input.provider ?? "omp";
      if (!PERCH_PROVIDERS.has(provider)) {
        throw Object.assign(new Error(`perch runtime "${provider}" is not available on this bridge`), { errorCode: "INVALID_ARGUMENT" });
      }
      const created = (await live.post("/sessions", {
        provider,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        permissionMode: perchPermissionModeFor(provider, input.permissionMode),
        ...(input.title ? { title: input.title } : {}),
      })) as PerchSessionSummary;
      registerSessionBackend(created.id);
      lastSeenRevision.set(created.id, created.revision);
      sessionCache = [created, ...sessionCache.filter((s) => s.id !== created.id)];
      await pollOnce();
      return created;
    },
    async models() {
      const { client: live } = assertLive();
      const catalog = (await live.get("/models")) as { models?: PerchModelEntry[] };
      return catalog.models ?? [];
    },
    async setModel(hostSessionId, model, provider) {
      const { client: live } = assertLive();
      return live.post(`/sessions/${encodeURIComponent(hostSessionId)}/model`, { provider, model });
    },
  };
}
