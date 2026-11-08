import type { SessionSummary } from "@pi-desktop/shared";
import { isRemoteSession } from "./remote-session-safety.ts";
import { remoteProjectKey, type RemoteProjectEntry } from "./remote-project-catalog.ts";
import { normalizeProjectPath } from "./sidebar-session-groups.ts";

/**
 * Sidebar project model — how sessions become the grouped or flat list.
 *
 * Grouping identity rules (the Perch lessons):
 * - Remote sessions group by (remoteHostKey, remoteProjectId) verbatim — the
 *   full remote cwd for path-like ids — never by basename, so same-named
 *   folders on different paths or hosts never share a group.
 * - A remote session never joins a local path group, even if a stale summary
 *   still carries a `projectPath`; one remote project yields exactly one
 *   sidebar entry.
 * - Display names are derived from the full path: a generic container
 *   basename (`code`, `tmp`, a home directory) folds its parent in, and
 *   names that collide across the visible list surface their parent path.
 */

/** Segments that describe a container, not the project inside it. */
const GENERIC_PROJECT_SEGMENTS = new Set([
  "app",
  "apps",
  "code",
  "data",
  "dev",
  "develop",
  "home",
  "mnt",
  "opt",
  "project",
  "projects",
  "repo",
  "repos",
  "root",
  "src",
  "srv",
  "temp",
  "tmp",
  "user",
  "users",
  "var",
  "work",
  "workspace",
  "workspaces",
]);

