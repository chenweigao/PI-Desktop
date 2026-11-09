/**
 * Direct remote sessions (Perch/Kimi): the sidebar's "new remote session"
 * entry creates a session on a host without registering a project. The store
 * action defaults the cwd to the remote home (browse with no path), dedupes
 * concurrent creates, and reuses an existing empty session at the same cwd.
 * Sidebar markup must carry host/runtime markers and never leak the internal
 * `remote-project:` scope key; ungrouped remote rows render in both layouts.
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
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "remote-direct-"));
const output = join(temp, "fixture.mjs");

// Storage must exist before the bundle evaluates: sidebar preferences load at
// import time, exactly like an app start.
const storageData = new Map();
globalThis.localStorage = {
  getItem: (key) => (storageData.has(key) ? storageData.get(key) : null),
  setItem: (key, value) => void storageData.set(key, String(value)),
  removeItem: (key) => void storageData.delete(key),
  clear: () => storageData.clear(),
};

await build({
  stdin: { contents: `
    export { useAppStore } from './apps/desktop/src/stores/app-store';
    export { directRemoteHosts, catalogAgents } from './apps/desktop/src/lib/remote-direct-session';
    export { Sidebar } from './apps/desktop/src/components/Sidebar';
    export { RemoteSessionLauncher } from './apps/desktop/src/components/remote/RemoteSessionLauncher';
    export { IPC } from '@pi-desktop/shared';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import i18n from 'i18next';
    import { initReactI18next } from 'react-i18next';
    import { remoteEn } from './apps/desktop/src/locales/remote';
    import { catalogs } from '@pi-desktop/i18n';
    import { Sidebar } from './apps/desktop/src/components/Sidebar';
    import { RemoteSessionLauncher } from './apps/desktop/src/components/remote/RemoteSessionLauncher';
    export async function renderSidebar() {
      await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en',
        resources: { en: { remote: remoteEn, translation: catalogs.en } },
        interpolation: { escapeValue: false } });
      return renderToStaticMarkup(React.createElement(Sidebar, {
        onToggleSidebar() {}, sidebarToggleShortcut: '', sidebarWidth: 275,
        onWidthChange() {}, onWidthCommit() {}, onResizeCollapse() {},
      }));
    }
    export async function renderLauncher() {
      await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en',
        resources: { en: { remote: remoteEn, translation: catalogs.en } },
        interpolation: { escapeValue: false } });
      return renderToStaticMarkup(React.createElement(RemoteSessionLauncher, {
        onCreate: async () => {}, onClose() {},
      }));
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
const { useAppStore, directRemoteHosts, catalogAgents, IPC } = fixture;
test.after(() => rm(temp, { recursive: true, force: true }));

const CAPS = { canPrompt: true, canStop: true, canRefresh: true, canReadWorkspace: true, canConfigureModel: true };
const at = (minute) => `2026-02-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const perchHost = { hostKey: "perch-a", label: "Perch A", url: "ws://127.0.0.1:1", connected: true, backend: "perch" };
const kimiHost = { hostKey: "kimi-b", label: "Kimi B", url: "ws://127.0.0.1:2", connected: true, backend: "kimi" };
const racpHost = { hostKey: "racp-c", label: "RACP C", url: "ws://127.0.0.1:3", connected: true };
const remoteSession = (id, hostKey, hostLabel, projectId, updatedAt, overrides = {}) => ({
  id, source: "remote", title: id, remoteHostKey: hostKey, remoteHostLabel: hostLabel,
  ...(projectId ? { remoteProjectId: projectId, remoteWorkspaceLabel: projectId.split("/").pop() } : {}),
  mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  capabilities: { ...CAPS }, createdAt: at(0), updatedAt, messageCount: 0,
  ...overrides,
});
const createdSession = (hostKey, cwd, suffix = "s1") => remoteSession(
  `remote:${hostKey}:${suffix}`, hostKey, "Perch A", cwd, at(1), { title: "", remoteAgent: "omp" },
);

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function bridge(handler) {
  const calls = [];
  globalThis.window = { matchMedia: () => ({ matches: false }), piDesktop: { platform: "linux", on: () => () => {}, invoke: async (channel, ...args) => {
    calls.push({ channel, input: args[0] }); return { ok: true, data: await handler(channel, args[0]) };
  } } };
  return calls;
}
function initialize() {
  useAppStore.setState({ sessions: [], activeSessionId: undefined, selectingSessionId: undefined, messages: [], retainedSessionIds: [], retainedTranscripts: {}, sessionHistory: {}, sessionMeta: {}, runningSessions: {}, pendingPlans: {}, pendingPermissions: {}, pendingAsks: {}, planningStates: {}, providers: [], workPanelContexts: {}, workPanelTabs: [], activeWorkPanelTabId: null, workspace: { path: "/local/private", name: "Local only" }, activeProjectPath: "/local/private", page: "chat", settings: { defaultMode: "agent" } });
}
function defaultRead(channel) {
  if (channel === IPC.invoke.sessionGet) return { session: { ...createdSession("perch-a", "/home/dev"), messages: [] } };
  if (channel === IPC.invoke.plansPending) return { plans: [] };
  if (channel === IPC.invoke.notificationAcknowledgeSessionOutcome) return { ok: true };
  return {};
}

test("direct hosts are exactly the cwd-based channels (Perch/Kimi), RACP excluded", () => {
  assert.deepEqual(directRemoteHosts([perchHost, kimiHost, racpHost]).map((host) => host.hostKey), ["perch-a", "kimi-b"]);
  assert.deepEqual(catalogAgents([{ agent: "omp" }, { agent: "codex" }, { agent: "omp" }, { agent: "" }]), ["omp", "codex"]);
  assert.deepEqual(catalogAgents(undefined), []);
});

test("createRemoteSession defaults the cwd to the remote home and selects the new session", async () => {
  initialize();
  const calls = bridge((channel, input) => {
    if (channel === IPC.invoke.remoteHostBrowseProjects) return { path: "/home/dev", entries: [] };
    if (channel === IPC.invoke.remoteHostCreateSession) return { session: createdSession(input.hostKey, input.projectId) };
    return defaultRead(channel);
  });
  await useAppStore.getState().createRemoteSession({ hostKey: "perch-a" });
  const browse = calls.find((call) => call.channel === IPC.invoke.remoteHostBrowseProjects);
  assert.deepEqual(browse.input, { hostKey: "perch-a" }, "home resolution sends no path");
  const create = calls.find((call) => call.channel === IPC.invoke.remoteHostCreateSession);
  assert.equal(create.input.projectId, "/home/dev", "the resolved home becomes the session cwd");
  assert.equal(create.input.hostKey, "perch-a");
  const state = useAppStore.getState();
  assert.equal(state.activeSessionId, "remote:perch-a:s1");
  assert.equal(state.sessions[0].remoteProjectId, "/home/dev");
  assert.equal(state.workspace.path, "/local/private", "no local project activation");
});

test("an explicit cwd skips the home browse and reaches the host unchanged", async () => {
  initialize();
  const calls = bridge((channel, input) => {
    if (channel === IPC.invoke.remoteHostCreateSession) return { session: createdSession(input.hostKey, input.projectId) };
    return defaultRead(channel);
  });
  await useAppStore.getState().createRemoteSession({ hostKey: "perch-a", cwd: "/srv/work", remoteProvider: "codex" });
  assert.ok(!calls.some((call) => call.channel === IPC.invoke.remoteHostBrowseProjects));
  const create = calls.find((call) => call.channel === IPC.invoke.remoteHostCreateSession);
  assert.equal(create.input.projectId, "/srv/work");
  assert.equal(create.input.provider, "codex");
});

test("concurrent direct creates on one host collapse into a single remote create", async () => {
  initialize();
  const home = deferred();
  const calls = bridge((channel, input) => {
    if (channel === IPC.invoke.remoteHostBrowseProjects) return home.promise;
    if (channel === IPC.invoke.remoteHostCreateSession) return { session: createdSession(input.hostKey, input.projectId) };
    return defaultRead(channel);
  });
  const first = useAppStore.getState().createRemoteSession({ hostKey: "perch-a" });
  const second = useAppStore.getState().createRemoteSession({ hostKey: "perch-a" });
  home.resolve({ path: "/home/dev", entries: [] });
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call.channel === IPC.invoke.remoteHostCreateSession).length, 1);
});

test("an existing empty session at the resolved cwd is reused, not duplicated", async () => {
  initialize();
  const existing = remoteSession("remote:perch-a:old", "perch-a", "Perch A", "/home/dev", at(5), { title: "" });
  useAppStore.setState({ sessions: [existing] });
  const calls = bridge((channel, input) => {
    if (channel === IPC.invoke.remoteHostBrowseProjects) return { path: "/home/dev", entries: [] };
    if (channel === IPC.invoke.sessionGet) return { session: { ...existing, messages: [] } };
    if (channel === IPC.invoke.remoteHostCreateSession) throw new Error("must not create over an empty slot");
    return defaultRead(channel);
  });
  await useAppStore.getState().createRemoteSession({ hostKey: "perch-a" });
  assert.equal(useAppStore.getState().activeSessionId, existing.id);
  assert.equal(useAppStore.getState().sessions.length, 1);
  assert.ok(!calls.some((call) => call.channel === IPC.invoke.remoteHostCreateSession));
});

function seedSidebar(overrides = {}) {
  globalThis.document = { documentElement: { dataset: { theme: "light" } } };
  const state = {
    sessions: [], sessionMeta: {}, projectMeta: {}, openProjectPaths: [], openProjects: [],
    workspace: null, activeProjectPath: null, activeSessionId: null, selectingSessionId: null,
    page: "chat", settings: {}, projectCollapsed: {},
    sessionView: { sort: "recent", archived: false, mode: "projects" },
    runningSessions: {}, pendingPermissions: {}, sessionOutcomes: {},
    ...overrides,
  };
  Object.assign(useAppStore.getInitialState(), state);
  useAppStore.setState(state);
}
const rows = (html) => [...html.matchAll(/data-sidebar-session-row="([^"]+)"/g)].map((match) => match[1]);

test("projects view: direct entry button, agent chip on rows, ungrouped remote row listed, no scope-key leak", async () => {
  seedSidebar({
    sessions: [
      remoteSession("remote:perch-a:one", "perch-a", "Perch A", "/home/x/code", at(30), { remoteAgent: "codex" }),
      remoteSession("remote:kimi-b:free", "kimi-b", "Kimi B", undefined, at(20), { title: "Loose remote" }),
    ],
  });
  const html = await fixture.renderSidebar();
  assert.match(html, /data-action="new-remote-session"/, "direct entry button in the sessions toolbar");
  // Host chip + runtime chip ride on the grouped remote row.
  const row = html.match(/data-sidebar-session-row="remote:perch-a:one"[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.match(row, />Perch A</);
  assert.match(row, /thread-item-agent[^>]*>codex</, "runtime chip shows remoteAgent");
  // An ungrouped remote session (no remoteProjectId) still lists in projects view.
  assert.ok(rows(html).includes("remote:kimi-b:free"));
  // The internal pending-request scope key never reaches the DOM.
  assert.doesNotMatch(html, /remote-project:/);
});

test("flat view: the same remote rows render in one list with host/runtime markers", async () => {
  seedSidebar({
    sessionView: { sort: "recent", archived: false, mode: "flat" },
    sessions: [
      remoteSession("remote:perch-a:one", "perch-a", "Perch A", "/home/x/code", at(30), { remoteAgent: "omp" }),
      remoteSession("remote:kimi-b:free", "kimi-b", "Kimi B", undefined, at(40), { title: "Loose remote" }),
    ],
  });
  const html = await fixture.renderSidebar();
  assert.match(html, /data-sidebar-flat-list/);
  assert.match(html, /data-action="new-remote-session"/, "entry stays available in flat mode");
  assert.ok(rows(html).includes("remote:perch-a:one"));
  assert.ok(rows(html).includes("remote:kimi-b:free"));
  assert.doesNotMatch(html, /remote-project:/);
});

test("launcher panel opens in a loading state and never renders a scope key", async () => {
  seedSidebar();
  const html = await fixture.renderLauncher();
  assert.match(html, /sidebar-remote-launch/);
  assert.match(html, /role="status"/, "hosts load announces itself");
  assert.doesNotMatch(html, /remote-project:/);
});
