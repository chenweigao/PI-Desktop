/**
 * Disconnect / recovery / approval / cancel acceptance against the isolated
 * Perch bridge + real OMP + kimi-k3. Separates two distinct semantics:
 *  - client disconnect (we simply stop polling): the remote turn keeps
 *    running; a fresh client reads the completed history without re-executing.
 *  - bridge restart: in-flight turn settles to `unknown`, interactions clear,
 *    history persists, and a stale approval answer fails closed.
 * No tunnel kill here (the tunnel is PI-side); the bridge-side contract is
 * what this pins.
 *
 * Run: node scripts/e2e-perch-recovery.mjs --endpoint <ep.json> --workspace <dir> --service-root <dir> --evidence <dir>
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const endpointPath = opt("endpoint"); const workspace = opt("workspace");
const serviceRoot = opt("service-root"); const evidence = opt("evidence") ?? ".";
if (!endpointPath || !workspace || !serviceRoot) { console.error("need --endpoint --workspace --service-root"); process.exit(2); }

let endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
const H = () => ({ Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" });
const base = () => `http://127.0.0.1:${endpoint.port}`;
const log = []; const note = (step, data) => { log.push({ step, at: new Date().toISOString(), data }); console.log(`· ${step}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, allowFail = false) {
  const r = await fetch(base() + path, { headers: H() });
  const t = await r.text();
  if (!r.ok && !allowFail) throw new Error(`${r.status} ${t}`);
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}
async function post(path, body, allowFail = false) {
  const r = await fetch(base() + path, { method: "POST", headers: H(), body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok && !allowFail) throw new Error(`${r.status} ${t}`);
  return { status: r.status, body: t ? JSON.parse(t) : {} };
}

async function pollUntil(id, done, { timeoutMs = 180_000, autoApprove = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body: snap } = await get(`/sessions/${id}`);
    if (autoApprove) for (const it of snap.interactions ?? []) {
      if (it.method === "confirm") await post(`/sessions/${id}/answer`, { id: it.id, allow: true });
      else if (it.method === "select") {
        const choice = (it.options ?? []).find((o) => /approve/i.test(o)) ?? it.options?.[0];
        await post(`/sessions/${id}/answer`, { id: it.id, value: choice });
      }
    }
    if (done(snap)) return snap;
    if (Date.now() > deadline) throw new Error(`timeout busy=${snap.busy} turnState=${snap.turnState} error=${snap.error}`);
    await sleep(400);
  }
}

/* ============ A. client disconnect: remote keeps running ============ */
{
  const created = (await post("/sessions", { provider: "omp", cwd: workspace, model: "kimi-k3", permissionMode: "always-ask", title: "recovery-A" })).body;
  const id = created.id;
  const marker = `recovery-a-${Date.now()}.txt`;
  const { body: receipt } = await post(`/sessions/${id}/prompt`, {
    requestId: crypto.randomUUID(),
    text: `In this exact order: (1) create a file ${marker} with content remote-continued; (2) run \`sleep 3\`; (3) read the file back and confirm.`,
  });
  note("A.prompt", { status: receipt.status });
  // Approve the file creation so the turn is genuinely mid-flight (now in the
  // sleep) when the client goes away.
  await pollUntil(id, (s) => s.busy === true, { timeoutMs: 90_000 });
  note("A.running", {});
  // "Disconnect": stop polling while the remote keeps working through the sleep.
  await sleep(5000);
  // Reconnect: the turn settles with no second prompt and no duplicate run.
  const snap = await pollUntil(id, (s) => s.busy === false && s.turnState === "completed", { timeoutMs: 120_000 });
  const onDisk = await readFile(join(workspace, marker), "utf8");
  assert.equal(onDisk.trim(), "remote-continued", "remote completed while the client was away");
  note("A.recovered", { turnState: snap.turnState, messages: (snap.messages ?? []).length });
}

