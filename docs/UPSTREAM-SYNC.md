# Upstream sync — PI-Desktop fork maintenance

How the `chenweigao/PI-Desktop` fork tracks the `vastsa/PI-Desktop` upstream and keeps the Perch/Kimi secondary-development work mergeable. This is a maintenance document, not a scheduled job: sync is manual, on demand (roughly biweekly or when the user asks).

## Remotes and branches

- `origin` → `https://github.com/vastsa/PI-Desktop` (upstream, read-only for us).
- `fork` → `https://github.com/chenweigao/PI-Desktop` (writable; the secondary-development work lives here).
- Feature branch: `feat/pi-perch-adapter`, created from `origin/main`.

Current upstream baseline: see `git merge-base origin/main HEAD` at sync time; the work was rebased onto `origin/main` `b7678c36c` during development. Never rewrite pushed shared history: default to `merge`, only `rebase` a branch that has not been pushed.

## What is ours vs upstream

Own modules (new, no upstream equivalent):
- `apps/desktop/electron/main/remote/perch/` — the Perch native-bridge adapter (client/host/session-backend/event-bridge).
- `apps/desktop/electron/main/remote/kimi/` — the Kimi channel adapter.
- Tests: `test/perch-*.test.mjs`, `test/kimi-*.test.mjs`, `test/remote-model-menu.test.mjs`, `test/sidebar-view-modes.test.mjs`.
- Scripts: `scripts/e2e-perch-*.mjs`, `scripts/e2e-kimi-adapter.mjs`.

Upstream touchpoints (edits to existing files — review these first on sync):
- `apps/desktop/electron/main/bootstrap/remote-hosts.ts` — the backend fork (`metadata.backend`), host orchestration, session summaries merge.
- `apps/desktop/electron/main/remote/backend-router.ts` — untouched shape, but it is the seam our adapters register into.
- `apps/desktop/electron/main/ipc/remote-host-ipc.ts`, `remote-session-ipc.ts` — the add/check IPC entries.
- `packages/shared/src/protocol.ts`, `types/sessions.ts`, `types/remote-host.ts` — new IPC channels and session fields (`remoteAgent`, provider/model on create).
- `apps/desktop/src/components/settings/RemoteHostsPage.tsx`, `Composer.tsx`, `Sidebar.tsx`, `remote/RemoteProjectGroups.tsx`, `features/chat/composer/*` — UI surfaces.
- `apps/desktop/src/stores/slices/{catalog-slice,session-slice,project-slice}.ts`, `stores/app-state.ts`, `lib/{perch-model-catalog,sidebar-project-model,sidebar-preferences,remote-project-session,remote-session-safety,remote-ipc-safety}.ts` — renderer state and helpers.
- `packages/i18n/src/locales/*` — new keys in all nine catalogs.

## Compatibility conventions

- The `remote-hosts.json` registry is additive: a `metadata.backend` field absent means a RACP host; `perch`/`kimi` mark the new channels. No migration; unknown values stay RACP.
- Renderer session ids are `remote:<hostKey>:<hostSessionId>` for all three backends.
- Approval requestIds keep the `#racp-approval:` delimiter across backends.
- The Perch/Kimi model catalogs are runtime reads, never persisted as local provider records.

## Sync procedure (manual, on demand)

```bash
cd _worktrees/pi-perch-adapter-20261107   # or the current task worktree
git fetch origin main
git checkout -b integrate/upstream-YYYYMMDD   # throwaway integration branch
git merge origin/main                        # merge, never rebase pushed work
# resolve conflicts in the touchpoints listed above first
pnpm install && pnpm -r build
cd apps/desktop && node --test test/*.test.mjs   # incl. perch/kimi suites
cd ../../packages/i18n && pnpm test
```

Then push the integration branch to the fork for review; merge into `feat/pi-perch-adapter` only after Codex acceptance on a Mac preview build. The user decides when to release.

## Updater safety

Upstream's in-app updater reads `apps/desktop/resources/app-update.yml` (`provider: github, owner: vastsa, repo: PI-Desktop`), so an official upstream package would replace the fork's custom build. **A fork build must ship its own `app-update.yml` pointing at the fork (or disable the updater) before any user installs it** — otherwise the next upstream release silently overwrites the Perch/Kimi work. That change is deliberately NOT made here: this fork has no release pipeline yet, and no certificate/signing is requested now. When the first fork release is planned, set `owner: chenweigao` in `app-update.yml` (or disable auto-update) as part of the release packaging, and verify the packaged app never reaches the vastsa feed.

## Post-sync regression checklist

Local + native RACP remote; Perch host connect/catalog/approval/cancel; Kimi host connect/catalog/approval; short turn between polls; consecutive streaming turns; disconnect recovery; history paging; settings persistence; and the Mac UI acceptance of the sidebar layouts and model/agent pickers.
