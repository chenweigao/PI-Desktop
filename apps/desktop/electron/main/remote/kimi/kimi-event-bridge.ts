/**
 * Kimi event bridge: turn Kimi snapshot polls into the renderer's existing
 * surfaces — `remoteInteractions` for pending approvals and `agentMessage` for
 * the live transcript/turn state. The Kimi service is poll-driven here (no WS);
 * a host-level poller feeds each session snapshot and this module is pure
 * translation + diff, idempotent across identical snapshots.
 *
 * Approvals: Kimi's `pending_approvals[]` become `ToolPermissionRequest` cards
 * (`approval_id` carried in the stateless requestId). A snapshot replaces the
 * renderer's list wholesale (a resolved/expired approval clears its card).
 *
 * Transcript: Kimi messages expand into UiMessage rows (text/thinking stay an
 * assistant row; each tool_call is a tool row correlated with its tool_result
 * by tool_call_id). Turn lifecycle maps to agent_start / agent_end, with
 * failures reported as error events, never a blanket completion.
 */
import { IPC, type AgentEventEnvelope, type AskToolRequest, type RemoteInteractionUpdate, type ToolPermissionRequest, type UiMessage } from "@pi-desktop/shared";
import { makeRemoteApprovalRequestId, makeRemoteSessionId } from "../backend-router.js";
import type { KimiApproval, KimiMessage, KimiPart, KimiQuestion, KimiSnapshot } from "./kimi-client.js";

export type KimiEventBridgeOptions = {
  hostKey: string;
  emit: (channel: string, payload: unknown) => void;
  log?: (level: "warn", message: string, data?: unknown) => void;
};

export interface KimiEventBridge {
  applySnapshot(hostSessionId: string, snapshot: KimiSnapshot): void;
  forgetSession(hostSessionId: string): void;
}

type SessionState = {
  busy: boolean;
  lastSeq: number;
  lastEpoch: string | null;
  lastMessages: Map<string, UiMessage>;
  liveApprovals: Set<string>;
  /** The prompt whose streaming row is live; ties the merge to this turn. */
  livePromptId: string | null;
  /** The snapshot seq whose terminal outcome we already reported, so a turn we
   * never saw busy still reports once and a repeated reason is not replayed. */
  reportedOutcomeSeq: number;
};

function toPermissionRequest(remoteSessionId: string, approval: KimiApproval): ToolPermissionRequest {
  const input = approval.tool_input_display;
  return {
    requestId: makeRemoteApprovalRequestId(remoteSessionId, approval.approval_id),
    sessionId: remoteSessionId,
    toolCallId: "",
    toolName: approval.tool_name ?? approval.action ?? "",
    argsPreview: input ?? null,
    risk: "medium",
    reason: approval.action ?? "",
  };
}

function toAskRequest(remoteSessionId: string, question: KimiQuestion): AskToolRequest {
  return {
    requestId: makeRemoteApprovalRequestId(remoteSessionId, question.question_id),
    sessionId: remoteSessionId,
    toolCallId: "",
    questions: (question.questions ?? []).map((item) => ({
      question: item.question,
      options: (item.options ?? []).map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
      ...(item.multi_select ? { multiSelect: true } : {}),
    })),
  };
}