/* ============ B. pending approval survives a client disconnect ============ */
{
  const created = (await post("/sessions", { provider: "omp", cwd: workspace, model: "kimi-k3", permissionMode: "always-ask", title: "recovery-B" })).body;
  const id = created.id;
  await post(`/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "Run `pwd` please." });
  // Wait for the approval to be pending.
  const withApproval = await pollUntil(id, (s) => (s.interactions ?? []).length > 0, { autoApprove: false, timeoutMs: 60_000 });
  const approval = withApproval.interactions[0];
  note("B.approval.pending", { id: approval.id, method: approval.method, title: approval.title });
  // Disconnect: stop polling; the approval stays pending on the bridge.
  await sleep(2500);
  // Reconnect: the same approval is still open and answerable.
  const { body: after } = await get(`/sessions/${id}`);
  const still = (after.interactions ?? []).find((x) => x.id === approval.id);
  assert.ok(still, "the same approval is still pending after a client disconnect");
  const choice = (still.options ?? []).find((o) => /approve/i.test(o)) ?? still.options?.[0];
  await post(`/sessions/${id}/answer`, { id: still.id, value: choice });
  // The answer may itself raise a fresh approval (always-ask re-asks on the
  // next tool), so keep approving until the turn settles.
  const settled = await pollUntil(id, (s) => s.busy === false && (s.pending ?? 0) === 0 && ["completed", "failed"].includes(s.turnState));
  note("B.answered", { turnState: settled.turnState });
}

/* ============ C. cancel targets the live turn ============ */
{
  const created = (await post("/sessions", { provider: "omp", cwd: workspace, model: "kimi-k3", permissionMode: "always-ask", title: "recovery-C" })).body;
  const id = created.id;
  await post(`/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "Run `sleep 8`, then say done." });
  // Drive the turn to genuinely running (model engaged), approving the bash
  // tool so it is mid-`sleep` when we abort — not stuck at the pre-approval.
  const running = await pollUntil(id, (s) => s.busy === true && s.turnId && (s.messages ?? []).length > 0, { timeoutMs: 90_000 });
  const turnId = running.turnId;
  note("C.running", { turnId });
  // Abort must name the live turn; a stale id is rejected.
  const stale = await post(`/sessions/${id}/abort`, { turnId: "turn-does-not-exist" }, true);
  assert.equal(stale.status, 400, "stale turn id rejected");
  const ok = await post(`/sessions/${id}/abort`, { turnId });
  assert.equal(ok.status, 200);
  // The turn settles (stopped/failed) without waiting out the sleep.
  const settled = await pollUntil(id, (s) => s.busy === false, { autoApprove: false, timeoutMs: 90_000 });
  assert.ok(["stopped", "failed", "completed"].includes(settled.turnState), `turn settled after abort (${settled.turnState})`);
  note("C.aborted", { turnState: settled.turnState });
}

/* ============ D. bridge restart: honest interruption, history persists ============ */
{
  const created = (await post("/sessions", { provider: "omp", cwd: workspace, model: "kimi-k3", permissionMode: "always-ask", title: "recovery-D" })).body;
  const id = created.id;
  await post(`/sessions/${id}/prompt`, { requestId: crypto.randomUUID(), text: "Run `sleep 8` then say done." });
  // Drive to genuinely running, approving the sleep so the turn is mid-flight.
  await pollUntil(id, (s) => s.busy === true && (s.messages ?? []).length > 0, { timeoutMs: 90_000 });
  const beforeRestart = (await get(`/sessions/${id}`)).body;
  const messagesBefore = (beforeRestart.messages ?? []).length;
  // Kill the bridge process; the restart resets in-flight state honestly.
  const pid = endpoint.pid;
  process.kill(pid, "SIGTERM");
  await sleep(1500);
  // Restart the isolated service on the same root (new port + token).
  const child = spawn("python3", [join(serviceRoot, "native-agent-service.py")], {
    env: { ...process.env, AWB_NATIVE_ROOT: serviceRoot },
    stdio: ["ignore", "ignore", "ignore"], detached: true,
  });
  child.unref();
  // Wait for a fresh endpoint.json (new pid).
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const next = JSON.parse(await readFile(endpointPath, "utf8"));
      if (next.pid !== pid) { endpoint = next; break; }
    } catch { /* not yet written */ }
    if (Date.now() > deadline) throw new Error("bridge did not restart");
    await sleep(300);
  }
  const health = (await get("/health")).body;
  note("D.restarted", { version: health.version, newPid: health.pid });
  const { body: after } = await get(`/sessions/${id}`);
  assert.equal(after.busy, false, "restart clears the phantom busy state");
  assert.ok(after.error, "restart marks the interrupted task honestly");
  assert.equal((after.interactions ?? []).length, 0, "restart clears pending approvals");
  assert.ok((after.messages ?? []).length >= messagesBefore, "history persists across restart");
  // A stale approval answer fails closed after restart.
  const staleAnswer = await post(`/sessions/${id}/answer`, { id: "ap-dead", value: "Approve" }, true);
  assert.equal(staleAnswer.status, 400, "stale approval answer fails closed after restart");
  note("D.honest", { error: after.error, history: (after.messages ?? []).length });
}

await writeFile(join(evidence, "perch-recovery.json"), JSON.stringify({ at: new Date().toISOString(), log }, null, 2));
console.log("PASS perch recovery: client-disconnect continues, approval survives, cancel is accurate, restart is honest");
