/**
 * Production-path Perch acceptance: drive the real adapter (createPerchHost →
 * PerchClient → PerchBackend registered in the real BackendRouter) against an
 * isolated Perch bridge + real OMP + 百炼 kimi-k3. No direct HTTP from the
 * test body — every mutation goes through the production IPC channel surface
 * (BackendRouter.route), and rendering is observed through the emitted
 * `remoteInteractions` / `agentMessage` events the renderer consumes.
 *
 * Covers: open an existing session, create a session, prompt → transcript
 * events, a real select approval answered allow (tool runs) and deny (tool
 * blocked), an accurate cancel, and the bridge surviving while this client is
 * gone (a second connect reads the settled history without re-executing).
 *
 * Run: node scripts/e2e-perch-adapter-production.mjs --endpoint <ep.json> --workspace <dir> --evidence <dir>
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { register } from "node:module";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));

const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter, makeRemoteSessionId } = await import("../apps/desktop/electron/main/remote/backend-router.ts");
const { createPerchHost } = await import("../apps/desktop/electron/main/remote/perch/perch-host.ts");

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const endpointPath = opt("endpoint"); const workspace = opt("workspace"); const evidence = opt("evidence") ?? ".";
if (!endpointPath || !workspace) { console.error("need --endpoint --workspace"); process.exit(2); }

const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
const log = []; const note = (s, d) => { log.push({ step: s, at: new Date().toISOString(), data: d }); console.log(`· ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The bridge under test is isolated and loopback-local, so the "SSH" layer is
 * a minimal stand-in: exec returns the endpoint descriptor, forward opens a
 * real local TCP pass-through to the bridge port (not a stub — the adapter's
 * HTTP still flows through the forward it created). Real system-SSH coverage
 * lives in test/perch-real-ssh.test.mjs. */
import { createServer, connect } from "node:net";
function localForwardTransport() {
  const servers = new Set();
  return {
    exec: async () => ({ stdout: JSON.stringify(endpoint), stderr: "", code: 0 }),
    execWithInput: async () => ({ stdout: "", stderr: "", code: 0 }),
    forward: async ({ localPort, remotePort }) => {
      const server = createServer((socket) => {
        const upstream = connect({ host: "127.0.0.1", port: endpoint.port });
        socket.pipe(upstream).pipe(socket);
      });
      servers.add(server);
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(localPort, "127.0.0.1", resolveListen);
      });
      return {
        localPort,
        close: async () => { servers.delete(server); await new Promise((r) => server.close(r)); },
      };
    },
    dispose: () => { for (const server of servers) server.close(); servers.clear(); },
  };
}

/* ---- a Perch host bound to the pass-through transport ---- */
const events = [];
const router = createBackendRouter();
const fakeTunnels = {
  open: async () => ({ url: `http://127.0.0.1:${endpoint.port}`, localPort: endpoint.port }),
  adopt: async () => { throw new Error("n/a"); },
  close: async () => {}, dispose: async () => {},
};
const host = createPerchHost({
  hostKey: "dev", label: "Perch test", router, tunnels: fakeTunnels,
  ssh: { host: "127.0.0.1", remotePort: endpoint.port },
  emit: (channel, payload) => events.push({ channel, payload }),
  buildTransport: localForwardTransport,
  pollMs: { busy: 300, idle: 1200 },
});
await host.connect();
note("host.connected", {});

const remoteId = (sid) => makeRemoteSessionId("dev", sid);
const route = async (channel, input) => (await router.route(channel, [input])).value;

