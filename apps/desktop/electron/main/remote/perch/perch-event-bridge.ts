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
import { IPC, type AgentEventEnvelope, type RemoteInteractionUpdate, type ToolPermissionRequest, type UiMessage } from "@pi-desktop/shared";
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
  lastMessages: Map<string, UiMessage>;
  liveInteractions: Set<string>;
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
 * Expand one Perch message into the renderer's UiMessage rows, preserving
 * part order. Text + thinking merge into one assistant/user row keyed by the
 * Perch message id; every tool_use is its own row keyed
 * `<messageId>#<tool_call_id>`, merged with the tool_result carrying the same
 * tool_call_id. A tool_use with no result is `running` only while the turn is
 * live; in settled history it is left without a status (completed row), never
 * a phantom spinner.
 */
export function perchMessageToUiMessages(message: PerchMessage, streaming: boolean): UiMessage[] {
  const parts = message.content ?? [];
  const createdAt = message.created_at ?? new Date().toISOString();
  const results = new Map<string, Extract<PerchPart, { type: "tool_result" }>>();
  for (const part of parts) {
    if (part.type === "tool_result" && part.tool_call_id) results.set(part.tool_call_id, part);
  }
  const rows: UiMessage[] = [];
  const text = parts.filter((p): p is Extract<PerchPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
  const thinking = parts.filter((p): p is Extract<PerchPart, { type: "thinking" }> => p.type === "thinking").map((p) => p.thinking).join("");
  if (hasTextRow(message.role, hasTextRowCheck(parts), parts)) {
    const row: UiMessage = {
      id: message.id,
      role: message.role === "user" ? "user" : message.role === "tool" ? "tool" : "assistant",
      content: text,
      createdAt,
      status: streaming ? "streaming" : "complete",
      ...(thinking ? { thinking } : {}),
    };
    rows.push(row);
  }
  let toolIndex = 0;
  for (const part of parts) {
    if (part.type !== "tool_use") continue;
    const callId = part.tool_call_id ?? `${message.id}:tool-${toolIndex++}`;
    const result = part.tool_call_id ? results.get(part.tool_call_id) : undefined;
    const row: UiMessage = {
      id: `${message.id}#${callId}`,
      role: "tool",
      content: result
        ? (typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2))
        : "",
      createdAt,
      toolCallId: callId,
      toolName: part.tool_name ?? "",
      toolArgs: part.input,
      status: result || !streaming ? "complete" : "streaming",
      ...(result
        ? { toolStatus: result.is_error ? "error" : "success", toolResult: result.output }
        : streaming
          ? { toolStatus: "running" as const }
          : {}),
    };
    rows.push(row);
  }
  // A tool_result whose call id has no tool_use in this message still renders.
  for (const part of parts) {
    if (part.type !== "tool_result") continue;
    const callId = part.tool_call_id ?? "";
    if (callId && parts.some((p) => p.type === "tool_use" && p.tool_call_id === callId)) continue;
    rows.push({
      id: `${message.id}#${callId || `result-${rows.length}`}`,
      role: "tool",
      content: typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2),
      createdAt,
      toolCallId: callId,
      toolResult: part.output,
      toolStatus: part.is_error ? "error" : "success",
      status: "complete",
    });
  }
  return rows;
}

function hasTextRowCheck(parts: PerchPart[]): boolean {
  return parts.some((p) => p.type === "text" || p.type === "thinking");
}
function hasTextRow(role: string, hasText: boolean, parts: PerchPart[]): boolean {
  if (role === "user") return true;
  if (hasText) return true;
  // An assistant message that is only tool calls gets no empty assistant row.
  return !parts.some((p) => p.type === "tool_use" || p.type === "tool_result");
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
      state = { busy: false, lastRevision: -1, lastMessages: new Map(), liveInteractions: new Set() };
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
      // A revision moving backwards means the bridge restarted: ids, epochs
      // and revisions all reset. Drop the diff state so stale streaming rows
      // and dead approval cards never survive into the new service.
      if (revision < state.lastRevision) {
        state.lastMessages = new Map();
        state.liveInteractions = new Set();
        state.busy = false;
      }
      state.lastRevision = revision;
      const turnId = snapshot.turnId ?? null;

      /* ---- approvals ---- */
      const now = Date.now() / 1000;
      const open = (snapshot.interactions ?? []).filter((item) => !item.expires || item.expires > now);
      const currentIds = new Set(open.map((item) => item.id));
      for (const id of state.liveInteractions) {
        if (!currentIds.has(id)) {
          const update: RemoteInteractionUpdate = {
            kind: "resolved", sessionId: remoteSessionId, requestKind: "permission",
            requestId: makeRemoteApprovalRequestId(remoteSessionId, id),
          };
          emit(IPC.event.remoteInteractions, update);
        }
      }
      state.liveInteractions = currentIds;
      const snapshotUpdate: RemoteInteractionUpdate = {
        kind: "snapshot", sessionId: remoteSessionId,
        permissions: open.map((item) => toPermissionRequest(remoteSessionId, item)),
        asks: [],
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
      for (const message of snapshot.messages ?? []) {
        for (const ui of perchMessageToUiMessages(message, busy)) {
          seen.set(ui.id, ui);
          const previous = state.lastMessages.get(ui.id);
          if (!previous) {
            emitAgent(remoteSessionId, { type: "message_start", message: ui }, turnId);
          } else if (JSON.stringify(previous) !== JSON.stringify(ui)) {
            emitAgent(remoteSessionId, { type: "message_update", message: ui }, turnId);
          }
        }
      }

      /* ---- settle: report the real outcome, never a blanket success ---- */
      if (settled) {
        for (const ui of seen.values()) {
          if (ui.status === "streaming") {
            emitAgent(remoteSessionId, { type: "message_end", message: { ...ui, status: "complete" } }, turnId);
          }
        }
        const turnState = snapshot.turnState;
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