/** Expand Kimi messages into renderer UiMessage rows, correlating tools by call id. */
export function kimiSnapshotToUiMessages(messages: KimiMessage[], streaming: boolean): UiMessage[] {
  const rows: UiMessage[] = [];
  const toolRowByCallId = new Map<string, UiMessage>();
  for (const message of messages) {
    // Compaction summaries are user-role rows injected by the runtime; they are
    // not user prompts and must not render as one.
    const isCompaction = message.metadata?.origin?.kind === "compaction_summary";
    const parts = message.content ?? [];
    const createdAt = message.created_at ?? new Date().toISOString();
    const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
    const thinking = parts.filter((p) => p.type === "thinking").map((p) => p.thinking ?? "").join("");
    const hasTools = parts.some((p) => p.type === "tool_call" || p.type === "tool_result");
    if (!isCompaction && (message.role === "user" || text || thinking || !hasTools)) {
      rows.push({
        id: message.id,
        role: message.role === "user" ? "user" : message.role === "tool" ? "tool" : "assistant",
        content: text,
        createdAt,
        // Durable history rows are never "streaming": a live turn's partial
        // text lives on the separate in-flight row, so these stay complete and
        // the settle pass never resurrects an old final as streaming.
        status: "complete",
        ...(thinking ? { thinking } : {}),
      });
    }
    let fallbackIndex = 0;
    for (const part of parts) {
      if (part.type === "tool_call") {
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
            status: "complete",
            toolStatus: streaming ? "running" : undefined,
          };
          toolRowByCallId.set(callId, row);
          rows.push(row);
        }
      } else if (part.type === "tool_result") {
        const callId = part.tool_call_id ?? "";
        let row = callId ? toolRowByCallId.get(callId) : undefined;
        if (!row) {
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

export function createKimiEventBridge(options: KimiEventBridgeOptions): KimiEventBridge {
  const { hostKey, emit } = options;
  const log = options.log ?? (() => undefined);
  const sessions = new Map<string, SessionState>();

  const stateFor = (hostSessionId: string): SessionState => {
    let state = sessions.get(hostSessionId);
    if (!state) {
      state = { busy: false, lastSeq: -1, lastEpoch: null, lastMessages: new Map(), liveApprovals: new Set(), livePromptId: null, reportedOutcomeSeq: -1 };
      sessions.set(hostSessionId, state);
    }
    return state;
  };

  const emitAgent = (remoteSessionId: string, event: AgentEventEnvelope["event"], turnId?: string): void => {
    const envelope: AgentEventEnvelope = {
      sessionId: remoteSessionId,
      ...(turnId ? { turnId } : {}),
      ts: Date.now(),
      event,
    };
    emit(IPC.event.agentMessage, envelope);
  };

  const applySnapshot = (hostSessionId: string, snapshot: KimiSnapshot): void => {
    try {
      const state = stateFor(hostSessionId);
      const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
      const epoch = snapshot.epoch ?? state.lastEpoch;
      const seq = snapshot.as_of_seq ?? state.lastSeq;
      // First-ever snapshot for this session: establishes the baseline only.
      const isBaseline = state.lastSeq === -1 && state.reportedOutcomeSeq === -1;
      let restarted = false;
      if ((epoch !== state.lastEpoch && state.lastEpoch !== null) || seq < state.lastSeq) {
        restartedReset(state, remoteSessionId, emitAgent);
        restarted = true;
      }
      state.lastEpoch = epoch ?? state.lastEpoch;
      state.lastSeq = seq;

      /* ---- approvals ---- */
      const open = snapshot.pending_approvals ?? [];
      const currentIds = new Set(open.map((item) => item.approval_id));
      for (const id of state.liveApprovals) {
        if (!currentIds.has(id)) {
          const update: RemoteInteractionUpdate = {
            kind: "resolved", sessionId: remoteSessionId, requestKind: "permission",
            requestId: makeRemoteApprovalRequestId(remoteSessionId, id),
          };
          emit(IPC.event.remoteInteractions, update);
        }
      }
      state.liveApprovals = currentIds;
      const snapshotUpdate: RemoteInteractionUpdate = {
        kind: "snapshot", sessionId: remoteSessionId,
        permissions: open.map((item) => toPermissionRequest(remoteSessionId, item)),
        asks: (snapshot.pending_questions ?? []).map((item) => toAskRequest(remoteSessionId, item)),
      };
      emit(IPC.event.remoteInteractions, snapshotUpdate);

      /* ---- turn lifecycle ---- */
      const session = snapshot.session;
      const busy = session ? (session.main_turn_active ?? session.busy ?? false) : false;
      if (busy && !state.busy) {
        emitAgent(remoteSessionId, { type: "agent_start" });
      }
      const settled = state.busy && !busy;

      /* ---- transcript diff (including the in-flight streaming tail) ---- */
      const seen = new Map<string, UiMessage>();
      for (const ui of kimiSnapshotToUiMessages(snapshot.messages?.items ?? [], busy)) {
        seen.set(ui.id, ui);
        const previous = state.lastMessages.get(ui.id);
        if (!previous) {
          emitAgent(remoteSessionId, restarted
            ? { type: "message_update", message: ui }
            : { type: "message_start", message: ui });
        } else if (JSON.stringify({ ...previous, createdAt: "" }) !== JSON.stringify({ ...ui, createdAt: "" })) {
          emitAgent(remoteSessionId, { type: "message_update", message: ui });
        }
      }
      // The in-flight turn's streaming text is not yet a durable message; show
      // it as a live assistant row keyed by the turn id so the next turn never
      // collides with this one, and the settle step ends it explicitly.
      const inFlight = snapshot.in_flight_turn;
      const liveRowId = inFlight?.turn_id !== undefined ? `in-flight:${hostSessionId}:${inFlight.turn_id}` : null;
      if (busy && inFlight?.current_prompt_id) state.livePromptId = inFlight.current_prompt_id;
      if (busy && inFlight && (inFlight.assistant_text || inFlight.thinking_text) && liveRowId) {
        const liveRow: UiMessage = {
          id: liveRowId,
          role: "assistant",
          content: inFlight.assistant_text ?? "",
          ...(inFlight.thinking_text ? { thinking: inFlight.thinking_text } : {}),
          createdAt: new Date().toISOString(),
          status: "streaming",
        };
        seen.set(liveRow.id, liveRow);
        const previous = state.lastMessages.get(liveRow.id);
        if (!previous) {
          emitAgent(remoteSessionId, { type: "message_start", message: liveRow });
        } else if (previous.content !== liveRow.content || previous.thinking !== liveRow.thinking) {
          emitAgent(remoteSessionId, { type: "message_update", message: liveRow });
        }
      }

      /* ---- settle: report the real outcome, exactly once per turn ----
       * busy→idle is a real settle. A short turn that ran between polls was
       * never observed busy: its durable last_turn_reason plus a strictly newer
       * snapshot seq reports it once. A cold attach that is ALREADY busy never
       * reports a previous turn's outcome as this turn's end. */
      const reason = session?.last_turn_reason;
      const terminalReason = reason && ["completed", "failed", "aborted", "cancelled", "stopped", "unknown", "interrupted"].includes(reason) ? reason : null;
      // The first snapshot only establishes the baseline: a terminal reason
      // from a turn this client never saw must not fire an outcome.
      const shouldReport = !busy && !isBaseline && terminalReason !== null && seq > state.reportedOutcomeSeq;
      if (settled || shouldReport) {
        for (const ui of seen.values()) {
          if (ui.status === "streaming") {
            emitAgent(remoteSessionId, { type: "message_end", message: { ...ui, status: "complete" } });
          }
        }
        // A live row from a COMPLETED turn merges into that turn's own final
        // assistant message — the row that follows this turn's prompt, not the
        // last assistant row in history (which could be an older turn's). A
        // cancelled/failed turn has no durable final: the partial is kept.
        const completed = reason === "completed" || (settled && !reason);
        const seenRows = [...seen.values()];
        const promptIndex = state.livePromptId
          ? seenRows.findIndex((ui) => ui.role === "user" && ui.id === state.livePromptId)
          : -1;
        const finalAssistant = completed
          ? (promptIndex >= 0
              ? seenRows.slice(promptIndex + 1).find((ui) => ui.role === "assistant" && ui.status === "complete")
              : seenRows.filter((ui) => ui.role === "assistant" && ui.status === "complete").at(-1))
          : undefined;
        for (const [id, stale] of state.lastMessages) {
          if (!id.startsWith(`in-flight:${hostSessionId}:`)) continue;
          if (finalAssistant) {
            emitAgent(remoteSessionId, { type: "message_end", message: finalAssistant, replacesMessageId: id });
          } else {
            emitAgent(remoteSessionId, { type: "message_end", message: { ...stale, status: "complete" } });
          }
        }
        if (reason === "failed") {
          emitAgent(remoteSessionId, { type: "error", error: { code: "TURN_FAILED", message: "remote turn failed" } });
        } else if (reason === "aborted" || reason === "cancelled" || reason === "stopped") {
          emitAgent(remoteSessionId, { type: "error", error: { code: "TURN_ABORTED", message: "turn stopped" } });
        } else if (reason === "unknown" || reason === "interrupted") {
          emitAgent(remoteSessionId, { type: "error", error: { code: "TURN_UNKNOWN", message: "the turn's outcome is unknown" } });
        } else if (settled || shouldReport) {
          emitAgent(remoteSessionId, { type: "agent_end", messageIds: [...seen.keys()] });
        }
        if (terminalReason) state.reportedOutcomeSeq = seq;
        state.livePromptId = null;
      }
      state.lastMessages = seen;
      state.busy = busy;
    } catch (error) {
      log("warn", "kimi snapshot translation failed", error);
    }
  };

  function restartedReset(state: SessionState, remoteSessionId: string, emitAgentFn: typeof emitAgent): void {
    if (state.busy) {
      emitAgentFn(remoteSessionId, {
        type: "error",
        error: { code: "TURN_UNKNOWN", message: "the Kimi service restarted while this turn was in flight; its outcome is unknown" },
      });
    }
    state.lastMessages = new Map();
    state.liveApprovals = new Set();
    state.busy = false;
  }

  return {
    applySnapshot,
    forgetSession(hostSessionId) { sessions.delete(hostSessionId); },
  };
}
