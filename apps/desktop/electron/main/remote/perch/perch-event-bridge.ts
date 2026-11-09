/**
 * Perch event bridge: turn Perch snapshot polls into the renderer's existing
 * surfaces — `remoteInteractions` for pending approvals and `agentMessage` for
 * the live transcript/turn state. The Perch bridge is pull-based, so a
 * host-level poller feeds each session snapshot here; this module is pure
 * translation + diff, idempotent across identical snapshots.
 *
 * Approvals: each open interaction becomes a `ToolPermissionRequest` whose
 * requestId carries the stateless `#racp-approval:` encoding and whose
 * toolName/argsPreview are split out of the OMP "Allow tool: …\nCommand: …"
 * title so the card renders the structured command, not a blob. A snapshot
 * replaces the renderer's list wholesale (restart/expiry clears cards).
 *
 * Transcript: every content block of a Perch message becomes its own stable
 * UiMessage (text/thinking stay an assistant row; each tool_use is a tool row
 * correlated with its tool_result by tool_call_id), so multi-tool turns lose
 * nothing and ordering is preserved.
 *
 * Turn lifecycle: `busy` rising emits `agent_start`; settling emits
 * `agent_end` for a completed turn, an `error` event (`TURN_FAILED`) for a
 * failed one, `TURN_ABORTED` for a user-stopped one, and `TURN_UNKNOWN` when
 * the bridge reports an unknown outcome (e.g. service interruption) — so the
 * renderer never records a failed turn as completed. All turn events carry
 * the remote's stable turnId when the snapshot has one.
 *
 * Restart honesty: a snapshot whose revision moved backwards means the bridge
 * restarted (its ids/epochs changed); the per-session diff state resets so no
 * stale streaming row survives.
 */
import { IPC, type AgentEventEnvelope, type AskToolRequest, type RemoteInteractionUpdate, type ToolPermissionRequest, type UiMessage } from "@pi-desktop/shared";
import { makeRemoteApprovalRequestId, makeRemoteSessionId } from "../backend-router.js";
import type { PerchInteraction } from "./perch-client.js";

export type PerchEventBridgeOptions = {
  hostKey: string;
  emit: (channel: string, payload: unknown) => void;
  log?: (level: "warn", message: string, data?: unknown) => void;
};

export interface PerchEventBridge {
  applySnapshot(hostSessionId: string, snapshot: PerchSnapshot): void;
  forgetSession(hostSessionId: string): void;
}

/** The snapshot slices this bridge reads (structural, from the Perch contract). */
export type PerchSnapshot = {
  revision?: number;
  busy?: boolean;
  turnId?: string | null;
  turnState?: string | null;
  error?: string | null;
  messages?: PerchMessage[];
  interactions?: PerchInteraction[];
};
export type PerchMessage = {
  id: string;
  role: string;
  created_at?: string;
  content?: PerchPart[];
};
export type PerchPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; tool_call_id?: string; tool_name?: string; input?: unknown }
  | { type: "tool_result"; tool_call_id?: string; output?: unknown; is_error?: boolean };

type SessionState = {
  busy: boolean;
  lastRevision: number;
  lastTurnId: string | null;
  lastMessages: Map<string, UiMessage>;
  /** Open interaction id → which card kind the renderer is showing for it. */
  liveInteractions: Map<string, "permission" | "ask">;
};

/** Split an OMP approval title "Allow tool: bash\nCommand: pwd && …" into parts. */
function splitOmpTitle(title: string | undefined): { toolName: string; command?: string } {
  if (!title) return { toolName: "" };
  const match = /^Allow tool:\s*([^\n]+)(?:\n([\s\S]*))?$/.exec(title.trim());
  if (!match) return { toolName: title };
  const toolName = match[1].trim();
  const rest = match[2]?.trim() ?? "";
  const command = /^Command:\s*([\s\S]*)$/.exec(rest)?.[1];
  return { toolName, ...(command ? { command } : {}) };
}

/**
 * Split open interactions into tool approvals and user questions, mirroring
 * Perch's own NativeInteractionView: a structured `AskUserQuestion`, an OMP
 * `input`/`editor` prompt, or a `select` without the "Allow tool:" approval
 * title are questions (ask cards); everything else is a tool approval.
 */
