/**
 * Perch `RemoteBackend`: serves renderer IPC calls for one Perch session over
 * the bridge's loopback HTTP. The contract is the RACP-agnostic
 * `RemoteBackend` (`handles`/`invoke`) from `../backend-router.ts`; this module
 * is the only place that knows the Perch HTTP verbs.
 *
 * Guarantees this implementation is responsible for:
 * - **No duplicate side effects.** `agentPrompt` sends a client `requestId`;
 *   when the response is lost (tunnel dropped mid-request) the receipt is
 *   re-read with `GET .../requests/{requestId}` and the *original* receipt is
 *   returned, never a resent prompt.
 * - **Accurate cancel.** `agentAbort`/`agentStop` name the session's current
 *   `turnId`; a stale turn id is rejected by the bridge (400 "轮次已变化") and
 *   surfaced, never silently applied to a newer turn.
 * - **Fail closed.** Unsupported operations (plan approval, workspace file
 *   browse) report `CAPABILITY_UNAVAILABLE` rather than pretending.
 */
import { IPC, ErrorCodes } from "@pi-desktop/shared";
import type { RemoteBackend } from "../backend-router.js";
import { parseRemoteSessionId, parseRemoteApprovalRequestId } from "../backend-router.js";
import type { PerchClient, PerchReceipt, PerchSessionSummary } from "./perch-client.js";
import { asReceipt, PerchBridgeError } from "./perch-client.js";
import { perchMessageToUi } from "./perch-event-bridge.js";

export type PerchBackendOptions = {
  hostKey: string;
  client: PerchClient;
  newRequestId?: () => string;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

function capabilityUnavailable(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE });
}
function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

const HANDLED_CHANNELS: ReadonlySet<string> = new Set([
  IPC.invoke.agentPrompt,
  IPC.invoke.agentGetStatus,
  IPC.invoke.agentStop,
  IPC.invoke.agentAbort,
  IPC.invoke.sessionGet,
  IPC.invoke.sessionDelete,
  IPC.invoke.toolResolvePermission,
]);

/** hostSessionId for a renderer call, or throw. */
function hostIdFor(args: readonly unknown[]): string {
  const first = args[0];
  const id = typeof first === "string" ? first
    : first && typeof first === "object"
      ? ((first as { sessionId?: unknown }).sessionId ?? (first as { id?: unknown }).id)
      : undefined;
  if (typeof id !== "string") throw invalid("call does not address a session");
  const parsed = parseRemoteSessionId(id);
  if (!parsed) throw invalid("malformed remote session id");
  return parsed.hostSessionId;
}

