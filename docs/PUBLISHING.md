# Publishing & Deployment — omp-vcc

Two audiences: **maintainers** releasing to registries and **consumers**
installing the plugin. Consumer-facing behavior lives in
[`docs/setup.md`](setup.md) and [`README.md`](../README.md); this page is the
release checklist plus the deployment matrix in one place. It is distilled from
the `0.1.0 → 0.1.2` dual-registry rollout (npmjs `omp-vcc` + GPR
`@zhulinchng/omp-vcc`) and the `omp-startup` reference implementation
(`publish-gpr.yml`).

## Package shape

No build step and no runtime dependencies. What npm ships is what both hosts
execute verbatim (`allowImportingTsExtensions: true`, `type: module`, zero
`dependencies`):

| Tarball entry | Role |
|---|---|
| `extensions/main.ts` + `extensions/vcc-core/**` | Hook + `vcc_recall` — the entire runtime |
| `skills/omp-vcc/SKILL.md` | Skill |
| `scripts/uninstall-reset.js` | `postuninstall` hook — restores `~/.omp/omp-vcc` ownership |
| `types.d.ts` | Ambient host-API shims (typecheck only) |
| `LICENSE`, `README.md` | Auto-included by npm even when not in `files` |
| *not shipped* | `tests/`, `docs/` (incl. `harness.md`, `omp-compaction.md`, `omp-snapcompact.md` — docs-only, correctly excluded from `files`), `tsconfig.json`, `bun.lock`, `.github/`, `AGENTS.md` |

Dual manifest (`package.json#omp.extensions` / `#pi.extensions`) points at
`./extensions/main.ts`; that is the entire “build output”. Keep `files`
exactly `["extensions","skills","scripts","types.d.ts"]` —
omitting `scripts` silently drops the `postuninstall` hook (seen as missing
`scripts/uninstall-reset.js` in `npm pack --dry-run` when `files` still listed
`tools/hooks/...` stubs). `README.md`/`LICENSE` need not be in `files`.
`docs/` — now including `harness.md` plus pinned `omp-compaction.md` /
`omp-snapcompact.md` — is intentionally **not** in `files` (correctly
excluded): they are reference docs cross-linked from `docs/architecture.md`
and `docs/setup.md`, not runtime code. Verify with `npm pack --dry-run` —
no `docs/` entry should appear.

## Maintainer release checklist

One-time setup:

1. npm account with 2FA `auth-and-writes` (as `czl.my` here); `npm login`,
   confirm `npm whoami` → `czl.my`, `npm config get registry` →
   `https://registry.npmjs.org/`. Classic token `npm_...` in `~/.npmrc` is
   classic auth-and-writes — every `npm publish` needs a fresh OTP or the
   browser `https://www.npmjs.com/auth/cli/...` flow.
2. GitHub: `gh auth status` → `zhulinchng` logged in; `gh auth token` must
   carry `read:packages`, `write:packages` (and `delete:packages` for API
   deletes). Initially ours lacked them (`admin:public_key gist read:org repo
   workflow` only) → all GPR `gh api /user/packages?package_type=npm` with
   `403 read:packages required` and `npm publish` to `npm.pkg.github.com`
   would `401`. Fix: `gh auth refresh -h github.com -s read:packages,write:packages,delete:packages`
   → device code (e.g. `0EF7-6D0D`) at `https://github.com/login/device` →
   authorize. Verify: `gh auth status` now lists those scopes; `curl -I -H
   "Authorization: Bearer $(gh auth token)" https://npm.pkg.github.com/@zhulinchng%2fomp-vcc`
   → `404` pre-publish (auth works) / `200` post-publish.
3. Git baseline committed — publishing with `M`/`??` risks shipping
   uncommitted edits you cannot reproduce.

Every release ships **two packages from one source**: the unscoped `omp-vcc`
on npmjs and the scoped `@zhulinchng/omp-vcc` on GitHub Packages. One version
bump covers both — never let them drift.