export function classifyPerchInteraction(interaction: PerchInteraction): "permission" | "ask" {
  if (interaction.name === "AskUserQuestion") return "ask";
  if (interaction.method === "input" || interaction.method === "editor") return "ask";
  if (interaction.method === "select" && !/^Allow tool:/.test((interaction.title ?? "").trim())) return "ask";
  return "permission";
}

function toAskRequest(remoteSessionId: string, interaction: PerchInteraction): AskToolRequest {
  const requestId = makeRemoteApprovalRequestId(remoteSessionId, interaction.id);
  if (interaction.name === "AskUserQuestion") {
    const input = (interaction.input ?? {}) as { questions?: Array<{ question?: string; options?: Array<string | { label?: string; description?: string }>; multi?: boolean; multiSelect?: boolean }> };
    return {
      requestId,
      sessionId: remoteSessionId,
      toolCallId: "",
      questions: (input.questions ?? []).map((question) => ({
        question: question.question ?? "",
        options: (question.options ?? []).map((option) =>
          typeof option === "string" ? { label: option } : { label: option.label ?? "", ...(option.description ? { description: option.description } : {}) }),
        ...(question.multi || question.multiSelect ? { multiSelect: true } : {}),
      })),
    };
  }
  const question = [interaction.title, interaction.message].filter((part) => part && part.trim()).join("\n");
  if (interaction.method === "select") {
    return {
      requestId,
      sessionId: remoteSessionId,
      toolCallId: "",
      questions: [{ question, options: (interaction.options ?? []).map((option) => ({ label: option })) }],
    };
  }
  // input/editor: free-form text; the ask card's custom option collects it.
  return { requestId, sessionId: remoteSessionId, toolCallId: "", questions: [{ question, options: [] }] };
}

function toPermissionRequest(remoteSessionId: string, interaction: PerchInteraction): ToolPermissionRequest {
  const { toolName, command } = splitOmpTitle(interaction.title ?? "");
  return {
    requestId: makeRemoteApprovalRequestId(remoteSessionId, interaction.id),
    sessionId: remoteSessionId,
    toolCallId: "",
    toolName: interaction.name ?? toolName,
    argsPreview: command ? { command } : interaction.input ?? null,
    risk: "medium",
    reason: interaction.message ?? "",
  };
}

/**
 * Expand one Perch message into conversation rows (text/thinking). Tool calls
 * are NOT handled here: Perch emits a tool_use and its tool_result as separate
 * messages, so correlation must happen across the whole snapshot — see
 * {@link perchSnapshotToUiMessages}. This single-message view keeps only the
 * conversation row and is used by backend history reads for non-tool content.
 */
export function perchMessageToUiMessages(message: PerchMessage, streaming: boolean): UiMessage[] {
  return perchSnapshotToUiMessages([message], streaming);
}

/**
 * Translate a whole snapshot's messages into renderer UiMessage rows.
 *
 * The native OMP contract delivers `tool_use` in an assistant message and the
 * matching `tool_result` in a later `tool` message — correlating within one
 * message silently drops results. Here tool rows are keyed by call identity
 * across the entire snapshot: the first tool_use creates the row (id
 * `<firstMessageId>#<callId>`, name + args preserved), and any later
 * tool_result with the same call id updates that same row (content, status,
 * readable output) instead of spawning a duplicate. Rows appear at the
 * position of their first observation so ordering matches the transcript.
 */
