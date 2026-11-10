import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

/**
 * Rendered launcher click-through: the real RemoteSessionLauncher in real
 * Chromium, driving the production `onCreate` payload — host row → runtime
 * pick → creation-fixed permission pick. This is the test that would have
 * caught the launcher/store permission field mismatch.
 */
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { remoteEn } from "../../apps/desktop/src/locales/remote";
import { IPC } from "@pi-desktop/shared";
import { RemoteSessionLauncher } from "../../apps/desktop/src/components/remote/RemoteSessionLauncher";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en), remote: remoteEn } },
  interpolation: { escapeValue: false } });

const created = [];
window.piDesktop = { platform: "linux", channels: IPC,
  on() { return () => undefined; },
  async invoke(channel, input) {
    if (channel === IPC.invoke.remoteHostList) return { ok: true, data: { hosts: [
      { hostKey: "perch-a", label: "Dev Box", url: "perch+ssh://dev", connected: true, status: "connected", transport: "ssh", backend: "perch", ssh: { host: "dev" } },
    ] } };
    if (channel === IPC.invoke.remoteHostModels) return { ok: true, data: { models: [
      { id: "kimi-k3", provider: "bailian", name: "kimi-k3", agent: "omp" },
      { id: "gpt-6.1-sol", provider: "codex", name: "gpt-6.1-sol", agent: "codex" },
    ] } };
    if (channel === IPC.invoke.remoteHostBrowseProjects) return { ok: true, data: { path: "/home/dev", entries: [] } };
    throw new Error("Unexpected IPC: " + channel);
  },
};

const view = createRoot(document.getElementById("root"));
flushSync(() => view.render(React.createElement(RemoteSessionLauncher, {
  onCreate: async (request) => { created.push(JSON.parse(JSON.stringify(request))); },
  onClose: () => {},
})));

const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 8000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const check = (value, message) => { if (!value) throw new Error(message); };
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
const click = async (node, message) => { check(node, message); flushSync(() => node.click()); await frame(); };

window.launcherProbe = async () => {
  const t = (k) => i18n.t(k);
  // Host row renders once the inventory loads; one click opens ONE form.
  await until(() => button("Dev Box"), "host row did not render");
  await click(button("Dev Box"), "host row missing");
  await until(() => document.querySelector(".sidebar-remote-launch-config"), "config form did not open");
  // Multi-runtime host: no silent default — Create stays disabled until the
  // user picks a runtime, all in the same form.
  const createBtn = () => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === t("remote:createRemoteSession"));
  check(createBtn()?.disabled, "create must stay disabled until a runtime is picked on a multi-runtime host");
  // Pick the runtime inside the same form.
  const agentSelect = document.querySelector('.sidebar-remote-launch-config [aria-label="' + t("remote:chooseAgent") + '"]');
  check(agentSelect, "runtime select missing");
  await click(agentSelect, "runtime select not clickable");
  await until(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.textContent.trim() === "omp"), "runtime options missing");
  const ompOption = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent.trim() === "omp");
  await click(ompOption, "omp option missing");
  // The permission select follows with OMP's own options and default marked.
  await until(() => {
    const perm = document.querySelector('.sidebar-remote-launch-config [aria-label="' + t("chat.permissionMode") + '"]');
    return perm && perm.textContent.includes(t("chat.remotePermissionOption.always-ask"));
  }, "permission select did not follow the runtime pick");
  // Switch permission to "Allow writes".
  const permSelect = document.querySelector('.sidebar-remote-launch-config [aria-label="' + t("chat.permissionMode") + '"]');
  await click(permSelect, "permission select not clickable");
  await until(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.textContent.includes(t("chat.remotePermissionOption.write"))), "permission options missing");
  const writeOption = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent.includes(t("chat.remotePermissionOption.write")));
  await click(writeOption, "write option missing");
  check(!createBtn().disabled, "create must enable once runtime is picked");
  await click(createBtn(), "create missing");
  check(created.length === 1, "expected exactly one create, got " + created.length);
  check(created[0].hostKey === "perch-a" && created[0].remoteProvider === "omp"
    && created[0].permissionMode === "write", "create payload lost the runtime or permission: " + JSON.stringify(created[0]));

  // Second run: defaults path — Codex with its default (workspace-ask) without touching the selects.
  await click(button("Dev Box"), "host row missing on second run");
  await until(() => document.querySelector(".sidebar-remote-launch-config"), "config form did not reopen");
  const agentSelect2 = document.querySelector('.sidebar-remote-launch-config [aria-label="' + t("remote:chooseAgent") + '"]');
  await click(agentSelect2, "runtime select missing on second run");
  await until(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.textContent.trim() === "codex"), "codex option missing");
  await click([...document.querySelectorAll('[role="option"]')].find((node) => node.textContent.trim() === "codex"), "codex option missing");
  await click(createBtn(), "create missing on second run");
  check(created.length === 2 && created[1].permissionMode === "workspace-ask" && created[1].remoteProvider === "codex",
    "codex default permission payload wrong: " + JSON.stringify(created[1]));
  flushSync(() => view.unmount());
  return { passed: true };
};
`;

test("remote launcher click-through carries runtime and creation-fixed permission", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-launcher-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "styles.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 900, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("LAUNCHER_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.launcherProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /LAUNCHER_PROBE \{"passed":true\}/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
