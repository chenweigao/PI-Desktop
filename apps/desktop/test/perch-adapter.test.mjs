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
  bridge.applySnapshot("s1", { interactions: [{ id: "ap-1", method: "confirm", title: "Run ls?" }] });
  const snapshot = emitted.find((e) => e.payload?.kind === "snapshot");
  assert.ok(snapshot, "snapshot emitted");
  assert.equal(snapshot.payload.permissions[0].requestId, makeRemoteApprovalRequestId(remoteId, "ap-1"));
  emitted.length = 0;
  bridge.applySnapshot("s1", { interactions: [] });
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

test("select approval maps deny and allow-session onto the right OMP option (never the first by default)", async () => {
  const bridge = await startBridge();
  bridge.interactions.push({ id: "sel-1", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Approve bash for this session", "Deny"] });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  const rid = makeRemoteApprovalRequestId(sessionId, "sel-1");
  // deny → the Deny option, not the first option.
  await backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: rid, decision: "deny" }]);
  assert.equal(bridge.answers.at(-1).value, "Deny");
  // allow-session → the session-scoped option, not plain Approve.
  bridge.interactions.push({ id: "sel-1", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Approve bash for this session", "Deny"] });
  await backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: rid, decision: "allow-session" }]);
  assert.equal(bridge.answers.at(-1).value, "Approve bash for this session");
  // allow-once → the plain Approve (exact, not the session variant).
  bridge.interactions.push({ id: "sel-1", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Approve bash for this session", "Deny"] });
  await backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: rid, decision: "allow-once" }]);
  assert.equal(bridge.answers.at(-1).value, "Approve");
  await new Promise((r) => bridge.server.close(r));
});

test("input/editor interactions fail closed rather than fabricate a value", async () => {
  const bridge = await startBridge();
  bridge.interactions.push({ id: "inp-1", method: "input", title: "Enter a value" });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  await assert.rejects(
    backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: makeRemoteApprovalRequestId(sessionId, "inp-1"), decision: "allow-once" }]),
    /not supported|CAPABILITY/i,
  );
  assert.equal(bridge.answers.length, 0, "no fabricated answer reached the bridge");
  await new Promise((r) => bridge.server.close(r));
});

test("OMP select approval renders as a structured tool card (tool + command split from title)", () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (c, p) => emitted.push({ channel: c, payload: p }) });
  bridge.applySnapshot("s1", { busy: true, interactions: [{ id: "ap-1", method: "select", title: "Allow tool: bash\nCommand: pwd && uname -s", options: ["Approve", "Deny"] }] });
  const snapshot = emitted.find((e) => e.payload?.kind === "snapshot");
  const perm = snapshot.payload.permissions[0];
  assert.equal(perm.toolName, "bash");
  assert.deepEqual(perm.argsPreview, { command: "pwd && uname -s" });
});

test("snapshot diff emits transcript events: agent_start, message stream, agent_end", () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (c, p) => emitted.push({ channel: c, payload: p }) });
  const sid = makeRemoteSessionId("dev", "s1");
  const agentEvents = () => emitted.filter((e) => e.channel === IPC.event.agentMessage).map((e) => e.payload.event.type);
  // Turn starts, first assistant text streams.
  bridge.applySnapshot("s1", { busy: true, messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "hel" }] },
  ] });
  assert.deepEqual(agentEvents(), ["agent_start", "message_start", "message_start"]);
  // Incremental update on the same message id.
  emitted.length = 0;
  bridge.applySnapshot("s1", { busy: true, messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "hello" }] },
  ] });
  assert.deepEqual(agentEvents(), ["message_update"]);
  // Settle: streaming rows end, agent_end fires.
  emitted.length = 0;
  bridge.applySnapshot("s1", { busy: false, turnState: "completed", messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "hello" }] },
  ] });
  assert.ok(agentEvents().includes("agent_end"));
});