```sh
# 0. Verify locally (gates must pass on the exact commit you will publish)
bunx tsc --noEmit
bun test            # 310 tests / 33 files, 768 expects
bun run smoke       # ok: session_before_compact hooked, vcc_recall registered
npm pack --dry-run  # check: LICENSE, README.md, scripts/uninstall-reset.js, extensions/** listed; name omp-vcc version X.Y.Z; total ~41 files
```

1. Bump the shared version once (both packages publish under this same
   number). `package.json` name stays **unscoped** `omp-vcc` — the GPR job
   scopes it:
   ```sh
   npm version patch   # or minor / major — creates commit + tag when git present
   # our rollout: npm version patch creates v0.1.2 (was @zhulinchng/omp-vcc@0.1.0 scoped, now omp-vcc unscoped primary)
   ```

2. Publish the **unscoped** package to npmjs. `prepublishOnly` re-runs
   `typecheck && test && smoke` as a gate; it aborts the publish on any
   failure. Choose one auth path:
   ```sh
   npm publish --access public
   # browser-auth flow: press ENTER at the prompt, approve in the opened
   # https://www.npmjs.com/auth/cli/... tab (2FA)
   # — or —
   npm publish --access public --otp 123456   # from authenticator
   ```
   Use `--access public` — without it a scoped publish is `restricted` and
   an unscoped first publish may be `402`. Never `publishConfig.registry` —
   the two registries need explicit `--registry` args (or none for npmjs
   default).

3. Publish the **scoped** package to GitHub Packages. Cutting the release
   triggers it automatically (Actions → Publish to GitHub Packages →
   Run workflow works too); its Gates job re-runs the full suite first:
   ```sh
   git push origin main --follow-tags
   gh release create v0.1.2 --title v0.1.2 \
     --notes "**npm:** [omp-vcc@0.1.2](https://www.npmjs.com/package/omp-vcc/v/0.1.2) — GPR: \`@zhulinchng/omp-vcc@0.1.2\`"
   ```
   Manual fallback (what we used for `0.1.1`/`0.1.2` before the workflow
   existed):
   ```sh
   npm pkg set name=@zhulinchng/omp-vcc
   GITHUB_TOKEN=$(gh auth token) npm publish --userconfig /tmp/gpr-npmrc --access public
   npm pkg set name=omp-vcc   # restore
   # where /tmp/gpr-npmrc contains:
   #   @zhulinchng:registry=https://npm.pkg.github.com
   #   //npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
   # Do NOT add --registry https://npm.pkg.github.com together with
   # --userconfig that already scopes @zhulinchng — the global --registry
   # override makes bunx/tsc resolve typescript via GPR (404) during
   # prepublishOnly. Use the scoped registry only.
   ```

4. Verify both registries report the same new version:
   ```sh
   npm view omp-vcc version
   npm view omp-vcc dist-tags --json   # latest should be new version
   npm view omp-vcc dist.tarball       # https://registry.npmjs.org/omp-vcc/-/omp-vcc-X.Y.Z.tgz

   GITHUB_TOKEN=$(gh auth token) npm view @zhulinchng/omp-vcc version --userconfig /tmp/gpr-npmrc
   curl -I -H "Authorization: Bearer $(gh auth token)" https://npm.pkg.github.com/@zhulinchng%2fomp-vcc  # 200
   ```

5. Inspect what would ship before a real publish with `npm publish --dry-run`
   (or `npm pack`).

### Patch-release and backfill runbook

Patch flow (as run for `0.1.10`) — order matters:

```sh
# 1. Commit the fix first so the release tag includes it; leave unrelated files alone.
git add <fix files> && git commit -m "fix(...): ..."
# 2. Bump, then tag annotated (plain `git tag` is rejected here).
npm version patch   # or minor / major
git tag -a vX.Y.Z -m "vX.Y.Z"   # only if npm skipped the tag
# 3. Gates on the exact tree you will publish.
bunx tsc --noEmit && bun test && bun run smoke && npm pack --dry-run
# 4. Push, then npmjs (needs OTP — tip 5), then the release, in this order.
git push origin main --follow-tags
npm publish --access public --otp <6-digit>
gh release create vX.Y.Z --title vX.Y.Z --notes-file /tmp/vX.Y.Z-notes.md
```

