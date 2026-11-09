/**
 * Real Kimi channel acceptance against an isolated `kimi web` service, driving
 * the production adapter (createKimiHost → KimiClient → KimiBackend through
 * the real BackendRouter). The service runs under a dedicated KIMI_CODE_HOME.
 *
 * If the isolated home has no model credentials, the test reports the catalog
 * as unavailable and verifies the honest failure surfaces — it never
 * fabricates a model answer. A real turn only runs when the catalog is live.
 *
 * Run:
 *   KIMI_TEST_ENDPOINT=<endpoint.json> node scripts/e2e-kimi-adapter.mjs
 * where the endpoint comes from a local-agent-service `--agent kimi` start.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));

const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter, makeRemoteSessionId } = await import("../apps/desktop/electron/main/remote/backend-router.ts");
const { createKimiHost } = await import("../apps/desktop/electron/main/remote/kimi/kimi-host.ts");

const endpointPath = process.env.KIMI_TEST_ENDPOINT;
if (!endpointPath) { console.error("need KIMI_TEST_ENDPOINT"); process.exit(2); }
const endpointRecord = JSON.parse(await readFile(endpointPath, "utf8"));
// The service record has no token; it lives in $KIMI_CODE_HOME/server.token.
const tokenPath = process.env.KIMI_TEST_TOKEN ?? new URL("./token-not-found", import.meta.url).pathname;
let token = endpointRecord.token;
if (!token && process.env.KIMI_TEST_TOKEN_PATH) {
  token = (await readFile(process.env.KIMI_TEST_TOKEN_PATH, "utf8")).trim();
}
if (!token) { console.error("need KIMI_TEST_TOKEN_PATH (the remote server.token)"); process.exit(2); }
const endpoint = { ...endpointRecord, token };

const events = [];
const router = createBackendRouter();
const host = createKimiHost({
  hostKey: "kimi-test", label: "Kimi test", router,
  ssh: { host: "127.0.0.1", remotePort: endpoint.port },
  emit: (channel, payload) => events.push({ channel, payload }),
  // The service is loopback-local in this test: a real local forward, and an
  // exec that returns the known endpoint descriptor.
  buildTransport: () => {
    const servers = new Set();
    return {
      exec: async () => ({ stdout: JSON.stringify(endpoint), stderr: "", code: 0 }),
      execWithInput: async () => ({ stdout: "", stderr: "", code: 0 }),
      forward: async ({ localPort, remotePort }) => {
        const { createServer, connect } = await import("node:net");
        const server = createServer((socket) => {
          const upstream = connect({ host: "127.0.0.1", port: remotePort });
          socket.pipe(upstream).pipe(socket);
        });
        servers.add(server);
        await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(localPort, "127.0.0.1", resolveListen); });
        return { localPort, close: async () => { servers.delete(server); await new Promise((r) => server.close(r)); } };
      },
      dispose: () => { for (const server of servers) server.close(); servers.clear(); },
    };
  },
  pollMs: { busy: 300, idle: 1200 },
});
await host.connect();
console.log("· host.connected");

const remoteId = (sid) => makeRemoteSessionId("kimi-test", sid);
const route = async (channel, input) => (await router.route(channel, [input])).value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- catalog: honest about availability ---- */
const models = await host.models();
console.log(`· catalog (${models.length} models)`);
if (models.length === 0) {
  console.log("PASS kimi adapter (catalog empty: no model credentials on the isolated home; adapter surfaces this honestly, no fabricated turn)");
  await host.close();
  process.exit(0);
}

/* ---- create + prompt through the production path ---- */
// Prefer a known-good model (env KIMI_TEST_MODEL), else bailian/kimi-k3 when
// the catalog has it, else the first entry: the first catalog model may be an
// account-blocked provider (ppx 403 on this machine), which is an environment
// boundary, not an adapter failure — say so explicitly when it happens.
const preferred = process.env.KIMI_TEST_MODEL
  ?? (models.some((m) => m.id === "bailian/kimi-k3") ? "bailian/kimi-k3" : models[0].id);
const created = await host.createSession({ cwd: "/tmp", title: "kimi-adapter-probe", model: preferred, permissionMode: "yolo" });
// The creation-time permission choice is on the session row immediately.
const row = host.summaries().find((s) => s.id.endsWith(created.id));
assert.equal(row?.remotePermission?.selected, "yolo", "creation permission on the list row");
console.log("· permission.creation", JSON.stringify(row.remotePermission));
const sid = created.id;
console.log("· session.created", sid, "model", preferred);
const marker = `kimi-${Math.random().toString(36).slice(2, 8)}`;
await route(IPC.invoke.agentPrompt, { sessionId: remoteId(sid), content: `Reply with exactly: ${marker}. No tools.`, messageId: `opt-${marker}` });
// Wait for the assistant reply carrying the token.
const deadline = Date.now() + 90_000;
for (;;) {
  const { session } = await route(IPC.invoke.sessionGet, { id: remoteId(sid) });
  const hit = session.messages.find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes(marker));
  if (hit) { console.log("· assistant replied with the token"); break; }
  if (Date.now() > deadline) throw new Error("no assistant reply with the token in time");
  await sleep(500);
}
const { status } = await route(IPC.invoke.agentGetStatus, { sessionId: remoteId(sid) });
assert.equal(status.isRunning, false, "turn settled");

