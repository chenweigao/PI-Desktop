import type { RemoteHostSummary } from "@pi-desktop/shared";
import type { PerchModelEntry } from "./perch-model-catalog";

/**
 * Only the cwd-based channels (Perch/Kimi) can create a session without a
 * registered project: their `createSession` takes a remote absolute cwd and
 * defaults it to the remote home. RACP hosts still need a project id.
 */
export function directRemoteHosts(hosts: RemoteHostSummary[]): RemoteHostSummary[] {
  return hosts.filter((host) => host.backend === "perch" || host.backend === "kimi");
}

/** Distinct runtime ids a host's model catalog offers, in catalog order. */
export function catalogAgents(catalog: PerchModelEntry[] | undefined): string[] {
  return [...new Set((catalog ?? []).map((entry) => entry.agent).filter(Boolean))];
}
