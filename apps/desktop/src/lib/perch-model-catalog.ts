/**
 * Projection of a Perch remote host's merged model catalog
 * (`api.remoteHostModels`) onto the composer model menu's provider/group
 * shape. The remote host owns these ids; nothing here is a local provider,
 * so the groups are display scaffolding only — a selection sends just the
 * model id back through `configureActiveSession` and the bridge resolves
 * the provider on its side.
 */
import type { ModelInfo, ProviderPublic } from "@pi-desktop/shared";
import { sameComposerModelId } from "./composer-models";
import { providerDisplayName, providerSearchText } from "./provider-display";

/** One model in a Perch host's merged catalog, as served by the bridge. */
export type PerchModelEntry = {
  id: string;
  provider: string;
  name: string;
  agent: string;
};

export type PerchModelGroup = {
  provider: ProviderPublic;
  providerDisplayName: string;
  providerSearchText: string;
  models: ModelInfo[];
  /** The agent these models run on (omp/codex/claude/…). */
  agent: string;
  /** modelId → the real wire provider (e.g. "bailian"), for the switch call. */
  wireProviders: Record<string, string>;
};

/** Synthetic provider id for one agent group; never a local provider id. */
export function perchAgentProviderId(hostKey: string, agent: string): string {
  return `perch:${hostKey}:${agent}`;
}

function syntheticAgentProvider(
  hostKey: string,
  agent: string,
  entries: readonly PerchModelEntry[],
): ProviderPublic {
  return {
    id: perchAgentProviderId(hostKey, agent),
    name: agent,
    vendorKey: "perch",
    type: "custom",
    protocol: "perch",
    enabled: true,
    authKind: "none",
    hasSecret: true,
    // The catalog name rides the existing alias slot: a row keeps the wire id
    // as its title and search target while the label shows the host's name.
    models: entries.map((entry) => ({
      id: entry.id,
      ...(entry.name.trim() && entry.name.trim() !== entry.id
        ? { alias: entry.name.trim() }
        : {}),
      contextWindow: 0,
      maxTokens: 0,
      thinkingLevels: [],
      defaultThinkingLevel: null,
    })),
    supportsReasoning: false,
    supportedThinkingLevels: [],
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * Group the merged catalog by its owning agent, keeping the bridge's order.
 * A single-agent host yields one group, so the menu renders a flat list with
 * no source rail; several agents get one rail section each.
 */
export function groupPerchModelCatalog(
  hostKey: string,
  entries: readonly PerchModelEntry[],
): PerchModelGroup[] {
  const byAgent = new Map<string, PerchModelEntry[]>();
  for (const entry of entries) {
    if (!entry.id.trim()) continue;
    const agent = entry.agent.trim() || entry.provider.trim() || "default";
    const bucket = byAgent.get(agent);
    if (bucket) bucket.push(entry);
    else byAgent.set(agent, [entry]);
  }
  return [...byAgent.entries()].map(([agent, agentEntries]) => {
    const provider = syntheticAgentProvider(hostKey, agent, agentEntries);
    return {
      provider,
      providerDisplayName: providerDisplayName(provider),
      providerSearchText: providerSearchText(provider),
      agent,
      wireProviders: Object.fromEntries(agentEntries.map((entry) => [entry.id, entry.provider])),
      models: agentEntries.map((entry) => ({
        modelId: entry.id,
        displayName: entry.name.trim() || entry.id,
        providerId: provider.id,
        capabilities: ["text" as const],
        source: "user" as const,
      })),
    };
  });
}

/** Display name for one catalog model: the host's name, falling back to the id. */
export function perchCatalogModelName(
  entries: readonly PerchModelEntry[] | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!entries || !modelId) return undefined;
  const entry = entries.find((candidate) => sameComposerModelId(candidate.id, modelId));
  return entry?.name.trim() || undefined;
}
