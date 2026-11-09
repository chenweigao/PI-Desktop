import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { GlobalPermissionMode, Mode, RemotePermissionCapability } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import { PERMISSION_MODE_I18N_KEYS } from "../../../lib/permission-mode-labels";

const SCOPE_I18N_KEYS: Record<RemotePermissionCapability["scope"], string> = {
  "next-message": "chat.remotePermissionScopeNextMessage",
  "next-turn": "chat.remotePermissionScopeNextTurn",
  "new-session": "chat.remotePermissionScopeNewSession",
  "runtime-managed": "chat.remotePermissionScopeRuntimeManaged",
};

/** A remote option id's label: agent-specific translation, generic, else the raw id. */
function remoteOptionLabel(t: TFunction, agent: string | undefined, id: string): string {
  if (agent) {
    const specific = t(`chat.remotePermissionOption.${agent}.${id}`, { defaultValue: "" });
    if (specific) return specific;
  }
  return t(`chat.remotePermissionOption.${id}`, { defaultValue: id });
}

/** Controlled permission UI shared by conversations and task drafts. */
export function ComposerPermissionPicker({t, mode, composerPermissionMode,
  permissionOpen, setPermissionOpen, controlsBlocked, onCloseOtherMenus, onSelect,
  remotePermission, remoteAgent,
}: {
  t: TFunction;
  mode: Mode;
  composerPermissionMode: GlobalPermissionMode;
  permissionOpen: boolean;
  setPermissionOpen: Dispatch<SetStateAction<boolean>>;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  onSelect: (mode: string) => void | Promise<void>;
  /**
   * A remote session's real permission capability (Perch/Kimi contract):
   * agent-native option ids and when a change takes effect. When present it
   * replaces the local ask/accept-edits/auto list entirely.
   */
  remotePermission?: RemotePermissionCapability | null;
  /** The remote runtime id (omp/kimi/qoder/…), for agent-specific labels. */
  remoteAgent?: string;
}) {
  const remote = remotePermission ?? null;
  // next-message/next-turn scopes are user-changeable; new-session is fixed at
  // creation and runtime-managed is decided per call — both render read-only.
  const remoteSelectable = !!remote && remote.options.length > 0
    && (remote.scope === "next-message" || remote.scope === "next-turn");
  const disabled = controlsBlocked || mode === "goal" || (remote !== null && !remoteSelectable);
  const selectedLabel = remote
    ? remoteOptionLabel(t, remoteAgent, remote.selected ?? "")
    : t(PERMISSION_MODE_I18N_KEYS[composerPermissionMode]);
  const scopeSuffix = remote ? ` · ${t(SCOPE_I18N_KEYS[remote.scope])}` : "";
  const baseTooltip = mode === "goal"
    ? `${t("chat.permissionMode")} · ${t("goal.autoWarning")}`
    : mode === "plan" && composerPermissionMode === "auto" && !remote
      ? `${t("chat.permissionMode")} · ${t("plan.autoWarning")}`
      : t("chat.permissionMode");
  const tooltip = baseTooltip + scopeSuffix;
  const options: string[] = remote ? remote.options : ["ask", "accept-edits", "auto"];
  const selected = remote ? remote.selected : composerPermissionMode;
  return (
        <AnchoredMenu
          className="composer-permission"
          open={permissionOpen && mode !== "goal" && disabled !== true}
          onClose={() => setPermissionOpen(false)}
          menuClassName="composer-permission-menu"
          label={t("chat.permissionMode")}
          role="menu"
          align="start"
          side="top"
          trigger={(ref) => (
            <TooltipButton
              ref={ref}
              type="button"
              className={`icon-btn mode-chip ${permissionOpen ? "active" : ""}`}
              tooltip={tooltip}
              ariaLabel={tooltip}
              aria-haspopup={mode === "goal" || disabled ? undefined : "menu"}
              aria-expanded={mode === "goal" || disabled ? false : permissionOpen}
              disabled={disabled}
              onClick={() => {
                onCloseOtherMenus();
                setPermissionOpen((open) => !open);
              }}
            >
              <span className="text-sm">
                {selectedLabel}
              </span>
              <IconChevronDown size={12} />
            </TooltipButton>
          )}
        >
          {options.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitemradio"
              aria-checked={selected === candidate}
              disabled={controlsBlocked}
              className={`composer-plus-item ${selected === candidate ? "active" : ""}`}
              onClick={async () => {
                setPermissionOpen(false);
                await onSelect(candidate);
              }}
            >
              <span className="flex-1 text-left">
                {remote ? remoteOptionLabel(t, remoteAgent, candidate) : t(PERMISSION_MODE_I18N_KEYS[candidate as GlobalPermissionMode])}
              </span>
              {selected === candidate ? <IconCheck size={13} /> : null}
            </button>
          ))}
        </AnchoredMenu>
  );
}