Never cut the release before npmjs succeeds — the release triggers the GPR mirror and the registries would drift. Verify with `curl`, not `npm view` (cached — tip 9).

Backfill (missing GitHub Releases or GPR versions, as done for `0.1.1`–`0.1.9`):

```sh
git push origin <missing-tag>   # tags must exist remotely before releasing
# Create releases oldest-first so the newest ends up Latest; notes = npm/GPR
# header + one bullet per user-facing change (template: checklist step 3).
gh release create vX.Y.Z --title vX.Y.Z --notes-file /tmp/vX.Y.Z-notes.md
# GPR versions the workflow missed: publish the tag tree verbatim under the
# `backfill` dist-tag (`latest` untouched).
git archive vX.Y.Z | tar -x -C /tmp/gpr-backfill/X.Y.Z
cd /tmp/gpr-backfill/X.Y.Z && npm pkg set name=@zhulinchng/omp-vcc
GITHUB_TOKEN=$(gh auth token) npm publish --userconfig /tmp/gpr-npmrc --access public --tag backfill --ignore-scripts
```

`--ignore-scripts` skips `prepublishOnly`: acceptable for backfill because the bytes are already immutable on npmjs — a backfill mirrors, it doesn't re-certify. Then `gh run rerun <red-run-id>` greens runs that failed only for lack of the version.

### GitHub Packages mirror

Every GitHub Release also publishes a scoped mirror `@zhulinchng/omp-vcc`
to the GitHub npm registry via `.github/workflows/publish-gpr.yml`
(release → automatic; Actions tab → manual `workflow_dispatch`). The workflow
runs in two jobs: a **Gates** job (`bun install --frozen-lockfile` →
`bunx tsc --noEmit` → `bun test` → `bun run smoke` on `oven-sh/setup-bun` +
`setup-node` 24) must succeed before the publish job starts, and
`prepublishOnly` re-runs the gates inside the publish step as defense. The
workflow repoints only the package name (`npm pkg set name=@zhulinchng/omp-vcc`)
— version and contents are otherwise identical to npmjs. Versions are
immutable on that registry too: a run whose version is already published skips
the publish step with a warning (`already-published=true`); bump first.
A run whose version is older than the registry latest cannot take the implicit `latest` dist-tag, so the publish step retries it under the explicit `backfill` dist-tag (`latest` untouched) — the same tag manual backfills use.
Installing from it requires an npm token with `read:packages`, even though
the package is public.

A separate CI workflow (`.github/workflows/ci.yml`) runs the same gates on
every push to `main` and every PR, on a bun/latest × Node 22/24 matrix —
releases should never be the first place code meets a fresh Node.

Post-publish verification (see below) before announcing.

### Versioning notes

- `0.x` line: treat minor bumps as breaking-allowed (semver §4), major for
  eventual stable.
- Hosts cache installed copies (`~/.omp/plugins/node_modules/`,
  `~/.pi/agent/settings.json` packages). Consumers only see an update after
  rerunning `omp plugin install omp-vcc` / `omp plugin install @zhulinchng/omp-vcc`.
- One version bump covers both registries. The rollout history shows why:
  `0.1.0` was published scoped-only, `0.1.1` dual but name was still
  `@zhulinchng/omp-vcc` (required manual `cp package.json.scoped` swapping),
  `0.1.2` aligns to `omp-startup` convention — primary `omp-vcc` unscoped,
  GPR job scopes. Future bumps need no swapping.

## Post-publish verification

Run from a scratch directory outside the repo (proves registry resolution,
not local files):

