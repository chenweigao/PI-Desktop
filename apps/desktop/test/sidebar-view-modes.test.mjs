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
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "sidebar-view-modes-"));
const output = join(temp, "fixture.mjs");

// Storage must exist before the bundle evaluates: the store module loads
// sidebar preferences (including the view mode) at import time, exactly like
// an app start.
const storageData = new Map();
globalThis.localStorage = {
  getItem: (key) => (storageData.has(key) ? storageData.get(key) : null),
  setItem: (key, value) => void storageData.set(key, String(value)),
  removeItem: (key) => void storageData.delete(key),
  clear: () => storageData.clear(),
};
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  piDesktop: {
    platform: "linux",
    on: () => () => {},
    invoke: async () => ({ ok: true, data: {} }),
  },
};

await build({
  stdin: {
    contents: `
      import { Sidebar } from './apps/desktop/src/components/Sidebar';
      export { Sidebar };
      export { useAppStore } from './apps/desktop/src/stores/app-store';
      export {
        buildSidebarRemoteGroups,
        dedupeSessionsById,
        remoteProjectDisplayParts,
        sessionOwningLabel,
      } from './apps/desktop/src/lib/sidebar-project-model';
      export {
        loadSidebarPreferences,
        SIDEBAR_PREFERENCES_KEY,
      } from './apps/desktop/src/lib/sidebar-preferences';
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import i18n from 'i18next';
      import { initReactI18next } from 'react-i18next';
      import { remoteEn } from './apps/desktop/src/locales/remote';
      import { catalogs } from '@pi-desktop/i18n';
      export async function renderSidebar() {
        await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en',
          resources: { en: { remote: remoteEn, translation: catalogs.en } },
          interpolation: { escapeValue: false } });
        return renderToStaticMarkup(React.createElement(Sidebar, {
          onToggleSidebar() {}, sidebarToggleShortcut: "", sidebarWidth: 275,
          onWidthChange() {}, onWidthCommit() {}, onResizeCollapse() {},
        }));
      }
    `,
    resolveDir: root,
    loader: "tsx",
  },
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  alias: {
    "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
    i18next: join(root, "apps/desktop/node_modules/i18next"),
  },
  loader: { ".css": "empty", ".gif": "dataurl", ".png": "dataurl" },
  plugins: [{
    name: "fixture-vite-url",
    setup(builder) {
      builder.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "fixture-url" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture-url" }, ({ path }) => ({
        contents: `export default ${JSON.stringify(path)};`,
        loader: "js",
      }));
    },
  }],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const fixture = await import(pathToFileURL(output).href);
const {
  Sidebar: _Sidebar,
  useAppStore,
  buildSidebarRemoteGroups,
  dedupeSessionsById,
  remoteProjectDisplayParts,
  sessionOwningLabel,
  loadSidebarPreferences,
  SIDEBAR_PREFERENCES_KEY,
} = fixture;
test.after(() => rm(temp, { recursive: true, force: true }));

