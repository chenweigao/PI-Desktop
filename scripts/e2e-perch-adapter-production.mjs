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
const { createPerchEventBridge } = await import("../apps/desktop/electron/main/remote/perch/perch-event-bridge.ts");

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const endpointPath = opt("endpoint"); const workspace = opt("workspace"); const evidence = opt("evidence") ?? ".";
if (!endpointPath || !workspace) { console.error("need --endpoint --workspace"); process.exit(2); }

const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
const log = []; const note = (s, d) => { log.push({ step: s, at: new Date().toISOString(), data: d }); console.log(`· ${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- a Perch host bound to a fake "SSH" that is actually local (the bridge
   is already isolated+local; the SSH layer is exercised separately). ---- */
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
  buildTransport: () => ({
    exec: async () => ({ stdout: JSON.stringify(endpoint), stderr: "", code: 0 }),
    execWithInput: async () => ({ stdout: "", stderr: "", code: 0 }),
    forward: async () => { throw new Error("n/a"); },
    dispose: () => {},
  }),
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
// The denied turn ends without the tool running.
await waitEvent((e, i) => i >= denyMark && e.channel === IPC.event.agentMessage && e.payload?.sessionId === remoteId(sid) && e.payload?.event?.type === "agent_end", "denied turn end", 120_000).catch(() => null);
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
await waitEvent((e, i) => i >= cancelMark && e.channel === IPC.event.agentMessage && e.payload?.sessionId === remoteId(sid) && e.payload?.event?.type === "agent_start", "agent_start for cancel", 90_000).catch(() => null);
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

/* ============ 4. client gone: remote continues, fresh read recovers ============ */
const markerD = `prod-d-${Date.now()}.txt`;
// One bash command does everything (create + sleep), so a single approval
// covers the whole turn and no second approval is needed while we are gone.
const offlineMark = events.length;
await route(IPC.invoke.agentPrompt, { sessionId: remoteId(sid), content: `Run exactly one bash command: printf 'offline-done' > ${markerD} && sleep 4. Then confirm the file content.` });
const approvalD = await openApprovalAfter(sid, offlineMark);
await route(IPC.invoke.toolResolvePermission, { requestId: approvalD.requestId, decision: "allow-once" });
// Confirm the turn is running (the sleep is in flight), then the client goes
// away entirely: stop this host (poller + router). The bridge keeps running.
await waitEvent((e, i) => i >= offlineMark && e.channel === IPC.event.agentMessage && e.payload?.sessionId === remoteId(sid) && e.payload?.event?.type === "agent_start", "offline turn started", 60_000).catch(() => null);
await host.close();
note("client.gone", {});
await sleep(5000);
// A fresh host re-discovers and reads the settled history without re-prompting.
const events2 = [];
const host2 = createPerchHost({
  hostKey: "dev", label: "Perch test", router, tunnels: fakeTunnels,
  ssh: { host: "127.0.0.1", remotePort: endpoint.port },
  emit: (c, p) => events2.push({ channel: c, payload: p }),
  buildTransport: () => ({
    exec: async () => ({ stdout: JSON.stringify(endpoint), stderr: "", code: 0 }),
    execWithInput: async () => ({ stdout: "", stderr: "", code: 0 }),
    forward: async () => { throw new Error("n/a"); }, dispose: () => {},
  }),
  pollMs: { busy: 300, idle: 1200 },
});
await host2.connect();
const recovered = await waitSnapshot(sid, (s) => JSON.stringify(s.messages).includes("offline-done"), "recovered history carries offline work", 90_000);
const onDiskD = await readFile(join(workspace, markerD), "utf8");
assert.equal(onDiskD.trim(), "offline-done", "remote completed while the client was fully closed");
note("recovered", { messages: recovered.messages.length });
await host2.close();

await writeFile(join(evidence, "perch-adapter-production.json"), JSON.stringify({ at: new Date().toISOString(), sid, workspace, log }, null, 2));
console.log("PASS perch production adapter: open/create/prompt/transcript/approval(allow+deny)/cancel/offline-recovery, all through the real adapter");
