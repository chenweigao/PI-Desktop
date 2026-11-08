/**
 * Kimi `RemoteBackend`: serves renderer IPC calls for one Kimi session over the
 * Kimi Web loopback API. The contract is the RACP-agnostic `RemoteBackend`; this
 * module is the only place that knows the Kimi HTTP verbs.
 *
 * Guarantees:
 * - **No duplicate side effects.** `agentPrompt` sends the renderer's optimistic
 *   message id as `prompt_id` — Kimi's idempotency key — so a retried send with
 *   the same id is deduped, and a lost response is never resent blindly.
 * - **Approvals are never bypassed.** PI's `allow-once` → `approved`, `deny` →
 *   `rejected`. Kimi grants per-request only; there is no session-scoped grant,
 *   so `allow-session` reports unsupported instead of fabricating one.
 * - **Accurate cancel.** `agentAbort` posts the session's `:abort`; the turn is
 *   settled by the snapshot, not the HTTP receipt.
 */
import { IPC, ErrorCodes } from "@pi-desktop/shared";
import type { RemoteBackend } from "../backend-router.js";
import { parseRemoteSessionId, parseRemoteApprovalRequestId } from "../backend-router.js";
import type { KimiClient, KimiSession, KimiSnapshot } from "./kimi-client.js";
import { KimiBridgeError } from "./kimi-client.js";
import { kimiSnapshotToUiMessages } from "./kimi-event-bridge.js";

export type KimiBackendOptions = {
  hostKey: string;
  client: KimiClient;
  /** Kimi carries the model on the next prompt; the host shares this map so a
   * model chosen at creation and one switched later land on the same key. */
  sessionModels?: Map<string, string>;
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
  IPC.invoke.sessionConfigure,
  IPC.invoke.sessionDelete,
  IPC.invoke.toolResolvePermission,
]);

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