```sh
npm view omp-vcc version          # → 0.1.2

mkdir -p /tmp/vcc-verify-npm && npm install --prefix /tmp/vcc-verify-npm omp-vcc@0.1.2
ls /tmp/vcc-verify-npm/node_modules/omp-vcc/extensions/main.ts
ls /tmp/vcc-verify-npm/node_modules/omp-vcc/scripts/uninstall-reset.js

mkdir -p /tmp/vcc-verify-gpr && GITHUB_TOKEN=$(gh auth token) npm install --prefix /tmp/vcc-verify-gpr @zhulinchng/omp-vcc@0.1.2 --userconfig /tmp/gpr-npmrc
ls /tmp/vcc-verify-gpr/node_modules/@zhulinchng/omp-vcc/extensions/main.ts

# Host-level (needs bun on $PATH)
omp plugin install omp-vcc
omp plugin list --json | jq '.[] | select(.name|contains("omp-vcc"))'
omp plugin doctor   # 5 ok 0 warnings 0 errors
omp -e @zhulinchng/omp-vcc <<-'OMPT'
/omp-vcc keep:2 hello
OMPT
# expect [Session Goal] toast omp-vcc: kept 2/...
```

Clean up: `omp plugin uninstall omp-vcc`, `rm -rf /tmp/vcc-verify-*`, `rm /tmp/gpr-npmrc`.

## Deployment matrix (consumers)

|  | omp | Pi |
|---|---|---|
| Install (npmjs) | `omp plugin install omp-vcc` (needs `bun` on `$PATH`) | `pi install npm:omp-vcc` |
| Install (GPR) | `omp plugin install @zhulinchng/omp-vcc` — requires `~/.npmrc` with `read:packages` token | same, via `pi` |
| Project-local | `<project>/.omp/plugins` via project anchor | `pi install -l npm:omp-vcc` |
| Update | rerun install (add `--force`) | rerun install |
| Remove | `omp plugin uninstall omp-vcc` + `postuninstall` resets ownership | `pi remove omp-vcc` |
| Inspect | `omp plugin list --json` | `pi list` |
| Files land in | `~/.omp/plugins/node_modules/omp-vcc`, registered via `omp-plugins.lock.json` | `~/.pi/agent/npm/node_modules/` |
| Source checkout | `omp plugin link /path/to/omp-vcc` → symlink | same for `pi` |
| GPR auth (`~/.npmrc`) | ` @zhulinchng:registry=https://npm.pkg.github.com` <br> `//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT` <br> Token needs `read:packages` (classic or fine-grained Packages: Read) | same |

GPR npm **always requires auth to install**, even for a `public` package —
`curl https://npm.pkg.github.com/@zhulinchng%2fomp-vcc` without a token is
`401`, with `Authorization: Bearer <PAT>` is `200`. Direct git install needs
no token: `omp plugin install github:zhulinchng/omp-vcc`.

## Tips & learnings (from the 0.1.0–0.1.2 rollout)

**1. Pick one primary name; scope only in the workflow.**  
Early `package.json` was `@zhulinchng/omp-vcc` (scoped). Publishing the
unscoped `omp-vcc` to npmjs then required ad-hoc swapping:
`cp package.json package.json.scoped; sed s/@zhulinchng\\/// > package.json;
npm publish; mv package.json.scoped package.json`. Forgetting to restore
left the worktree `M`. `omp-startup` does it the other way — primary
`omp-startup`, workflow does `npm pkg set name=@zhulinchng/omp-startup`
before `npm publish` to GPR. We switched `omp-vcc` to this in `adb0181` —
future `npm publish` just works, no manual `sed`.

**2. `files` must match reality.**  
Initial `files` listed `tools, hooks, rules, prompts, agents, mcp.json,
.mcp.json` (copied from a scaffold) plus no `scripts`. `npm pack --dry-run`
then showed 38 files, `scripts/uninstall-reset.js` missing → `postuninstall`
would silently do nothing on consumer machines. Fix: `files:
["extensions","skills","commands","scripts","types.d.ts"]`. `LICENSE`/`README.md`
are auto-included — they appeared in `npm notice` even after we dropped them
from `files`. Verify with `npm pack --dry-run | grep -E "LICENSE|scripts/uninstall"`.