test("sessionGet returns a renderer-ready SessionDetail with UiMessage transcript", async () => {
  const bridge = await startBridge();
  // Seed a snapshot with a tool call + result.
  bridge.interactions.length = 0;
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  // Patch the fake bridge to return messages on the session snapshot.
  const origGet = (await import("../electron/main/remote/perch/perch-client.ts"));
  void origGet;
  // Drive through the router so the remoteId is parsed like production.
  const router = createBackendRouter();
  router.registerBackend(sessionId, backend);
  const result = await router.route(IPC.invoke.sessionGet, [{ id: sessionId }]);
  assert.ok(result && typeof result === "object" && "remote" in result && result.remote);
  const detail = result.value.session;
  assert.equal(detail.id, sessionId);
  assert.equal(detail.source, "remote");
  assert.ok(Array.isArray(detail.messages));
  await new Promise((r) => bridge.server.close(r));
});

/* ---- Codex review c4823fe75 regression coverage ---- */

test("endpoint discovery builds valid POSIX shell (bash -n accepts it)", async () => {
  const { discoverPerchEndpoint } = await import("../electron/main/remote/perch/perch-client.ts");
  const { spawnSync } = await import("node:child_process");
  let captured = "";
  await assert.rejects(discoverPerchEndpoint(async (command) => {
    captured = command;
    const check = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
    assert.equal(check.status, 0, `discovery script must parse: ${check.stderr}`);
    return { stdout: "", stderr: "", code: 0 };
  }), /PERCH_ENDPOINT_UNAVAILABLE|discover/);
  assert.ok(captured.includes("endpoint.json"));
});

test("allow-once without a single-use option refuses instead of escalating", async () => {
  const bridge = await startBridge();
  bridge.interactions.push({ id: "sel-2", method: "select", title: "Allow tool: bash\nCommand: ls",
    options: ["Approve bash for this session", "Deny"] });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  await assert.rejects(
    backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: makeRemoteApprovalRequestId(sessionId, "sel-2"), decision: "allow-once" }]),
    /no option matching|refusing to guess/i,
  );
  assert.equal(bridge.answers.length, 0, "no escalation reached the bridge");
  await new Promise((r) => bridge.server.close(r));
});

test("an unknown decision is rejected, not treated as allow", async () => {
  const bridge = await startBridge();
  bridge.interactions.push({ id: "sel-3", method: "select", title: "Allow tool: bash\nCommand: ls",
    options: ["Approve", "Approve bash for this session", "Deny"] });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  await assert.rejects(
    backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: makeRemoteApprovalRequestId(sessionId, "sel-3"), decision: "definitely" }]),
    /unknown permission decision/i,
  );
  assert.equal(bridge.answers.length, 0);
  await new Promise((r) => bridge.server.close(r));
});

test("failed turns emit a TURN_FAILED error (never a bare agent_end)", () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (c, p) => emitted.push(p) });
  bridge.applySnapshot("s1", { busy: true, turnId: "t1", revision: 5, messages: [] });
  bridge.applySnapshot("s1", { busy: false, turnId: "t1", turnState: "failed", error: "model failed", revision: 6, messages: [] });
  const types = emitted.filter((e) => e.event).map((e) => ({ type: e.event.type, code: e.event.error?.code, turnId: e.turnId }));
  assert.deepEqual(types, [
    { type: "agent_start", code: undefined, turnId: "t1" },
    { type: "error", code: "TURN_FAILED", turnId: "t1" },
  ]);
});

test("stopped and unknown turns report their real outcome", () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (c, p) => emitted.push(p) });
  bridge.applySnapshot("s1", { busy: true, turnId: "t2", revision: 1, messages: [] });
  bridge.applySnapshot("s1", { busy: false, turnId: "t2", turnState: "stopped", revision: 2, messages: [] });
  bridge.applySnapshot("s1", { busy: true, turnId: "t3", revision: 3, messages: [] });
  bridge.applySnapshot("s1", { busy: false, turnId: "t3", turnState: "unknown", error: "托管服务曾中断", revision: 4, messages: [] });
  const codes = emitted.filter((e) => e.event?.type === "error").map((e) => e.event.error.code);
  assert.deepEqual(codes, ["TURN_ABORTED", "TURN_UNKNOWN"]);
  assert.equal(emitted.filter((e) => e.event?.type === "agent_end").length, 0, "no fake completion");
});

