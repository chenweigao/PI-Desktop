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
import { createRequire, register } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
// The kimi host-level regression below imports main-process TypeScript
// directly; the hook resolves its bundler-style specifiers.
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const root = resolve(here, "../../..");
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
test("review: launcher permission must reach the create IPC", async () => {
  initialize();
  const calls = bridge((channel,input) => {
    if(channel === IPC.invoke.remoteHostCreateSession) return {session: createdSession(input.hostKey,input.projectId)};
    return defaultRead(channel);
  });
  // Exact request shape emitted by RemoteSessionLauncher, forwarded unchanged by Sidebar.
  await useAppStore.getState().createRemoteSession({hostKey:"perch-a",cwd:"/acceptance",remoteProvider:"omp",permissionMode:"write"});
  const request=calls.find(call=>call.channel===IPC.invoke.remoteHostCreateSession).input;
  console.log("REVIEW_PERMISSION_PAYLOAD", JSON.stringify(request));
  assert.equal(request.permissionMode,"write","selected launcher permission was lost before IPC");
});

test("review: catalog refresh must retain active remote permission", async () => {
  initialize();
  const listed=createdSession("perch-a","/acceptance");
  const permission={selected:"write",options:["always-ask","write","yolo"],scope:"new-session"};
  useAppStore.setState({sessions:[{...listed,remotePermission:permission}],activeSessionId:listed.id});
  // Both production host.summaries() currently omit remotePermission.
  bridge(channel=>channel===IPC.invoke.sessionList?{sessions:[listed],runningSessionIds:[]}:defaultRead(channel));
  await useAppStore.getState().refreshSessions();
  assert.deepEqual(useAppStore.getState().sessions.find(s=>s.id===listed.id).remotePermission,permission,"catalog refresh removed the permission capability");
});

test("review: project-based creation carries the chosen permission mode to the IPC", async () => {
  initialize();
  const calls = bridge((channel, input) => {
    if (channel === IPC.invoke.remoteHostCreateSession) return { session: createdSession(input.hostKey, input.projectId) };
    return defaultRead(channel);
  });
  await useAppStore.getState().newSession({
    remoteProject: { hostKey: "perch-a", projectId: "/acceptance", label: "acceptance" },
    remoteProvider: "omp", remotePermissionMode: "yolo",
  });
  const request = calls.find((call) => call.channel === IPC.invoke.remoteHostCreateSession).input;
  assert.equal(request.permissionMode, "yolo", "project-flow permission was lost before IPC");
  assert.equal(request.provider, "omp");
});

test("review: kimi host summaries carry the permission capability, pending next-message choice wins", async () => {
  const { createKimiHost } = await import("../electron/main/remote/kimi/kimi-host.ts");
  const { createKimiClient } = await import("../electron/main/remote/kimi/kimi-client.ts");
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const prompts = [];
  // The fake persists created sessions, like the real service does: a list
  // right after a create must already contain the new row.
  const store = new Map([["k1", { id: "k1", title: "k1", agent_config: { permission_mode: "manual" }, metadata: { cwd: "/srv" } }]]);
  const server = createServer(async (req, res) => {
    const reply = (code, data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ code, msg: "ok", data })); };
    const url = new URL(req.url, "http://x");
    const body = req.method === "POST" ? JSON.parse(await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b || "{}")); })) : {};
    if (url.pathname === "/api/v1/sessions" && req.method === "GET") return reply(0, { items: [...store.values()], has_more: false });
    if (url.pathname === "/api/v1/sessions" && req.method === "POST") {
      const id = `k${store.size + 1}`;
      const created = { id, title: body.title ?? "k", agent_config: {}, metadata: { cwd: body.metadata?.cwd } };
      store.set(id, created);
      return reply(0, created);
    }
    const m = url.pathname.match(/^\/api\/v1\/sessions\/([^/:]+)(.*)$/);
    if (m && req.method === "GET" && m[2] === "") return reply(0, { ...(store.get(m[1]) ?? { id: m[1], title: "k", metadata: { cwd: "/srv" } }), busy: false });
    if (m && req.method === "GET" && m[2] === "/snapshot") return reply(0, { as_of_seq: 1, epoch: "e1", session: { id: m[1], busy: false, agent_config: {}, metadata: { cwd: "/srv" } }, messages: { items: [], has_more: false }, pending_approvals: [], pending_questions: [] });
    if (m && req.method === "POST" && m[2] === "/prompts") { prompts.push(body); return reply(0, { prompt_id: body.prompt_id, status: "running" }); }
    return reply(40404, null, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const { createBackendRouter, makeRemoteSessionId } = await import("../electron/main/remote/backend-router.ts");
  const router = createBackendRouter();
  const host = createKimiHost({
    hostKey: "kimi-t", label: "Kimi T", router,
    ssh: { host: "127.0.0.1", remotePort: port },
    discoverEndpoint: async () => ({ port, token: "t" }),
    // No SSH in this test: the tunnel forward maps straight onto the fake
    // in-process service port, exactly the shape the production tunnel yields.
    buildTransport: () => ({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execWithInput: async () => ({ stdout: "", stderr: "", code: 0 }),
      forward: async () => ({ localPort: port, close: async () => {} }),
      dispose: () => {},
    }),
    emit: () => undefined, log: () => undefined,
  });
  try {
    await host.connect();
    await host.sessions();
    const created = await host.createSession({ cwd: "/srv", title: "t", permissionMode: "yolo" });
    // List rows carry the capability; a pending next-message choice overrides
    // the service's last-applied value instead of vanishing on refresh.
    const listed = host.summaries().find((s) => s.id.endsWith(":k1"));
    assert.deepEqual(listed.remotePermission, { selected: "manual", options: ["manual", "yolo", "auto"], scope: "next-message" });
    const createdRow = host.summaries().find((s) => s.id.endsWith(":k2"));
    assert.equal(createdRow.remotePermission.selected, "yolo", "creation-time choice survives on the list row");
    assert.equal(created.id, "k2");
    const promptResult = await router.route(IPC.invoke.agentPrompt, [{ sessionId: makeRemoteSessionId("kimi-t", "k2"), content: "hi", messageId: "m1" }]);
    assert.equal(prompts.at(-1).permission_mode, "yolo", "next prompt carries the chosen mode");
    assert.equal(promptResult.remote, true);
    // The PI placeholder ("ask") at creation means "the runtime default": it
    // must not be forwarded as a literal mode nor fail after creation.
    const defaulted = await host.createSession({ cwd: "/srv", title: "t2", permissionMode: "ask" });
    assert.equal(defaulted.id, "k3");
    const row3 = host.summaries().find((s) => s.id.endsWith(":k3"));
    assert.equal(row3.remotePermission.selected, "manual", "placeholder maps to the kimi default");
    await router.route(IPC.invoke.agentPrompt, [{ sessionId: makeRemoteSessionId("kimi-t", "k3"), content: "hi", messageId: "m2" }]);
    assert.equal(prompts.at(-1).permission_mode, undefined, "placeholder never reaches the wire");
    // A string-addressed configure returns the renderer-visible id, so a
    // deferred flush merges onto the right row.
    const configured = await router.route(IPC.invoke.sessionConfigure, [makeRemoteSessionId("kimi-t", "k3"), { permissionMode: "auto" }]);
    assert.equal(configured.value.session.id, "remote:kimi-t:k3");
  } finally {
    await host.close();
    server.close();
  }
});