**3. Repository URL normalization.**  
`package.json#repository.url` of `https://github.com/...` is auto-corrected
on publish to `git+https://github.com/...` (`npm warn publish ... normalized`).
Set it `git+https://...` from the start to avoid the warning.

**4. `prepublishOnly` is your last gate — make it count.**  
`omp-startup` has `npm run typecheck && npm test && npm run smoke`;
`omp-vcc` initially had only `typecheck`. We aligned to the full gate
(`typecheck && test && smoke`) in `adb0181`. Combined with the GitHub
Gates job, this gives two independent defenses — local `npm publish` aborts
before tarball creation, and the GPR workflow's Gates job blocks publish if
any matrix run fails.

**5. npm 2FA `auth-and-writes` means every publish needs OTP or web auth.**
`npm profile get` showed `two-factor auth: auth-and-writes` for `czl.my`.
`npm publish` then did `PUT 401` → `EOTP OTP required for authentication`
→ `https://www.npmjs.com/auth/cli/...`. The authId URL is redacted
(`***`) in both the terminal's `npm error` and `~/.npm/_logs/...-debug-0.log`,
so copy-pasting from logs fails — use `--otp <code>` from the authenticator
app, or press ENTER at the prompt and approve in the **browser tab that
`npm` opens** (not the log). OTP codes expire in 30 s — have the app open
first. `npm publish --dry-run` does not trigger OTP (no PUT).

**6. GitHub token scopes are per-purpose.**
`gh auth status` after `gh auth login` gave `admin:public_key gist read:org
repo workflow` — enough for code, not for Packages. All `gh api
/user/packages?package_type=npm` returned `403 You need at least
read:packages` and `curl -I npm.pkg.github.com/...` without token was `401`.
Fix is the device-code flow:
`gh auth refresh -h github.com -s read:packages,write:packages,delete:packages`
→ `https://github.com/login/device` → code `0EF7-6D0D`. After, `gh auth status`
must list `read:packages, write:packages, delete:packages`. Classic `repo`
scope alone is insufficient for granular-permission npm.

**7. GPR `npm publish` must use a scoped registry config, not a global
`--registry` override.**  
`GITHUB_TOKEN=$(gh auth token) npm publish --registry
https://npm.pkg.github.com --userconfig /tmp/gpr-npmrc` sets the **default**
registry to GPR; then `prepublishOnly`'s `bunx tsc` tried to `GET
https://npm.pkg.github.com/typescript` → `404` (GPR knows nothing about
unscoped `typescript`). Fix: keep the default registry as npmjs and only map
the scope:
`@zhulinchng:registry=https://npm.pkg.github.com`
`//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}`
then `npm publish --userconfig /tmp/gpr-npmrc --access public` (no
`--registry` flag). `npm pkg set name=@zhulinchng/omp-vcc` selects the GPR
via scope dispatch.

**8. `--access public` vs package visibility are different things.**
`npm publish --access public` to `npm.pkg.github.com` gave
`Publishing ... with tag latest and public access` and `+ @zhulinchng/omp-vcc@0.1.1`,
but `gh api /user/packages/npm/omp-vcc | jq .visibility` stayed `private`.
Personal-account packages default `private` and stay private until you
change them at
`https://github.com/users/zhulinchng/packages/npm/package/omp-vcc/settings`
→ **Danger Zone → Change visibility → Public** → type `omp-vcc`. Publishing
`0.1.2` with `--access public` still left `private`, because visibility is a
package-level setting, not a version attribute. All three GPR versions
(`0.1.0`/`0.1.1`/`0.1.2`) remain `private` until that one click; future
versions will be `public` once you flip it (irreversible). Even as `public`,
GPR npm **still requires** `read:packages` auth to `npm install` (unlike
npmjs).

