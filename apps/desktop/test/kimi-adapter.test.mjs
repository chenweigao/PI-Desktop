/**
 * Kimi adapter contract tests: the real KimiBackend + KimiClient against a
 * fake in-process Kimi Web service (the {code,msg,data} envelope, approval
 * snapshot, prompt receipts). No SSH, no Electron. Focus: idempotent prompt,
 * approval decisions (approved/rejected, never a fabricated session grant),
 * abort only when running, restart reconciliation, tool correlation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createKimiClient } = await import("../electron/main/remote/kimi/kimi-client.ts");
const { createKimiBackend } = await import("../electron/main/remote/kimi/kimi-session-backend.ts");
const { createKimiEventBridge } = await import("../electron/main/remote/kimi/kimi-event-bridge.ts");
const { createBackendRouter, makeRemoteSessionId, makeRemoteApprovalRequestId } = await import("../electron/main/remote/backend-router.ts");
const { IPC } = await import("@pi-desktop/shared");

async function startKimi() {
  const state = {
    server: null, port: 0,
    prompts: [], approvals: [], aborts: 0,
    pendingApprovals: [],
    busy: false, lastTurnReason: "completed",
    messages: [],
    receipts: new Map(),
    dropNextPrompt: false,
  };
  state.server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const reply = (code, data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ code, msg: code === 0 ? "success" : "error", data }));
    };
    if (req.headers.authorization !== "Bearer kimi-token") return reply(40101, null, 401);
    const body = req.method === "POST" ? JSON.parse(await new Promise((r) => {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b || "{}"));
    })) : {};
    const m = url.pathname.match(/^\/api\/v1\/sessions\/([^/:]+)(.*)$/);
    if (url.pathname === "/api/v1/sessions" && req.method === "GET") return reply(0, { items: [], has_more: false });
    if (url.pathname === "/api/v1/sessions" && req.method === "POST") {
      return reply(0, { id: "ks1", title: body.title ?? "kimi", metadata: { cwd: body.metadata?.cwd }, busy: false, agent_config: {} });
    }
    if (m) {
      const sub = m[1]; const rest = url.pathname.slice(`/api/v1/sessions/${sub}`.length);
      if (req.method === "GET" && rest === "") {
        return reply(0, { id: sub, title: "kimi", busy: state.busy, main_turn_active: state.busy, last_turn_reason: state.lastTurnReason, pending_interaction: state.pendingApprovals.length ? "approval" : "none", agent_config: {}, metadata: { cwd: "/srv" } });
      }
      if (req.method === "GET" && rest === "/snapshot") {
        return reply(0, { as_of_seq: state.prompts.length, epoch: "e1", session: { id: sub, busy: state.busy, main_turn_active: state.busy, last_turn_reason: state.lastTurnReason, pending_interaction: state.pendingApprovals.length ? "approval" : "none", agent_config: {}, metadata: { cwd: "/srv" } }, messages: { items: state.messages, has_more: false }, pending_approvals: state.pendingApprovals });
      }
      if (req.method === "POST" && rest === "/prompts") {
        // Accept the prompt, then hang: the client times out and must NOT
        // resend (the prompt_id dedupes a later explicit retry).
        const receipt = { prompt_id: body.prompt_id, status: "running", content: body.content };
        state.receipts.set(body.prompt_id, receipt);
        state.prompts.push(body);
        state.busy = true;
        if (state.dropNextPrompt) { state.dropNextPrompt = false; return; }
        return reply(0, receipt);
      }
      if (req.method === "POST" && rest === ":abort") {
        state.aborts++; state.busy = false; state.lastTurnReason = "aborted";
        return reply(0, { aborted: true });
      }
      const approvalMatch = rest.match(/^\/approvals\/([^/]+)$/);
      if (req.method === "POST" && approvalMatch) {
        const aid = approvalMatch[1];
        const idx = state.pendingApprovals.findIndex((a) => a.approval_id === aid);
        if (idx < 0) return reply(40004, null, 400);
        state.pendingApprovals.splice(idx, 1);
        state.approvals.push({ id: aid, decision: body.decision });
        return reply(0, { ok: true });
      }
    }
    return reply(40404, null, 404);
  });
  state.server.listen(0, "127.0.0.1");
  await once(state.server, "listening");
  state.port = state.server.address().port;
  return state;
}

function clientFor(kimi, timeoutMs) {
  return createKimiClient({
    localBaseUrl: () => `http://127.0.0.1:${kimi.port}`,
    endpoint: () => ({ port: kimi.port, token: "kimi-token" }),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

test("envelope: HTTP 200 with code!=0 is a failure; 401 is stale token", async () => {
  const kimi = await startKimi();
  const client = clientFor(kimi);
  const data = await client.get("/api/v1/sessions");
  assert.deepEqual(data, { items: [], has_more: false });
  const bad = createKimiClient({ localBaseUrl: () => `http://127.0.0.1:${kimi.port}`, endpoint: () => ({ port: kimi.port, token: "wrong" }) });
  await assert.rejects(bad.get("/api/v1/sessions"), /token|restarted|401/);
  await new Promise((r) => kimi.server.close(r));
});

test("prompt uses the renderer's optimistic message id as the idempotent prompt_id", async () => {
  const kimi = await startKimi();
  const backend = createKimiBackend({ hostKey: "k", client: clientFor(kimi), newRequestId: () => "fallback" });
  const sessionId = makeRemoteSessionId("k", "ks1");
  const result = await backend.invoke(IPC.invoke.agentPrompt, [{ sessionId, content: "hi", messageId: "opt-1" }]);
  assert.equal(result.accepted, true);
  assert.equal(kimi.prompts[0].prompt_id, "opt-1");
  await new Promise((r) => kimi.server.close(r));
});

test("a lost prompt response is not resent (prompt_id dedupes a later retry)", async () => {
  const kimi = await startKimi();
  kimi.dropNextPrompt = true;
  const backend = createKimiBackend({ hostKey: "k", client: clientFor(kimi, 800) });
  const sessionId = makeRemoteSessionId("k", "ks1");
  await assert.rejects(
    backend.invoke(IPC.invoke.agentPrompt, [{ sessionId, content: "hi", messageId: "opt-2" }]),
    /not resent|connection drop/i,
  );
  assert.equal(kimi.prompts.length, 1, "the prompt landed exactly once");
  await new Promise((r) => kimi.server.close(r));
});

test("approval maps allow-once to approved and deny to rejected; allow-session is refused", async () => {
  const kimi = await startKimi();
  kimi.pendingApprovals.push({ approval_id: "ap1", tool_name: "bash", action: "run" });
  const backend = createKimiBackend({ hostKey: "k", client: clientFor(kimi) });
  const sessionId = makeRemoteSessionId("k", "ks1");
  const rid = makeRemoteApprovalRequestId(sessionId, "ap1");
  await backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: rid, decision: "allow-once" }]);
  assert.deepEqual(kimi.approvals.at(-1), { id: "ap1", decision: "approved" });
  kimi.pendingApprovals.push({ approval_id: "ap2", tool_name: "bash", action: "run" });
  await backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: makeRemoteApprovalRequestId(sessionId, "ap2"), decision: "deny" }]);
  assert.deepEqual(kimi.approvals.at(-1), { id: "ap2", decision: "rejected" });
  // Kimi grants per request only; a session-wide allow is refused, not faked.
  kimi.pendingApprovals.push({ approval_id: "ap3", tool_name: "bash", action: "run" });
  await assert.rejects(
    backend.invoke(IPC.invoke.toolResolvePermission, [{ requestId: makeRemoteApprovalRequestId(sessionId, "ap3"), decision: "allow-session" }]),
    /per-request|session-wide|not.*support/i,
  );
  assert.equal(kimi.approvals.length, 2, "no fabricated session grant reached the service");
  await new Promise((r) => kimi.server.close(r));
});

test("abort only fires while the session is running", async () => {
  const kimi = await startKimi();
  const backend = createKimiBackend({ hostKey: "k", client: clientFor(kimi) });
  const sessionId = makeRemoteSessionId("k", "ks1");
  kimi.busy = true;
  const running = await backend.invoke(IPC.invoke.agentAbort, [{ sessionId }]);
  assert.equal(running.aborted, true);
  assert.equal(kimi.aborts, 1);
  kimi.busy = false;
  const idle = await backend.invoke(IPC.invoke.agentAbort, [{ sessionId }]);
  assert.equal(idle.aborted, false);
  assert.equal(kimi.aborts, 1, "no second abort");
  await new Promise((r) => kimi.server.close(r));
});

test("snapshot: pending approvals become cards and resolve on removal", () => {
  const emitted = [];
  const bridge = createKimiEventBridge({ hostKey: "k", emit: (c, p) => emitted.push({ channel: c, payload: p }) });
  const remoteId = makeRemoteSessionId("k", "ks1");
  bridge.applySnapshot("ks1", { as_of_seq: 1, epoch: "e1", session: { id: "ks1", busy: false }, pending_approvals: [{ approval_id: "ap1", tool_name: "bash", action: "run" }] });
  const snapshot = emitted.find((e) => e.payload?.kind === "snapshot");
  assert.ok(snapshot, "snapshot emitted");
  assert.equal(snapshot.payload.permissions[0].requestId, makeRemoteApprovalRequestId(remoteId, "ap1"));
  emitted.length = 0;
  bridge.applySnapshot("ks1", { as_of_seq: 2, epoch: "e1", session: { id: "ks1", busy: false }, pending_approvals: [] });
  const resolved = emitted.find((e) => e.payload?.kind === "resolved");
  assert.ok(resolved, "resolved emitted when the approval disappears");
  assert.equal(resolved.payload.requestId, makeRemoteApprovalRequestId(remoteId, "ap1"));
});

test("tool_call and tool_result correlate by call id across Kimi messages", async () => {
  const { kimiSnapshotToUiMessages } = await import("../electron/main/remote/kimi/kimi-event-bridge.ts");
  const rows = kimiSnapshotToUiMessages([
    { id: "m1", role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_call", tool_call_id: "c1", tool_name: "bash", input: { command: "pwd" } }] },
    { id: "m2", role: "tool", content: [{ type: "tool_result", tool_call_id: "c1", output: "/srv", is_error: false }] },
  ], false);
  const toolRows = rows.filter((r) => r.role === "tool");
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0].toolName, "bash");
  assert.equal(toolRows[0].content, "/srv");
  assert.equal(toolRows[0].toolStatus, "success");
});

test("a failed turn reports an error, never a bare agent_end", () => {
  const emitted = [];
  const bridge = createKimiEventBridge({ hostKey: "k", emit: (c, p) => emitted.push(p) });
  bridge.applySnapshot("ks1", { as_of_seq: 1, epoch: "e1", session: { id: "ks1", busy: true, main_turn_active: true }, messages: { items: [] } });
  bridge.applySnapshot("ks1", { as_of_seq: 2, epoch: "e1", session: { id: "ks1", busy: false, main_turn_active: false, last_turn_reason: "failed" }, messages: { items: [] } });
  const error = emitted.filter((e) => e.event?.type === "error");
  assert.equal(error.length, 1);
  assert.equal(error[0].event.error.code, "TURN_FAILED");
  assert.equal(emitted.filter((e) => e.event?.type === "agent_end").length, 0, "no fake completion");
});

test("router drives a Kimi session end-to-end", async () => {
  const kimi = await startKimi();
  kimi.pendingApprovals.push({ approval_id: "ap9", tool_name: "bash", action: "run" });
  const router = createBackendRouter();
  router.registerBackend(makeRemoteSessionId("k", "ks1"), createKimiBackend({ hostKey: "k", client: clientFor(kimi) }));
  const sessionId = makeRemoteSessionId("k", "ks1");
  const prompt = await router.route(IPC.invoke.agentPrompt, [{ sessionId, content: "hi", messageId: "opt-9" }]);
  assert.equal(prompt.remote, true);
  const resolve = await router.route(IPC.invoke.toolResolvePermission, [{ requestId: makeRemoteApprovalRequestId(sessionId, "ap9"), decision: "allow-once" }]);
  assert.equal(resolve.remote, true);
  assert.deepEqual(kimi.approvals.at(-1), { id: "ap9", decision: "approved" });
  await new Promise((r) => kimi.server.close(r));
});
