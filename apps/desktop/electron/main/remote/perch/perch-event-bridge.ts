/**
 * Perch event bridge: turn a Perch snapshot poll into the renderer's existing
 * interaction surface (`remoteInteractions` snapshot/resolved). The Perch
 * bridge is pull-based (no push stream), so a host-level poller feeds each
 * session snapshot here; this module is pure translation + dedup.
 *
 * What it does on each snapshot:
 * - pending `interactions[]` → a `kind:"snapshot"` `remoteInteractions`
 *   payload listing the live `permissions`, so the renderer replaces its card
 *   list wholesale (restart/shutdown clears the card, exactly like RACP).
 * - an interaction id that disappeared since the last snapshot → a
 *   `kind:"resolved"` payload, so the card closes on an answer or on the
 *   bridge's own expiry without waiting for the next full list.
 *
 * Approval requestIds are encoded with the existing
 * `remote:<hostKey>:<sid>#racp-approval:<interactionId>` delimiter so the
 * renderer's resolve call routes back to this session statelessly.
 */
import { IPC, type RemoteInteractionUpdate, type ToolPermissionRequest } from "@pi-desktop/shared";
import { makeRemoteApprovalRequestId, makeRemoteSessionId } from "../backend-router.js";
import type { PerchInteraction } from "./perch-client.js";

export type PerchEventBridgeOptions = {
  hostKey: string;
  emit: (channel: string, payload: unknown) => void;
  log?: (level: "warn", message: string, data?: unknown) => void;
};

export interface PerchEventBridge {
  /** Apply one freshly-polled snapshot for a session. */
  applySnapshot(hostSessionId: string, interactions: PerchInteraction[]): void;
  forgetSession(hostSessionId: string): void;
}

function toPermissionRequest(remoteSessionId: string, interaction: PerchInteraction): ToolPermissionRequest {
  return {
    requestId: makeRemoteApprovalRequestId(remoteSessionId, interaction.id),
    sessionId: remoteSessionId,
    toolCallId: "",
    toolName: interaction.name ?? interaction.title ?? "",
    argsPreview: interaction.input ?? null,
    risk: "medium",
    reason: interaction.message ?? interaction.title ?? "",
  };
}

export function createPerchEventBridge(options: PerchEventBridgeOptions): PerchEventBridge {
  const { hostKey, emit } = options;
  const log = options.log ?? (() => undefined);
  // Last-seen live interaction ids per host session, for resolved detection.
  const live = new Map<string, Set<string>>();

  const applySnapshot = (hostSessionId: string, interactions: PerchInteraction[]): void => {
    try {
      const remoteSessionId = makeRemoteSessionId(hostKey, hostSessionId);
      const now = Date.now() / 1000;
      const open = interactions.filter((item) => !item.expires || item.expires > now);
      const currentIds = new Set(open.map((item) => item.id));
      const previous = live.get(hostSessionId) ?? new Set<string>();
      // Anything that was open and is gone resolved (answered) or expired.
      for (const id of previous) {
        if (currentIds.has(id)) continue;
        const update: RemoteInteractionUpdate = {
          kind: "resolved", sessionId: remoteSessionId,
          requestKind: "permission", requestId: makeRemoteApprovalRequestId(remoteSessionId, id),
        };
        emit(IPC.event.remoteInteractions, update);
      }
      live.set(hostSessionId, currentIds);
      // Wholesale snapshot: the renderer replaces its list, which is what
      // clears a card whose approval died with a bridge restart.
      const snapshotUpdate: RemoteInteractionUpdate = {
        kind: "snapshot", sessionId: remoteSessionId,
        permissions: open.map((item) => toPermissionRequest(remoteSessionId, item)),
        asks: [],
      };
      emit(IPC.event.remoteInteractions, snapshotUpdate);
    } catch (error) {
      log("warn", "perch snapshot translation failed", error);
    }
  };

  return {
    applySnapshot,
    forgetSession(hostSessionId) { live.delete(hostSessionId); },
  };
}
