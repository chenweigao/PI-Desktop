import { readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composerSource = await readComposerSource();

test("Agent and Plan permission menus present only effective selectable modes", () => {
  const picker = composerSource.slice(
    composerSource.indexOf("/* features/chat/composer/ComposerPermissionPicker.tsx */"),
  );

  // Local sessions: exactly the three PI modes, never `inherit`.
  assert.match(picker, /\["ask", "accept-edits", "auto"\]/);
  assert.match(picker, /aria-checked=\{selected === candidate\}/);
  assert.match(picker, /PERMISSION_MODE_I18N_KEYS\[candidate as GlobalPermissionMode\]/);
  assert.doesNotMatch(picker, /permissionInherit/);
  assert.doesNotMatch(picker, /\["inherit",/);
  // Remote sessions: the runtime's own capability replaces the local list.
  assert.match(picker, /remotePermission\?: RemotePermissionCapability \| null/);
  assert.match(picker, /const options: string\[\] = remote \? remote\.options : \["ask", "accept-edits", "auto"\]/);
  // next-message/next-turn scopes are selectable; creation-fixed and
  // runtime-managed scopes render read-only.
  assert.match(picker, /remote\.scope === "next-message" \|\| remote\.scope === "next-turn"/);
});

test("Goal keeps the permission chip visible but fixes it to Full auto", () => {
  const picker = composerSource.slice(
    composerSource.indexOf("/* features/chat/composer/ComposerPermissionPicker.tsx */"),
  );

  assert.match(
    composerSource,
    /const composerPermissionMode: Exclude<PermissionMode, "inherit"> =\s*\n\s*mode === "goal" \? "auto" : effectivePermissionMode;/,
  );
  assert.match(picker, /mode === "goal" \|\| disabled \? undefined : "menu"/);
  assert.match(picker, /controlsBlocked \|\| mode === "goal"/);
  assert.match(picker, /permissionOpen && mode !== "goal"/);
});
