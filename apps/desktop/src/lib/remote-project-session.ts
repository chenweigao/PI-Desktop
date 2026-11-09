import type { SessionSummary } from "@pi-desktop/shared";
import { api } from "./api";
import { isRemoteSession, safeSessionSummary } from "./remote-session-safety";
import { sessionIsReusableEmpty } from "./session-create";
import { isAutomationSession } from "./session-origin";
import { sessionIsArchived } from "./sidebar-preferences";
import type { SessionRuntime } from "../stores/runtime/session-runtime";
import type { StoreAccess } from "../stores/slices/types";

/** A remote project is identified by its host and project id, never a local path. */
export type RemoteProjectTarget = { hostKey: string; projectId: string; label: string };

export function remoteProjectForSession(session?: SessionSummary): RemoteProjectTarget | undefined {
  if (!isRemoteSession(session) || !session?.remoteHostKey || !session.remoteProjectId) return undefined;
  return { hostKey: session.remoteHostKey, projectId: session.remoteProjectId,
    label: session.remoteWorkspaceLabel ?? session.remoteProjectId };
}

export async function openRemoteProjectSession(
  { get, set, runtime }: StoreAccess & { runtime: SessionRuntime },
  project: RemoteProjectTarget,
  options?: { provider?: string; model?: string },
): Promise<void> {
  const scope = `remote-project:${JSON.stringify([project.hostKey, project.projectId])}`;
  const pending = runtime.pendingNewSessionRequests.get(scope);
  if (pending) { await pending; return; }
  const intent = runtime.beginNavigationIntent();
  const request = (async () => {
    const state = get();
    const latest = state.sessions.filter((session) =>
      !isAutomationSession(session)
      && session.remoteHostKey === project.hostKey && session.remoteProjectId === project.projectId
      && !sessionIsArchived(session.id, state.sessionMeta),
    ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    // An explicit agent/model choice is never satisfied by reusing a session
    // running a different one: picking Codex must not reopen an OMP session.
    const explicitChoice = options?.provider ?? options?.model;
    const matchesChoice = !explicitChoice || (latest
      && (options?.provider === undefined || latest.remoteAgent === options.provider)
      && (options?.model === undefined || latest.modelId === options.model));
    if (latest && matchesChoice && sessionIsReusableEmpty(latest, {
      running: state.runningSessions[latest.id] === true,
      liveMessageCount: runtime.liveMessageCountForSession(latest.id, state),
      submitted: runtime.submittedComposerDrafts.has(latest.id),
    })) {
      // RACP list summaries do not publish a durable message count. Read the
      // actual bounded history before treating a cold catalog row as empty.
      const detail = await api.getSession(latest.id);
      if (!runtime.navigationIntentIsCurrent(intent)) return null;
      const current = get();
      const candidate = current.sessions.find((session) => session.id === latest.id);
      if (candidate && !sessionIsArchived(candidate.id, current.sessionMeta)
        && detail.session && !detail.session.hasMoreBefore && sessionIsReusableEmpty(detail.session, {
        running: current.runningSessions[latest.id] === true,
        liveMessageCount: Math.max(detail.session.messages?.length ?? 0, runtime.liveMessageCountForSession(latest.id, current)),
        submitted: runtime.submittedComposerDrafts.has(latest.id),
      })) {
        await get().selectSession(latest.id, { navigationIntent: intent });
        return runtime.navigationIntentIsCurrent(intent) ? latest.id : null;
      }
    }
    const result = await api.createRemoteSession({ hostKey: project.hostKey,
      projectId: project.projectId, mode: "agent", permissionMode: "ask",
      ...(options?.provider ? { provider: options.provider } : {}),
      ...(options?.model ? { model: options.model } : {}) });
    const session = safeSessionSummary(result.session);
    // Preserve a successful creation even if the user navigated away while it ran.
    set((current) => ({ sessions: [session, ...current.sessions.filter((item) => item.id !== session.id)] }));
    if (!runtime.navigationIntentIsCurrent(intent)) return null;
    await get().selectSession(session.id, { navigationIntent: intent });
    return runtime.navigationIntentIsCurrent(intent) ? session.id : null;
  })();
  runtime.pendingNewSessionRequests.set(scope, request);
  try { await request; }
  finally {
    if (runtime.pendingNewSessionRequests.get(scope) === request) runtime.pendingNewSessionRequests.delete(scope);
  }
}

/**
 * Direct remote session: the caller names a host, not a project. The cwd
 * defaults to the remote home directory — a browse with no path resolves it
 * on the host — so no project registration ever happens. The resolved cwd
 * feeds the same project-session machinery, which dedupes concurrent creates
 * and reuses an existing empty session at that cwd instead of piling up rows.
 */
export async function openDirectRemoteSession(
  access: StoreAccess & { runtime: SessionRuntime },
  target: { hostKey: string; cwd?: string },
  options?: { provider?: string; model?: string },
): Promise<void> {
  const cwd = target.cwd?.trim()
    ? target.cwd.trim()
    : (await api.remoteHostBrowseProjects(target.hostKey)).path;
  const label = cwd.replace(/\/+$/, "").split("/").pop() || cwd;
  await openRemoteProjectSession(access,
    { hostKey: target.hostKey, projectId: cwd, label }, options);
}
