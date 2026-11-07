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
  createSession(input: { cwd: string; model?: string; permissionMode?: string; title?: string }): Promise<PerchSessionSummary>;
}

/** Map a PI permission mode onto the OMP create-time modes. */
export function perchPermissionMode(value: string | undefined): "always-ask" | "write" | "yolo" {
  // PI's "ask" is the conservative default and equals OMP's always-ask;
  // "auto" maps to write; anything unknown stays safe.
  if (value === "write" || value === "yolo" || value === "always-ask") return value;
  if (value === "auto") return "write";
  return "always-ask";
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
    options.router.registerBackend(
      makeRemoteSessionId(options.hostKey, hostSessionId),
      createPerchBackend({ hostKey: options.hostKey, client, log }),
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
      for (const session of sessions) {
        const hostSessionId = session.id;
        if (session.busy || (session.pending ?? 0) > 0) anyBusy = true;
        if (!lastSeenRevision.has(hostSessionId)) {
          registerSessionBackend(hostSessionId);
          lastSeenRevision.set(hostSessionId, session.revision);
        }
        const known = lastSeenRevision.get(hostSessionId);
        if (!session.busy && (session.pending ?? 0) === 0 && session.revision === known) {
          continue;
        }
        const snapshot = (await client.get(`/sessions/${encodeURIComponent(hostSessionId)}`)) as PerchSessionSummary & { revision?: number };
        if (snapshot.busy || (snapshot.pending ?? 0) > 0) anyBusy = true;
        lastSeenRevision.set(hostSessionId, snapshot.revision ?? session.revision);
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
        mode: "agent",
        permissionMode: "ask",
        thinkingLevel: "off",
        messageCount: 0,
        updatedAt: new Date((session.updated ?? 0) * 1000).toISOString(),
        createdAt: new Date((session.updated ?? 0) * 1000).toISOString(),
        capabilities: {
          canPrompt: connected, canStop: connected, canRefresh: connected,
          canConfigureModel: false, canAttach: false, canSteer: false,
          canEditMessages: false, canUseLocalTools: false, canUseTerminal: false,
          canReadWorkspace: false,
          ...(connected ? {} : {}),
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
      const target = path && path.startsWith("/") ? path : "$HOME";
      // Directories only, one per line, trailing slash — the project picker
      // navigates directories. Shell-escape by single-quoting.
      const safe = target.replace(/'/g, "'\\''");
      const result = await transport.exec(
        `cd -- '${safe}' 2>/dev/null && pwd && ls -1Ap | grep '/$' | head -200`,
        { timeoutMs: 15_000 },
      );
      const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const resolved = lines[0] ?? target;
      const entries = lines.slice(1).map((name) => {
        const clean = name.replace(/\/$/, "");
        return { name: clean, path: `${resolved.replace(/\/$/, "")}/${clean}` };
      });
      return { path: resolved, entries };
    },
    async createSession(input) {
      const { client: live } = assertLive();
      if (!input.cwd.startsWith("/")) {
        throw Object.assign(new Error("perch session cwd must be a remote absolute path"), { errorCode: "INVALID_ARGUMENT" });
      }
      const created = (await live.post("/sessions", {
        provider: "omp",
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        permissionMode: perchPermissionMode(input.permissionMode),
        ...(input.title ? { title: input.title } : {}),
      })) as PerchSessionSummary;
      registerSessionBackend(created.id);
      lastSeenRevision.set(created.id, created.revision);
      sessionCache = [created, ...sessionCache.filter((s) => s.id !== created.id)];
      await pollOnce();
      return created;
    },
  };
}