export function createPerchBackend(options: PerchBackendOptions): RemoteBackend {
  const { client } = options;
  const newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID());
  const log = options.log ?? (() => undefined);

  const snapshot = (hostSessionId: string) =>
    client.get(`/sessions/${encodeURIComponent(hostSessionId)}`) as Promise<Record<string, unknown>>;

  const getSummary = async (hostSessionId: string): Promise<PerchSessionSummary> => {
    const snap = (await snapshot(hostSessionId)) as unknown as PerchSessionSummary;
    return snap;
  };

  /**
   * Submit a prompt with a durable requestId. If the POST fails at the
   * transport level (tunnel dropped, response lost), resolve the receipt
   * before returning: the bridge dedupes on requestId, so the original
   * submission — if it landed — is returned instead of a duplicate prompt.
   */
  const submitPrompt = async (hostSessionId: string, text: string): Promise<PerchReceipt> => {
    const requestId = newRequestId();
    try {
      return asReceipt(await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/prompt`, { requestId, text }));
    } catch (error) {
      if (error instanceof PerchBridgeError && error.errorCode === "HOST_DISCONNECTED") {
        // The response may have been lost after the bridge accepted the turn.
        const receipt = asReceipt(await client.get(
          `/sessions/${encodeURIComponent(hostSessionId)}/requests/${encodeURIComponent(requestId)}`,
        ));
        if (receipt.status !== "notFound") return receipt;
      }
      throw error;
    }
  };

  const invoke = async (channel: string, args: readonly unknown[]): Promise<unknown> => {
    switch (channel) {
      case IPC.invoke.agentPrompt: {
        const req = args[0] as { sessionId: string; content: string };
        const receipt = await submitPrompt(hostIdFor(args), req.content);
        return { accepted: receipt.status !== "failed", turnId: receipt.id };
      }
      case IPC.invoke.agentGetStatus: {
        const summary = await getSummary(hostIdFor(args));
        return {
          status: {
            sessionId: (args[0] as { sessionId?: string }).sessionId ?? summary.id,
            isRunning: summary.busy === true,
            ...(summary.turnId ? { currentTurnId: summary.turnId } : {}),
            pendingToolConfirmations: summary.pending ?? 0,
          },
        };
      }
      case IPC.invoke.agentStop:
      case IPC.invoke.agentAbort: {
        const req = args[0] as { sessionId: string; turnId?: string };
        const hostSessionId = hostIdFor(args);
        // Cancel must name the current turn; never abort a newer turn by
        // accident. Read the live turnId when the caller did not pin one.
        const summary = await getSummary(hostSessionId);
        const turnId = req.turnId ?? summary.turnId ?? undefined;
        if (!turnId || summary.busy !== true) {
          return channel === IPC.invoke.agentStop ? { requested: false } : { aborted: false };
        }
        await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/abort`, { turnId });
        return channel === IPC.invoke.agentStop ? { requested: true } : { aborted: true };
      }
      case IPC.invoke.sessionGet: {
        const hostSessionId = hostIdFor(args);
        const remoteSessionId = ((): string => {
          const first = args[0];
          const id = typeof first === "string" ? first : (first as { id?: string })?.id ?? (first as { sessionId?: string })?.sessionId;
          return typeof id === "string" ? id : "";
        })();
        const snap = (await snapshot(hostSessionId)) as PerchSessionSummary;
        const busy = snap.busy === true;
        const messages = (snap.messages ?? []).map((m) => perchMessageToUi(m as never, busy));
        return {
          session: {
            id: remoteSessionId,
            source: "remote",
            remoteHostKey: options.hostKey,
            title: snap.title,
            messageCount: messages.length,
            messages,
            mode: "code",
            permissionMode: "ask",
            thinkingLevel: "default",
            updatedAt: new Date((snap.updated ?? 0) * 1000).toISOString(),
            createdAt: new Date((snap.updated ?? 0) * 1000).toISOString(),
            capabilities: { canPrompt: true, canStop: true, canRefresh: true, canConfigureModel: false },
          },
        };
      }
      case IPC.invoke.sessionDelete: {
        const hostSessionId = hostIdFor(args);
        await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/delete`, {});
        return { ok: true };
      }
      case IPC.invoke.toolResolvePermission: {
        const resolution = args[0] as { requestId: string; decision: string; value?: unknown };
        const parsed = parseRemoteApprovalRequestId(resolution.requestId);
        if (!parsed) throw invalid("malformed remote approval request id");
        const hostSessionId = parseRemoteSessionId(parsed.remoteSessionId)?.hostSessionId;
        if (!hostSessionId) throw invalid("malformed remote session id");
        // Read the live interaction to pick the right answer shape: an OMP
        // `confirm` takes {confirmed}, a select/input/editor takes {value}.
        const snap = await snapshot(hostSessionId);
        const interactions = (snap.interactions ?? []) as Array<{ id: string; method?: string }>;
        const target = interactions.find((item) => item.id === parsed.hostApprovalId);
        if (!target) {
          // Stale / already-resolved id: fail closed rather than guess.
          throw Object.assign(new Error("approval is no longer open"), { errorCode: "NOT_FOUND" });
        }
        const body: Record<string, unknown> = { id: parsed.hostApprovalId };
        if (target.method === "confirm") {
          body.allow = resolution.decision === "allow-once" || resolution.decision === "allow";
        } else if (target.method === "select") {
          // Map the user's explicit decision onto the OMP select options
          // (e.g. "Approve" / "Approve bash for this session" / "Deny").
          // Never default to the first option and never upgrade a plain allow
          // into a session-scoped grant unless the user asked for it.
          const options = (target as { options?: string[] }).options ?? [];
          const pick = (re: RegExp) => options.find((o) => re.test(o));
          const value = resolution.decision === "deny"
            ? pick(/deny|reject|拒绝/i)
            : resolution.decision === "allow-session"
              ? (pick(/for this session|this session|会话/i) ?? pick(/approve|allow|允许/i))
              : (pick(/^approve$|^allow$|^允许$/i) ?? pick(/approve|allow|允许(?!.*session)/i));
          if (!value) {
            throw capabilityUnavailable(`no matching OMP option for decision "${resolution.decision}"`);
          }
          body.value = value;
        } else {
          // input/editor collect free-form content the three-button card
          // cannot supply; fail closed rather than fabricate a value.
          throw capabilityUnavailable(`approval method "${target.method}" is not supported by this UI`);
        }
        await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/answer`, body);
        return { ok: true };
      }
      case IPC.invoke.plansResolve:
        throw capabilityUnavailable("plan approval is not available on a Perch session");
      default:
        throw capabilityUnavailable(`perch backend does not handle ${channel}`);
    }
  };

  void log;
  return { handles: (channel: string) => HANDLED_CHANNELS.has(channel), invoke };
}