export function perchSnapshotToUiMessages(messages: PerchMessage[], streaming: boolean): UiMessage[] {
  const rows: UiMessage[] = [];
  const toolRowByCallId = new Map<string, UiMessage>();
  for (const message of messages) {
    const parts = message.content ?? [];
    const createdAt = message.created_at ?? new Date().toISOString();
    const text = parts.filter((p): p is Extract<PerchPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
    const thinking = parts.filter((p): p is Extract<PerchPart, { type: "thinking" }> => p.type === "thinking").map((p) => p.thinking).join("");
    const hasTools = parts.some((p) => p.type === "tool_use" || p.type === "tool_result");
    if (message.role === "user" || text || thinking || !hasTools) {
      rows.push({
        id: message.id,
        role: message.role === "user" ? "user" : message.role === "tool" ? "tool" : "assistant",
        content: text,
        createdAt,
        status: streaming ? "streaming" : "complete",
        ...(thinking ? { thinking } : {}),
      });
    }
    let fallbackIndex = 0;
    for (const part of parts) {
      if (part.type === "tool_use") {
        const callId = part.tool_call_id ?? `${message.id}:tool-${fallbackIndex++}`;
        let row = toolRowByCallId.get(callId);
        if (!row) {
          row = {
            id: `${message.id}#${callId}`,
            role: "tool",
            content: "",
            createdAt,
            toolCallId: callId,
            toolName: part.tool_name ?? "",
            toolArgs: part.input,
            status: streaming ? "streaming" : "complete",
            toolStatus: streaming ? "running" : undefined,
          };
          toolRowByCallId.set(callId, row);
          rows.push(row);
        } else {
          // A later mention of the same call (e.g. refreshed metadata) updates
          // the row in place; it never moves or duplicates.
          if (part.tool_name && !row.toolName) row.toolName = part.tool_name;
          if (part.input !== undefined && row.toolArgs === undefined) row.toolArgs = part.input;
        }
      } else if (part.type === "tool_result") {
        const callId = part.tool_call_id ?? "";
        let row = callId ? toolRowByCallId.get(callId) : undefined;
        if (!row) {
          // A result with no observed call still renders once, keyed stably.
          row = {
            id: `${message.id}#${callId || `result-${fallbackIndex++}`}`,
            role: "tool",
            content: "",
            createdAt,
            toolCallId: callId,
            toolName: "",
            status: "complete",
          };
          if (callId) toolRowByCallId.set(callId, row);
          rows.push(row);
        }
        row.content = typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2);
        row.toolResult = part.output;
        row.toolStatus = part.is_error ? "error" : "success";
        row.status = "complete";
      }
    }
  }
  return rows;
}

/** Back-compat single-row view used by older tests: the first expanded row. */
export function perchMessageToUi(message: PerchMessage, streaming: boolean): UiMessage {
  return perchMessageToUiMessages(message, streaming)[0];
}