export function splitProjectPath(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

/** `/home/<user>`, `/Users/<user>`, `/root`, `C:/Users/<user>` — the user root is not a project name. */
export function isHomeLikeProjectPath(segments: readonly string[]): boolean {
  if (segments.length === 0) return true;
  const head = segments[0]!.toLowerCase();
  if (segments.length <= 2 && (head === "home" || head === "users" || head === "root")) {
    return true;
  }
  return (
    segments.length <= 3 &&
    /^[A-Za-z]:$/.test(segments[0]!) &&
    segments[1]?.toLowerCase() === "users"
  );
}

export type ProjectDisplayParts = {
  /** The row's primary label. */
  name: string;
  /** Parent path, shown when the name alone does not identify the project. */
  qualifier: string;
};

/**
 * Display parts for a remote project id (a full cwd for Perch-style hosts,
 * an opaque id for older RACP hosts). The basename alone is never trusted:
 * generic containers fold their parent segment in (`code` → `weigao.cwg/code`),
 * and home-like roots keep the whole path because the user name is the least
 * useful segment.
 */
export function remoteProjectDisplayParts(
  projectId: string,
  label?: string | null,
): ProjectDisplayParts {
  const source = (projectId ?? "").trim();
  const fallback = (label ?? "").trim() || source;
  if (!source) return { name: fallback, qualifier: "" };
  const rooted = source.startsWith("/");
  const segments = splitProjectPath(source);
  if (segments.length === 0) return { name: fallback || source, qualifier: "" };
  const qualifierFor = (keepTail: number) => {
    const rest = segments.slice(0, Math.max(0, segments.length - keepTail));
    return rest.length ? `${rooted ? "/" : ""}${rest.join("/")}` : "";
  };
  if (isHomeLikeProjectPath(segments)) {
    return { name: source.replace(/\\/g, "/").replace(/\/+$/, "") || "/", qualifier: "" };
  }
  const base = segments[segments.length - 1]!;
  if (GENERIC_PROJECT_SEGMENTS.has(base.toLowerCase())) {
    if (segments.length > 2) {
      return {
        name: `${segments[segments.length - 2]}/${base}`,
        qualifier: qualifierFor(2),
      };
    }
    // `/tmp`, `/code`: the path itself is the only honest identity.
    return { name: `${rooted ? "/" : ""}${segments.join("/")}`, qualifier: "" };
  }
  return { name: base, qualifier: qualifierFor(1) };
}

export type SidebarRemoteGroup = {
  project: RemoteProjectEntry & ProjectDisplayParts & { showQualifier: boolean };
  sessions: SessionSummary[];
};

function remoteGroupTimestamp(group: { sessions: SessionSummary[] }): number {
  let latest = 0;
  for (const session of group.sessions) {
    const value = Date.parse(session.updatedAt ?? "");
    if (Number.isFinite(value) && value > latest) latest = value;
  }
  return latest;
}

/**
 * Build the sidebar's remote project groups. Keys stay on
 * `remoteProjectKey(hostKey, projectId)`; this layer only fixes what the
 * groups look like — meaningful names, host identity, and collision markers.
 *
 * `siblingNames` carries the lowercased names of neighbouring groups (local
 * projects) so a remote group that would be mistaken for a local one also
 * shows its qualifier.
 */
export function buildSidebarRemoteGroups(
  sessions: SessionSummary[],
  compare: (left: SessionSummary, right: SessionSummary) => number,
  siblingNames: readonly string[] = [],
): SidebarRemoteGroup[] {
  const byKey = new Map<string, SidebarRemoteGroup>();
  for (const session of sessions) {
    if (!isRemoteSession(session) || !session.remoteHostKey || !session.remoteProjectId) {
      continue;
    }
    const key = remoteProjectKey(session.remoteHostKey, session.remoteProjectId);
    let group = byKey.get(key);
    if (!group) {
      const parts = remoteProjectDisplayParts(
        session.remoteProjectId,
        session.remoteWorkspaceLabel,
      );
      group = {
        project: {
          key,
          hostKey: session.remoteHostKey,
          projectId: session.remoteProjectId,
          label: session.remoteWorkspaceLabel ?? session.remoteProjectId,
          hostLabel: session.remoteHostLabel ?? session.remoteHostKey,
          // Filled in once every session of the group is known.
          connected: false,
          ...parts,
          showQualifier: false,
        },
        sessions: [],
      };
      byKey.set(key, group);
    }
    group.sessions.push(session);
  }
  const groups = [...byKey.values()];
  for (const group of groups) {
    group.sessions.sort(compare);
    // A host that dropped off keeps its rows but cannot take new work.
    group.project.connected = group.sessions.some(
      (item) => item.capabilities?.canPrompt === true,
    );
  }

  // Same name on a different (host, path) reads as one group unless the
  // parent path surfaces; mark every colliding name, local siblings included.
  const nameCounts = new Map<string, number>();
  for (const name of siblingNames) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  for (const group of groups) {
    const name = group.project.name.toLocaleLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  for (const group of groups) {
    const name = group.project.name.toLocaleLowerCase();
    group.project.showQualifier =
      (nameCounts.get(name) ?? 0) > 1 && group.project.qualifier !== "";
  }

  // Most recently active project first; name and key keep it deterministic.
  return groups.sort((a, b) => {
    const byActivity = remoteGroupTimestamp(b) - remoteGroupTimestamp(a);
    if (byActivity !== 0) return byActivity;
    const byName = a.project.name.localeCompare(b.project.name, undefined, {
      sensitivity: "base",
    });
    return byName !== 0 ? byName : a.project.key.localeCompare(b.project.key);
  });
}

/** One row per session id: the first occurrence wins, duplicates never render twice. */
export function dedupeSessionsById(sessions: readonly SessionSummary[]): SessionSummary[] {
  const seen = new Set<string>();
  const result: SessionSummary[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    result.push(session);
  }
  return result;
}

/**
 * The owning-space label a flat or pinned row carries next to its title:
 * `host · project` for remote sessions, the project name for local ones.
 */
export function sessionOwningLabel(
  session: Pick<
    SessionSummary,
    | "id"
    | "projectPath"
    | "remoteHostLabel"
    | "remoteHostKey"
    | "remoteProjectId"
    | "remoteWorkspaceLabel"
  > & Partial<Pick<SessionSummary, "source">>,
  projectNameForPath: (normalizedPath: string) => string | undefined,
): string | undefined {
  if (isRemoteSession(session)) {
    const host = session.remoteHostLabel ?? session.remoteHostKey;
    const project = session.remoteProjectId
      ? remoteProjectDisplayParts(session.remoteProjectId, session.remoteWorkspaceLabel).name
      : session.remoteWorkspaceLabel;
    return [host, project].filter(Boolean).join(" · ") || undefined;
  }
  const path = normalizeProjectPath(session.projectPath);
  if (!path) return undefined;
  return projectNameForPath(path);
}
