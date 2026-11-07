/**
 * Perch event bridge: turn Perch snapshot polls into the renderer's existing
 * surfaces — `remoteInteractions` for pending approvals and `agentMessage` for
 * the live transcript/turn state. The Perch bridge is pull-based, so a
 * host-level poller feeds each session snapshot here; this module is pure
 * translation + dedup, idempotent across identical snapshots.
 *
 * Approvals: each open interaction becomes a `ToolPermissionRequest` whose
 * requestId carries the stateless `#racp-approval:` encoding and whose
 * toolName/argsPreview are split out of the OMP "Allow tool: …\nCommand: …"
 * title so the card renders the structured command, not a blob. A snapshot
 * replaces the renderer's list wholesale (restart/expiry clears cards).
 *
 * Transcript: snapshot messages are diffed against the last emitted state and
 * forwarded as `agent_start` / `message_start` / `message_update` /
 * `message_end` / `agent_end` so the renderer's existing store builds the
 * transcript exactly as for a local session.
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
  lastMessages: Map<string, UiMessage>;
  liveInteractions: Set<string>;
  emittedStart: boolean;
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
    // The card renders argsPreview through the same tool presentation as the
    // transcript; a bash command reads as a shell block.
    argsPreview: command ? { command } : interaction.input ?? null,
    risk: "medium",
    reason: interaction.message ?? "",
  };
}

/** Translate one Perch message into a UiMessage the renderer can render. */
export function perchMessageToUi(message: PerchMessage, streaming: boolean): UiMessage {
  const parts = message.content ?? [];
  const text = parts.filter((p): p is Extract<PerchPart, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
  const thinking = parts.filter((p): p is Extract<PerchPart, { type: "thinking" }> => p.type === "thinking").map((p) => p.thinking).join("");
  const toolUse = parts.find((p): p is Extract<PerchPart, { type: "tool_use" }> => p.type === "tool_use");
  const toolResult = parts.find((p): p is Extract<PerchPart, { type: "tool_result" }> => p.type === "tool_result");
  const base: UiMessage = {
    id: message.id,
    role: message.role === "user" ? "user" : message.role === "tool" ? "tool" : "assistant",
    content: text,
    createdAt: message.created_at ?? new Date().toISOString(),
    status: streaming ? "streaming" : "complete",
  };
  if (thinking) base.thinking = thinking;
  if (toolUse) {
    base.role = "tool";
    base.toolCallId = toolUse.tool_call_id ?? message.id;
    base.toolName = toolUse.tool_name ?? "";
    base.toolArgs = toolUse.input;
    base.toolStatus = "running";
  }
  if (toolResult) {
    base.role = "tool";
    base.toolCallId = toolResult.tool_call_id ?? message.id;
    base.toolResult = toolResult.output;
    base.content = typeof toolResult.output === "string" ? toolResult.output : JSON.stringify(toolResult.output, null, 2);
    base.toolStatus = toolResult.is_error ? "error" : "success";
    base.status = "complete";
  }
  return base;
}

export function createPerchEventBridge(options: PerchEventBridgeOptions): PerchEventBridge {
  const { hostKey, emit } = options;
  const log = options.log ?? (() => undefined);
  const sessions = new Map<string, SessionState>();

  const stateFor = (hostSessionId: string): SessionState => {
    let state = sessions.get(hostSessionId);
    if (!state) {
      state = { busy: false, lastMessages: new Map(), liveInteractions: new Set(), emittedStart: false };
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

  const applySnapshot = (hostSessionId: string, snapshot: PerchSnapshot): void => {
    try {
      const state = stateFor(hostSessionId);
      const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);

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
        emitAgent(remoteSessionId, { type: "agent_start" });
        state.emittedStart = true;
      }
      const settled = state.busy && !busy;
      const turnState = snapshot.turnState;

      /* ---- transcript diff ---- */
      const messages = snapshot.messages ?? [];
      const seen = new Map<string, UiMessage>();
      for (const message of messages) {
        const ui = perchMessageToUi(message, busy);
        seen.set(message.id, ui);
        const previous = state.lastMessages.get(message.id);
        if (!previous) {
          emitAgent(remoteSessionId, { type: "message_start", message: ui });
        } else if (JSON.stringify(previous) !== JSON.stringify(ui)) {
          emitAgent(remoteSessionId, { type: "message_update", message: ui });
        }
      }

      /* ---- settle ---- */
      if (settled) {
        for (const ui of seen.values()) {
          if (ui.status === "streaming") {
            emitAgent(remoteSessionId, { type: "message_end", message: { ...ui, status: "complete" } });
          }
        }
        emitAgent(remoteSessionId, { type: "agent_end", messageIds: [...seen.keys()] });
        state.emittedStart = false;
      }
      state.lastMessages = seen;
      state.busy = busy;
      void turnState;
    } catch (error) {
      log("warn", "perch snapshot translation failed", error);
    }
  };

  return {
    applySnapshot,
    forgetSession(hostSessionId) { sessions.delete(hostSessionId); },
  };
}
