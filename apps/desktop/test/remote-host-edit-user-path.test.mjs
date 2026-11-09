import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { RemoteHostsPage } from "../../apps/desktop/src/components/settings/RemoteHostsPage";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const label = (key) => i18n.t("settings.remoteHosts." + key);

// A fake main process whose update path mirrors bootstrap/remote-hosts.ts
// merge semantics ("" clears, absent keeps) so the probe verifies both the
// exact IPC payload the form emits and the persisted state after a remount.
const records = new Map();
records.set("host-1", { hostKey: "host-1", label: "Build Box", url: "local-tunnel://host-1",
  connected: true, status: "connected", transport: "ssh", backend: "perch",
  ssh: { host: "old.example.com", user: "alice", port: 2222, identityFile: "/keys/id_ed25519" } });
records.set("host-1-kimi", { hostKey: "host-1-kimi", label: "Build Box · Kimi", url: "kimi+ssh://old.example.com",
  connected: true, status: "connected", transport: "ssh", backend: "kimi", siblingOf: "host-1",
  ssh: { host: "old.example.com", user: "alice", port: 2222, identityFile: "/keys/id_ed25519", remotePort: 58627 } });
const updates = [];
const summary = (record) => JSON.parse(JSON.stringify(record));
window.piDesktop = { platform: "linux", channels: IPC,
  on() { return () => undefined; },
  async invoke(channel, input) {
    if (channel === IPC.invoke.remoteHostList) return { ok: true, data: { hosts: [...records.values()].map(summary) } };
    if (channel === IPC.invoke.remoteHostModels) return { ok: true, data: { models: [] } };
    if (channel === IPC.invoke.remoteHostRuntimes) return { ok: true, data: { runtimes: [
      { provider: "omp", installed: true, version: "omp 18.13.1", models: [{ id: "kimi-k3", name: "kimi-k3", provider: "bailian" }], modelCheck: "configured", credentialCheck: "provider-managed" },
      { provider: "qoder", installed: true, version: "qoderclicn 1.1.58", models: [], modelCheck: "missing", credentialCheck: "missing" },
      { provider: "codex", installed: false, models: [], modelCheck: "unverified", credentialCheck: "unverified" },
      { provider: "kimi", installed: true, models: [], modelCheck: "unverified", credentialCheck: "unverified", registered: true },
      { provider: "claude", installed: false, models: [], modelCheck: "unverified", credentialCheck: "unverified", error: "probe timed out" },
    ] } };
    if (channel === IPC.invoke.remoteHostUpdate) {
      updates.push(JSON.parse(JSON.stringify(input)));
      const record = records.get(input.hostKey);
      if (!record) return { ok: false, error: { message: "unknown host" } };
      if (typeof input.label === "string" && input.label.trim()) record.label = input.label.trim();
      if (input.ssh && typeof input.ssh === "object") {
        const merged = { ...record.ssh };
        for (const [field, value] of Object.entries(input.ssh)) {
          if (value === "" || value === null) delete merged[field];
          else merged[field] = value;
        }
        record.ssh = merged;
      }
      return { ok: true, data: { host: summary(record) } };
    }
    throw new Error("Unexpected IPC: " + channel);
  },
};

let view;
const mount = () => { view = createRoot(document.getElementById("root")); flushSync(() => view.render(React.createElement(RemoteHostsPage))); };
const check = (value, message) => { if (!value) throw new Error(message); };
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const editButton = () => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label("edit"));
const saveButton = () => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label("save"));
const input = (key) => document.querySelector('input[aria-label="' + label(key) + '"]');
const fill = async (key, value) => {
  const element = input(key);
  check(element, "missing input " + key);
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame();
};
const openEditor = async () => {
  check(editButton(), "edit action missing");
  flushSync(() => editButton().click());
  await until(() => saveButton(), "edit form did not open");
};
const save = async () => {
  flushSync(() => saveButton().click());
  await until(() => !saveButton(), "edit form did not close");
  await frame();
};
const errorText = () => document.querySelector(".settings-remote-hosts [role='alert'], .settings-remote-hosts .text-danger, .settings-remote-hosts form + p")?.textContent
  ?? [...document.querySelectorAll("p")].map((node) => node.textContent).join("|");

