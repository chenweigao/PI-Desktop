/**
 * Perch adapter contract tests: run the real `PerchBackend` + `PerchClient`
 * against a fake in-process HTTP bridge that mimics
 * `native-agent-service.py` semantics (receipts, epoch, approvals). No SSH,
 * no Electron. Focus: idempotent prompt, stale-approval fail-closed, abort
 * turnId guard, snapshot→interactions translation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createPerchClient } = await import("../electron/main/remote/perch/perch-client.ts");
const { createPerchBackend } = await import("../electron/main/remote/perch/perch-session-backend.ts");
const { createPerchEventBridge } = await import("../electron/main/remote/perch/perch-event-bridge.ts");
const { createBackendRouter, makeRemoteSessionId, makeRemoteApprovalRequestId } = await import("../electron/main/remote/backend-router.ts");
const { IPC } = await import("@pi-desktop/shared");

async function startBridge() {
  const state = {
    server: null, port: 0,
    prompts: [], aborts: [], answers: [],
    interactions: [], turnId: "turn-1", busy: false, revision: 1,
    receipts: new Map(),
    dropNextPrompt: false,
  };
  state.server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== "Bearer test-token") return reply(401, { error: "Unauthorized" });
    const body = req.method === "POST" ? JSON.parse(await new Promise((r) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b || "{}"));
    })) : {};
    if (req.method === "GET" && parts[0] === "sessions" && parts.length === 1) {
      return reply(200, { sessions: [] });
    }
    if (parts[0] === "sessions" && parts[1] === "s1") {
      if (req.method === "GET" && parts.length === 2) {
        return reply(200, { id: "s1", revision: state.revision, busy: state.busy, turnId: state.turnId, pending: state.interactions.length, interactions: state.interactions, messages: [] });
      }
      if (parts[2] === "requests" && parts[3]) {
        return reply(200, state.receipts.get(parts[3]) ?? { id: parts[3], status: "notFound" });
      }
      if (parts[2] === "prompt") {
        if (state.dropNextPrompt) {
          // Accept the turn, then hang: the client times out and must resolve
          // via GET .../requests/{requestId}, not a resend.
          state.dropNextPrompt = false;
          const receipt = { id: body.requestId, status: "accepted" };
          state.receipts.set(body.requestId, receipt);
          state.prompts.push({ requestId: body.requestId, text: body.text });
          state.busy = true; state.revision++;
          return; // never respond
        }
        const existing = state.receipts.get(body.requestId);
        if (existing) return reply(200, existing);
        const receipt = { id: body.requestId, status: "accepted" };
        state.receipts.set(body.requestId, receipt);
        state.prompts.push({ requestId: body.requestId, text: body.text });
        state.busy = true; state.revision++;
        return reply(200, receipt);
      }
      if (parts[2] === "abort") {
        if (body.turnId !== state.turnId) return reply(400, { error: "轮次已变化，请重新同步" });
        state.aborts.push({ turnId: body.turnId }); state.busy = false; state.revision++;
        return reply(200, { ok: true });
      }
      if (parts[2] === "answer") {
        const idx = state.interactions.findIndex((item) => item.id === body.id);
        if (idx < 0) return reply(400, { error: "该审批已失效" });
        state.interactions.splice(idx, 1); state.answers.push(body); state.revision++;
        return reply(200, { ok: true });
      }
    }
    return reply(404, { error: "unknown" });
  });
  state.server.listen(0, "127.0.0.1");
  await once(state.server, "listening");
  state.port = state.server.address().port;
  return state;
}

function clientFor(bridge, timeoutMs) {
  return createPerchClient({
    localBaseUrl: () => `http://127.0.0.1:${bridge.port}`,
    endpoint: () => ({ port: bridge.port, token: "test-token" }),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

test("prompt is idempotent across a lost response (receipt re-read, no duplicate)", async () => {
  const bridge = await startBridge();
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge, 800), newRequestId: () => "req-fixed" });
  const sessionId = makeRemoteSessionId("dev", "s1");
  // Accept the prompt but never respond, so the client times out and must
  // resolve the receipt instead of resending with a new id.
  bridge.dropNextPrompt = true;
  const result = await backend.invoke(IPC.invoke.agentPrompt, [{ sessionId, content: "hello" }]);
  assert.equal(result.accepted, true);
  assert.equal(bridge.prompts.length, 1, "prompt landed exactly once");
  await new Promise((r) => bridge.server.close(r));
});

test("abort names the live turn id; an idle session never re-aborts", async () => {
  const bridge = await startBridge();
  bridge.busy = true; bridge.turnId = "turn-current";
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  const ok = await backend.invoke(IPC.invoke.agentAbort, [{ sessionId }]);
  assert.equal(ok.aborted, true);
  assert.deepEqual(bridge.aborts, [{ turnId: "turn-current" }]);
  // Once the session is idle (the first abort landed), a second call — even
  // one that still names a stale turn id — is a no-op, never a second abort.
  const again = await backend.invoke(IPC.invoke.agentAbort, [{ sessionId, turnId: "turn-current" }]);
  assert.equal(again.aborted, false);
  assert.equal(bridge.aborts.length, 1, "no duplicate abort reached the bridge");
  await new Promise((r) => bridge.server.close(r));
});

test("abort against a live turn whose id changed is rejected by the bridge (no silent wrong-turn abort)", async () => {
  const bridge = await startBridge();
  bridge.busy = true; bridge.turnId = "turn-new";
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  await assert.rejects(
    backend.invoke(IPC.invoke.agentAbort, [{ sessionId, turnId: "turn-stale" }]),
    /轮次已变化/,
  );
  assert.equal(bridge.aborts.length, 0, "the stale turn id never aborted anything");
  await new Promise((r) => bridge.server.close(r));
});

test("a stale approval answer fails closed (bridge 400 surfaces, no silent resolve)", async () => {
  const bridge = await startBridge();
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  const requestId = makeRemoteApprovalRequestId(sessionId, "approval-gone");
  await assert.rejects(
    backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId, decision: "allow-once" }]),
    /no longer open|已失效/,
  );
  assert.equal(bridge.answers.length, 0, "no answer reached the bridge");
  await new Promise((r) => bridge.server.close(r));
});

test("an open confirm interaction resolves with allow mapped to confirmed", async () => {
  const bridge = await startBridge();
  bridge.interactions.push({ id: "ap-1", method: "confirm", title: "Run ls?" });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  const result = await backend.invoke(IPC.invoke.toolResolvePermission, [
    { requestId: makeRemoteApprovalRequestId(sessionId, "ap-1"), decision: "allow-once" },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(bridge.answers, [{ id: "ap-1", allow: true }]);
  await new Promise((r) => bridge.server.close(r));
});

test("snapshot translation: interactions become permission cards and resolve on removal", async () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (channel, payload) => emitted.push({ channel, payload }) });
  const remoteId = makeRemoteSessionId("dev", "s1");
  bridge.applySnapshot("s1", [{ id: "ap-1", method: "confirm", title: "Run ls?" }]);
  const snapshot = emitted.find((e) => e.payload?.kind === "snapshot");
  assert.ok(snapshot, "snapshot emitted");
  assert.equal(snapshot.payload.permissions[0].requestId, makeRemoteApprovalRequestId(remoteId, "ap-1"));
  emitted.length = 0;
  bridge.applySnapshot("s1", []);
  const resolved = emitted.find((e) => e.payload?.kind === "resolved");
  assert.ok(resolved, "resolved emitted when the interaction disappears");
  assert.equal(resolved.payload.requestId, makeRemoteApprovalRequestId(remoteId, "ap-1"));
});

test("router drives a Perch session end-to-end: prompt + approval resolve route to the Perch backend", async () => {
  const bridge = await startBridge();
  bridge.interactions.push({ id: "ap-9", method: "confirm", title: "Allow?" });
  const router = createBackendRouter();
  const client = clientFor(bridge);
  router.registerBackend(makeRemoteSessionId("dev", "s1"), createPerchBackend({ hostKey: "dev", client }));
  const sessionId = makeRemoteSessionId("dev", "s1");
  const prompt = await router.route(IPC.invoke.agentPrompt, [{ sessionId, content: "hi" }]);
  assert.equal(typeof prompt === "object" && prompt && prompt.remote, true);
  assert.equal(bridge.prompts.length, 1);
  const resolve = await router.route(IPC.invoke.toolResolvePermission, [
    { requestId: makeRemoteApprovalRequestId(sessionId, "ap-9"), decision: "deny" },
  ]);
  assert.equal(typeof resolve === "object" && resolve && resolve.remote, true);
  assert.deepEqual(bridge.answers, [{ id: "ap-9", allow: false }]);
  await new Promise((r) => bridge.server.close(r));
});

test("401 surfaces as a stale-token signal, prompting endpoint re-discovery", async () => {
  const bridge = await startBridge();
  const client = createPerchClient({
    localBaseUrl: () => `http://127.0.0.1:${bridge.port}`,
    endpoint: () => ({ port: bridge.port, token: "wrong-token" }),
  });
  await assert.rejects(client.get("/sessions"), /token|restarted|401/i);
  await new Promise((r) => bridge.server.close(r));
});