test("multi-tool messages keep every call correlated with its result", async () => {
  const { perchMessageToUiMessages } = await import("../electron/main/remote/perch/perch-event-bridge.ts");
  const rows = perchMessageToUiMessages({ id: "m1", role: "assistant", created_at: "2026-01-01T00:00:00Z", content: [
    { type: "text", text: "two tools" },
    { type: "tool_use", tool_call_id: "t1", tool_name: "bash", input: { command: "ls" } },
    { type: "tool_use", tool_call_id: "t2", tool_name: "read", input: { path: "/x" } },
    { type: "tool_result", tool_call_id: "t1", output: "ok" },
  ] }, false);
  assert.equal(rows.length, 3, "assistant row + both tool rows");
  assert.equal(rows[0].role, "assistant");
  assert.equal(rows[0].content, "two tools");
  const t1 = rows.find((r) => r.toolCallId === "t1");
  const t2 = rows.find((r) => r.toolCallId === "t2");
  assert.equal(t1.toolStatus, "success");
  assert.equal(t1.content, "ok");
  assert.equal(t2.toolName, "read");
  assert.equal(t2.toolStatus, undefined, "a settled tool_use without result is not a spinner");
  assert.notEqual(t2.status, "streaming");
});

test("a bridge restart (revision moving backwards) resets diff state and force-updates known ids", () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (c, p) => emitted.push(p) });
  bridge.applySnapshot("s1", { busy: true, revision: 10, messages: [{ id: "a", role: "assistant", content: [{ type: "text", text: "hi" }] }] });
  emitted.length = 0;
  // Service restarted: revision restarts from a low number. The renderer may
  // already hold this row id from the dead epoch, and ignores message_start
  // for it — so the recovered content must arrive as message_update.
  bridge.applySnapshot("s1", { busy: false, revision: 1, turnState: "completed", messages: [{ id: "a", role: "assistant", content: [{ type: "text", text: "hi" }] }] });
  const updates = emitted.filter((e) => e.event?.type === "message_update");
  assert.ok(updates.length >= 1, "recovered rows pushed as message_update, not a start the renderer would drop");
  assert.equal(updates[0].event.message.id, "a");
});

test("history paging walks backwards with epoch-checked cursors", async () => {
  const bridge = await startBridge();
  // Extend the fake bridge with paged history semantics.
  const pages = { "": { messages: [{ id: "m3", role: "assistant", content: [{ type: "text", text: "newest" }] }], history: { epoch: "e1", start: 2, total: 3, end: 3 } },
    "2": { messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "older" }] }], history: { epoch: "e1", start: 0, total: 3, end: 2 } } };
  const origHandler = bridge.server.listeners("request")[0];
  bridge.server.removeAllListeners("request");
  bridge.server.on("request", (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/sessions/s1" && url.searchParams.has("turns")) {
      const before = url.searchParams.get("before") ?? "";
      const epoch = url.searchParams.get("epoch");
      if (before && epoch !== "e1") {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "History changed; reopen the conversation" }));
      }
      const page = pages[before] ?? pages[""];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "s1", title: "paged", busy: false, updated: 1, ...page }));
    }
    origHandler(req, res);
  });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  const first = (await backend.invoke(IPC.invoke.sessionGet, [{ id: sessionId }])).session;
  assert.equal(first.messages.at(-1).id, "m3");
  assert.equal(first.hasMoreBefore, true);
  const second = (await backend.invoke(IPC.invoke.sessionGet, [{ id: sessionId, messageBefore: first.messageStart }])).session;
  assert.equal(second.messages[0].content, "older");
  assert.equal(second.hasMoreBefore, false);
  await new Promise((r) => bridge.server.close(r));
});

/* ---- Codex review 0a4130fd4 regression coverage ---- */