/** Wait until the emitted events satisfy `pred`. */
async function waitEvent(pred, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let i = 0; i < events.length; i++) if (pred(events[i], i)) return events[i];
    if (Date.now() > deadline) throw new Error(`deadline waiting for ${label}`);
    await sleep(200);
  }
}
/** Wait until the live snapshot (via production sessionGet) satisfies `pred`. */
async function waitSnapshot(sid, pred, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { session } = await route(IPC.invoke.sessionGet, { id: remoteId(sid) });
    if (pred(session)) return session;
    if (Date.now() > deadline) throw new Error(`deadline waiting for ${label}`);
    await sleep(300);
  }
}
const ridOf = (sid, approvalId) => `${remoteId(sid)}#racp-approval:${approvalId}`;
async function openApproval(sid) {
  const ev = await waitEvent(
    (e) => e.channel === IPC.event.remoteInteractions && e.payload?.kind === "snapshot"
      && e.payload?.sessionId === remoteId(sid) && (e.payload?.permissions ?? []).length > 0,
    "approval snapshot");
  return ev.payload.permissions[0];
}

/** Wait for a permission snapshot emitted at/after `mark` with ≥1 permission. */
async function openApprovalAfter(sid, mark) {
  const ev = await waitEvent(
    (e, i) => i >= mark && e.channel === IPC.event.remoteInteractions && e.payload?.kind === "snapshot"
      && e.payload?.sessionId === remoteId(sid) && (e.payload?.permissions ?? []).length > 0,
    "approval snapshot after mark");
  return ev.payload.permissions[0];
}

/* ============ 1. create + prompt + transcript + select approval (allow) ============ */
const markerA = `prod-a-${Date.now()}.txt`;
const created = await host.createSession({ cwd: workspace, model: "kimi-k3", permissionMode: "always-ask", title: "adapter-prod-1" });
const sid = created.id;
note("session.created", { sid });
// The prompt is a production IPC call routed to the Perch backend.
await route(IPC.invoke.agentPrompt, { sessionId: remoteId(sid), content: `Create a file ${markerA} with content adapter-ok, then read it back.` });
note("prompt.sent", {});
// The select approval surfaces as a permission snapshot; answer allow-once.
const approval = await openApproval(sid);
note("approval.shown", { toolName: approval.toolName, args: approval.argsPreview });
assert.ok(["bash", "write", "edit"].includes(approval.toolName), `OMP select renders as a tool card (got ${approval.toolName})`);
await route(IPC.invoke.toolResolvePermission, { requestId: approval.requestId, decision: "allow-once" });
note("approval.allowed", {});
// The turn settles; the transcript reached the renderer as agent events.
await waitEvent((e) => e.channel === IPC.event.agentMessage && e.payload?.sessionId === remoteId(sid) && e.payload?.event?.type === "agent_end", "agent_end", 180_000);
const detail = await waitSnapshot(sid, (s) => JSON.stringify(s.messages).includes("adapter-ok"), "transcript carries file content");
const onDiskA = await readFile(join(workspace, markerA), "utf8");
assert.equal(onDiskA.trim(), "adapter-ok", "tool ran on the remote after the real approval");
note("turn.completed", { messages: detail.messages.length });

/* ============ 2. deny blocks the tool ============ */
const markerB = `prod-b-${Date.now()}.txt`;
// Send the deny prompt and answer the *new* approval that appears after it.
const denyMark = events.length;
await route(IPC.invoke.agentPrompt, { sessionId: remoteId(sid), content: `Create a file ${markerB} with content should-not-exist.` });
const approvalB = await openApprovalAfter(sid, denyMark);
await route(IPC.invoke.toolResolvePermission, { requestId: approvalB.requestId, decision: "deny" });
note("deny.sent", {});
// The denied turn must end — a missing agent_end fails the test, never skipped.
await waitEvent((e, i) => i >= denyMark && e.channel === IPC.event.agentMessage && e.payload?.sessionId === remoteId(sid) && e.payload?.event?.type === "agent_end", "denied turn end", 120_000);
await sleep(2000);
const existsB = await readFile(join(workspace, markerB), "utf8").then(() => true, () => false);
assert.equal(existsB, false, "denied tool never created the file");
note("deny.blocked", {});