export function createPerchEventBridge(options: PerchEventBridgeOptions): PerchEventBridge {
  const { hostKey, emit } = options;
  const log = options.log ?? (() => undefined);
  const sessions = new Map<string, SessionState>();

  const stateFor = (hostSessionId: string): SessionState => {
    let state = sessions.get(hostSessionId);
    if (!state) {
      state = { busy: false, lastRevision: -1, lastTurnId: null, lastMessages: new Map(), liveInteractions: new Map() };
      sessions.set(hostSessionId, state);
    }
    return state;
  };

  const emitAgent = (remoteSessionId: string, event: AgentEventEnvelope["event"], turnId?: string | null): void => {
    const envelope: AgentEventEnvelope = {
      sessionId: remoteSessionId,
      ...(turnId ? { turnId } : {}),
      ts: Date.now(),
      event,
    };
    emit(IPC.event.agentMessage, envelope);
  };

  const applySnapshot = (hostSessionId: string, snapshot: PerchSnapshot): void => {
    try {
      const state = stateFor(hostSessionId);
      const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
      const revision = snapshot.revision ?? state.lastRevision;
      // A revision moving backwards means the bridge restarted. The old turn
      // must be terminated FIRST (the renderer still shows it running), then
      // the diff baseline resets and every row is force-updated — the renderer
      // ignores message_start for an id it already has, so a recovered row is
      // pushed with message_update.
      let restarted = false;
      if (revision < state.lastRevision) {
        restarted = true;
        if (state.busy) {
          emitAgent(remoteSessionId, {
            type: "error",
            error: {
              code: "TURN_UNKNOWN",
              message: snapshot.error ?? "the bridge restarted while this turn was in flight; its outcome is unknown",
            },
          }, state.lastTurnId ?? null);
        }
        state.lastMessages = new Map();
        state.liveInteractions = new Map();
        state.busy = false;
      }
      state.lastRevision = revision;
      const turnId = snapshot.turnId ?? null;
      state.lastTurnId = turnId ?? state.lastTurnId;

      /* ---- approvals & questions ---- */
      const now = Date.now() / 1000;
      const open = (snapshot.interactions ?? []).filter((item) => !item.expires || item.expires > now);
      const current = new Map(open.map((item) => [item.id, classifyPerchInteraction(item)] as const));
      for (const [id, requestKind] of state.liveInteractions) {
        if (!current.has(id)) {
          const update: RemoteInteractionUpdate = {
            kind: "resolved", sessionId: remoteSessionId, requestKind,
            requestId: makeRemoteApprovalRequestId(remoteSessionId, id),
          };
          emit(IPC.event.remoteInteractions, update);
        }
      }
      state.liveInteractions = current;
      const snapshotUpdate: RemoteInteractionUpdate = {
        kind: "snapshot", sessionId: remoteSessionId,
        permissions: open.filter((item) => current.get(item.id) === "permission").map((item) => toPermissionRequest(remoteSessionId, item)),
        asks: open.filter((item) => current.get(item.id) === "ask").map((item) => toAskRequest(remoteSessionId, item)),
      };
      emit(IPC.event.remoteInteractions, snapshotUpdate);

      /* ---- turn lifecycle ---- */
      const busy = snapshot.busy === true;
      if (busy && !state.busy) {
        emitAgent(remoteSessionId, { type: "agent_start" }, turnId);
      }
      const settled = state.busy && !busy;

      /* ---- transcript diff (keyed by UiMessage id, order-preserving) ---- */
      const seen = new Map<string, UiMessage>();
      // createdAt is display-only and unstable when a message lacks one, so it
      // never decides whether a row changed.
      const comparable = (m: UiMessage) => {
        const { createdAt: _createdAt, ...rest } = m;
        return JSON.stringify(rest);
      };
      for (const ui of perchSnapshotToUiMessages(snapshot.messages ?? [], busy)) {
        seen.set(ui.id, ui);
        const previous = state.lastMessages.get(ui.id);
        if (!previous) {
          // After a restart the renderer may already hold a row with this id
          // from the dead epoch (e.g. a partial streaming text). message_start
          // is ignored for known ids, so force the recovered content through
          // message_update instead.
          emitAgent(remoteSessionId, restarted
            ? { type: "message_update", message: ui }
            : { type: "message_start", message: ui }, turnId);
        } else if (comparable(previous) !== comparable(ui)) {
          emitAgent(remoteSessionId, { type: "message_update", message: ui }, turnId);
        }
      }

      /* ---- settle: report the real outcome, never a blanket success ---- */
      if (settled) {
        for (const ui of seen.values()) {
          if (ui.status === "streaming") {
            emitAgent(remoteSessionId, { type: "message_end", message: { ...ui, status: "complete" } }, turnId);
          }
        }
        // Rows that vanished from the snapshot (a streaming partial that the
        // durable final replaced) must be ended too, or the renderer keeps a
        // stale streaming row next to the final one. On a completed turn the
        // vanished partial is merged into the turn's final assistant row.
        const turnState = snapshot.turnState;
        const finalAssistant = turnState === "completed" || !turnState
          ? [...seen.values()].filter((ui) => ui.role === "assistant" && ui.status === "complete").at(-1)
          : undefined;
        for (const [id, previous] of state.lastMessages) {
          if (!seen.has(id) && previous.status === "streaming") {
            if (finalAssistant) {
              emitAgent(remoteSessionId, { type: "message_end", message: finalAssistant, replacesMessageId: id }, turnId);
            } else {
              emitAgent(remoteSessionId, { type: "message_end", message: { ...previous, status: "complete" } }, turnId);
            }
          }
        }
        const errorText = snapshot.error ?? undefined;
        if (turnState === "unknown") {
          emitAgent(remoteSessionId, {
            type: "error",
            error: { code: "TURN_UNKNOWN", message: errorText ?? "the bridge lost track of this turn" },
          }, turnId);
        } else if (turnState === "failed" || (turnState !== "stopped" && turnState !== "completed" && errorText)) {
          emitAgent(remoteSessionId, {
            type: "error",
            error: { code: "TURN_FAILED", message: errorText ?? "remote turn failed" },
          }, turnId);
        } else if (turnState === "stopped" || snapshot.turnState === "cancelled") {
          emitAgent(remoteSessionId, {
            type: "error",
            error: { code: "TURN_ABORTED", message: errorText ?? "turn stopped" },
          }, turnId);
        } else {
          emitAgent(remoteSessionId, { type: "agent_end", messageIds: [...seen.keys()] }, turnId);
        }
      }
      state.lastMessages = seen;
      state.busy = busy;
    } catch (error) {
      log("warn", "perch snapshot translation failed", error);
    }
  };

  return {
    applySnapshot,
    forgetSession(hostSessionId) { sessions.delete(hostSessionId); },
  };
}
