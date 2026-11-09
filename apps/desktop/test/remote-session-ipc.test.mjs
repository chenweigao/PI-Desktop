import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
register(new URL("./helpers/electron-stub-hooks.mjs", import.meta.url));
const { registerRemoteSessionIpc } = await import("../electron/main/ipc/remote-session-ipc.ts");

function harness(createSession) {
  const handlers = new Map();
  registerRemoteSessionIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    () => ({ createSession }),
  );
  return handlers;
}

test("createSession passes a runtime-native permission id through when a provider is named", async () => {
  const seen = [];
  const handlers = harness(async (request) => {
    seen.push(request);
    return { id: "remote:h:s1", title: "", mode: "agent", permissionMode: "ask", thinkingLevel: "off", messageCount: 0, updatedAt: "", createdAt: "" };
  });
  await handlers.get(IPC.invoke.remoteHostCreateSession)({
    hostKey: "h", projectId: "/srv", provider: "omp", permissionMode: "write",
  });
  assert.equal(seen[0].permissionMode, "write", "runtime-native id reached the boot");
});

test("createSession without a runtime still validates PI permission modes", async () => {
  const handlers = harness(async () => { throw new Error("must not be reached"); });
  await assert.rejects(
    handlers.get(IPC.invoke.remoteHostCreateSession)({ hostKey: "h", projectId: "/srv", permissionMode: "workspace-auto" }),
    /invalid permissionMode/,
  );
  await assert.rejects(
    handlers.get(IPC.invoke.remoteHostCreateSession)({ hostKey: "h", projectId: "/srv", permissionMode: 42 }),
    /invalid permissionMode/,
  );
  // A PI mode without a provider is still accepted.
  const seen = [];
  const ok = harness(async (request) => {
    seen.push(request);
    return { id: "remote:h:s1", title: "", mode: "agent", permissionMode: "ask", thinkingLevel: "off", messageCount: 0, updatedAt: "", createdAt: "" };
  });
  await ok.get(IPC.invoke.remoteHostCreateSession)({ hostKey: "h", projectId: "/srv", permissionMode: "ask" });
  assert.equal(seen[0].permissionMode, "ask");
});

test("addPerch reports the auto-registered Kimi sibling; probe failures stay silent", async () => {
  const { registerRemoteHostIpc } = await import("../electron/main/ipc/remote-host-ipc.ts");
  const perchSummary = { hostKey: "dev-box-x", label: "X", url: "perch+ssh://x", connected: true, backend: "perch" };
  const kimiSummary = { hostKey: "dev-box-x-kimi", label: "X · Kimi", url: "kimi+ssh://x", connected: false, backend: "kimi", siblingOf: "dev-box-x" };
  const withKimi = new Map();
  registerRemoteHostIpc({
    registrar: { handle: (channel, handler) => withKimi.set(channel, handler) },
    getRemoteHostsBoot: () => ({
      addHost: async () => perchSummary,
      probeKimiSibling: async () => kimiSummary,
    }),
  });
  const added = await withKimi.get(IPC.invoke.remoteHostAddPerch)({ host: "x", label: "X" });
  assert.deepEqual(added.alsoAdded, kimiSummary, "the sibling rides the add response");

  const withoutKimi = new Map();
  registerRemoteHostIpc({
    registrar: { handle: (channel, handler) => withoutKimi.set(channel, handler) },
    getRemoteHostsBoot: () => ({
      addHost: async () => perchSummary,
      probeKimiSibling: async () => { throw new Error("ssh down"); },
    }),
  });
  const plain = await withoutKimi.get(IPC.invoke.remoteHostAddPerch)({ host: "x", label: "X" });
  assert.equal(plain.alsoAdded, undefined, "a failed probe never breaks the add");
  assert.deepEqual(plain.host, perchSummary);
});