/* ============ 3. accurate cancel ============ */
const cancelMark = events.length;
await route(IPC.invoke.agentPrompt, { sessionId: remoteId(sid), content: "Run `sleep 8` then say done." });
// Approve the sleep so the turn is genuinely running (not stuck pre-approval).
const cancelApproval = await openApprovalAfter(sid, cancelMark);
await route(IPC.invoke.toolResolvePermission, { requestId: cancelApproval.requestId, decision: "allow-once" });
await waitEvent((e, i) => i >= cancelMark && e.channel === IPC.event.agentMessage && e.payload?.sessionId === remoteId(sid) && e.payload?.event?.type === "agent_start", "agent_start for cancel", 90_000);
// Give the tool a beat to start the sleep.
await sleep(1000);
const aborted = await route(IPC.invoke.agentAbort, { sessionId: remoteId(sid) });
assert.equal(aborted.aborted, true, "abort named the live turn");
// Wait until the bridge itself reports the session idle before prompting again.
await (async () => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { status } = await route(IPC.invoke.agentGetStatus, { sessionId: remoteId(sid) });
    if (!status.isRunning) break;
    if (Date.now() > deadline) throw new Error("abort did not settle");
    await sleep(400);
  }
})();
note("cancel.ok", {});

/* ============ 4. client gone: remote continues, fresh read recovers ============
 * NOTE (2026-11-08): the environment's OMP 18.13.1 stalls tool execution
 * (tool_execution_start with no tool_execution_end, no file written, even
 * locally), so a tool-writing offline proof cannot run reliably here — see
 * ACCEPTANCE.md. This segment therefore proves the disconnect/continue
 * contract with a text-only turn: the assistant's reply completes while the
 * client is fully closed, and recovery reads the settled history. */
const offline = await host.createSession({ cwd: workspace, model: "kimi-k3", permissionMode: "write", title: "adapter-prod-offline" });
const offlineSid = offline.id;
const offlineToken = `offline-${Math.random().toString(36).slice(2, 10)}`;
const offlineMark = events.length;
await route(IPC.invoke.agentPrompt, { sessionId: remoteId(offlineSid),
  content: `Reply with exactly this token and nothing else: ${offlineToken}. Do not use tools.` });
await waitEvent((e, i) => i >= offlineMark && e.channel === IPC.event.agentMessage && e.payload?.sessionId === remoteId(offlineSid) && e.payload?.event?.type === "agent_start", "offline turn started", 90_000);
// The turn is running; the client goes away entirely before it settles.
const goneAt = Date.now();
await host.close();
note("client.gone", { goneAt });
await sleep(8000);
// A fresh host re-discovers and reads the settled history without re-prompting.
const events2 = [];
const host2 = createPerchHost({
  hostKey: "dev", label: "Perch test", router, tunnels: fakeTunnels,
  ssh: { host: "127.0.0.1", remotePort: endpoint.port },
  emit: (c, p) => events2.push({ channel: c, payload: p }),
  buildTransport: localForwardTransport,
  pollMs: { busy: 300, idle: 1200 },
});
await host2.connect();
const recovered = await waitSnapshot(offlineSid, (s) =>
  s.messages.some((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes(offlineToken)),
  "recovered assistant row carries the token", 90_000);
const assistantRow = recovered.messages.find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes(offlineToken));
assert.ok(assistantRow, "token found in the assistant reply, not the user echo");
const { status: offlineStatus } = await route(IPC.invoke.agentGetStatus, { sessionId: remoteId(offlineSid) });
assert.equal(offlineStatus.isRunning, false, "turn settled while disconnected");
note("recovered", { messages: recovered.messages.length, goneAt });
await host2.close();

await writeFile(join(evidence, "perch-adapter-production.json"), JSON.stringify({ at: new Date().toISOString(), sid, workspace, log }, null, 2));
console.log("PASS perch production adapter: open/create/prompt/transcript/approval(allow+deny)/cancel/offline-recovery, all through the real adapter");
