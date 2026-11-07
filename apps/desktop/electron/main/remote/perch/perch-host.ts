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
 * The bridge token lives only inside the `PerchClient` closure built here;
 * nothing in this module returns it.
 */
import { makeRemoteSessionId, type BackendRouter } from "../backend-router.js";
import type { SshTunnelManager } from "../ssh-tunnel.js";
import type { SshTransport } from "../ssh-transport.js";
import {
  createPerchClient, discoverPerchEndpoint,
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
  /** The SSH target descriptor (from registry metadata). */
  ssh: { host: string; port?: number; user?: string; identityFile?: string; remotePort: number };
  sshSecret?: string;
  emit: (channel: string, payload: unknown) => void;
  /** Injectable for tests; defaults to the system ssh transport. */
  buildTransport?: () => SshTransport;
  /** Injectable for tests; defaults to `discoverPerchEndpoint`. */
  discoverEndpoint?: (exec: (cmd: string, o?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>) => Promise<PerchEndpoint>;
  /** Busy/idle poll cadence in ms; injectable for tests. */
  pollMs?: { busy: number; idle: number };
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export interface PerchHost {
  connect(): Promise<void>;
  close(): Promise<void>;
  sessions(): Promise<PerchSessionSummary[]>;
  createSession(input: { cwd: string; model?: string; permissionMode?: string; title?: string }): Promise<PerchSessionSummary>;
}

export function createPerchHost(options: PerchHostOptions): PerchHost {
  const log = options.log ?? (() => undefined);
  const pollMs = { busy: options.pollMs?.busy ?? 400, idle: options.pollMs?.idle ?? 2000 };
  const bridge: PerchEventBridge = createPerchEventBridge({ hostKey: options.hostKey, emit: options.emit, log });

  let endpoint: PerchEndpoint | null = null;
  let localPort = 0;
  let client: PerchClient | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let lastSeenRevision = new Map<string, number>();

  const assertLive = (): { client: PerchClient; endpoint: PerchEndpoint } => {
    if (closed || !client || !endpoint) {
      throw Object.assign(new Error("perch host is not connected"), { errorCode: "AGENT_UNAVAILABLE" });
    }
    return { client, endpoint };
  };

  async function pollOnce(): Promise<boolean> {
    if (closed || !client) return false;
    let anyBusy = false;
    try {
      const list = (await client.get("/sessions")) as { sessions?: PerchSessionSummary[] };
      const sessions = list.sessions ?? [];
      for (const session of sessions) {
        const hostSessionId = session.id;
        const remoteSessionId = makeRemoteSessionId(options.hostKey, hostSessionId);
        if (session.busy || (session.pending ?? 0) > 0) anyBusy = true;
        // Register a backend the first time we see a session, so its IPC
        // routes here even before the user opens it.
        if (!lastSeenRevision.has(hostSessionId)) {
          options.router.registerBackend(remoteSessionId, createPerchBackend({
            hostKey: options.hostKey, client, log,
          }));
          lastSeenRevision.set(hostSessionId, session.revision);
        }
        // Fetch the full snapshot whenever anything could have moved: a busy
        // turn streams, a pending approval can resolve, and a revision bump is
        // the only idle signal. Idle + unchanged revision skips the fetch.
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
      log("warn", "perch poll failed", { hostKey: options.hostKey, error: String(error) });
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
      const buildTransport = options.buildTransport;
      if (!buildTransport) throw Object.assign(new Error("no ssh transport for perch host"), { errorCode: "INVALID_ARGUMENT" });
      const transport = buildTransport();
      const discover = options.discoverEndpoint ?? discoverPerchEndpoint;
      endpoint = await discover((cmd, o) => transport.exec(cmd, o));
      const tunnel = await options.tunnels.open(options.hostKey, {
        host: options.ssh.host, remotePort: endpoint.port,
        version: "",
        ...(options.ssh.port !== undefined ? { port: options.ssh.port } : {}),
        ...(options.ssh.user ? { user: options.ssh.user } : {}),
        ...(options.ssh.identityFile ? { identityFile: options.ssh.identityFile } : {}),
      }, options.sshSecret);
      localPort = tunnel.localPort;
      const ep = endpoint;
      client = createPerchClient({
        localBaseUrl: () => `http://127.0.0.1:${localPort}`,
        endpoint: () => ep,
        log,
      });
      closed = false;
      await pollOnce();
      schedulePoll(true);
    },
    async close() {
      closed = true;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      await options.tunnels.close(options.hostKey);
      lastSeenRevision = new Map();
      client = null;
    },
    async sessions() {
      const { client: live } = assertLive();
      const list = (await live.get("/sessions")) as { sessions?: PerchSessionSummary[] };
      return list.sessions ?? [];
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
        permissionMode: input.permissionMode ?? "always-ask",
        ...(input.title ? { title: input.title } : {}),
      })) as PerchSessionSummary;
      const remoteSessionId = makeRemoteSessionId(options.hostKey, created.id);
      options.router.registerBackend(remoteSessionId, createPerchBackend({
        hostKey: options.hostKey, client: live, log,
      }));
      lastSeenRevision.set(created.id, created.revision);
      await pollOnce();
      return created;
    },
  };
}
