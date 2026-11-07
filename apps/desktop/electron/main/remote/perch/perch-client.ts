/**
 * Perch native bridge client (main process only).
 *
 * The Perch remote core is a Bearer-authenticated loopback HTTP service
 * (`perch/remote/native-agent-service.py`, SERVICE_VERSION 13), reached through
 * the user's SSH tunnel. This module owns the two things that must never leak:
 * the bridge token and the SSH endpoint discovery. The token is read over SSH
 * from the remote `$AWB_NATIVE_ROOT/endpoint.json` (or obtained via
 * `--ensure`), held only here in the main process, and sent as
 * `Authorization: Bearer <token>` on every request. It is never forwarded to
 * the renderer, never written to a log, and never placed in a URL.
 *
 * Contract notes this client encodes (see
 * `_evidence/pi-perch-adapter-20261107/perch-native-service-contract.md`):
 * - Every call may fail with a transport error (tunnel down) or an HTTP error
 *   `{error}` (400/401/404/409). 401 means the token is stale (service
 *   restarted) → the caller must re-discover the endpoint, not retry blindly.
 * - `prompt`/`steer` are idempotent on a client-generated `requestId`; a lost
 *   response is resolved by `GET /sessions/{id}/requests/{requestId}` before
 *   any retry, never by resending with a new id.
 * - History/snapshot reads use `revision`/`epoch` so an unchanged poll is
 *   `{unchanged:true}` and a service restart surfaces as an epoch change.
 */

/** One discovered Perch endpoint: where the bridge listens and its token. */
export type PerchEndpoint = {
  /** Loopback port on the remote host the service listens on. */
  port: number;
  /** Bearer token, minted per service start. Main-process secret. */
  token: string;
  pid?: number;
};

/** Minimal SSH exec surface this client needs to discover the endpoint. */
export type PerchSshExec = (command: string, options?: { timeoutMs?: number }) => Promise<{
  stdout: string;
  stderr: string;
  code: number;
}>;

export type PerchClientOptions = {
  /** Loopback base URL on *this* machine after the tunnel is up. */
  localBaseUrl: () => string;
  /** Current endpoint (port on the remote + token). */
  endpoint: () => PerchEndpoint;
  /** Per-request timeout; defaults to 30s. Injectable for tests. */
  timeoutMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export class PerchBridgeError extends Error {
  readonly status: number;
  readonly errorCode: string;
  constructor(message: string, status: number, errorCode: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

function fail(message: string, errorCode: string): PerchBridgeError {
  return new PerchBridgeError(message, 0, errorCode);
}

/**
 * Read the live endpoint over SSH. The remote port changes every service
 * restart, so it is never cached across a reconnect. We try, in order:
 * `--ensure` (starts or reuses the service and prints the descriptor), then a
 * direct read of `endpoint.json`. Both are loopback-local on the remote.
 */
export async function discoverPerchEndpoint(exec: PerchSshExec): Promise<PerchEndpoint> {
  const roots = [
    "$HOME/.local/share/agent-workbench/native",
  ];
  for (const root of roots) {
    const script = [
      `if [ -x "${root}/native-agent-service.py" ] || [ -f "${root}/native-agent-service.py" ]; then`,
      `  (cd "${root}" && python3 native-agent-service.py --ensure 2>/dev/null) || cat "${root}/endpoint.json" 2>/dev/null`,
      `else cat "${root}/endpoint.json" 2>/dev/null; fi`,
    ].join("; ");
    const result = await exec(script, { timeoutMs: 30_000 });
    const text = result.stdout.trim();
    if (!text) continue;
    // `--ensure` may print diagnostics before the JSON line; take the last
    // brace-delimited line that parses and carries both port and token.
    for (const line of text.split(/\r?\n/).reverse()) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<PerchEndpoint>;
        if (typeof parsed.port === "number" && typeof parsed.token === "string" && parsed.token) {
          return { port: parsed.port, token: parsed.token, ...(parsed.pid ? { pid: parsed.pid } : {}) };
        }
      } catch { /* keep scanning lines */ }
    }
  }
  throw fail("could not discover the Perch endpoint over SSH", "PERCH_ENDPOINT_UNAVAILABLE");
}

export interface PerchClient {
  get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export function createPerchClient(options: PerchClientOptions): PerchClient {
  const log = options.log ?? (() => undefined);
  async function request(method: "GET" | "POST", path: string, body: unknown, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const endpoint = options.endpoint();
    const base = options.localBaseUrl().replace(/\/$/, "");
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      log("warn", "perch request transport failure", { path, error: String(error) });
      throw fail(`perch bridge unreachable: ${String(error)}`, "HOST_DISCONNECTED");
    }
    if (response.status === 401) {
      // Token minted per service start; a 401 means the bridge restarted and
      // this endpoint is stale. The caller re-discovers before any retry.
      throw new PerchBridgeError("perch bridge rejected the token (service restarted?)", 401, "PERCH_AUTH_STALE");
    }
    const text = await response.text();
    let parsed: unknown = {};
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = {}; } }
    if (!response.ok) {
      const message = (parsed as { error?: string }).error ?? `perch request failed (${response.status})`;
      const code = response.status === 409 ? "PERCH_CONFLICT"
        : response.status === 404 ? "PERCH_NOT_FOUND"
        : "PERCH_REQUEST_FAILED";
      throw new PerchBridgeError(message, response.status, code);
    }
    return parsed;
  }
  return {
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body) => request("POST", path, body),
  };
}

/** Type guards for the slices of the contract the adapter depends on. */
export type PerchSessionSummary = {
  id: string; provider: string; title: string; cwd: string;
  busy: boolean; archived: boolean; updated: number; revision: number;
  completed: number; model: string; error: string | null;
  pending: number; cancelled: boolean; thinking: string | null;
  permissionMode?: string;
  turnId?: string | null; turnState?: string | null;
  context?: { tokens: number | null; limit: number | null } | null;
  messages?: unknown[];
  interactions?: unknown[];
  history?: { epoch: string; start: number; total: number; end: number };
};

export type PerchReceipt = {
  id: string;
  status: "submitting" | "submitted" | "accepted" | "running" | "completed" | "stopped" | "failed" | "unknown" | "consumed" | "notFound";
  error?: string | null;
};

export type PerchInteraction = {
  id: string;
  method?: string;
  title?: string;
  message?: string;
  options?: string[];
  name?: string;
  input?: unknown;
  expires?: number | null;
};

export function asSessionSummary(value: unknown): PerchSessionSummary {
  const v = value as PerchSessionSummary;
  if (!v || typeof v.id !== "string") throw fail("malformed session summary", "PERCH_REQUEST_FAILED");
  return v;
}

export function asReceipt(value: unknown): PerchReceipt {
  const v = value as PerchReceipt;
  if (!v || typeof v.id !== "string" || typeof v.status !== "string") {
    throw fail("malformed receipt", "PERCH_REQUEST_FAILED");
  }
  return v;
}