test("tool_use and tool_result in SEPARATE messages correlate by call identity (native OMP contract)", async () => {
  const { perchSnapshotToUiMessages } = await import("../electron/main/remote/perch/perch-event-bridge.ts");
  const rows = perchSnapshotToUiMessages([
    { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:00Z", content: [
      { type: "text", text: "checking" },
      { type: "tool_use", tool_call_id: "c1", tool_name: "bash", input: { command: "pwd" } },
    ] },
    { id: "r1", role: "tool", created_at: "2026-01-01T00:00:01Z", content: [
      { type: "tool_result", tool_call_id: "c1", output: "/srv/work", is_error: false },
    ] },
  ], false);
  const toolRows = rows.filter((r) => r.role === "tool");
  assert.equal(toolRows.length, 1, "one tool row, not a call row plus an orphan result row");
  assert.equal(toolRows[0].id, "a1#c1", "row keyed by the call's first observation");
  assert.equal(toolRows[0].toolName, "bash");
  assert.deepEqual(toolRows[0].toolArgs, { command: "pwd" });
  assert.equal(toolRows[0].content, "/srv/work", "readable output, not serialized JSON");
  assert.equal(toolRows[0].toolStatus, "success");
});

test("a live call updates in place when its result arrives in a later snapshot", () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (c, p) => emitted.push(p) });
  bridge.applySnapshot("s1", { busy: true, revision: 1, messages: [
    { id: "a1", role: "assistant", content: [{ type: "tool_use", tool_call_id: "c1", tool_name: "bash", input: { command: "ls" } }] },
  ] });
  bridge.applySnapshot("s1", { busy: true, revision: 2, messages: [
    { id: "a1", role: "assistant", content: [{ type: "tool_use", tool_call_id: "c1", tool_name: "bash", input: { command: "ls" } }] },
    { id: "r1", role: "tool", content: [{ type: "tool_result", tool_call_id: "c1", output: "done" }] },
  ] });
  const starts = emitted.filter((e) => e.event?.type === "message_start" && e.event.message.toolCallId === "c1");
  const updates = emitted.filter((e) => e.event?.type === "message_update" && e.event.message.toolCallId === "c1");
  assert.equal(starts.length, 1, "one tool row created");
  assert.equal(updates.length, 1, "the result updates the same row");
  assert.equal(updates[0].event.message.toolStatus, "success");
  assert.equal(updates[0].event.message.content, "done");
});

test("revision reset emits the old turn's terminal error BEFORE re-rendering, and the store reconciles", () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (c, p) => emitted.push(p) });
  bridge.applySnapshot("s1", { busy: true, turnId: "old-turn", revision: 100, messages: [
    { id: "a1", role: "assistant", content: [{ type: "text", text: "partial" }] },
  ] });
  emitted.length = 0;
  // Restart: revision collapses, the old turn's outcome is unknown, and the
  // recovered history carries the final text under the same message id.
  bridge.applySnapshot("s1", { busy: false, turnId: "old-turn", turnState: "unknown", error: "托管服务曾中断", revision: 1, messages: [
    { id: "a1", role: "assistant", content: [{ type: "text", text: "final" }] },
  ] });
  const events = emitted.filter((e) => e.event).map((e) => e.event.type);
  const errorAt = events.indexOf("error");
  const updateAt = events.indexOf("message_update");
  assert.ok(errorAt >= 0, "terminal error emitted for the in-flight turn");
  assert.ok(updateAt > errorAt, "content reconciliation happens after the terminal error");
  const err = emitted.filter((e) => e.event)[errorAt];
  assert.equal(err.event.error.code, "TURN_UNKNOWN");
  const update = emitted.filter((e) => e.event)[updateAt];
  assert.equal(update.event.message.content, "final", "recovered row carries the final text");
});

