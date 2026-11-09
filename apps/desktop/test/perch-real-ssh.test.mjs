/**
 * Real-SSH production entry test for the Perch adapter: the actual
 * `createRemoteHostsBoot` opens a host record marked `metadata.backend:"perch"`
 * through a real system `ssh` connection (localhost, the user's own key —
 * read-only `exec`/`forward`, no config changes) to an isolated Perch bridge
 * started under a dedicated AWB_NATIVE_ROOT. No fake transport, no direct
 * bridge HTTP from the test body: discovery, tunnel, polling and session IPC
 * all run the production path.
 *
 * Asserts: the host connects over real SSH, the Perch session list flows into
 * the global `sessionSummaries()` (with remoteProjectId), project browse goes
 * over SSH, a session is created through boot.createSession (with PI's "ask"
 * mapped to OMP always-ask), and the session IPC routes prompt/status calls.
 *
 * Run:
 *   node --test apps/desktop/test/perch-real-ssh.test.mjs
 * Requires: sshd on localhost + the isolated bridge (see RUNBOOK §2) with
 * PERCH_TEST_ENDPOINT pointing at its endpoint.json.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { createBackendRouter, makeRemoteSessionId } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteHostsBoot } = await import("../electron/main/bootstrap/remote-hosts.ts");

const endpointPath = process.env.PERCH_TEST_ENDPOINT;
const workspace = process.env.PERCH_TEST_WORKSPACE;

function reversibleEncryption() {
  return {
    isAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (buf) => buf.toString("utf8").slice(4),
  };
}

test("perch host over real ssh: discover, list, browse, create, prompt-route", { timeout: 120_000 }, async (t) => {
  if (!endpointPath || !workspace) {
    t.skip("PERCH_TEST_ENDPOINT / PERCH_TEST_WORKSPACE not set");
    return;
  }
  const endpoint = JSON.parse(await readFile(endpointPath, "utf8"));
  const dataDir = await mkdtemp(join(tmpdir(), "perch-ssh-boot-"));
  const router = createBackendRouter();
  const events = [];
  const boot = createRemoteHostsBoot({
    dataDir, encryption: reversibleEncryption(), router,
    clientInfo: { name: "perch-ssh-test", version: "0.0.0" },
    emit: (channel, payload) => events.push({ channel, payload }),
    log: (level, message, data) => console.log(`[boot:${level}]`, message, data ? JSON.stringify(data) : ""),
  });
  try {
    // Register the Perch host exactly like the Settings UI does (same record
    // shape the remoteHostAddPerch IPC handler persists).
    const summary = await boot.addHost({
      hostKey: "localhost-perch",
      label: "Localhost Perch",
      url: "perch+ssh://localhost",
      deviceToken: "",
      metadata: {
        transport: "ssh",
        backend: "perch",
        ssh: { host: "localhost", remotePort: 1 },
      },
    });
    assert.equal(summary.connected, true, "host connected over real SSH (discover + tunnel)");

    // Sessions from the real bridge appear in the global summaries with a
    // project identity derived from the remote cwd.
    const sessions = await boot.sessions("localhost-perch");
    assert.ok(Array.isArray(sessions));
    const summaries = boot.sessionSummaries();
    const perchRows = summaries.filter((s) => s.remoteHostKey === "localhost-perch");
    assert.deepEqual(
      perchRows.map((s) => s.id).sort(),
      sessions.map((s) => s.id).sort(),
      "sessionSummaries() exposes the Perch inventory to the global session list",
    );
    for (const row of perchRows) {
      assert.ok(row.remoteProjectId?.startsWith("/"), "remoteProjectId carries the remote cwd");
    }

    // Project browse goes over real SSH (no bridge endpoint for it).
    const browse = await boot.browseProjects("localhost-perch", workspace);
    assert.equal(browse.path, workspace);
    assert.ok(Array.isArray(browse.entries));

    // Create a session through the production boot path. PI's default "ask"
    // must map to OMP always-ask (the bridge rejects "ask").
    const created = await boot.createSession({
      hostKey: "localhost-perch", projectId: workspace, permissionMode: "ask",
    });
    assert.ok(created.id.startsWith("remote:localhost-perch:"));
    const hostSessionId = created.id.replace(/^remote:localhost-perch:/, "");

    // The session IPC routes through the router to the Perch backend: status
    // comes back renderer-shaped.
    const status = await router.route(IPC.invoke.agentGetStatus, [{ sessionId: created.id }]);
    assert.equal(status.remote, true);
    assert.equal(status.value.status.isRunning, false);

    // And the transcript read renders UiMessage-shaped rows.
    const detail = await router.route(IPC.invoke.sessionGet, [{ id: created.id }]);
    assert.equal(detail.value.session.id, created.id);
    assert.ok(Array.isArray(detail.value.session.messages));
    // The bridge's permission capability flows through (OMP fixes it at
    // creation; PI's "ask" mapped to always-ask).
    assert.deepEqual(detail.value.session.remotePermission, {
      selected: "always-ask",
      options: ["always-ask", "write", "yolo"],
      scope: "new-session",
    });
    // The per-runtime readiness probe lists every runtime the bridge serves,
    // plus the Kimi service sharing this machine (this host has one running).
    const runtimes = await boot.runtimeStatus("localhost-perch");
    assert.equal(runtimes.length, 7, "six bridge runtimes plus the kimi sibling probe");
    const omp = runtimes.find((r) => r.provider === "omp");
    assert.equal(omp.installed, true, "omp installed on this host");
    assert.ok(omp.models.length > 0, "omp models discovered");
    for (const runtime of runtimes) {
      assert.ok(["configured", "missing", "session-handshake", "unverified"].includes(runtime.modelCheck));
    }
    const kimiRow = runtimes.find((r) => r.provider === "kimi");
    assert.equal(kimiRow.installed, true, "kimi service detected on the same host");

    // Detection registered the Kimi channel under the same saved connection —
    // an existing host gains it without re-entering any SSH field.
    const afterProbe = await boot.list();
    const sibling = afterProbe.find((h) => h.hostKey === "localhost-perch-kimi");
    assert.ok(sibling, "kimi sibling registered by the runtime probe");
    assert.equal(sibling.backend, "kimi");
    assert.equal(sibling.ssh.host, "localhost");

    // Connection edits to the primary follow the sibling (one machine, one
    // configuration); a derived sibling name follows a rename.
    await boot.updateHost("localhost-perch", { label: "Renamed Perch" });
    let rows = await boot.list();
    assert.equal(rows.find((h) => h.hostKey === "localhost-perch-kimi").label, "Renamed Perch · Kimi");
    // A valid connection field follows the link (the current user keeps SSH
    // working; an invalid one would surface the edit's own error instead).
    const me = process.env.USER || "root";
    await boot.updateHost("localhost-perch", { ssh: { user: me } });
    rows = await boot.list();
    assert.equal(rows.find((h) => h.hostKey === "localhost-perch-kimi").ssh.user, me);
    // The sibling's own service port never leaks across the link.
    assert.equal(rows.find((h) => h.hostKey === "localhost-perch-kimi").ssh.remotePort ?? 1, 1);
    // And edits in the reverse direction reach the parent (clearing the user
    // field on the sibling clears it on the parent too).
    await boot.updateHost("localhost-perch-kimi", { ssh: { user: "" } });
    rows = await boot.list();
    assert.equal(rows.find((h) => h.hostKey === "localhost-perch").ssh.user, undefined);
    note({ endpointPort: endpoint.port, created: hostSessionId });
    // A fresh boot over the same dataDir (an app restart) keeps the sibling.
    await boot.closeAll();
    const boot2 = createRemoteHostsBoot({
      dataDir, encryption: reversibleEncryption(), router,
      clientInfo: { name: "perch-ssh-test", version: "0.0.0" },
      emit: () => undefined,
      log: () => undefined,
    });
    const reopened = await boot2.list();
    const reopenedSibling = reopened.find((h) => h.hostKey === "localhost-perch-kimi");
    assert.ok(reopenedSibling, "kimi sibling persists across an app restart");
    assert.equal(reopenedSibling.label, "Renamed Perch · Kimi", "propagated rename persists");
    // Removing the machine removes the linked Kimi channel with it.
    await boot2.removeHost("localhost-perch");
    const afterRemove = await boot2.list();
    assert.ok(!afterRemove.some((h) => h.hostKey === "localhost-perch"), "primary removed");
    assert.ok(!afterRemove.some((h) => h.hostKey === "localhost-perch-kimi"), "sibling removed with the machine");
    await boot2.closeAll();
  } finally {
    await boot.closeAll().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

function note(data) {
  console.log("· real-ssh", JSON.stringify(data));
}
