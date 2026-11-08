import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import type { SidebarRemoteGroup } from "../../lib/sidebar-project-model";
import { normalizeProjectPath } from "../../lib/sidebar-session-groups";
import {
  getVisibleProjectSessions,
  updateProjectSessionExpansion,
} from "../../lib/sidebar-project-sessions";
import {
  projectRunSummaryIsLive,
  resolveSidebarRunningAffordances,
  summarizeProjectRuns,
} from "../../lib/sidebar-project-runs";
import { useAppStore } from "../../stores/app-store";
import { ProjectRunBadge, ProjectRunCount, ProjectRunRail } from "../ProjectRunIndicator";
import { IconChevronDown, IconFolder, IconNewSession } from "../icons";
import { TooltipButton } from "../ui";

/**
 * Collapse state lives in the shared project-collapse map, namespaced off
 * local paths. The map normalizes keys on write, so the read key goes through
 * the same normalization (a Windows-style remote id keeps one identity).
 */
export function remoteGroupCollapseKey(projectKey: string): string {
  const raw = `remote:${projectKey}`;
  return normalizeProjectPath(raw) ?? raw;
}

function remoteGroupDomId(key: string): string {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `sidebar-remote-project-${(hash >>> 0).toString(36)}`;
}

/**
 * The same project/chat hierarchy as the local groups, keyed by (host,
 * project id) rather than local paths: chevron + name + host chip + parent
 * path qualifier, persisted collapse, folded history, and the group's own
 * new-conversation entry.
 */
export function RemoteProjectGroups({ groups, renderSessions }: {
  groups: SidebarRemoteGroup[];
  renderSessions: (sessions: SessionSummary[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const settings = useAppStore((state) => state.settings);
  // Remote groups carry the same running affordances as local projects, so a
  // collapsed host group does not hide live work either.
  const runAffordances = resolveSidebarRunningAffordances(settings);
  const runningSessions = useAppStore((state) => state.runningSessions);
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  const projectCollapsed = useAppStore((state) => state.projectCollapsed);
  const setProjectCollapsed = useAppStore((state) => state.setProjectCollapsed);
  const createSession = async (project: SidebarRemoteGroup["project"]) => {
    if (busy || !project.connected) return;
    setBusy(project.key);
    try {
      await useAppStore.getState().newSession({ remoteProject: project });
    } catch (error) {
      useAppStore.getState().showToast(
        error instanceof Error ? error.message : String(error),
        { variant: "error" },
      );
    } finally {
      setBusy(null);
    }
  };
  return <>{groups.map(({ project, sessions }) => {
    const collapsed = projectCollapsed[remoteGroupCollapseKey(project.key)] === true;
    const groupId = remoteGroupDomId(project.key);
    const runSummary = summarizeProjectRuns(sessions, runningSessions, pendingPermissions);
    const runIsLive = projectRunSummaryIsLive(runSummary);
    const showRunBadge = runAffordances.badge && runIsLive;
    const showRunRail = runAffordances.rail && runIsLive;
    // Same exclusivity rule as the local sidebar: one set of numbers, owned by
    // the badge while it is on and by the rail when it is off.
    const showRunCount = runAffordances.railCount && runIsLive;
    const { visibleSessions, hiddenCount } = getVisibleProjectSessions(
      sessions,
      expanded[project.key] ?? false,
    );
    const fullPath = project.projectId;
    const groupTitle = `${project.name} · ${project.hostLabel} · ${fullPath}`;
    return <section
      className={`sidebar-session-group project-group remote-project-group ${runIsLive ? "has-running-sessions" : ""} ${showRunRail ? "has-run-rail" : ""} ${collapsed ? "is-collapsed" : ""}`}
      key={project.key}
      aria-labelledby={groupId}
      data-sidebar-remote-project={project.key}
    >
      {showRunRail ? <ProjectRunRail summary={runSummary} /> : null}
      <div className="sidebar-session-group-header">
        <TooltipButton
          type="button"
          id={groupId}
          className="sidebar-session-group-title"
          tooltip={`${project.hostLabel} · ${fullPath}`}
          tooltipDelayMs={500}
          tooltipClassName="ui-tooltip-path"
          ariaLabel={t("remote:identity", { host: project.hostLabel, workspace: project.name })}
          aria-expanded={!collapsed}
          aria-controls={`${groupId}-sessions`}
          data-action="toggle-remote-project-collapse"
          onClick={() => setProjectCollapsed(remoteGroupCollapseKey(project.key), !collapsed)}
        >
          <IconChevronDown
            size={13}
            className={`sidebar-disclosure-icon ${collapsed ? "collapsed" : ""}`}
          />
          <IconFolder size={13} aria-hidden />
          <span className="sidebar-session-group-name">{project.name}</span>
          <span className="thread-item-source" title={project.hostLabel}>
            {project.hostLabel}
          </span>
          {project.showQualifier ? (
            <span className="sidebar-session-group-qualifier" title={fullPath}>
              {project.qualifier}
            </span>
          ) : null}
          {showRunBadge ? <ProjectRunBadge summary={runSummary} /> : null}
          {showRunCount ? <ProjectRunCount summary={runSummary} /> : null}
        </TooltipButton>
        <TooltipButton
          type="button"
          className="sidebar-session-group-add"
          tooltip={project.connected
            ? t("nav.newTask")
            : t("remote:offlineHost", { label: project.hostLabel })}
          ariaLabel={`${t("nav.newTask")}: ${groupTitle}`}
          disabled={busy !== null || !project.connected}
          onClick={() => void createSession(project)}
        >
          <IconNewSession size={13} />
        </TooltipButton>
      </div>
      <div
        id={`${groupId}-sessions`}
        className={`sidebar-session-group-body project ${collapsed ? "collapsed" : ""}`}
        role="region"
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
      >
        <div className="sidebar-session-group-clip">
          <div className="sidebar-session-group-list">
            {renderSessions(visibleSessions)}
            {hiddenCount > 0 ? (
              <button
                key="load-more"
                type="button"
                className="sidebar-load-more"
                onClick={() =>
                  setExpanded((previous) =>
                    updateProjectSessionExpansion(previous, project.key, true),
                  )
                }
              >
                {t("nav.loadMoreCount", { count: hiddenCount })}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>;
  })}</>;
}
