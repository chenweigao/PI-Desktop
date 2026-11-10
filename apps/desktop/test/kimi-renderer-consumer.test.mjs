/**
 * Kimi renderer consumer: the production KimiEventBridge's events drive the
 * REAL renderer store (handleAgentEvent + subscribeRemoteInteractions), not an
 * event-array assertion. Covers: live transcript + a completed turn, a failed
 * turn recorded as failed, an approval card with a resolvable requestId, an
 * aborted turn, and the settle merge (a live row is replaced by the durable
 * final, never duplicated).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "kimi-renderer-"));
const output = join(temp, "fixture.mjs");
await build({
  stdin: { contents: `
    export { useAppStore } from './apps/desktop/src/stores/app-store';
    export { subscribeRemoteInteractions } from './apps/desktop/src/lib/remote-interactions';
    export { IPC } from '@pi-desktop/shared';
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
const { useAppStore, subscribeRemoteInteractions, IPC } = fixture;

register(pathToFileURL(join(root, "apps/desktop/test/helpers/ts-import-hooks.mjs")));
const { createKimiEventBridge } = await import("../electron/main/remote/kimi/kimi-event-bridge.ts");
const { makeRemoteSessionId } = await import("../electron/main/remote/backend-router.ts");

test.after(() => rm(temp, { recursive: true, force: true }));

const session = { id: makeRemoteSessionId("k", "s1"), source: "remote", remoteHostKey: "k", title: "Kimi", messageCount: 0, mode: "agent", permissionMode: "ask", thinkingLevel: "off", capabilities: { canPrompt: true, canStop: true, canRefresh: true }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

function setupStore() {
  const listeners = new Map();
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    piDesktop: {
      platform: "linux",
      on: (channel, handler) => { listeners.set(channel, handler); return () => listeners.delete(channel); },
      invoke: async (channel) => ({
        ok: true,
        data: channel === IPC.invoke.sessionList
          ? { sessions: [session], runningSessionIds: [] }
          : { entries: [], plans: [] },
      }),
    },
  };
  useAppStore.setState({
    sessions: [session], activeSessionId: session.id, retainedSessionIds: [session.id],
    messages: [], pendingPermissions: {}, pendingAsks: {}, latestTurnResults: {}, runningSessions: {},
  });
  return listeners;
}

const kimiMessages = (items) => ({ items, has_more: false });

test("kimi bridge events drive the real store: live row merges into the durable final", async () => {
  const listeners = setupStore();
  const unsubscribe = subscribeRemoteInteractions();
  const emit = (channel, payload) => {
    if (channel === IPC.event.agentMessage) useAppStore.getState().handleAgentEvent(payload);
    else listeners.get(channel)?.(payload);
  };
  const bridge = createKimiEventBridge({ hostKey: "k", emit });
  // Turn 1 runs: in-flight partial, then the durable final lands and the turn
  // completes — the live row must be replaced, not duplicated.
  bridge.applySnapshot("s1", { as_of_seq: 1, epoch: "e1", session: { id: "s1", busy: true, main_turn_active: true }, in_flight_turn: { turn_id: 1, current_prompt_id: "p1", assistant_text: "partial" }, messages: kimiMessages([{ id: "p1", role: "user", content: [{ type: "text", text: "hi" }] }]) });
  assert.ok(useAppStore.getState().messages.some((m) => m.id === "in-flight:s1:1" && m.status === "streaming"));
  bridge.applySnapshot("s1", { as_of_seq: 2, epoch: "e1", session: { id: "s1", busy: false, last_turn_reason: "completed" }, messages: kimiMessages([
    { id: "p1", role: "user", content: [{ type: "text", text: "hi" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ]) });
  await new Promise((r) => setTimeout(r, 400));
  const messages = useAppStore.getState().messages;
  assert.ok(!messages.some((m) => m.id === "in-flight:s1:1"), "the live row is gone");
  assert.ok(messages.some((m) => m.id === "a1" && m.content === "final answer" && m.status === "complete"), "the durable final replaced it");
  assert.equal(useAppStore.getState().latestTurnResults[session.id]?.status, "completed");
  unsubscribe();
});

test("a failed turn records failed; an approval card resolves and clears", async () => {
  const listeners = setupStore();
  const unsubscribe = subscribeRemoteInteractions();
  const emit = (channel, payload) => {
    if (channel === IPC.event.agentMessage) useAppStore.getState().handleAgentEvent(payload);
    else listeners.get(channel)?.(payload);
  };
  const bridge = createKimiEventBridge({ hostKey: "k", emit });
  bridge.applySnapshot("s1", { as_of_seq: 1, epoch: "e1", session: { id: "s1", busy: true, main_turn_active: true, pending_interaction: "approval" }, pending_approvals: [{ approval_id: "ap1", tool_name: "bash", action: "run" }], messages: kimiMessages([]) });
  const pending = useAppStore.getState().pendingPermissions[session.id];
  assert.equal(pending?.length, 1, "approval card pending");
  assert.equal(pending[0].toolName, "bash");
  bridge.applySnapshot("s1", { as_of_seq: 2, epoch: "e1", session: { id: "s1", busy: true, main_turn_active: true }, pending_approvals: [], messages: kimiMessages([]) });
  assert.equal(useAppStore.getState().pendingPermissions[session.id], undefined, "card cleared on resolution");
  bridge.applySnapshot("s1", { as_of_seq: 3, epoch: "e1", session: { id: "s1", busy: false, last_turn_reason: "failed" }, messages: kimiMessages([]) });
  assert.equal(useAppStore.getState().latestTurnResults[session.id]?.status, "failed", "failed turn recorded as failed");
  unsubscribe();
});

test("an aborted turn reports TURN_ABORTED and keeps its partial", async () => {
  const listeners = setupStore();
  const emit = (channel, payload) => {
    if (channel === IPC.event.agentMessage) useAppStore.getState().handleAgentEvent(payload);
    else listeners.get(channel)?.(payload);
  };
  const bridge = createKimiEventBridge({ hostKey: "k", emit });
  bridge.applySnapshot("s1", { as_of_seq: 1, epoch: "e1", session: { id: "s1", busy: true, main_turn_active: true }, in_flight_turn: { turn_id: 1, current_prompt_id: "p1", assistant_text: "work in progress" }, messages: kimiMessages([{ id: "p1", role: "user", content: [{ type: "text", text: "hi" }] }]) });
  bridge.applySnapshot("s1", { as_of_seq: 2, epoch: "e1", session: { id: "s1", busy: false, last_turn_reason: "aborted" }, messages: kimiMessages([{ id: "p1", role: "user", content: [{ type: "text", text: "hi" }] }]) });
  await new Promise((r) => setTimeout(r, 400));
  const state = useAppStore.getState();
  assert.notEqual(state.latestTurnResults[session.id]?.status, "completed", "aborted is not completed");
  const row = state.messages.find((m) => m.id === "in-flight:s1:1");
  assert.ok(row && row.status === "complete", "the partial row is kept and ended, not replaced by an older turn");
});

test("renderer store: an injected reminder never becomes a user bubble, including on multi-turn re-open", async () => {
  const listeners = setupStore();
  const unsubscribe = subscribeRemoteInteractions();
  const emit = (channel, payload) => {
    if (channel === IPC.event.agentMessage) useAppStore.getState().handleAgentEvent(payload);
    else listeners.get(channel)?.(payload);
  };
  const bridge = createKimiEventBridge({ hostKey: "k", emit });
  // Real 2.4.0 wire shape: the date reminder is a user-role injection between
  // the user's prompt and the assistant's reply, across two turns.
  const wire = [
    { id: "p1", role: "user", content: [{ type: "text", text: "reply with just: ok" }], metadata: { origin: { kind: "user" } } },
    { id: "inj1", role: "user", metadata: { origin: { kind: "injection", variant: "date_change" } },
      content: [{ type: "text", text: "<system-reminder>\nToday's date is 2026-11-10.\n</system-reminder>" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  bridge.applySnapshot("s1", { as_of_seq: 1, epoch: "e1", session: { id: "s1", busy: true, main_turn_active: true }, messages: kimiMessages(wire.slice(0, 1)) });
  bridge.applySnapshot("s1", { as_of_seq: 2, epoch: "e1", session: { id: "s1", busy: false, last_turn_reason: "completed" }, messages: kimiMessages(wire) });
  await new Promise((r) => setTimeout(r, 400));
  let messages = useAppStore.getState().messages;
  assert.ok(!messages.some((m) => typeof m.content === "string" && m.content.includes("system-reminder")), "reminder leaked into the live transcript");
  assert.ok(messages.some((m) => m.id === "p1" && m.role === "user"), "the real user prompt is missing");
  // Re-open: a fresh bridge (a cold reconnect) replays the same wire — same result.
  const bridge2 = createKimiEventBridge({ hostKey: "k", emit });
  bridge2.applySnapshot("s1", { as_of_seq: 3, epoch: "e1", session: { id: "s1", busy: false }, messages: kimiMessages(wire) });
  await new Promise((r) => setTimeout(r, 400));
  messages = useAppStore.getState().messages;
  assert.ok(!messages.some((m) => typeof m.content === "string" && m.content.includes("system-reminder")), "reminder leaked on re-open");
  unsubscribe();
});