test("review: selecting an idle remote session reads its detail, never commits an empty pane", async () => {
  initialize();
  const idle = createdSession("perch-a", "/srv/idle", "s-idle");
  useAppStore.setState({ sessions: [idle] });
  const calls = bridge((channel) => {
    if (channel === IPC.invoke.sessionGet) return { session: { ...idle, messages: [{ id: "m1", role: "assistant", content: "real history", createdAt: at(2) }] } };
    return defaultRead(channel);
  });
  await useAppStore.getState().selectSession(idle.id);
  assert.ok(
    calls.some((call) => call.channel === IPC.invoke.sessionGet && call.input?.id === idle.id),
    "a remote session with no cached transcript must read its real detail",
  );

  // And when the detail read fails, the pane must not have committed an empty
  // transcript over real history first.
  initialize();
  const failing = createdSession("perch-a", "/srv/idle", "s-idle-fail");
  useAppStore.setState({ sessions: [failing] });
  bridge((channel) => {
    if (channel === IPC.invoke.sessionGet) throw new Error("host dropped");
    return defaultRead(channel);
  });
  await useAppStore.getState().selectSession(failing.id).catch(() => undefined);
  const cached = useAppStore.getState().sessionHistory[failing.id];
  assert.notEqual(cached?.hasMoreBefore, false, "an empty window was committed over real history");
});

test("kimi inventory follows has_more pages so late sessions still get backends", async () => {
  const { createKimiHost } = await import("../electron/main/remote/kimi/kimi-host.ts");
  const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const all = Array.from({ length: 120 }, (_, i) => ({ id: `s${String(i).padStart(3, "0")}`, title: `s${i}`, metadata: { cwd: "/srv" } }));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const reply = (code, data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ code, msg: "ok", data })); };
    if (url.pathname === "/api/v1/sessions" && req.method === "GET") {
      const before = url.searchParams.get("before");
      const start = before ? all.findIndex((s) => s.id === before) + 1 : 0;
      const items = all.slice(start, start + 100);
      return reply(0, { items, has_more: start + 100 < all.length });
    }
    const m = url.pathname.match(/^\/api\/v1\/sessions\/([^/:]+)\/snapshot$/);
    if (m) return reply(0, { as_of_seq: 1, epoch: "e1", session: { id: m[1], busy: false, metadata: { cwd: "/srv" } }, messages: { items: [], has_more: false }, pending_approvals: [], pending_questions: [] });
    const one = url.pathname.match(/^\/api\/v1\/sessions\/([^/:]+)$/);
    if (one && req.method === "GET") {
      const found = all.find((s) => s.id === one[1]);
      return found ? reply(0, { ...found, busy: false }) : reply(40404, null, 404);
    }
    return reply(40404, null, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const router = createBackendRouter();
  const host = createKimiHost({
    hostKey: "kimi-paged", label: "Kimi paged", router,
    ssh: { host: "127.0.0.1", remotePort: port },
    discoverEndpoint: async () => ({ port, token: "t" }),
    buildTransport: () => ({ exec: async () => ({ stdout: "", stderr: "", code: 0 }), execWithInput: async () => ({ stdout: "", stderr: "", code: 0 }), forward: async () => ({ localPort: port, close: async () => {} }), dispose: () => {} }),
    emit: () => undefined, log: () => undefined,
  });
  try {
    await host.connect();
    const summaries = host.summaries();
    assert.equal(summaries.length, 120, "all pages read");
    assert.ok(summaries.some((s) => s.id === "remote:kimi-paged:s119"), "the second page's sessions are listed");
    // A page-2 session routes to a live backend.
    const status = await router.route(IPC.invoke.agentGetStatus, [{ sessionId: "remote:kimi-paged:s119" }]);
    assert.equal(status.remote, true, "second-page session has a backend");
  } finally {
    await host.close();
    server.close();
  }
});