mount();
window.remoteHostEditProbe = async () => {
  await until(() => editButton(), "host inventory did not render");
  // The Kimi sibling card is grouped with its machine, not a second mystery host.
  check(document.body.textContent.includes(label("linkedTo").split("{{label}}")[0].trim()) === false
    || document.body.textContent.includes("linked to Build Box"),
    "sibling card did not name its parent host");
  // Hydration: the edit form shows every stored SSH field.
  await openEditor();
  check(input("sshHost").value === "old.example.com", "host not hydrated");
  check(input("sshUser").value === "alice", "user not hydrated");
  check(input("sshPort").value === "2222", "port not hydrated");
  check(input("sshIdentityFile").value === "/keys/id_ed25519", "identity file not hydrated");

  // 1. Changing only the address sends exactly that field.
  await fill("sshHost", "new.example.com");
  await save();
  check(updates.length === 1, "expected one update, got " + updates.length);
  check(JSON.stringify(updates[0]) === JSON.stringify({ hostKey: "host-1", ssh: { host: "new.example.com" } }),
    "address change payload wrong: " + JSON.stringify(updates[0]));
  await until(() => editButton(), "list did not come back");

  // 2. Clearing the user sends "" so the backend deletes the stored value.
  await openEditor();
  check(input("sshHost").value === "new.example.com", "updated host not persisted into the form");
  await fill("sshUser", "");
  await save();
  check(updates.length === 2, "expected a second update");
  check(JSON.stringify(updates[1]) === JSON.stringify({ hostKey: "host-1", ssh: { user: "" } }),
    "clear-user payload wrong: " + JSON.stringify(updates[1]));
  check(records.get("host-1").ssh.user === undefined, "cleared user survived in the record");

  // 3. A pure rename sends no ssh block, so the backend keeps the connection.
  await openEditor();
  await fill("fieldLabel", "Renamed Box");
  await save();
  check(updates.length === 3, "expected a third update");
  check(JSON.stringify(updates[2]) === JSON.stringify({ hostKey: "host-1", label: "Renamed Box" }),
    "rename payload must not carry ssh: " + JSON.stringify(updates[2]));

  // 4. Clearing the port sends "" (back to the SSH default).
  await openEditor();
  await fill("sshPort", "");
  await save();
  check(updates.length === 4, "expected a fourth update");
  check(JSON.stringify(updates[3]) === JSON.stringify({ hostKey: "host-1", ssh: { port: "" } }),
    "clear-port payload wrong: " + JSON.stringify(updates[3]));
  check(records.get("host-1").ssh.port === undefined, "cleared port survived in the record");

  // 5. Saving without changes emits no IPC at all.
  await openEditor();
  await save();
  check(updates.length === 4, "no-op save still called update: " + JSON.stringify(updates.at(-1)));

  // 6. An emptied host is rejected locally; nothing is sent.
  await openEditor();
  await fill("sshHost", "");
  flushSync(() => saveButton().click());
  await frame();
  check(updates.length === 4, "empty host reached the backend");
  check(saveButton(), "form closed despite the validation error");
  check(errorText().includes(label("sshHostRequired")), "missing host-required error: " + errorText());

  // 7. A non-numeric or out-of-range port is rejected locally; nothing is sent.
  await fill("sshHost", "new.example.com");
  await fill("sshPort", "abc");
  flushSync(() => saveButton().click());
  await frame();
  check(updates.length === 4, "invalid port reached the backend");
  check(errorText().includes(label("sshPortInvalid")), "missing invalid-port error: " + errorText());
  await fill("sshPort", "99999");
  flushSync(() => saveButton().click());
  await frame();
  check(updates.length === 4, "out-of-range port reached the backend");
  check(errorText().includes(label("sshPortInvalid")), "99999 accepted as a port");
  flushSync(() => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === i18n.t("common.cancel")).click());
  await until(() => editButton() && !saveButton(), "cancel did not close the form");

  // 8. Runtime probe: one click surfaces per-runtime readiness honestly.
  const runtimesButton = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label("runtimesCheck"));
  check(runtimesButton, "runtime check action missing on a connected Perch host");
  flushSync(() => runtimesButton.click());
  await until(() => document.querySelectorAll(".settings-remote-host-runtime").length === 5, "runtime rows did not render");
  const runtimeText = document.querySelector(".settings-remote-host-runtimes").textContent;
  check(runtimeText.includes("omp") && runtimeText.includes("1"), "ready runtime did not show its model count: " + runtimeText);
  check(runtimeText.includes(label("runtimeNotInstalled")), "missing runtime not marked");
  check(runtimeText.includes(label("runtimeCredentialsMissing")) || runtimeText.includes(label("runtimeModelsMissing")), "unconfigured runtime not marked");
  // A registered Kimi channel and a probe error are their own states, never
  // flattened into "not installed" or a fake "ready".
  check(runtimeText.includes(label("runtimeRegistered")), "registered kimi row missing");
  check(runtimeText.includes("probe timed out"), "probe error was hidden");

  // 9. Persistence across a full remount: list, hydrate, unchanged values.
  flushSync(() => view.unmount());
  mount();
  await until(() => editButton(), "remounted inventory missing");
  check(document.body.textContent.includes("Renamed Box"), "rename did not persist");
  await openEditor();
  check(input("sshHost").value === "new.example.com" && input("sshUser").value === "" && input("sshPort").value === ""
    && input("sshIdentityFile").value === "/keys/id_ed25519", "remounted form hydration wrong");
  flushSync(() => view.unmount());
  return { passed: true };
};
`;

test("remote host edit form submits real diffs over IPC and persists", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-host-edit-"));
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
    console.log("REMOTE_HOST_EDIT_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.remoteHostEditProbe()")));
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /REMOTE_HOST_EDIT_PROBE \{"passed":true\}/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
