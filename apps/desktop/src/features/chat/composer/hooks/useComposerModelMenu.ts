import { sameRecentModel } from "../../../../lib/recent-models";
import type {
  Mode,
  ProviderPublic,
  SessionThinkingLevel,
} from "@pi-desktop/shared";
import {
  imageGenerationBindings,
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
  isImageGenerationModel,
} from "@pi-desktop/shared";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  composerModelBinding,
  composerModelMatchesQuery,
  composerModelsForProvider,
  sameComposerModelId,
} from "../../../../lib/composer-models";
import { groupPerchModelCatalog } from "../../../../lib/perch-model-catalog";
import {
  providerDisplayName,
  providerSearchText,
} from "../../../../lib/provider-display";
import { providerThinkingLevels } from "../../../../lib/session-thinking";
import { useAppStore } from "../../../../stores/app-store";
import {
  sessionThinkingMenuLevels,
  thinkingLevelForProvider,
  thinkingProviderForModel,
} from "../model";
import { createLatestCommitQueue } from "../thinking-commit-queue";

/** Rail section that lists the most recently used models. */
export const RECENT_MODEL_SECTION = "recent";
/** Recent rows get their own rail section, so a few more than one screen fits. */
const RECENT_MODEL_LIMIT = 6;

export function providerModelSection(providerId: string): string {
  return `provider:${providerId}`;
}

export type ComposerModelSection =
  | { id: string; kind: "recent"; count: number }
  | { id: string; kind: "provider"; provider: ProviderPublic; label: string; count: number };

type UseComposerModelMenuOptions = {
  mode: Mode;
  activeSessionId: string | null | undefined;
  provider: ProviderPublic | undefined;
  modelId: string | undefined;
  thinkingProvider: ProviderPublic | null | undefined;
  thinkingLevel: SessionThinkingLevel;
  controlsBlocked: boolean;
  /**
   * Set when the active session lives on a Perch remote host that advertises
   * `canConfigureModel`: the menu lists that host's catalog instead of the
   * local providers, and a selection sends only the model id.
   */
  remoteCatalogHostKey?: string | null;
  /** While the remote session is busy the bridge refuses a model switch. */
  modelSwitchBlocked?: boolean;
  /** Explains `modelSwitchBlocked` as a toast on a switch attempt. */
  modelSwitchBlockedMessage?: string;
  configureActiveSession: (configuration: {
    mode: Mode; providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel;
  }) => Promise<void>;
};