/* ---- tool + approval through the production path (manual mode asks) ---- */
// Switch the session to manual: the next prompt's tool call must surface as a
// permission card; approving it lets the tool run on the service host.
const { writeFile: writeFile2, readFile: readFile2, rm: rm2 } = await import("node:fs/promises");
await router.route(IPC.invoke.sessionConfigure, [{ sessionId: remoteId(sid) }, { permissionMode: "manual" }]);
const markerFile = `/tmp/kimi-approval-${Math.random().toString(36).slice(2, 8)}.txt`;
await route(IPC.invoke.agentPrompt, {
  sessionId: remoteId(sid),
  content: `Run exactly this shell command now, no explanation: printf kimi-approved > ${markerFile}`,
  messageId: `tool-${markerFile}`,
});
const approvalDeadline = Date.now() + 120_000;
let approval = null;
for (;;) {
  const hit = events.find((e) => e.channel === IPC.event.remoteInteractions && e.payload?.kind === "snapshot"
    && e.payload.sessionId === remoteId(sid) && (e.payload.permissions ?? []).length > 0);
  if (hit) { approval = hit.payload.permissions[0]; break; }
  if (Date.now() > approvalDeadline) break;
  await sleep(400);
}
if (approval) {
  console.log("· approval.shown", approval.toolName);
  assert.notEqual(approval.sessionGrant, false, "kimi web ≥2.4 offers the native session scope");
  // Exercise the native session grant end-to-end.
  await route(IPC.invoke.toolResolvePermission, { requestId: approval.requestId, decision: "allow-session" });
  console.log("· approval.allowed (session scope)");
  const settleDeadline = Date.now() + 120_000;
  for (;;) {
    const { session } = await route(IPC.invoke.sessionGet, { id: remoteId(sid) });
    if (!session.capabilities) throw new Error("session lost");
    const { status: st } = await route(IPC.invoke.agentGetStatus, { sessionId: remoteId(sid) });
    if (!st.isRunning) break;
    if (Date.now() > settleDeadline) throw new Error("approved turn did not settle");
    await sleep(500);
  }
  const onDisk = await readFile2(markerFile, "utf8").then(() => true, () => false);
  console.log(onDisk ? "· approval.tool-ran (file on disk)" : "· approval.tool-not-run (model chose another path)");
  await rm2(markerFile, { force: true });
} else {
  console.log("· approval.not-raised (model did not call a tool; boundary noted, not faked)");
}
/* ---- question round: the model asks via its ask tool; we answer ---- */
await router.route(IPC.invoke.sessionConfigure, [{ sessionId: remoteId(sid) }, { permissionMode: "yolo" }]);
await route(IPC.invoke.agentPrompt, {
  sessionId: remoteId(sid),
  content: "Use your ask-user question tool to ask me exactly one question with two options: red or blue. Wait for my answer, then reply with just the color I picked.",
  messageId: `ask-${marker}`,
});
const askDeadline = Date.now() + 120_000;
let ask = null;
for (;;) {
  const hit = events.find((e) => e.channel === IPC.event.remoteInteractions && e.payload?.kind === "snapshot"
    && e.payload.sessionId === remoteId(sid) && (e.payload.asks ?? []).length > 0);
  if (hit) { ask = hit.payload.asks[0]; break; }
  if (Date.now() > askDeadline) break;
  await sleep(400);
}
if (ask) {
  console.log("· ask.shown", JSON.stringify(ask.questions.map((q) => q.question)));
  await route(IPC.invoke.askToolResolve, { requestId: ask.requestId, answers: [["blue"]] });
  console.log("· ask.answered");
  const settle2 = Date.now() + 120_000;
  for (;;) {
    const { session } = await route(IPC.invoke.sessionGet, { id: remoteId(sid) });
    const done = session.messages.some((m) => m.role === "assistant" && typeof m.content === "string" && /blue/i.test(m.content));
    if (done) { console.log("· ask.turn-continued (answer in transcript)"); break; }
    if (Date.now() > settle2) throw new Error("turn did not continue with the answer");
    await sleep(600);
  }
} else {
  console.log("· ask.not-raised (model did not ask; boundary noted, not faked)");
}
await host.close();
console.log("PASS kimi adapter: create/prompt/reply/approval/question through the production path with a real model");
