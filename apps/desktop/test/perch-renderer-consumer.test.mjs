/**
 * Renderer consumer contract for the Perch adapter: events produced by the
 * PRODUCTION `createPerchEventBridge` are fed into the REAL renderer store
 * (`handleAgentEvent` + `subscribeRemoteInteractions`), not an event-array
 * assertion. Proves the adapter's output is a valid renderer contract:
 * transcript rows land in store.messages, a failed turn becomes
 * latestTurnResults.status="failed" (not "completed"), and a select approval
 * surfaces in pendingPermissions with a resolvable requestId.
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
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "perch-renderer-"));
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
const { createPerchEventBridge } = await import("../electron/main/remote/perch/perch-event-bridge.ts");
const { makeRemoteSessionId } = await import("../electron/main/remote/backend-router.ts");

test.after(() => rm(temp, { recursive: true, force: true }));

const session = { id: makeRemoteSessionId("dev", "s1"), source: "remote", remoteHostKey: "dev", title: "Perch", messageCount: 0, mode: "agent", permissionMode: "ask", thinkingLevel: "off", capabilities: { canPrompt: true, canStop: true, canRefresh: true }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

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

test("perch bridge events drive the real renderer store: transcript, failure, approval", () => {
  const listeners = setupStore();
  const unsubscribe = subscribeRemoteInteractions();
  // Production bridge emitting through the captured IPC channel.
  const emit = (channel, payload) => {
    if (channel === IPC.event.agentMessage) useAppStore.getState().handleAgentEvent(payload);
    else listeners.get(channel)?.(payload);
  };
  const bridge = createPerchEventBridge({ hostKey: "dev", emit });

  // A turn with text + two tools + results, then a FAILED settle.
  bridge.applySnapshot("s1", { busy: true, turnId: "t1", revision: 1, messages: [
    { id: "u1", role: "user", created_at: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "do it" }] },
  ] });
  bridge.applySnapshot("s1", { busy: true, turnId: "t1", revision: 2, messages: [
    { id: "u1", role: "user", created_at: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "do it" }] },
    { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:01Z", content: [
      { type: "text", text: "running tools" },
      { type: "tool_use", tool_call_id: "c1", tool_name: "bash", input: { command: "ls" } },
      { type: "tool_use", tool_call_id: "c2", tool_name: "read", input: { path: "/x" } },
    ] },
  ], interactions: [{ id: "ap1", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Deny"] }] });

  let state = useAppStore.getState();
  assert.equal(state.runningSessions[session.id], true, "agent_start marked the session running");
  assert.ok(state.messages.some((m) => m.content === "running tools"), "assistant text row in the store");
  assert.ok(state.messages.some((m) => m.toolCallId === "c1"), "first tool row present");
  assert.ok(state.messages.some((m) => m.toolCallId === "c2"), "second tool row present (multi-tool kept)");
  const pending = state.pendingPermissions[session.id];
  assert.equal(pending?.length, 1, "approval card pending");
  assert.equal(pending[0].toolName, "bash");
  assert.deepEqual(pending[0].argsPreview, { command: "ls" });
  assert.ok(pending[0].requestId.includes("#racp-approval:"), "requestId routes back to this session");

  // Resolve the approval: snapshot without it clears the card.
  bridge.applySnapshot("s1", { busy: true, turnId: "t1", revision: 3, messages: [], interactions: [] });
  assert.equal(useAppStore.getState().pendingPermissions[session.id], undefined, "card cleared on resolution");

  // The turn FAILS. The store must record failed, never completed.
  bridge.applySnapshot("s1", { busy: false, turnId: "t1", turnState: "failed", error: "model blew up", revision: 4, messages: [
    { id: "u1", role: "user", created_at: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "do it" }] },
  ] });
  state = useAppStore.getState();
  assert.equal(state.runningSessions[session.id], false, "settled");
  assert.equal(state.latestTurnResults[session.id]?.status, "failed", "failed turn recorded as failed");
  unsubscribe();
});

test("a completed turn records completed with its message ids", () => {
  const listeners = setupStore();
  const emit = (channel, payload) => {
    if (channel === IPC.event.agentMessage) useAppStore.getState().handleAgentEvent(payload);
    else listeners.get(channel)?.(payload);
  };
  const bridge = createPerchEventBridge({ hostKey: "dev", emit });
  bridge.applySnapshot("s1", { busy: true, turnId: "t9", revision: 1, messages: [
    { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "done" }] },
  ] });
  bridge.applySnapshot("s1", { busy: false, turnId: "t9", turnState: "completed", revision: 2, messages: [
    { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "done" }] },
  ] });
  const state = useAppStore.getState();
  assert.equal(state.latestTurnResults[session.id]?.status, "completed");
  assert.equal(state.latestTurnResults[session.id]?.turnId, "t9", "stable remote turn identity");
});

test("bridge restart reconciles the store: in-flight turn fails honestly, recovered text replaces the partial", async () => {
  const listeners = setupStore();
  const emit = (channel, payload) => {
    if (channel === IPC.event.agentMessage) useAppStore.getState().handleAgentEvent(payload);
    else listeners.get(channel)?.(payload);
  };
  const bridge = createPerchEventBridge({ hostKey: "dev", emit });
  // Turn streaming a partial answer at revision 100.
  bridge.applySnapshot("s1", { busy: true, turnId: "t-old", revision: 100, messages: [
    { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "partial" }] },
  ] });
  assert.equal(useAppStore.getState().runningSessions[session.id], true);
  assert.ok(useAppStore.getState().messages.some((m) => m.id === "a1" && m.content === "partial"));
  // The bridge restarts: revision collapses, outcome unknown, recovered final text.
  bridge.applySnapshot("s1", { busy: false, turnId: "t-old", turnState: "unknown", error: "服务中断", revision: 1, messages: [
    { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:00Z", content: [{ type: "text", text: "final" }] },
  ] });
  const state = useAppStore.getState();
  assert.equal(state.runningSessions[session.id], false, "the renderer stops spinning");
  assert.equal(state.latestTurnResults[session.id]?.status, "failed", "unknown outcome never reads as completed");
  // message_update rides the renderer's throttle queue; let it flush.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const row = useAppStore.getState().messages.find((m) => m.id === "a1");
  assert.equal(row?.content, "final", "the recovered row replaced the partial text in place");
});
