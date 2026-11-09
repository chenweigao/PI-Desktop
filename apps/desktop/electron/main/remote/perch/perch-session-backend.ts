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
import { IPC, ErrorCodes, type RemotePermissionCapability, type RemotePermissionScope } from "@pi-desktop/shared";
import type { RemoteBackend } from "../backend-router.js";
import { parseRemoteSessionId, parseRemoteApprovalRequestId } from "../backend-router.js";
import type { PerchClient, PerchInteraction, PerchReceipt, PerchSessionSummary } from "./perch-client.js";
import { asReceipt, PerchBridgeError } from "./perch-client.js";
import { classifyPerchInteraction, perchSnapshotToUiMessages, type PerchMessage } from "./perch-event-bridge.js";

/** PI renderer history paging: virtual cursors mapped to Perch `turns/before/epoch`. */
type PerchHistoryCursor = { hostSessionId: string; before: number; epoch: string };

export type PerchBackendOptions = {
  hostKey: string;
  client: PerchClient;
  /** Session-scoped allow: tools remembered as allowed for this session. */
  sessionAllowedTools?: Map<string, Set<string>>;
  /** Model catalog lookup so a model switch names its provider correctly. */
  listModels?: () => Promise<Array<{ id: string; provider: string; agent: string }>>;
  newRequestId?: () => string;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

function capabilityUnavailable(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.CAPABILITY_UNAVAILABLE });
}
function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

const PERMISSION_SCOPES: ReadonlySet<string> = new Set(["next-message", "next-turn", "new-session", "runtime-managed"]);

/** The bridge's permission capability, defaulted defensively. Shared by the
 * session backend (detail/configure) and the host inventory (list rows). */