export function createKimiBackend(options: KimiBackendOptions): RemoteBackend {
  const { client } = options;
  const newRequestId = options.newRequestId ?? (() => globalThis.crypto.randomUUID());
  const log = options.log ?? (() => undefined);
  // Kimi switches the model per prompt, not per session: a configure call
  // records the choice and the next prompt carries it.
  const pendingModel = options.sessionModels ?? new Map<string, string>();

  const getSession = async (hostSessionId: string): Promise<KimiSession> =>
    (await client.get(`/api/v1/sessions/${encodeURIComponent(hostSessionId)}`)) as KimiSession;

  const getSnapshot = async (hostSessionId: string): Promise<KimiSnapshot> =>
    (await client.get(`/api/v1/sessions/${encodeURIComponent(hostSessionId)}/snapshot`)) as KimiSnapshot;

  const invoke = async (channel: string, args: readonly unknown[]): Promise<unknown> => {
    switch (channel) {
      case IPC.invoke.agentPrompt: {
        const req = args[0] as { sessionId: string; content: string; messageId?: string; idempotencyKey?: string };
        const hostSessionId = hostIdFor(args);
        const promptId = req.messageId ?? req.idempotencyKey ?? newRequestId();
        const model = pendingModel.get(hostSessionId);
        const body: Record<string, unknown> = {
          prompt_id: promptId,
          content: [{ type: "text", text: req.content }],
          ...(model ? { model } : {}),
        };
        try {
          const receipt = await client.post(`/api/v1/sessions/${encodeURIComponent(hostSessionId)}/prompts`, body);
          pendingModel.delete(hostSessionId);
          return { accepted: true, turnId: (receipt as { prompt_id?: string }).prompt_id ?? promptId };
        } catch (error) {
          if (error instanceof KimiBridgeError && error.errorCode === "HOST_DISCONNECTED") {
            // The response may have been lost after the service accepted the
            // prompt. The prompt_id is durable; a retry with the same id is
            // deduped, so report an honest unknown instead of resending.
            throw Object.assign(
              new Error("prompt outcome unknown after a connection drop; the request was not resent"),
              { errorCode: "HOST_DISCONNECTED", details: { promptId } },
            );
          }
          throw error;
        }
      }
      case IPC.invoke.agentGetStatus: {
        const session = await getSession(hostIdFor(args));
        const running = session.main_turn_active ?? session.busy ?? false;
        return {
          status: {
            sessionId: (args[0] as { sessionId?: string }).sessionId ?? session.id,
            isRunning: running,
            pendingToolConfirmations: session.pending_interaction === "approval" ? 1 : 0,
          },
        };
      }
      case IPC.invoke.agentStop:
      case IPC.invoke.agentAbort: {
        const hostSessionId = hostIdFor(args);
        const session = await getSession(hostSessionId);
        if (!(session.main_turn_active ?? session.busy)) {
          return channel === IPC.invoke.agentStop ? { requested: false } : { aborted: false };
        }
        await client.post(`/api/v1/sessions/${encodeURIComponent(hostSessionId)}:abort`, {});
        return channel === IPC.invoke.agentStop ? { requested: true } : { aborted: true };
      }
      case IPC.invoke.sessionGet: {
        const hostSessionId = hostIdFor(args);
        const remoteSessionId = (args[0] as { id?: string; sessionId?: string }).id
          ?? (args[0] as { sessionId?: string }).sessionId ?? "";
        const [session, snapshot] = await Promise.all([getSession(hostSessionId), getSnapshot(hostSessionId)]);
        const running = session.main_turn_active ?? session.busy ?? false;
        const messages = kimiSnapshotToUiMessages(snapshot.messages?.items ?? [], running);
        return {
          session: {
            id: remoteSessionId,
            source: "remote",
            remoteHostKey: options.hostKey,
            remoteAgent: "kimi",
            title: session.title ?? "",
            messageCount: messages.length,
            messages,
            mode: "agent",
            permissionMode: "ask",
            thinkingLevel: "off",
            ...(session.agent_config?.model ? { modelId: session.agent_config.model } : {}),
            updatedAt: session.updated_at ?? new Date().toISOString(),
            createdAt: session.updated_at ?? new Date().toISOString(),
            capabilities: { canPrompt: true, canStop: true, canRefresh: true, canConfigureModel: true },
          },
        };
      }
      case IPC.invoke.sessionConfigure: {
        const hostSessionId = hostIdFor(args);
        const config = (args[1] ?? {}) as { modelId?: string };
        if (!config.modelId) throw capabilityUnavailable("kimi sessions only support switching the model");
        const session = await getSession(hostSessionId);
        if (session.main_turn_active ?? session.busy) {
          throw capabilityUnavailable("stop or finish the current task before switching the model");
        }
        // Kimi carries the model on the next prompt; record it now.
        pendingModel.set(hostSessionId, config.modelId);
        return { session: { id: (args[0] as { sessionId?: string }).sessionId ?? hostSessionId, modelId: config.modelId } };
      }
      case IPC.invoke.sessionDelete: {
        await client.post(`/api/v1/sessions/${encodeURIComponent(hostIdFor(args))}:delete`, {});
        return { ok: true };
      }
      case IPC.invoke.toolResolvePermission: {
        const resolution = args[0] as { requestId: string; decision: string };
        const parsed = parseRemoteApprovalRequestId(resolution.requestId);
        if (!parsed) throw invalid("malformed remote approval request id");
        const hostSessionId = parseRemoteSessionId(parsed.remoteSessionId)?.hostSessionId;
        if (!hostSessionId) throw invalid("malformed remote session id");
        // Kimi grants per request only; there is no session-scoped grant, so
        // "allow-session" is refused rather than fabricated.
        if (resolution.decision === "allow-session") {
          throw capabilityUnavailable("kimi approvals are per-request; there is no session-wide allow");
        }
        const decision = resolution.decision === "deny" ? "rejected"
          : resolution.decision === "allow-once" ? "approved"
          : null;
        if (!decision) throw invalid(`unknown permission decision "${resolution.decision}"`);
        await client.post(
          `/api/v1/sessions/${encodeURIComponent(hostSessionId)}/approvals/${encodeURIComponent(parsed.hostApprovalId)}`,
          { decision },
        );
        return { ok: true };
      }
      case IPC.invoke.plansResolve:
        throw capabilityUnavailable("plan approval is not available on a Kimi session");
      default:
        throw capabilityUnavailable(`kimi backend does not handle ${channel}`);
    }
  };

  void log;
  return { handles: (channel: string) => HANDLED_CHANNELS.has(channel), invoke };
}