const CAPS = {
  canPrompt: true, canStop: true, canRefresh: true, canReadWorkspace: true,
  canConfigureModel: false, canAttach: false, canSteer: false,
  canEditMessages: false, canUseLocalTools: false, canUseTerminal: false,
};
const at = (minute) => `2026-02-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const localSession = (id, projectPath, updatedAt, title = id) => ({
  id, title, projectPath, mode: "agent", createdAt: at(0), updatedAt,
});
const remoteSession = (id, hostKey, hostLabel, projectId, updatedAt, overrides = {}) => ({
  id, source: "remote", title: id, remoteHostKey: hostKey, remoteHostLabel: hostLabel,
  remoteProjectId: projectId, remoteWorkspaceLabel: projectId.split("/").pop(),
  mode: "agent", permissionMode: "ask", thinkingLevel: "off",
  capabilities: { ...CAPS }, createdAt: at(0), updatedAt, messageCount: 0,
  ...overrides,
});

function seed(overrides = {}) {
  globalThis.document = { documentElement: { dataset: { theme: "light" } } };
  // renderToStaticMarkup reads zustand's getInitialState as the server
  // snapshot; seed both so SSR and client reads agree.
  const state = {
    sessions: [],
    sessionMeta: {},
    projectMeta: {},
    openProjectPaths: [],
    openProjects: [],
    workspace: null,
    activeProjectPath: null,
    activeSessionId: null,
    selectingSessionId: null,
    page: "chat",
    settings: {},
    projectCollapsed: {},
    sessionView: { sort: "recent", archived: false, mode: "projects" },
    runningSessions: {},
    pendingPermissions: {},
    sessionOutcomes: {},
    ...overrides,
  };
  Object.assign(useAppStore.getInitialState(), state);
  useAppStore.setState(state);
}

const rows = (html) =>
  [...html.matchAll(/data-sidebar-session-row="([^"]+)"/g)].map((match) => match[1]);
const remoteGroupKeys = (html) =>
  [...html.matchAll(/data-sidebar-remote-project="([^"]+)"/g)].map((match) =>
    match[1].replaceAll("&quot;", '"'),
  );

test("remote group keys distinguish host and full path; same basenames never mix", () => {
  const sessions = [
    remoteSession("a-old", "perch-a", "Perch A", "/home/x/code", at(1)),
    remoteSession("a-new", "perch-a", "Perch A", "/home/x/code", at(9)),
    remoteSession("b", "perch-b", "Perch B", "/home/x/code", at(8)),
    remoteSession("c", "perch-a", "Perch A", "/srv/repos/code", at(7)),
  ];
  const groups = buildSidebarRemoteGroups(sessions, (l, r) => r.updatedAt.localeCompare(l.updatedAt));
  assert.equal(groups.length, 3);
  const byKey = new Map(groups.map((group) => [group.project.key, group]));
  assert.ok(byKey.has('["perch-a","/home/x/code"]'));
  assert.ok(byKey.has('["perch-b","/home/x/code"]'));
  assert.ok(byKey.has('["perch-a","/srv/repos/code"]'));
  // Same (host, path) sessions share one group, sorted inside it.
  assert.deepEqual(
    byKey.get('["perch-a","/home/x/code"]').sessions.map((item) => item.id),
    ["a-new", "a-old"],
  );
  // Groups order by latest activity, not by host or label.
  assert.deepEqual(
    groups.map((group) => group.project.key),
    ['["perch-a","/home/x/code"]', '["perch-b","/home/x/code"]', '["perch-a","/srv/repos/code"]'],
  );
  // Basenames stay display data: the meaningful name folds the parent in.
  assert.equal(byKey.get('["perch-a","/home/x/code"]').project.name, "x/code");
  assert.equal(byKey.get('["perch-a","/srv/repos/code"]').project.name, "repos/code");
  // Offline hosts keep their rows but report not connected.
  const offline = buildSidebarRemoteGroups(
    [remoteSession("off", "perch-c", "Perch C", "/home/x/app", at(2), {
      capabilities: { ...CAPS, canPrompt: false },
    })],
    (l, r) => r.updatedAt.localeCompare(l.updatedAt),
  );
  assert.equal(offline[0].project.connected, false);
});

test("remote project display names survive useless basenames and home roots", () => {
  assert.deepEqual(remoteProjectDisplayParts("/home/weigao.cwg/code"), {
    name: "weigao.cwg/code", qualifier: "/home",
  });
  assert.deepEqual(remoteProjectDisplayParts("/home/weigao.cwg"), {
    name: "/home/weigao.cwg", qualifier: "",
  });
  assert.deepEqual(remoteProjectDisplayParts("/tmp"), { name: "/tmp", qualifier: "" });
  assert.deepEqual(remoteProjectDisplayParts("/home/x/work/perch"), {
    name: "perch", qualifier: "/home/x/work",
  });
  assert.deepEqual(remoteProjectDisplayParts("C:\\Users\\me\\app"), {
    name: "me/app", qualifier: "C:/Users",
  });
  // Opaque RACP ids pass through untouched.
  assert.deepEqual(remoteProjectDisplayParts("project-42", "Opaque"), {
    name: "project-42", qualifier: "",
  });
  assert.deepEqual(remoteProjectDisplayParts("", "Fallback"), {
    name: "Fallback", qualifier: "",
  });
});

test("owning labels mark host and project; duplicate ids collapse to one row", () => {
  const remote = remoteSession("r", "perch-a", "Perch A", "/home/x/code", at(1));
  assert.equal(
    sessionOwningLabel(remote, () => undefined),
    "Perch A · x/code",
  );
  assert.equal(
    sessionOwningLabel(localSession("l", "/work/app", at(1)), () => "Work app"),
    "Work app",
  );
  assert.equal(sessionOwningLabel(localSession("t", null, at(1)), () => undefined), undefined);
  const dupes = dedupeSessionsById([remote, { ...remote, title: "copy" }]);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].title, "r");
});

test("grouped mode: one entry per remote project, local groups stay local, collapse persists", async () => {
  const staleRemote = remoteSession(
    "remote:perch-a:stale", "perch-a", "Perch A", "/home/weigao.cwg/code", at(50),
    { projectPath: "/work/app" },
  );
  seed({
    sessions: [
      localSession("local-a", "/work/app", at(10), "Local task"),
      staleRemote,
      remoteSession("remote:perch-b:one", "perch-b", "Perch B", "/home/x/code", at(40)),
    ],
    openProjectPaths: ["/work/app"],
    projectCollapsed: { 'remote:["perch-a","/home/weigao.cwg/code"]': true },
  });
  const html = await fixture.renderSidebar();
  // The stale projectPath must not leak the remote row into the local group…
  const localGroup = html.match(/data-sidebar-project-group="\/work\/app"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.deepEqual(rows(localGroup), ["local-a"]);
  // …and the remote project appears exactly once, under its own key.
  assert.deepEqual(remoteGroupKeys(html), [
    '["perch-a","/home/weigao.cwg/code"]',
    '["perch-b","/home/x/code"]',
  ]);
  assert.equal(
    rows(html).filter((id) => id === "remote:perch-a:stale").length,
    1,
    "one remote project, one sidebar entry",
  );
  // Host chip + persisted collapse on the remote group header.
  const remoteA = html.match(
    /<section[^>]*data-sidebar-remote-project="\[&quot;perch-a&quot;[\s\S]*?<\/section>/,
  )?.[0] ?? "";
  assert.match(remoteA, />Perch A</);
  assert.match(remoteA, /class="[^"]*is-collapsed/);
  assert.match(remoteA, /aria-hidden="true"/);
  assert.match(remoteA, /sidebar-session-group-add/);
  const remoteB = html.match(
    /<section[^>]*data-sidebar-remote-project="\[&quot;perch-b&quot;[\s\S]*?<\/section>/,
  )?.[0] ?? "";
  assert.match(remoteB, /aria-expanded="true"/);
  assert.match(remoteB, /sidebar-session-group-name">x\/code</);
});

test("grouped mode: colliding names across hosts surface the parent path qualifier", async () => {
  seed({
    sessions: [
      remoteSession("remote:perch-a:one", "perch-a", "Perch A", "/home/x/code", at(40)),
      remoteSession("remote:perch-b:one", "perch-b", "Perch B", "/opt/x/code", at(30)),
    ],
  });
  const html = await fixture.renderSidebar();
  const qualifiers = [...html.matchAll(/sidebar-session-group-qualifier"[^>]*>([^<]+)</g)]
    .map((match) => match[1]);
  assert.deepEqual(qualifiers.sort(), ["/home", "/opt"]);
});

test("flat mode: one sorted list with host/agent markers and owning project labels", async () => {
  seed({
    sessionView: { sort: "recent", archived: false, mode: "flat" },
    sessions: [
      localSession("local-old", "/work/app", at(10), "Alpha local"),
      localSession("local-new", "/srv/app", at(45), "Beta local"),
      localSession("temp", null, at(20), "Loose chat"),
      remoteSession("remote:perch-a:one", "perch-a", "Perch A", "/home/x/code", at(30)),
      remoteSession("remote:perch-b:one", "perch-b", "Perch B", "/srv/repos/code", at(40)),
    ],
    openProjectPaths: ["/work/app", "/srv/app"],
  });
  const html = await fixture.renderSidebar();
  assert.match(html, /data-sidebar-flat-list/);
  // No group chrome in flat mode…
  assert.equal(remoteGroupKeys(html).length, 0);
  assert.doesNotMatch(html, /data-sidebar-project-group=/);
  // …just one list, ordered by recency across local and remote rows.
  assert.deepEqual(rows(html), [
    "local-new",
    "remote:perch-b:one",
    "remote:perch-a:one",
    "temp",
    "local-old",
  ]);
  const flatList = html.match(/data-sidebar-flat-list[\s\S]*$/)?.[0] ?? "";
  // Host markers ride on the remote rows, project labels on the owned rows.
  assert.match(flatList, />Perch A</);
  assert.match(flatList, />Perch B</);
  const owning = [...flatList.matchAll(/thread-item-project">([^<]+)</g)].map((m) => m[1]);
  assert.ok(owning.includes("Perch A · x/code"));
  assert.ok(owning.includes("Perch B · repos/code"));
  assert.ok(owning.includes("app"));
  assert.ok(owning.includes("Temporary"));
});

test("flat mode honours the shared session sort and keeps pins out of the flat list", async () => {
  seed({
    sessionView: { sort: "name", archived: false, mode: "flat" },
    sessions: [
      localSession("b-local", "/work/app", at(40), "Beta"),
      remoteSession("remote:perch-a:one", "perch-a", "Perch A", "/home/x/code", at(30), { title: "Alpha remote" }),
      localSession("pinned", "/work/app", at(50), "Gamma pinned"),
    ],
    openProjectPaths: ["/work/app"],
    sessionMeta: { pinned: { pinned: true } },
  });
  const html = await fixture.renderSidebar();
  // The pin lives in the pinned section only; the flat list is name-sorted.
  assert.deepEqual(rows(html), ["pinned", "remote:perch-a:one", "b-local"]);
  assert.match(html, /data-sidebar-session-section="pinned"/);
});

test("view mode choice persists across a restart through sidebar preferences", () => {
  storageData.clear();
  assert.equal(loadSidebarPreferences().sessionView.mode, "projects");
  seed();
  useAppStore.getState().setSessionViewMode("flat");
  assert.equal(useAppStore.getState().sessionView.mode, "flat");
  const stored = JSON.parse(storageData.get(SIDEBAR_PREFERENCES_KEY));
  assert.equal(stored.sessionView.mode, "flat");
  // A fresh read stands in for the next app start.
  assert.equal(loadSidebarPreferences().sessionView.mode, "flat");
  useAppStore.getState().setSessionViewMode("projects");
  assert.equal(loadSidebarPreferences().sessionView.mode, "projects");
  // Unknown values from older or foreign builds fall back to the default.
  storageData.set(SIDEBAR_PREFERENCES_KEY, JSON.stringify({ sessionView: { mode: "grid" } }));
  assert.equal(loadSidebarPreferences().sessionView.mode, "projects");
  storageData.clear();
});
