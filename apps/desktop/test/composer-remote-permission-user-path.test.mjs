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
 * The composer permission picker on a remote session, rendered for real: the
 * runtime's own options replace the local ask/accept-edits/auto list, the
 * effective scope is named, next-turn scopes stay selectable, creation-fixed
 * scopes render read-only, and a selection reports the runtime's option id.
 */
const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ComposerPermissionPicker } from "../../apps/desktop/src/features/chat/composer/ComposerPermissionPicker";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });

const picks = [];
function Probe({ remotePermission, remoteAgent }) {
  const [open, setOpen] = useState(false);
  return React.createElement(ComposerPermissionPicker, {
    t: i18n.t.bind(i18n), mode: "agent", composerPermissionMode: "ask",
    permissionOpen: open, setPermissionOpen: setOpen,
    controlsBlocked: false, onCloseOtherMenus: () => {},
    onSelect: async (candidate) => { picks.push(candidate); },
    remotePermission, remoteAgent,
  });
}
let view;
const mount = (remotePermission, remoteAgent) => {
  view?.unmount();
  view = createRoot(document.getElementById("root"));
  flushSync(() => view.render(React.createElement(Probe, { remotePermission, remoteAgent })));
};
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const check = (value, message) => { if (!value) throw new Error(message); };
const chip = () => document.querySelector(".composer-permission .mode-chip");
const menuOptions = () => [...document.querySelectorAll('.composer-permission-menu [role="menuitemradio"]')];

window.permissionProbe = async () => {
  // next-turn runtime (Qoder): selectable, options replace the PI list, scope named.
  mount({ selected: "default", options: ["default", "acceptEdits", "plan", "dontAsk", "auto", "bypassPermissions"], scope: "next-turn" }, "qoder");
  await until(() => chip(), "chip missing");
  check(!chip().disabled, "next-turn picker must be enabled");
  check(chip().textContent.includes(i18n.t("chat.remotePermissionOption.default")), "selected label not shown");
  flushSync(() => chip().click());
  await until(() => menuOptions().length === 6, "qoder options missing, got " + menuOptions().length);
  check(!document.body.textContent.includes(i18n.t("chat.permissionAsk")), "local PI options leaked into a remote picker");
  const plan = menuOptions().find((node) => node.textContent.includes(i18n.t("chat.remotePermissionOption.plan")));
  check(plan, "plan option missing");
  flushSync(() => plan.click());
  await frame();
  check(picks.at(-1) === "plan", "selection did not report the runtime id: " + JSON.stringify(picks));

  // creation-fixed runtime (OMP): read-only, scope named, no menu.
  picks.length = 0;
  mount({ selected: "always-ask", options: ["always-ask", "write", "yolo"], scope: "new-session" }, "omp");
  await until(() => chip(), "omp chip missing");
  check(chip().disabled, "creation-fixed picker must be read-only");
  check(chip().textContent.includes(i18n.t("chat.remotePermissionOption.always-ask")), "omp selection not shown");
  flushSync(() => chip().click());
  await frame();
  check(menuOptions().length === 0, "a read-only picker opened a menu");
  check(picks.length === 0, "a read-only picker emitted a selection");

  // kimi (next-message): selectable with its own labels.
  mount({ selected: "manual", options: ["manual", "yolo", "auto"], scope: "next-message" }, "kimi");
  await until(() => chip() && !chip().disabled, "kimi picker must be enabled");
  flushSync(() => chip().click());
  await until(() => menuOptions().length === 3, "kimi options missing");
  check(menuOptions().some((node) => node.textContent.includes(i18n.t("chat.remotePermissionOption.kimi.yolo"))), "kimi-specific label missing");
  view.unmount();
  return { passed: true };
};
`;

test("composer permission picker renders remote runtime options with their scope", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-permission-"));
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
    console.log("PERMISSION_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.permissionProbe()")));
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
    assert.match(output, /PERMISSION_PROBE \{"passed":true\}/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