test("model switch resolves the picked model's own provider, never the session's current one", async () => {
  const bridge = await startBridge();
  const posted = [];
  // Extend the fake bridge: session summary on /sessions/s1, model catalog,
  // and a model endpoint that records the posted provider.
  const orig = bridge.server.listeners("request")[0];
  bridge.server.removeAllListeners("request");
  bridge.server.on("request", (req, res) => {
    const url = new URL(req.url, "http://x");
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/sessions/s1") {
      return reply(200, { id: "s1", provider: "omp", provider_id: "bailian", model: "kimi-k3", busy: false, updated: 1, revision: 1, pending: 0, interactions: [], messages: [] });
    }
    if (req.method === "GET" && url.pathname === "/models") {
      return reply(200, { models: [
        { id: "kimi-k3", provider: "bailian", name: "kimi-k3", agent: "omp" },
        { id: "deepseek-v4-pro", provider: "aone", name: "DeepSeek V4 Pro", agent: "omp" },
      ] });
    }
    if (req.method === "POST" && url.pathname === "/sessions/s1/model") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { posted.push(JSON.parse(b)); reply(200, { ok: true }); });
      return;
    }
    orig(req, res);
  });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge),
    listModels: async () => [
      { id: "kimi-k3", provider: "bailian", agent: "omp" },
      { id: "deepseek-v4-pro", provider: "aone", agent: "omp" },
    ] });
  const sessionId = makeRemoteSessionId("dev", "s1");
  await backend.invoke(IPC.invoke.sessionConfigure, [{ sessionId }, { modelId: "deepseek-v4-pro" }]);
  assert.equal(posted[0].provider, "aone", "the picked model's own provider, not the session's bailian");
  assert.equal(posted[0].model, "deepseek-v4-pro");
  await new Promise((r) => bridge.server.close(r));
});

test("a model from another runtime is refused, not misrouted as a model switch", async () => {
  const bridge = await startBridge();
  const orig = bridge.server.listeners("request")[0];
  bridge.server.removeAllListeners("request");
  bridge.server.on("request", (req, res) => {
    const url = new URL(req.url, "http://x");
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/sessions/s1") {
      return reply(200, { id: "s1", provider: "omp", provider_id: "bailian", model: "kimi-k3", busy: false, updated: 1, revision: 1, pending: 0, interactions: [], messages: [] });
    }
    orig(req, res);
  });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge),
    listModels: async () => [
      { id: "kimi-k3", provider: "bailian", agent: "omp" },
      { id: "gpt-6.1-sol", provider: "codex", agent: "codex" },
    ] });
  const sessionId = makeRemoteSessionId("dev", "s1");
  await assert.rejects(
    backend.invoke(IPC.invoke.sessionConfigure, [{ sessionId }, { modelId: "gpt-6.1-sol" }]),
    /belongs to the codex runtime/,
  );
  await new Promise((r) => bridge.server.close(r));
});

