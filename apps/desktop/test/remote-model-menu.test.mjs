/**
 * Perch remote model menu: for a remote session whose host advertises
 * `canConfigureModel`, the composer's model menu lists that host's merged
 * Perch catalog (grouped by agent), the chip shows the real current model
 * name, and a selection routes through `configureActiveSession` →
 * `sessionConfigure` carrying only the model id. A busy session gets a
 * clear refusal, and a native RACP session (canConfigureModel: false) keeps
 * its locked, generic menu.
 *
 * Harness mirrors remote-mvp-renderer.test.mjs: one esbuild bundle of the
 * real renderer modules, driven through a stubbed preload bridge.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "remote-model-menu-"));
const output = join(temp, "fixture.mjs");
await build({
  stdin: { contents: `
    export { api } from './apps/desktop/src/lib/api';
    import { useAppStore } from './apps/desktop/src/stores/app-store';
    export { useAppStore };
    export { groupPerchModelCatalog, perchCatalogModelName } from './apps/desktop/src/lib/perch-model-catalog';
    export { IPC } from '@pi-desktop/shared';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import i18n from 'i18next';
    import { initReactI18next, useTranslation } from 'react-i18next';
    import { catalogs } from '@pi-desktop/i18n';
    import { ChatSurface } from './apps/desktop/src/components/ChatSurface';
    import { useComposerModelMenu } from './apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu';
    import { ComposerModelList } from './apps/desktop/src/features/chat/composer/ComposerModelList';
    let i18nReady;
    const ready = () => i18nReady ??= i18n.use(initReactI18next).init({lng:'en', fallbackLng:'en', resources:{en:{translation:catalogs.en}}, interpolation:{escapeValue:false}});
    export async function renderChat(session) {
      await ready();
      // zustand SSR selectors read getInitialState(), so mirror the live
      // state into it the way remote-mvp-renderer.test.mjs does.
      Object.assign(useAppStore.getInitialState(), useAppStore.getState(), { sessions:[session], activeSessionId:session.id, retainedSessionIds:[session.id], messages:[] });
      return renderToStaticMarkup(React.createElement(ChatSurface));
    }
    let lastMenu = null;
    export function lastRenderedMenu() { return lastMenu; }
    function MenuProbe(props) {
      const { t } = useTranslation();
      const menu = useComposerModelMenu({
        mode: 'agent',
        activeSessionId: props.sessionId,
        provider: undefined,
        modelId: props.modelId,
        thinkingProvider: undefined,
        thinkingLevel: 'off',
        controlsBlocked: false,
        remoteCatalogHostKey: props.hostKey,
        modelSwitchBlocked: props.blocked === true,
        modelSwitchBlockedMessage: props.blockedMessage,
        configureActiveSession: props.configureActiveSession,
      });
      lastMenu = menu;
      return React.createElement(ComposerModelList, {
        t,
        query: menu.query, setQuery: menu.setQuery,
        modelSearchRef: menu.modelSearchRef, modelListRef: menu.modelListRef,
        modelGroups: menu.modelGroups, modelHighlight: menu.modelHighlight,
        recentEntries: menu.recentEntries, sections: menu.sections,
        activeSection: menu.activeSection, sectionStep: menu.sectionStep,
        selectSection: menu.selectSection, showSectionRail: menu.showSectionRail,
        searching: menu.searching, paneRows: menu.paneRows,
        setModelHighlight: menu.setModelHighlight, selectModel: menu.selectModel,
        selectedProviderId: menu.menuSelectedProviderId, selectedModelId: props.modelId,
      });
    }
    export async function renderMenu(props) {
      await ready();
      return renderToStaticMarkup(React.createElement(MenuProbe, props));
    }
  `, resolveDir: root, loader: "tsx" },
  outfile: output, bundle: true, platform: "node", format: "esm", jsx: "automatic",
  alias: { "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"), "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"), react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"), i18next: join(root, "apps/desktop/node_modules/i18next") },
  loader: { ".css": "empty", ".gif": "dataurl", ".png": "dataurl" },
  plugins: [{ name: "fixture-vite-url", setup(builder) {
    builder.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "fixture-url" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, ({ path }) => ({ contents: `export default ${JSON.stringify(path)};`, loader: "js" }));
  } }],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const fixture = await import(pathToFileURL(output).href);
const { api, useAppStore, groupPerchModelCatalog, perchCatalogModelName, IPC } = fixture;
test.after(() => rm(temp, { recursive: true, force: true }));

const hostKey = "ssh-perch";
const perchCapabilities = { canPrompt: true, canStop: true, canRefresh: true, canConfigureModel: true };
const catalog = [
  { id: "gpt-5.1-codex", provider: "openai", name: "GPT-5.1 Codex", agent: "codex" },
  { id: "gpt-5.1-codex-mini", provider: "openai", name: "GPT-5.1 Codex Mini", agent: "codex" },
  { id: "claude-sonnet-4.5", provider: "anthropic", name: "Claude Sonnet 4.5", agent: "claude" },
];
const perchSession = {
  id: "remote:ssh-perch:s1", source: "remote", remoteHostKey: hostKey, remoteHostLabel: "Perch box",
  title: "Perch task", messageCount: 0, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  modelId: "gpt-5.1-codex", providerId: "openai", capabilities: perchCapabilities,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const racpSession = {
  id: "remote:racp:s9", source: "remote", remoteHostKey: "racp", remoteHostLabel: "RACP host",
  title: "RACP task", messageCount: 0, mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  capabilities: { canPrompt: true, canStop: true, canRefresh: true, canReadWorkspace: true, canConfigureModel: false },
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
function bridge(handler) {
  const calls = [];
  globalThis.window = { matchMedia: () => ({ matches: false }), piDesktop: { platform: "linux", on: () => () => {}, invoke: async (channel, ...args) => {
    calls.push({ channel, args }); return { ok: true, data: await handler(channel, args) };
  } } };
  return calls;
}
// zustand selectors under renderToStaticMarkup read getInitialState(), so a
// seed writes both the live state and the initial snapshot.
function seed(overrides) {
  useAppStore.setState(overrides);
  Object.assign(useAppStore.getInitialState(), useAppStore.getState());
}
function initialize() {
  seed({ sessions: [], activeSessionId: undefined, selectingSessionId: undefined, messages: [], retainedSessionIds: [], retainedTranscripts: {}, sessionHistory: {}, sessionMeta: {}, runningSessions: {}, pendingPlans: {}, pendingPermissions: {}, pendingAsks: {}, planningStates: {}, providers: [], remoteModelCatalogs: {}, remoteModelCatalogErrors: {}, toasts: [], workPanelContexts: {}, workPanelTabs: [], activeWorkPanelTabId: null, workspace: { path: "/local/private", name: "Local only" }, activeProjectPath: "/local/private", page: "chat", settings: { defaultMode: "agent" } });
}

test("the Perch catalog groups by agent with the catalog name on the alias slot", () => {
  const groups = groupPerchModelCatalog(hostKey, catalog);
  assert.deepEqual(groups.map((group) => group.providerDisplayName), ["codex", "claude"]);
  assert.deepEqual(groups.map((group) => group.models.length), [2, 1]);
  const row = groups[0].models[0];
  assert.equal(row.modelId, "gpt-5.1-codex");
  assert.equal(row.displayName, "GPT-5.1 Codex");
  assert.equal(groups[0].provider.models[0].alias, "GPT-5.1 Codex");
  assert.notEqual(groups[0].provider.id, "openai", "the synthetic provider never poses as a local one");
  assert.equal(perchCatalogModelName(catalog, "gpt-5.1-codex"), "GPT-5.1 Codex");
  assert.equal(perchCatalogModelName(catalog, "missing"), undefined);
  assert.equal(perchCatalogModelName(undefined, "gpt-5.1-codex"), undefined);
});

test("loadRemoteModelCatalog caches per host and a failed refresh keeps the old catalog", async () => {
  initialize();
  let fail = false;
  const calls = bridge((channel) => {
    if (channel === IPC.invoke.remoteHostModels) {
      if (fail) throw new Error("host unreachable");
      return { models: catalog };
    }
    return {};
  });
  await useAppStore.getState().loadRemoteModelCatalog(hostKey);
  assert.deepEqual(useAppStore.getState().remoteModelCatalogs[hostKey], catalog);
  await useAppStore.getState().loadRemoteModelCatalog(hostKey);
  assert.equal(calls.filter((call) => call.channel === IPC.invoke.remoteHostModels).length, 1, "second load is cached");
  fail = true;
  await useAppStore.getState().loadRemoteModelCatalog(hostKey, { force: true });
  assert.deepEqual(useAppStore.getState().remoteModelCatalogs[hostKey], catalog, "failure keeps the previous catalog");
  assert.match(useAppStore.getState().remoteModelCatalogErrors[hostKey], /host unreachable/);
  // A host with nothing cached records the error and retries next time.
  await useAppStore.getState().loadRemoteModelCatalog("other-host");
  assert.equal(useAppStore.getState().remoteModelCatalogs["other-host"], undefined);
  assert.match(useAppStore.getState().remoteModelCatalogErrors["other-host"], /host unreachable/);
  fail = false;
  await useAppStore.getState().loadRemoteModelCatalog("other-host");
  assert.deepEqual(useAppStore.getState().remoteModelCatalogs["other-host"], catalog, "uncached failure does not stick");
  assert.equal(useAppStore.getState().remoteModelCatalogErrors["other-host"], undefined);
});

test("the remote menu lists the Perch catalog by agent with the current model checked", async () => {
  initialize();
  seed({ sessions: [perchSession], activeSessionId: perchSession.id, remoteModelCatalogs: { [hostKey]: catalog } });
  const html = await fixture.renderMenu({ hostKey, modelId: "gpt-5.1-codex", sessionId: perchSession.id, configureActiveSession: async () => {} });
  // Two agents → the source rail lists both with their counts.
  assert.match(html, /composer-model-rail-label">codex<\/span><span class="composer-model-rail-count">2</);
  assert.match(html, /composer-model-rail-label">claude<\/span><span class="composer-model-rail-count">1</);
  // The pane opens on the section holding the current model.
  assert.match(html, /<span class="composer-model-label is-alias">GPT-5\.1 Codex<\/span>/);
  assert.match(html, /<span class="composer-model-label is-alias">GPT-5\.1 Codex Mini<\/span>/);
  assert.ok(!html.includes('title="claude-sonnet-4.5"'), "the other agent's rows stay on their own rail section");
  // The wire id stays the row's identity; the current model is checked.
  assert.match(html, /<button[^>]*title="gpt-5\.1-codex"[^>]*aria-checked="true"/);
  assert.match(html, /<button[^>]*title="gpt-5\.1-codex-mini"[^>]*aria-checked="false"/);
  const menu = fixture.lastRenderedMenu();
  assert.equal(menu.remoteCatalogStatus, "ready");
  assert.equal(menu.showSectionRail, true);
});

test("a single-agent catalog renders as one flat list without the rail", async () => {
  initialize();
  seed({ sessions: [perchSession], activeSessionId: perchSession.id, remoteModelCatalogs: { [hostKey]: catalog.filter((entry) => entry.agent === "codex") } });
  const html = await fixture.renderMenu({ hostKey, modelId: "gpt-5.1-codex", sessionId: perchSession.id, configureActiveSession: async () => {} });
  assert.equal(fixture.lastRenderedMenu().showSectionRail, false);
  assert.match(html, /GPT-5\.1 Codex Mini/);
});

test("the composer chip names the Perch session's current model", async () => {
  initialize();
  seed({ remoteModelCatalogs: { [hostKey]: catalog } });
  bridge(() => ({}));
  const html = await fixture.renderChat(perchSession);
  assert.match(html, /<span class="composer-model-thinking-model">GPT-5\.1 Codex<\/span>/);
  const chip = html.match(/<button[^>]*composer-model-thinking-chip[^>]*>/)?.[0] ?? "";
  assert.ok(chip && !chip.includes("disabled"), "the model switch is enabled for a configurable remote session");
});

test("before the catalog answers the chip falls back to the wire id, never the generic label", async () => {
  initialize();
  bridge(() => ({}));
  const html = await fixture.renderChat(perchSession);
  assert.match(html, /<span class="composer-model-thinking-model">gpt-5\.1-codex<\/span>/);
});

test("a native RACP remote session keeps its locked, generic model menu", async () => {
  initialize();
  seed({ remoteModelCatalogs: { [hostKey]: catalog } });
  bridge(() => ({}));
  const html = await fixture.renderChat(racpSession);
  const chip = html.match(/<button[^>]*composer-model-thinking-chip[^>]*>/)?.[0] ?? "";
  assert.ok(chip.includes("disabled"), "chip stays disabled without canConfigureModel");
  assert.match(html, /<span class="composer-model-thinking-model">Model<\/span>/);
  assert.ok(!html.includes("GPT-5.1 Codex"), "no Perch catalog leaks into a RACP session");
});

test("switching routes configureSession with the model id and the partial answer merges onto the row", async () => {
  initialize();
  useAppStore.setState({ sessions: [perchSession], activeSessionId: perchSession.id });
  const calls = bridge((channel) =>
    channel === IPC.invoke.sessionConfigure
      // The Perch backend answers with the switched identity only, and names
      // the bare host-side id.
      ? { session: { id: "s1", modelId: "gpt-5.1-codex-mini", providerId: "openai" } }
      : {});
  await useAppStore.getState().configureActiveSession({ mode: "agent", modelId: "gpt-5.1-codex-mini", thinkingLevel: "off" });
  const configure = calls.find((call) => call.channel === IPC.invoke.sessionConfigure);
  assert.ok(configure, "sessionConfigure reached the bridge");
  assert.equal(configure.args[0], perchSession.id);
  assert.deepEqual(configure.args[1], { mode: "agent", modelId: "gpt-5.1-codex-mini", thinkingLevel: "off" });
  const row = useAppStore.getState().sessions.find((session) => session.id === perchSession.id);
  assert.ok(row, "the row keeps its renderer-visible id");
  assert.equal(row.modelId, "gpt-5.1-codex-mini");
  assert.equal(row.providerId, "openai");
  assert.equal(row.title, "Perch task", "the partial answer cannot drop the title");
  assert.equal(row.source, "remote");
  assert.equal(row.remoteHostKey, hostKey);
  assert.equal(row.capabilities.canConfigureModel, true);
});

test("the menu's selection sends only the model id — the bridge resolves the provider", async () => {
  initialize();
  seed({ sessions: [perchSession], activeSessionId: perchSession.id, remoteModelCatalogs: { [hostKey]: catalog } });
  bridge(() => ({}));
  const configured = [];
  await fixture.renderMenu({ hostKey, modelId: "gpt-5.1-codex", sessionId: perchSession.id, configureActiveSession: async (config) => { configured.push(config); } });
  const menu = fixture.lastRenderedMenu();
  const target = menu.flatModels.find((entry) => entry.model.modelId === "gpt-5.1-codex-mini");
  await menu.selectModel(target.provider, "gpt-5.1-codex-mini");
  assert.equal(configured.length, 1);
  assert.deepEqual(configured[0], { mode: "agent", modelId: "gpt-5.1-codex-mini", thinkingLevel: "off" });
  assert.ok(!("providerId" in configured[0]), "no local provider id crosses the wire");
});

test("a busy Perch session gets a clear refusal instead of a switch", async () => {
  initialize();
  seed({ sessions: [perchSession], activeSessionId: perchSession.id, remoteModelCatalogs: { [hostKey]: catalog } });
  bridge(() => ({}));
  const configured = [];
  await fixture.renderMenu({ hostKey, modelId: "gpt-5.1-codex", sessionId: perchSession.id, blocked: true, blockedMessage: "Wait for the current task to finish before switching models.", configureActiveSession: async (config) => { configured.push(config); } });
  const menu = fixture.lastRenderedMenu();
  await menu.selectModel(menu.flatModels[0].provider, "gpt-5.1-codex-mini");
  assert.equal(configured.length, 0, "no configure call while the session is busy");
  assert.ok(useAppStore.getState().toasts.some((toast) => toast.message.includes("finish before switching")), "the refusal explains itself");
});

test("a RACP remote session never issues sessionConfigure from the store", async () => {
  initialize();
  useAppStore.setState({ sessions: [racpSession], activeSessionId: racpSession.id });
  const calls = bridge(() => ({}));
  await useAppStore.getState().configureActiveSession({ mode: "agent", modelId: "gpt-5.1-codex-mini", thinkingLevel: "off" });
  assert.ok(!calls.some((call) => call.channel === IPC.invoke.sessionConfigure), "canConfigureModel: false stays fail-closed");
});
