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
import { IPC, type AgentEventEnvelope, type RemoteInteractionUpdate, type ToolPermissionRequest, type UiMessage } from "@pi-desktop/shared";
import { makeRemoteApprovalRequestId, makeRemoteSessionId } from "../backend-router.js";
import type { KimiApproval, KimiMessage, KimiPart, KimiSnapshot } from "./kimi-client.js";

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
        status: streaming ? "streaming" : "complete",
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
            status: streaming ? "streaming" : "complete",
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
      state = { busy: false, lastSeq: -1, lastEpoch: null, lastMessages: new Map(), liveApprovals: new Set() };
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
        asks: [],
      };
      emit(IPC.event.remoteInteractions, snapshotUpdate);

      /* ---- turn lifecycle ---- */
      const session = snapshot.session;
      const busy = session ? (session.main_turn_active ?? session.busy ?? false) : false;
      if (busy && !state.busy) {
        emitAgent(remoteSessionId, { type: "agent_start" });
      }
      const settled = state.busy && !busy;

      /* ---- transcript diff ---- */
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

      /* ---- settle: report the real outcome ---- */
      if (settled) {
        for (const ui of seen.values()) {
          if (ui.status === "streaming") {
            emitAgent(remoteSessionId, { type: "message_end", message: { ...ui, status: "complete" } });
          }
        }
        const reason = session?.last_turn_reason;
        if (reason === "failed") {
          emitAgent(remoteSessionId, { type: "error", error: { code: "TURN_FAILED", message: "remote turn failed" } });
        } else if (reason === "unknown" || reason === "interrupted") {
          emitAgent(remoteSessionId, { type: "error", error: { code: "TURN_UNKNOWN", message: "the turn's outcome is unknown" } });
        } else {
          emitAgent(remoteSessionId, { type: "agent_end", messageIds: [...seen.keys()] });
        }
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
