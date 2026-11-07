/**
 * Real closed-loop acceptance against an isolated Perch bridge + real OMP +
 * 百炼 kimi-k3. No mock model. Drives the actual HTTP contract the adapter
 * consumes: create a session rooted at a dedicated test dir, prompt for
 * `pwd`/`uname -s`/a small file create+read, answer the always-ask approval,
 * and assert the tool output matches the remote reality.
 *
 * Evidence (sanitized) is written to the evidence dir. The bridge token is
 * read from the isolated endpoint.json and never printed.
 *
 * Run:
 *   node scripts/e2e-perch-adapter.mjs \
 *     --endpoint <serviceRoot/endpoint.json> --workspace <dir>
 */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const endpointPath = opt("endpoint");
const workspace = opt("workspace");
const evidence = opt("evidence") ?? ".";
if (!endpointPath || !workspace) { console.error("need --endpoint and --workspace"); process.exit(2); }

const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
const base = `http://127.0.0.1:${endpoint.port}`;
const H = { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" };
const log = [];
const note = (step, data) => { log.push({ step, at: new Date().toISOString(), data }); console.log(`· ${step}`); };

async function get(path) {
  const r = await fetch(base + path, { headers: H });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  return JSON.parse(t || "{}");
}
async function post(path, body) {
  const r = await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  return JSON.parse(t || "{}");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the snapshot until `done`, auto-answering confirm approvals with allow. */
async function drive(id, done, { timeoutMs = 180_000, autoApprove = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastRevision = -1;
  for (;;) {
    const snap = await get(`/sessions/${id}`);
    if (snap.revision !== lastRevision) lastRevision = snap.revision;
    // Answer any open approval (always-ask mode). OMP tool approval is a
    // `select` ("Approve" / "Approve bash for this session" / "Deny"); a
    // `confirm` takes {confirmed}. Map to the bridge's answer shape.
    for (const it of snap.interactions ?? []) {
      if (!autoApprove) continue;
      if (it.method === "confirm") {
        note("approval.allow", { id: it.id, title: it.title });
        await post(`/sessions/${id}/answer`, { id: it.id, allow: true });
      } else if (it.method === "select") {
        const choice = (it.options ?? []).find((o) => /approve/i.test(o)) ?? it.options?.[0];
        note("approval.select", { id: it.id, title: it.title, choice });
        await post(`/sessions/${id}/answer`, { id: it.id, value: choice });
      }
    }
    if (done(snap)) return snap;
    if (Date.now() > deadline) throw new Error(`drive timeout; last state busy=${snap.busy} turnState=${snap.turnState} error=${snap.error}`);
    await sleep(400);
  }
}

/* ---- health + provider check ---- */
const health = await get("/health");
assert.equal(health.version, 13, "bridge SERVICE_VERSION");
note("health", { version: health.version, implementation: health.implementation });
const setup = await get("/setup?provider=omp");
assert.ok(setup.installed, "omp installed on the remote");
const kimi = (setup.models ?? []).find((m) => m.provider === "bailian" && m.id === "kimi-k3");
assert.ok(kimi, "bailian/kimi-k3 is in the remote catalog");
note("catalog", { kimi: { provider: kimi.provider, id: kimi.id } });

/* ---- create a session rooted at the dedicated workspace ---- */
const created = await post("/sessions", {
  provider: "omp", cwd: workspace, model: "kimi-k3", permissionMode: "always-ask",
  title: "pi-perch-adapter acceptance",
});
const id = created.id;
note("session.created", { id, cwd: created.cwd, model: created.model, permission: created.permission });
assert.equal(created.permission?.selected, "always-ask");

/* ---- turn 1: pwd + uname, via a marker file for ground truth ---- */
const markerName = `probe-${Date.now()}.txt`;
const promptText = [
  `In the current directory, do exactly these steps and report concisely:`,
  `1) run \`pwd\` and \`uname -s\`;`,
  `2) create a file named ${markerName} containing exactly: perch-adapter-ok;`,
  `3) read it back and tell me its content.`,
  `Report the values of pwd, uname -s, and the file content.`,
].join(" ");
const requestId = crypto.randomUUID();
const receipt = await post(`/sessions/${id}/prompt`, { requestId, text: promptText });
assert.ok(["submitting", "submitted", "accepted", "running"].includes(receipt.status), `receipt accepted, got ${receipt.status}`);
note("prompt.receipt", { requestId: receipt.id, status: receipt.status });

const finalSnap = await drive(id, (snap) => snap.busy === false && (snap.pending ?? 0) === 0 && (snap.turnState === "completed" || snap.turnState === "failed"));
note("turn.settled", { turnState: finalSnap.turnState, busy: finalSnap.busy, error: finalSnap.error });
assert.equal(finalSnap.turnState, "completed", `turn completed (error=${finalSnap.error})`);

/* ---- assertions against remote ground truth ---- */
const messages = finalSnap.messages ?? [];
const fullText = JSON.stringify(messages);
assert.ok(fullText.includes(workspace) || fullText.includes(workspace.replace(/\/$/, "")), "transcript carries the remote pwd");
assert.ok(/Linux/i.test(fullText), "transcript carries uname -s = Linux");
assert.ok(fullText.includes("perch-adapter-ok"), "transcript carries the created file content");
const onDisk = await readFile(join(workspace, markerName), "utf8");
assert.equal(onDisk.trim(), "perch-adapter-ok", "file on the remote disk matches");
note("assertions", { pwdInTranscript: true, unameInTranscript: true, fileOnDisk: true });

/* ---- receipt is durable and queryable ---- */
const stored = await get(`/sessions/${id}/requests/${requestId}`);
assert.equal(stored.id, requestId);
assert.ok(["completed", "accepted", "running", "submitted", "consumed"].includes(stored.status), `receipt terminal-ish status ${stored.status}`);
note("receipt.query", { status: stored.status });

await writeFile(join(evidence, "perch-real-loop.json"), JSON.stringify({
  at: new Date().toISOString(), sessionId: id, workspace, markerName, log,
  turnState: finalSnap.turnState,
}, null, 2));
console.log("PASS perch real loop: kimi-k3 + OMP executed pwd/uname/file, approval answered, receipt durable");
