import type { SessionCapabilities, SessionSummary } from "@pi-desktop/shared";

export function isRemoteSession(session?: Pick<SessionSummary, "id" | "source"> | null): boolean {
  return session?.source === "remote" || session?.id?.startsWith("remote:") === true;
}

/**
 * Missing capabilities preserve local behavior, but never grant remote local
 * access. A remote session is additionally limited to capabilities its backend
 * explicitly advertises as switchable over the wire: prompting and lifecycle
 * (RACP), workspace reads, and — on Perch hosts only — model configuration.
 * Native RACP sessions advertise `canConfigureModel: false`, so admitting the
 * capability here changes nothing for them.
 */
export function sessionAllows(
  session: Pick<SessionSummary, "id" | "source" | "capabilities"> | undefined,
  capability: keyof SessionCapabilities,
): boolean {
  if (isRemoteSession(session)) {
    return ["canPrompt", "canStop", "canRefresh", "canReadWorkspace", "canConfigureModel"].includes(capability)
      && session?.capabilities?.[capability] === true;
  }
  return session?.capabilities?.[capability] !== false;
}

/** A remote path is display data, not an Electron workspace activation target. */
export function safeSessionSummary<T extends SessionSummary>(session: T): T {
  if (!isRemoteSession(session)) return session;
  const { projectPath: _localPath, ...safe } = session;
  return { ...safe, source: "remote" } as T;
}