export function remotePermissionOf(summary: PerchSessionSummary): RemotePermissionCapability | undefined {
  const capability = summary.permission;
  if (!capability) return undefined;
  const scope = (PERMISSION_SCOPES.has(capability.scope ?? "") ? capability.scope : "new-session") as RemotePermissionScope;
  return {
    selected: capability.selected ?? null,
    options: Array.isArray(capability.options) ? capability.options.filter((o): o is string => typeof o === "string") : [],
    scope,
  };
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
  IPC.invoke.askToolResolve,
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
  // Process-wide virtual cursor space; avoids reusing a cursor across hosts.
  let nextHistoryCursor = 2 ** 48;
  const historyCursors = new Map<number, PerchHistoryCursor>();

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
  const submitPrompt = async (hostSessionId: string, text: string, idempotencyKey?: string): Promise<PerchReceipt> => {
    const requestId = idempotencyKey ?? newRequestId();
    try {
      return asReceipt(await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/prompt`, { requestId, text }));
    } catch (error) {
      if (error instanceof PerchBridgeError && error.errorCode === "HOST_DISCONNECTED") {
        // The response may have been lost after the bridge accepted the turn.
        try {
          const receipt = asReceipt(await client.get(
            `/sessions/${encodeURIComponent(hostSessionId)}/requests/${encodeURIComponent(requestId)}`,
          ));
          if (receipt.status !== "notFound") return receipt;
        } catch (lookupError) {
          // Tunnel still down: report an honest unknown outcome. The requestId
          // travels with the error so a later retry with the same idempotency
          // key stays idempotent instead of double-executing.
          log("warn", "perch prompt outcome unknown; receipt unreadable", { requestId, error: String(lookupError) });
          throw Object.assign(
            new Error("prompt outcome unknown after a connection drop; the request was not resent"),
            { errorCode: "HOST_DISCONNECTED", details: { requestId } },
          );
        }
      }
      throw error;
    }
  };

  const sessionAllowedTools = options.sessionAllowedTools ?? new Map<string, Set<string>>();

  const invoke = async (channel: string, args: readonly unknown[]): Promise<unknown> => {
    switch (channel) {
      case IPC.invoke.agentPrompt: {
        // The renderer's optimistic message id becomes the Perch requestId:
        // the bridge keys the persisted user message by that id, so the
        // snapshot's user row shares the optimistic row's id and updates it in
        // place — no duplicate bubble, and legitimate repeated prompts (a new
        // optimistic id each time) are never deduped away.
        const req = args[0] as { sessionId: string; content: string; idempotencyKey?: string; messageId?: string };
        const key = req.messageId ?? req.idempotencyKey;
        const receipt = await submitPrompt(hostIdFor(args), req.content, key);
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
        const input = (typeof args[0] === "object" ? args[0] : {}) as {
          id?: string; sessionId?: string; messageBefore?: number; messageLimit?: number;
        };
        const remoteSessionId = input.id ?? input.sessionId ?? "";
        // Paged read: Perch pages by user-prompt turns (`turns`, capped per
        // page) with `before`+`epoch` walking backwards; PI cursors are
        // virtual numbers mapped onto a Perch (before, epoch) pair. An epoch
        // mismatch makes the bridge answer 400 → surfaced as an expired
        // cursor, and the renderer reopens the conversation instead of
        // splicing two histories.
        const limit = Number.isFinite(input.messageLimit)
          ? Math.max(1, Math.min(100, Math.floor(input.messageLimit!))) : 50;
        const query: Record<string, string | number | undefined> = { turns: Math.max(1, Math.ceil(limit / 4)) };
        if (input.messageBefore !== undefined) {
          const cursor = historyCursors.get(input.messageBefore);
          if (!cursor || cursor.hostSessionId !== hostSessionId) {
            throw Object.assign(new Error("remote history cursor expired; reopen the conversation"), { errorCode: "INVALID_ARGUMENT" });
          }
          query.before = cursor.before;
          query.epoch = cursor.epoch;
        }
        let snap: PerchSessionSummary;
        try {
          snap = (await client.get(`/sessions/${encodeURIComponent(hostSessionId)}`, query)) as PerchSessionSummary;
        } catch (error) {
          if (error instanceof PerchBridgeError && /history changed/i.test(error.message)) {
            throw Object.assign(new Error("remote history changed; reopen the conversation"), { errorCode: "INVALID_ARGUMENT" });
          }
          throw error;
        }
        const busy = snap.busy === true;
        const messages = perchSnapshotToUiMessages((snap.messages ?? []) as PerchMessage[], busy);
        const history = snap.history;
        let messageStart = 0;
        const hasMoreBefore = history ? history.start > 0 : false;
        if (hasMoreBefore && history) {
          messageStart = nextHistoryCursor--;
          historyCursors.set(messageStart, { hostSessionId, before: history.start, epoch: history.epoch });
          while (historyCursors.size > 1024) historyCursors.delete(historyCursors.keys().next().value!);
        }
        return {
          session: {
            id: remoteSessionId,
            source: "remote",
            remoteHostKey: options.hostKey,
            title: snap.title,
            messageCount: messages.length,
            messages,
            mode: "agent",
            permissionMode: "ask",
            // The runtime's real permission capability (selected/options/
            // scope) — `permissionMode` above is only a PI-mode placeholder.
            ...(remotePermissionOf(snap) ? { remotePermission: remotePermissionOf(snap) } : {}),
            thinkingLevel: "off",
            // The real remote model, so the composer shows it instead of a
            // generic "模型" placeholder.
            ...(snap.model ? { modelId: snap.model } : {}),
            ...(snap.provider_id ? { providerId: snap.provider_id } : {}),
            ...(snap.provider ? { remoteAgent: snap.provider } : {}),
            updatedAt: new Date((snap.updated ?? 0) * 1000).toISOString(),
            createdAt: new Date((snap.updated ?? 0) * 1000).toISOString(),
            capabilities: { canPrompt: true, canStop: true, canRefresh: true, canConfigureModel: true },
            messageStart,
            messageEnd: messages.length,
            hasMoreBefore,
            hasMoreAfter: false,
          },
        };
      }
      case IPC.invoke.sessionDelete: {
        const hostSessionId = hostIdFor(args);
        await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/delete`, {});
        return { ok: true };
      }
      case IPC.invoke.sessionConfigure: {
        const hostSessionId = hostIdFor(args);
        const config = (args[1] ?? {}) as { modelId?: string; providerId?: string; permissionMode?: string };
        if (!config.modelId && !config.permissionMode) {
          throw capabilityUnavailable("perch sessions support switching the model or the permission mode");
        }
        const summary = await getSummary(hostSessionId);
        if (config.modelId && summary.busy) {
          throw capabilityUnavailable("stop or finish the current task before switching the model");
        }
        if (config.permissionMode !== undefined) {
          // The bridge is the validating authority; mirror its contract so an
          // unsupported scope fails with an honest reason instead of a silent
          // no-op (omp/codex fix the mode at creation, dsh manages it live).
          const capability = remotePermissionOf(summary);
          if (!capability || !capability.options.includes(config.permissionMode)) {
            throw capabilityUnavailable(`permission mode "${config.permissionMode}" is not offered by this runtime`);
          }
          if (capability.scope !== "next-turn") {
            throw capabilityUnavailable(capability.scope === "new-session"
              ? "this runtime fixes the permission mode at session creation"
              : "this runtime manages permissions itself");
          }
          await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/permission`, { mode: config.permissionMode });
        }
        if (!config.modelId) {
          // Permission-only change: report the refreshed capability.
          const refreshed = await getSummary(hostSessionId);
          return { session: {
            id: (args[0] as { sessionId?: string }).sessionId ?? hostSessionId,
            ...(refreshed.model ? { modelId: refreshed.model } : {}),
            ...(refreshed.provider_id ? { providerId: refreshed.provider_id } : {}),
            ...(remotePermissionOf(refreshed) ? { remotePermission: remotePermissionOf(refreshed) } : {}),
          } };
        }
        // Always resolve the model's identity from the live catalog — never
        // reuse the session's current provider, or a cross-provider pick would
        // be routed to the old one.
        const catalog = options.listModels ? await options.listModels() : [];
        const entry = catalog.find((m) => m.id === config.modelId
          && (!config.providerId || m.provider === config.providerId));
        if (!entry) {
          throw capabilityUnavailable(`model "${config.modelId}" is not in this host's catalog`);
        }
        // A model belongs to one runtime; a session runs on another. Switching
        // the model across runtimes would be a different agent, not a model
        // switch — refuse instead of misrouting the session.
        const sessionProvider = summary.provider ?? "omp";
        if (entry.agent && entry.agent !== sessionProvider) {
          throw capabilityUnavailable(
            `"${config.modelId}" belongs to the ${entry.agent} runtime; create a new ${entry.agent} session instead of switching this ${sessionProvider} session`,
          );
        }
        const provider = entry.provider;
        await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/model`, { provider, model: config.modelId });
        // Return the updated renderer summary so the composer reflects the switch.
        const updated = await getSummary(hostSessionId);
        return { session: {
          id: (args[0] as { sessionId?: string }).sessionId ?? hostSessionId,
          modelId: updated.model, providerId: updated.provider_id,
          ...(remotePermissionOf(updated) ? { remotePermission: remotePermissionOf(updated) } : {}),
        } };
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
        const interactions = (snap.interactions ?? []) as PerchInteraction[];
        const target = interactions.find((item) => item.id === parsed.hostApprovalId);
        if (!target) {
          // Stale / already-resolved id: fail closed rather than guess.
          throw Object.assign(new Error("approval is no longer open"), { errorCode: "NOT_FOUND" });
        }
        // A session-scoped allow remembers the tool: later requests for the
        // same tool on this session auto-approve, so the user is not asked
        // again (Qoder/OMP have no native per-session grant; the adapter owns
        // it). Qoder/Claude interactions name the tool in `name`; OMP carries
        // the "Allow tool: <name>" title.
        const rememberTool = resolution.decision === "allow-session"
          ? (target.name ?? (target as { title?: string }).title?.match(/^Allow tool:\s*([^\n]+)/)?.[1]?.trim())
          : undefined;
        const body: Record<string, unknown> = { id: parsed.hostApprovalId };
        // Qoder/Claude interactions carry no `method`: the bridge forwards
        // {id, allow} to the runtime as-is, exactly like Perch's own UI.
        if (!target.method || target.method === "confirm") {
          // confirm has one answer; allow-once and allow-session both approve
          // this request. allow-session additionally remembers the tool so
          // later identical requests auto-approve.
          body.allow = resolution.decision === "allow-once" || resolution.decision === "allow" || resolution.decision === "allow-session";
        } else if (target.method === "select") {
          // Map the user's explicit decision onto the OMP select options by
          // exact semantics. Three separate scopes must never blur:
          //  - deny           → the option that refuses (default Deny / Reject)
          //  - allow-session  → the option explicitly scoped to the session
          //  - allow-once     → a single-use option ONLY; when the runtime did
          //    not offer one, refuse instead of escalating the user's grant
          //    to a session-scoped approval.
          const options = (target as { options?: string[] }).options ?? [];
          const lower = options.map((o) => o.toLowerCase());
          const isSessionScoped = (i: number) => /session|会话/.test(lower[i]);
          const isDeny = (i: number) => /^(deny|reject|拒绝)$/.test(lower[i]) || /deny|reject|拒绝/.test(lower[i]);
          const isApprove = (i: number) => /approve|allow|允许|批准/.test(lower[i]);
          let value: string | undefined;
          if (resolution.decision === "deny") {
            value = options.find((_, i) => isDeny(i));
          } else if (resolution.decision === "allow-session") {
            value = options.find((_, i) => isApprove(i) && isSessionScoped(i));
          } else if (resolution.decision === "allow-once") {
            // Exact single-use verbs first ("Approve", "Allow"), never an
            // option whose label widens the grant to the session.
            value = options.find((_, i) => /^(approve|allow|允许|批准)$/.test(lower[i]))
              ?? options.find((_, i) => isApprove(i) && !isSessionScoped(i) && !isDeny(i));
          } else {
            throw invalid(`unknown permission decision "${resolution.decision}"`);
          }
          if (!value) {
            throw capabilityUnavailable(
              `the remote approval has no option matching "${resolution.decision}"; refusing to guess`,
            );
          }
          body.value = value;
        } else {
          // input/editor collect free-form content the three-button card
          // cannot supply; fail closed rather than fabricate a value.
          throw capabilityUnavailable(`approval method "${target.method}" is not supported by this UI`);
        }
        await client.post(`/sessions/${encodeURIComponent(hostSessionId)}/answer`, body);
        // Record the grant only after the bridge accepted the answer, so a
        // failed answer never leaves a phantom session grant behind.
        if (rememberTool) {
          const allowed = sessionAllowedTools.get(hostSessionId) ?? new Set<string>();
          allowed.add(rememberTool);
          sessionAllowedTools.set(hostSessionId, allowed);
        }
        return { ok: true };
      }
      case IPC.invoke.askToolResolve: {
        const resolution = args[0] as { requestId: string; answers: Array<string[] | null> };
        const parsed = parseRemoteApprovalRequestId(resolution.requestId);
        if (!parsed) throw invalid("malformed remote ask request id");
        const hostSessionId = parseRemoteSessionId(parsed.remoteSessionId)?.hostSessionId;
        if (!hostSessionId) throw invalid("malformed remote session id");
        const snap = await snapshot(hostSessionId);
        const interactions = (snap.interactions ?? []) as PerchInteraction[];
        const target = interactions.find((item) => item.id === parsed.hostApprovalId);
        if (!target) {
          throw Object.assign(new Error("question is no longer open"), { errorCode: "NOT_FOUND" });
        }
        if (classifyPerchInteraction(target) !== "ask") {
          throw invalid("that interaction is a tool approval, not a question");
        }
        const body: Record<string, unknown> = { id: parsed.hostApprovalId };
        const answers = resolution.answers ?? [];
        if (target.name === "AskUserQuestion") {
          // Claude/Qoder/Codex structured questions: the bridge forwards
          // {allow, answers: {question: label}} to the runtime as-is.
          const questions = (((target.input ?? {}) as { questions?: Array<{ question?: string }> }).questions ?? []);
          const answered: Record<string, string> = {};
          questions.forEach((question, index) => {
            const picked = answers[index];
            if (picked && picked.length && question.question) answered[question.question] = picked.join("\u3001");
          });
          if (!Object.keys(answered).length) body.cancelled = true;
          else if (Object.keys(answered).length < questions.length) {
            // Codex rejects a partial answer map outright ("请回答所有问
            // 题"); fail here with an honest reason instead of letting the
            // bridge's error surface as an opaque failure.
            throw invalid("this runtime requires every question answered; answer the rest or dismiss the card");
          }
          else { body.allow = true; body.answers = answered; }
        } else if (target.method === "select") {
          const picked = answers[0]?.[0];
          if (!picked) body.cancelled = true;
          else {
            if (!(target.options ?? []).includes(picked)) {
              throw invalid(`answer "${picked}" is not one of the offered options`);
            }
            body.value = picked;
          }
        } else {
          // input/editor: free-form text; empty means the user cancelled.
          const text = answers[0]?.[0]?.trim();
          if (!text) body.cancelled = true;
          else body.value = text;
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