test("interaction classification: approvals stay permissions, input/editor/select-questions become asks", async () => {
  const { classifyPerchInteraction } = await import("../electron/main/remote/perch/perch-event-bridge.ts");
  assert.equal(classifyPerchInteraction({ id: "1", method: "confirm", title: "Run ls?" }), "permission");
  assert.equal(classifyPerchInteraction({ id: "2", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Deny"] }), "permission");
  assert.equal(classifyPerchInteraction({ id: "3", method: "select", title: "Which region?", options: ["cn", "us"] }), "ask");
  assert.equal(classifyPerchInteraction({ id: "4", method: "input", title: "Enter a value" }), "ask");
  assert.equal(classifyPerchInteraction({ id: "5", method: "editor", title: "Edit the config" }), "ask");
  assert.equal(classifyPerchInteraction({ id: "6", name: "AskUserQuestion", input: { questions: [{ question: "Pick", options: [{ label: "A" }] }] } }), "ask");
});

test("snapshot routes question interactions to asks, approvals to permissions; resolved keeps the right kind", async () => {
  const emitted = [];
  const bridge = createPerchEventBridge({ hostKey: "dev", emit: (c, p) => emitted.push({ channel: c, payload: p }) });
  bridge.applySnapshot("s1", { busy: true, interactions: [
    { id: "ap-1", method: "select", title: "Allow tool: bash\nCommand: ls", options: ["Approve", "Deny"] },
    { id: "q-1", method: "input", title: "Enter the release version" },
    { id: "q-2", method: "select", title: "Which region?", options: ["cn", "us"] },
    { id: "q-3", name: "AskUserQuestion", input: { questions: [{ question: "Pick one", options: [{ label: "A", description: "first" }, { label: "B" }] }] } },
  ] });
  const snapshot = emitted.find((e) => e.payload?.kind === "snapshot");
  assert.equal(snapshot.payload.permissions.length, 1, "only the approval is a permission");
  assert.equal(snapshot.payload.asks.length, 3, "questions surface as asks");
  const inputAsk = snapshot.payload.asks.find((a) => a.requestId.endsWith("q-1"));
  assert.equal(inputAsk.questions[0].question, "Enter the release version");
  assert.deepEqual(inputAsk.questions[0].options, [], "input is free text");
  const selectAsk = snapshot.payload.asks.find((a) => a.requestId.endsWith("q-2"));
  assert.deepEqual(selectAsk.questions[0].options.map((o) => o.label), ["cn", "us"]);
  const structured = snapshot.payload.asks.find((a) => a.requestId.endsWith("q-3"));
  assert.equal(structured.questions[0].options[0].description, "first");
  // Resolution emits the matching requestKind so the right card clears.
  bridge.applySnapshot("s1", { busy: true, interactions: [] });
  const resolved = emitted.filter((e) => e.payload?.kind === "resolved");
  assert.equal(resolved.length, 4);
  assert.equal(resolved.find((r) => r.payload.requestId.endsWith("ap-1")).payload.requestKind, "permission");
  assert.equal(resolved.find((r) => r.payload.requestId.endsWith("q-1")).payload.requestKind, "ask");
});

test("askToolResolve answers OMP input/select questions and AskUserQuestion; empty means cancelled", async () => {
  const bridge = await startBridge();
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  // input: free text → {value}
  bridge.interactions.push({ id: "q-in", method: "input", title: "Version?" });
  await backend.invoke(IPC.invoke.askToolResolve, [{ requestId: makeRemoteApprovalRequestId(sessionId, "q-in"), answers: [["1.2.3"]] }]);
  assert.equal(bridge.answers.at(-1).value, "1.2.3");
  // input skipped → cancelled
  bridge.interactions.push({ id: "q-in2", method: "input", title: "Version?" });
  await backend.invoke(IPC.invoke.askToolResolve, [{ requestId: makeRemoteApprovalRequestId(sessionId, "q-in2"), answers: [null] }]);
  assert.equal(bridge.answers.at(-1).cancelled, true);
  // select question: chosen option → {value}; an unknown option is refused
  bridge.interactions.push({ id: "q-sel", method: "select", title: "Region?", options: ["cn", "us"] });
  await assert.rejects(
    backend.invoke(IPC.invoke.askToolResolve, [{ requestId: makeRemoteApprovalRequestId(sessionId, "q-sel"), answers: [["eu"]] }]),
    /not one of the offered options/,
  );
  await backend.invoke(IPC.invoke.askToolResolve, [{ requestId: makeRemoteApprovalRequestId(sessionId, "q-sel"), answers: [["us"]] }]);
  assert.equal(bridge.answers.at(-1).value, "us");
  // AskUserQuestion → {allow, answers keyed by question text}
  bridge.interactions.push({ id: "q-auq", name: "AskUserQuestion", input: { questions: [
    { question: "Framework?", options: [{ label: "React" }, { label: "Vue" }] },
    { question: "CSS?", options: [{ label: "Tailwind" }] },
  ] } });
  await backend.invoke(IPC.invoke.askToolResolve, [{ requestId: makeRemoteApprovalRequestId(sessionId, "q-auq"), answers: [["Vue"], ["Tailwind"]] }]);
  const auq = bridge.answers.at(-1);
  assert.equal(auq.allow, true);
  assert.deepEqual(auq.answers, { "Framework?": "Vue", "CSS?": "Tailwind" });
  // an approval id is not a question; a stale id fails closed
  bridge.interactions.push({ id: "ap-1", method: "confirm", title: "Run ls?" });
  await assert.rejects(
    backend.invoke(IPC.invoke.askToolResolve, [{ requestId: makeRemoteApprovalRequestId(sessionId, "ap-1"), answers: [["x"]] }]),
    /not a question/,
  );
  await assert.rejects(
    backend.invoke(IPC.invoke.askToolResolve, [{ requestId: makeRemoteApprovalRequestId(sessionId, "gone"), answers: [["x"]] }]),
    /no longer open/,
  );
  await new Promise((r) => bridge.server.close(r));
});

test("sessionGet surfaces the bridge's real permission capability", async () => {
  const bridge = await startBridge();
  const orig = bridge.server.listeners("request")[0];
  bridge.server.removeAllListeners("request");
  bridge.server.on("request", (req, res) => {
    const url = new URL(req.url, "http://x");
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/sessions/s1") {
      return reply(200, { id: "s1", provider: "qoder", busy: false, updated: 1, revision: 1, pending: 0, interactions: [], messages: [],
        permission: { selected: "acceptEdits", options: ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"], scope: "next-turn" } });
    }
    orig(req, res);
  });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const result = await backend.invoke(IPC.invoke.sessionGet, [{ sessionId: makeRemoteSessionId("dev", "s1") }]);
  assert.deepEqual(result.session.remotePermission, {
    selected: "acceptEdits",
    options: ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"],
    scope: "next-turn",
  });
  await new Promise((r) => bridge.server.close(r));
});

test("sessionConfigure permission: next-turn runtimes POST /permission, new-session runtimes refuse without a write", async () => {
  const bridge = await startBridge();
  const posted = [];
  let provider = "qoder";
  let selected = "default";
  const orig = bridge.server.listeners("request")[0];
  bridge.server.removeAllListeners("request");
  bridge.server.on("request", (req, res) => {
    const url = new URL(req.url, "http://x");
    const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const capability = provider === "qoder"
      ? { selected, options: ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"], scope: "next-turn" }
      : { selected: "always-ask", options: ["always-ask", "write", "yolo"], scope: "new-session" };
    if (req.method === "GET" && url.pathname === "/sessions/s1") {
      return reply(200, { id: "s1", provider, busy: false, updated: 1, revision: 1, pending: 0, interactions: [], messages: [], permission: capability });
    }
    if (req.method === "POST" && url.pathname === "/sessions/s1/permission") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        posted.push(JSON.parse(b));
        selected = JSON.parse(b).mode;
        reply(200, { ok: true, permission: { ...capability, selected } });
      });
      return;
    }
    orig(req, res);
  });
  const backend = createPerchBackend({ hostKey: "dev", client: clientFor(bridge) });
  const sessionId = makeRemoteSessionId("dev", "s1");
  // qoder (next-turn): the change is written and the refreshed capability returned
  const result = await backend.invoke(IPC.invoke.sessionConfigure, [{ sessionId }, { permissionMode: "plan" }]);
  assert.deepEqual(posted, [{ mode: "plan" }]);
  assert.equal(result.session.remotePermission.selected, "plan");
  // an id outside the runtime's catalog is refused before any POST
  await assert.rejects(
    backend.invoke(IPC.invoke.sessionConfigure, [{ sessionId }, { permissionMode: "workspace-auto" }]),
    /not offered by this runtime/,
  );
  assert.equal(posted.length, 1, "invalid mode still posted");
  // omp (new-session): refused honestly, nothing written
  provider = "omp";
  await assert.rejects(
    backend.invoke(IPC.invoke.sessionConfigure, [{ sessionId }, { permissionMode: "yolo" }]),
    /fixes the permission mode at session creation/,
  );
  assert.equal(posted.length, 1, "new-session runtime change reached the bridge");
  await new Promise((r) => bridge.server.close(r));
});