**9. `npm view` is cached; `curl` the registry for ground truth.**
After `+ omp-vcc@0.1.1`, `npm view omp-vcc version` still returned `0.1.0`
for ~1 min (stale cache) while
`curl -fsS https://registry.npmjs.org/omp-vcc | jq .["dist-tags"]` already
showed `"latest":"0.1.1"` and `.versions | keys` included `0.1.1`.
`npm view omp-vcc dist-tags --json` refreshed faster than `npm view omp-vcc
version`. For GPR, `npm view @zhulinchng/omp-vcc version --registry
https://npm.pkg.github.com` needs `GITHUB_TOKEN` even for `public`.

**10. Mirror the `omp-startup` workflow file verbatim (then adapt).**
The working `publish-gpr.yml` is essentially `omp-startup`'s with two
adaptations: `oven-sh/setup-bun` + `bun install --frozen-lockfile` for the
Bun-based gates, and `registry-url: https://npm.pkg.github.com` +
**11. Keep one version for both registries — tag once.**
Workflow is `on: release[published]` → `git push origin main --follow-tags;
gh release create vX.Y.Z`. Publishing `omp-vcc@0.1.2` to npmjs and
`@zhulinchng/omp-vcc@0.1.2` to GPR under the same tag makes `npm view` agree
on both. The earlier manual path (publish GPR first, npm later) worked but
left `0.1.1`/`0.1.2` publishes split across days and required manual `npm pkg
set` juggling.

**12. `harness.md` + `setup.md` §Working with existing strategies are canonical for `overrideDefaultCompaction` vs `compaction.methodOrder`.**
`docs/harness.md` (§3 intercepts / §4 does-not-edit / §8 strategies) and
`docs/setup.md` (§Working with existing strategies) are the canonical
references for how `overrideDefaultCompaction` (plugin gate, default `true`
→ handles every auto trigger as `V_ui`) interacts with the host's
`compaction.methodOrder` walk (`remote` → `snapcompact` → `handoff` →
`shake` → `soft`). Consumers should read those two sections before flipping
`overrideDefaultCompaction` or reordering `compaction.methodOrder` — they
explain sentinel bypass (`/omp-vcc` always handled), `override:false` fallback
to the host walk, and when to keep `snapcompact`/`handoff` alongside `omp-vcc`.

## Troubleshooting publishes

| Symptom | Fix |
|---|---|
| `E409` / name conflict on first publish | `npm view omp-vcc` — someone took the unscoped name; GPR scoped `npm view @zhulinchng/omp-vcc --registry https://npm.pkg.github.com` similarly |
| `ENEEDAUTH` / `401` / `403` on npmjs | `npm login` again; `npm config get registry` must be `https://registry.npmjs.org/`; check you did not `npm config set //npm.pkg.github.com/:_authToken` globally |
| `EOTP` / `https://www.npmjs.com/auth/cli/...` | `npm publish --otp <6-digit>` or press ENTER and approve in the browser tab npm opens; do not copy the `***`-redacted URL from logs |
| `EOTP` in CI | Use `npm publish --otp` with an automation token or a granular token (`--//registry.npmjs.org/:_authToken`) — classic tokens with `auth-and-writes` cannot publish headlessly without OTP |
| `404 GET https://npm.pkg.github.com/typescript` during `bunx tsc` | You passed `--registry https://npm.pkg.github.com` globally — use scoped config only (see point 7) |
| `gh api 403 read:packages required` | `gh auth refresh -h github.com -s read:packages,write:packages,delete:packages` then `gh auth status` |
| GPR package shows `private` after `--access public` | Make it public once via UI: package → Package settings → Danger Zone → Change visibility → Public (see point 8) |
| `npm view` stale after publish | `curl -fsS https://registry.npmjs.org/omp-vcc | jq .["dist-tags"]` or `npm view omp-vcc dist-tags --json` — `npm view <pkg> version` caches |
| `already-published=true` warning in `publish-gpr.yml` | Version is immutable — `npm version patch && git push --follow-tags && gh release create v...` |
| `prepublishOnly` fails remotely but passes locally | Node/bun version drift — `publish-gpr.yml` pins Node 24 + `bun: 1.3.14`; run same locally |

