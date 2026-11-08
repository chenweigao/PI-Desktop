/**
 * Kimi channel client (main process only).
 *
 * The Kimi channel is a separate Perch runtime: a `kimi web` loopback service
 * (started/managed by Perch's `local-agent-service.py`), reached over SSH with
 * a Bearer token read from the remote `$KIMI_CODE_HOME/server.token`. It is
 * NOT the native-agent bridge — different envelope, different session model.
 *
 * Contract notes this client encodes (see
 * `_evidence/pi-perch-adapter-20261107/perch-kimi-adapter-contract.md`):
 * - Every response is a `{code, msg, data}` envelope; HTTP 200 is not success
 *   unless `code === 0`. 401 means the token is stale (service restarted).
 * - The token is read over SSH from the remote `server.token`, held only in
 *   this process, and sent as `Authorization: Bearer <token>` — never in a
 *   URL, a log, or the renderer.
 * - Prompts carry a client-generated `prompt_id` as the idempotency key; a
 *   lost response is never resent blindly.
 */

export type KimiEndpoint = { port: number; token: string; pid?: number };

export type KimiSshExec = (command: string, options?: { timeoutMs?: number }) => Promise<{
  stdout: string; stderr: string; code: number;
}>;

export class KimiBridgeError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly code: number;
  constructor(message: string, status: number, errorCode: string, code = 0) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.code = code;
  }
}

function fail(message: string, errorCode: string): KimiBridgeError {
  return new KimiBridgeError(message, 0, errorCode);
}

/**
 * Discover the Kimi endpoint over SSH: stream Perch's local-agent-service.py
 * `--agent kimi` (it starts or reuses the loopback service and prints one
 * JSON line `{port, token}`), falling back to reading the token file when a
 * service is already running outside Perch's ownership. Newline-separated
 * POSIX shell, never `;`-joined.
 */
export async function discoverKimiEndpoint(exec: KimiSshExec, port = 58627): Promise<KimiEndpoint> {
  const script = [
    `set -e`,
    `SERVICE="$HOME/.local/share/agent-workbench/native/local-agent-service.py"`,
    `if [ -f "$SERVICE" ]; then`,
    `  python3 "$SERVICE" --agent kimi --port ${port} 2>/dev/null && exit 0`,
    `fi`,
    // The service is already running outside Perch's ownership: read the token
    // file directly. The port is the caller's configured one.
    `TOKEN_PATH="$HOME/.kimi-code/server.token"`,
    `if [ -f "$TOKEN_PATH" ]; then`,
    `  TOKEN=$(cat "$TOKEN_PATH" | tr -d '[:space:]')`,
    `  printf '{"port": %d, "token": "%s"}' ${port} "$TOKEN"`,
    `fi`,
  ].join("\n");
  const result = await exec(script, { timeoutMs: 30_000 });
  const text = result.stdout.trim();
  if (text) {
    for (const line of text.split(/\r?\n/).reverse()) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<KimiEndpoint>;
        if (typeof parsed.port === "number" && typeof parsed.token === "string" && parsed.token) {
          return { port: parsed.port, token: parsed.token, ...(parsed.pid ? { pid: parsed.pid } : {}) };
        }
      } catch { /* keep scanning */ }
    }
  }
  throw fail("could not discover the Kimi endpoint over SSH", "KIMI_ENDPOINT_UNAVAILABLE");
}

export interface KimiClient {
  get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export type KimiClientOptions = {
  localBaseUrl: () => string;
  endpoint: () => KimiEndpoint;
  timeoutMs?: number;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export function createKimiClient(options: KimiClientOptions): KimiClient {
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
      log("warn", "kimi request transport failure", { path, error: String(error) });
      throw fail(`kimi service unreachable: ${String(error)}`, "HOST_DISCONNECTED");
    }
    if (response.status === 401) {
      throw new KimiBridgeError("kimi service rejected the token (service restarted?)", 401, "KIMI_AUTH_STALE");
    }
    const text = await response.text();
    let envelope: { code?: number; msg?: string; data?: unknown; error?: string } = {};
    if (text) { try { envelope = JSON.parse(text); } catch { envelope = {}; } }
    // The envelope's business code is authoritative; HTTP 200 with code != 0
    // is still a failure.
    const code = envelope.code ?? (response.ok ? 0 : -1);
    if (!response.ok || code !== 0) {
      const message = envelope.msg ?? envelope.error ?? `kimi request failed (${response.status})`;
      throw new KimiBridgeError(message, response.status, "KIMI_REQUEST_FAILED", code);
    }
    return envelope.data;
  }
  return {
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body) => request("POST", path, body),
  };
}

/** Type guards for the slices of the Kimi contract the adapter depends on. */
export type KimiSession = {
  id: string; title?: string; updated_at?: string;
  busy?: boolean; main_turn_active?: boolean;
  pending_interaction?: string | null;
  archived?: boolean;
  last_turn_reason?: string;
  metadata?: { cwd?: string };
  agent_config?: { model?: string; permission_mode?: string };
};

export type KimiApproval = {
  approval_id: string; tool_name?: string; action?: string;
  tool_input_display?: unknown; agent_id?: string;
};

export type KimiSnapshot = {
  as_of_seq?: number; epoch?: string;
  session?: KimiSession;
  messages?: { items?: KimiMessage[]; has_more?: boolean };
  in_flight_turn?: { turn_id?: number; assistant_text?: string; thinking_text?: string; current_prompt_id?: string };
  pending_approvals?: KimiApproval[];
};

export type KimiMessage = {
  id: string; role: string; created_at?: string;
  content?: KimiPart[];
  metadata?: { origin?: { kind?: string } };
};
export type KimiPart = {
  type: string; text?: string; thinking?: string;
  tool_call_id?: string; tool_name?: string; input?: unknown; output?: unknown; is_error?: boolean;
};

export function asKimiSession(value: unknown): KimiSession {
  const v = value as KimiSession;
  if (!v || typeof v.id !== "string") throw fail("malformed kimi session", "KIMI_REQUEST_FAILED");
  return v;
}