export function useComposerModelMenu({
  mode,
  activeSessionId,
  provider,
  modelId,
  thinkingProvider: resolvedThinkingProvider,
  thinkingLevel,
  controlsBlocked,
  remoteCatalogHostKey = null,
  modelSwitchBlocked = false,
  modelSwitchBlockedMessage,
  configureActiveSession,
}: UseComposerModelMenuOptions) {
  const providers = useAppStore((s) => s.providers);
  const recentModels = useAppStore((s) => s.recentModels);
  const imageGeneration = useAppStore((s) => s.settings?.imageGeneration);
  const imageGenerationModels = useAppStore((s) => s.settings?.imageGenerationModels);
  const imageGenerationCandidates = useMemo(
    () => imageGenerationBindings(imageGenerationModels, imageGeneration),
    [imageGenerationModels, imageGeneration],
  );
  const providerModels = useAppStore((s) => s.providerModels);
  const loadProviderModels = useAppStore((s) => s.loadProviderModels);
  const showToast = useAppStore((s) => s.showToast);
  const remoteModelCatalog = useAppStore((s) =>
    remoteCatalogHostKey ? s.remoteModelCatalogs[remoteCatalogHostKey] : undefined,
  );
  const remoteModelCatalogError = useAppStore((s) =>
    remoteCatalogHostKey ? s.remoteModelCatalogErrors[remoteCatalogHostKey] : undefined,
  );
  const loadRemoteModelCatalog = useAppStore((s) => s.loadRemoteModelCatalog);
  const [open, setOpen] = useState(false);
  // null follows the default section; a rail click pins one until close.
  const [section, setSection] = useState<string | null>(null);
  // Direction of the last rail move, so the pane slides in from that side.
  const [sectionStep, setSectionStep] = useState(0);
  const [query, setQuery] = useState("");
  const [modelHighlight, setModelHighlight] = useState(-1);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const thinkingConfigRef = useRef({
    mode,
    providerId: provider?.id,
    modelId,
    configureActiveSession,
    showToast,
  });
  thinkingConfigRef.current = {
    mode,
    providerId: provider?.id,
    modelId,
    configureActiveSession,
    showToast,
  };
  const thinkingQueueRef = useRef<ReturnType<typeof createLatestCommitQueue<SessionThinkingLevel>> | null>(
    null,
  );
  if (!thinkingQueueRef.current) {
    thinkingQueueRef.current = createLatestCommitQueue<SessionThinkingLevel>({
      send: async (level) => {
        const current = thinkingConfigRef.current;
        await current.configureActiveSession({
          mode: current.mode,
          providerId: current.providerId,
          modelId: current.modelId,
          thinkingLevel: level,
        });
      },
      onError: (error) => {
        const current = thinkingConfigRef.current;
        current.showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      },
    });
  }

  const thinkingProvider =
    resolvedThinkingProvider ??
    thinkingProviderForModel(
      provider,
      modelId,
      provider ? providerModels[provider.id] : undefined,
    );
  const availableThinkingLevels = providerThinkingLevels(thinkingProvider);
  const thinkingMenuLevels = sessionThinkingMenuLevels(availableThinkingLevels);
  const remoteGroups = useMemo(
    () =>
      remoteCatalogHostKey && remoteModelCatalog
        ? groupPerchModelCatalog(remoteCatalogHostKey, remoteModelCatalog)
        : [],
    [remoteCatalogHostKey, remoteModelCatalog],
  );
  const modelGroups = useMemo(
    () =>
      remoteCatalogHostKey
        ? remoteGroups
        : providers
            .filter(
              (candidate) =>
                candidate.enabled &&
                (candidate.hasSecret || candidate.authKind === "none"),
            )
            .map((candidate) => {
              const models = composerModelsForProvider(
                candidate,
                providerModels[candidate.id],
                imageGenerationCandidates,
              );
              return {
                provider: candidate,
                providerDisplayName: providerDisplayName(candidate),
                providerSearchText: providerSearchText(candidate),
                models,
              };
            })
            .filter((group) => group.models.length > 0),
    [remoteCatalogHostKey, remoteGroups, providers, providerModels, imageGenerationCandidates],
  );
  // The menu's provider identity for the current selection: a local session's
  // provider owns it directly; a remote session's current model names the
  // agent group holding it.
  const menuSelectedProviderId = useMemo(() => {
    if (!remoteCatalogHostKey) return provider?.id;
    return modelGroups.find((group) =>
      group.models.some((model) => sameComposerModelId(model.modelId, modelId ?? "")),
    )?.provider.id;
  }, [remoteCatalogHostKey, modelGroups, provider?.id, modelId]);
  const recentEntries = useMemo(() => {
    const entries = modelGroups.flatMap(group => group.models.map(model => ({ provider: group.provider, model })));
    return (recentModels ?? []).flatMap(recent => {
      const entry = entries.find(entry => sameRecentModel(recent, {
        providerId: entry.provider.id, modelId: entry.model.modelId,
      }));
      return entry ? [entry] : [];
    }).slice(0, RECENT_MODEL_LIMIT);
  }, [modelGroups, recentModels]);
  const queryNeedle = query.trim().toLowerCase();
  const filteredModelGroups = useMemo(
    () =>
      queryNeedle
        ? modelGroups
            .map((group) => ({
              ...group,
              models: group.models.filter((model) =>
                composerModelMatchesQuery(
                  model,
                  group.providerSearchText,
                  queryNeedle,
                  composerModelBinding(group.provider, model.modelId)?.alias,
                ),
              ),
            }))
            .filter((group) => group.models.length > 0)
        : modelGroups,
    [modelGroups, queryNeedle],
  );
  const searching = queryNeedle.length > 0;
  // While searching, provider counts become match counts so the rail shows
  // where the results live; the recent section has no separate result set.
  const sections = useMemo<ComposerModelSection[]>(() => [
    ...(recentEntries.length > 0
      ? [{ id: RECENT_MODEL_SECTION, kind: "recent" as const, count: recentEntries.length }]
      : []),
    ...modelGroups.map((group) => ({
      id: providerModelSection(group.provider.id),
      kind: "provider" as const,
      provider: group.provider,
      label: group.providerDisplayName,
      count: searching
        ? (filteredModelGroups.find((candidate) => candidate.provider.id === group.provider.id)?.models.length ?? 0)
        : group.models.length,
    })),
  ], [filteredModelGroups, modelGroups, recentEntries.length, searching]);
  // One pane height for every source: the tallest source (or the rail itself)
  // decides it, so switching sources or typing never resizes the menu.
  const paneRows = Math.max(
    sections.length,
    recentEntries.length,
    ...modelGroups.map((group) => group.models.length),
  );
  const selectedProviderSection =
    menuSelectedProviderId && modelGroups.some((group) => group.provider.id === menuSelectedProviderId)
      ? providerModelSection(menuSelectedProviderId)
      : null;
  const defaultSection =
    recentEntries.length > 0 ? RECENT_MODEL_SECTION : (selectedProviderSection ?? sections[0]?.id ?? null);
  const activeSection =
    section && sections.some((candidate) => candidate.id === section) ? section : defaultSection;
  const visibleRecents = useMemo(
    () => (!searching && activeSection === RECENT_MODEL_SECTION ? recentEntries : []),
    [activeSection, recentEntries, searching],
  );
  const visibleGroups = useMemo(
    () => searching
      ? filteredModelGroups
      : modelGroups.filter((group) => providerModelSection(group.provider.id) === activeSection),
    [activeSection, filteredModelGroups, modelGroups, searching],
  );
  const flatModels = useMemo(
    () =>
      [...visibleRecents, ...visibleGroups.flatMap((group) =>
        group.models.map((model) => ({ provider: group.provider, model })),
      )],
    [visibleGroups, visibleRecents],
  );
  const flatModelsKey = useMemo(
    () => flatModels.map((entry) => `${entry.provider.id}:${entry.model.modelId}`).join("|"),
    [flatModels],
  );
  const activeFlatIndex = useMemo(
    () =>
      flatModels.findIndex(
        (entry) =>
          entry.provider.id === menuSelectedProviderId &&
          sameComposerModelId(entry.model.modelId, modelId ?? ""),
      ),
    [flatModels, menuSelectedProviderId, modelId],
  );

  useEffect(() => {
    if (!open) return;
    setModelHighlight(queryNeedle ? (flatModels.length ? 0 : -1) : activeFlatIndex);
  }, [activeFlatIndex, flatModels.length, flatModelsKey, open, queryNeedle]);

  useEffect(() => {
    if (!open) return;
    for (const candidate of providers) {
      if (candidate.enabled && (candidate.hasSecret || candidate.authKind === "none")) {
        void loadProviderModels(candidate.id);
      }
    }
  }, [loadProviderModels, open, providers]);

  // The chip label and the menu both read this catalog, so load it with the
  // session rather than on menu open — the current model's name should never
  // fall back to a bare wire id once the host has answered.
  useEffect(() => {
    if (!remoteCatalogHostKey) return;
    void loadRemoteModelCatalog(remoteCatalogHostKey);
  }, [remoteCatalogHostKey, loadRemoteModelCatalog]);

  useEffect(() => {
    if (open) return;
    setSection(null);
    setSectionStep(0);
    setQuery("");
    setModelHighlight(-1);
  }, [open]);
  useEffect(() => {
    thinkingQueueRef.current?.invalidate();
  }, [activeSessionId, provider?.id, modelId]);

  useEffect(() => {
    if (!controlsBlocked) return;
    setOpen(false);
    thinkingQueueRef.current?.invalidate();
  }, [controlsBlocked]);

  useEffect(() => {
    if (!open || modelHighlight < 0) return;
    modelListRef.current
      ?.querySelector(`[data-model-index="${modelHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [modelHighlight, open]);

  const selectModel = async (candidate: ProviderPublic, nextModelId: string) => {
    thinkingQueueRef.current?.invalidate();
    await thinkingQueueRef.current?.idle();
    // A Perch remote session switches models through its host's own catalog:
    // the bridge resolves the provider from the model id, so no local
    // provider id crosses the wire and no local thinking ladder applies.
    if (remoteCatalogHostKey) {
      if (modelSwitchBlocked) {
        if (modelSwitchBlockedMessage) {
          showToast(modelSwitchBlockedMessage, { variant: "info" });
        }
        return;
      }
      try {
        await configureActiveSession({
          mode,
          modelId: nextModelId,
          thinkingLevel,
        });
        setQuery("");
        setModelHighlight(-1);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      }
      return;
    }
    if (isImageGenerationModel(
      imageGenerationBindings(
        useAppStore.getState().settings?.imageGenerationModels,
        useAppStore.getState().settings?.imageGeneration,
      ),
      candidate.id,
      nextModelId,
    )) return;
    try {
      const nextModelProvider = thinkingProviderForModel(
        candidate,
        nextModelId,
        providerModels[candidate.id],
      );
      const nextBinding = candidate.models.find((entry) =>
        sameComposerModelId(entry.id, nextModelId),
      );
      const nextModel = providerModels[candidate.id]?.find((entry) =>
        sameComposerModelId(entry.modelId, nextModelId),
      );
      const selectedSameModel =
        activeSessionId &&
        candidate.id === provider?.id &&
        sameComposerModelId(modelId ?? "", nextModelId);
      const nextThinkingLevel = selectedSameModel
        ? thinkingLevelForProvider(nextModelProvider, thinkingLevel)
        : (nextModel?.catalogSource === "models.dev"
          ? initialThinkingLevelForBinding(
              nextBinding,
              nextModelProvider?.supportedThinkingLevels,
            )
          : initialThinkingLevelForUnmatchedModel(
              nextBinding,
              nextModelProvider?.supportedThinkingLevels,
            ));
      await configureActiveSession({
        mode,
        providerId: candidate.id,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      });
      setQuery("");
      setModelHighlight(-1);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  /** Show one rail section. Picking a source ends any search in progress. */
  const selectSection = (id: string) => {
    const from = sections.findIndex((candidate) => candidate.id === activeSection);
    const to = sections.findIndex((candidate) => candidate.id === id);
    // The pane is keyed by section, so an unchanged section never replays.
    setSectionStep(to < from ? -1 : 1);
    setSection(id);
    setQuery("");
    setModelHighlight(-1);
    modelListRef.current?.scrollTo({ top: 0 });
  };

  /**
   * Commit a reasoning level without leaving the menu surface. Latest-wins:
   * a drag that crosses several stops only persists the last pending level
   * after the in-flight write settles. Returns false when the configuration
   * is rejected or invalidated by a session/model change.
   */
  const commitThinkingLevel = (level: SessionThinkingLevel) => {
    const queue = thinkingQueueRef.current;
    if (!queue) return Promise.resolve(false);
    return queue.commit(level);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      // A search in progress is the innermost state: Escape clears it first.
      if (query && event.target instanceof HTMLInputElement) {
        setQuery("");
        setModelHighlight(-1);
        return;
      }
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        const entry = flatModels[modelHighlight];
        if (entry) {
          event.preventDefault();
          void selectModel(entry.provider, entry.model.modelId);
        }
      }
      return;
    }
    if (!(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (!flatModels.length) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setModelHighlight((current) => {
      const base = current < 0 ? (delta > 0 ? -1 : flatModels.length) : current;
      return (base + delta + flatModels.length) % flatModels.length;
    });
  };

  // Remote catalog state for the picker's empty surface: while nothing is
  // cached, the host answer is either still in flight or has failed.
  const remoteCatalogStatus = !remoteCatalogHostKey
    ? ("local" as const)
    : remoteModelCatalog !== undefined
      ? ("ready" as const)
      : remoteModelCatalogError
        ? ("error" as const)
        : ("loading" as const);
  return {
    open,
    setOpen,
    sections,
    activeSection: searching ? null : activeSection,
    sectionStep,
    selectSection,
    showSectionRail: sections.length > 1,
    paneRows,
    searching,
    query,
    setQuery,
    modelHighlight,
    setModelHighlight,
    modelSearchRef,
    modelListRef,
    modelGroups: visibleGroups,
    recentEntries: visibleRecents,
    flatModels,
    thinkingMenuLevels,
    selectModel,
    commitThinkingLevel,
    onMenuKeyDown,
    controlsBlocked,
    menuSelectedProviderId,
    remoteCatalogStatus,
  };
}
