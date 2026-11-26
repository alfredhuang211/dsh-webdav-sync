# Development, release and publishing

How to change this plugin, verify it, and ship a version.

> Every command here was run on this repository. If one stops working, fix the
> document — a runbook that lies is worse than none.

---

## 1. What this package is

A **DSH bundle**: an npm package whose `package.json` declares `dsh.bundle`, so
installing it adds a configuration layer to a DSH profile.

```
package.json       name, exports, dsh.bundle / dsh.client, engines.dsh
cordis.patch.yml   the layer: which rows the bundle inserts into a profile
lib/               host half (hand-written, no build step)
client/bundle.js   browser half (hand-written classic script, no build step)
locale/{en,zh}.json  display title/description for the Plugins page
icon.svg           Plugins-page artwork
```

**There is no build step.** `lib/` and `client/bundle.js` are the source of
truth and are committed as-is, because the consumer's pnpm blocks dependency
build scripts and a Git install must carry runnable output.

---

## 2. Everyday development

```bash
npm ci        # install exactly what the lockfile pins
npm test      # node --test test/*.test.mjs
```

### `.npmrc` carries two settings that matter

```ini
minimumReleaseAge=0
omit=peer
```

**`omit=peer`** — this package declares DSH and its own runtime as *peer*
dependencies, supplied by the consuming Harness. npm installs peers where pnpm
does not, so without this one `npm install` pulls the whole harness (610
packages, ~500 MB) and pins a stale DSH into the lockfile. `npm install
--include=peer` overrides it.

**`minimumReleaseAge=0`** — install a version the moment it is published. This is
an npm setting; DSH installs with pnpm, which keeps its own fresh-release hold
(§8). The value must use `=`, not `:` — npm reads only the former, so the
`minimumReleaseAge: 0` this file used to contain was inert.

### This repository used pnpm until 0.2.3

It was the only one of the four plugins on pnpm. It moved to npm so that all
four share one CI recipe. `pnpm-lock.yaml` was replaced by
`package-lock.json`; do not reintroduce a pnpm lockfile.

### Editing the host half

`lib/*.js` is plain ESM. Keep the plugin shape intact: `export const name`,
optional `export const inject`, `export function apply`.

### Editing the browser half

`client/bundle.js` must keep the shape the Harness module table expects:
`window.__ModuleLoader__.load({ id, factory })`, where **`id` must equal the
package name**. A test asserts this.

### Editing the bundle patch

`cordis.patch.yml` inserts one row. Only one identifier follows the package name:

| Field | Follows the package name? | Why |
|---|---|---|
| `name` | **yes** | Node resolves the module by package name |
| `id` | **no** | the profile override key; renaming orphans user overrides |

`name:` must be **quoted** when it starts with `@`: `@` is a YAML reserved
indicator and an unquoted value fails to parse, silently disabling the bundle.

### Editing display metadata

`locale/en.json` and `locale/zh.json` carry `meta.title` and
`meta.description`, read by the Plugins page **without activating the plugin**.
English titles use sentence case. Both files plus the icon must be exported:

```json
"exports": {
  "./locale/*.json": "./locale/*.json",
  "./icon": "./icon.svg"
}
```

Without those entries the page shows the bare package name — which is what
happened here before 0.2.3. Icons: SVG/PNG/JPEG/WebP, under 256 KiB, inside the
package.

---

## 3. What must stay consistent

**Module identifiers follow the package name. On-disk and on-wire state does
not.**

| Identifier | Scope | Why |
|---|---|---|
| package `name` | scoped | consumed by npm and Node |
| row `name` in the patch | scoped | resolved as a module |
| client bundle `id` | scoped | must equal the package name |
| row `id` in the patch | unscoped | profile override key |
| the settings namespace | unscoped | existing user settings are filed under it |

---

## 4. Versioning and `engines.dsh`

**Prereleases need an explicit branch.** node-semver only lets a prerelease
satisfy a range when a comparator on the *same* `major.minor.patch` tuple carries
a prerelease tag:

```
>=0.2.0-rc.1 <0.3.0                            ✗ rejects 0.2.3-alpha.2
>=0.2.0-rc.1 <0.3.0 || >=0.2.3-alpha.2 <0.3.0  ✓
```

This package uses the second form. DSH's check runs with `includePrerelease`; a
user's plain `npm install` does not, so the first form fails outside DSH while
passing inside it.

---

## 5. Release checklist

```bash
npm ci
npm test
npm pack --dry-run
```

Confirm the pack list contains `lib/`, `client/bundle.js`, `cordis.patch.yml`,
`locale/*.json`, `icon.svg`, `README.md` and `LICENSE`, and no tests or
credentials.

Then bump, commit, tag:

```bash
npm version patch --no-git-tag-version
git add -A && git commit -m "release: v0.2.4"
git tag v0.2.4
git push origin main --tags
```

**The tag must equal `package.json` `version`**; the workflow refuses to publish
on a mismatch. Remember to update the version mentioned in `README.md`.

---

## 6. Automated publishing (OIDC)

`.github/workflows/publish.yml` publishes on a `v*` tag using npm **trusted
publishing**: GitHub signs a short-lived OIDC token, npm exchanges it for a
publish token. **No `NPM_TOKEN` secret exists, and none should be added.**

Pipeline: `install → test → pack → verify tag/version → publish --provenance →
poll until the tarball is downloadable`.

This path is proven on this repository: `v0.2.3` published end to end, with a
signed attestation.

### Requirements that are not in this repository

The trusted publisher is registered on npmjs.com, per package:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `alfredhuang211` |
| Repository | `dsh-webdav-sync` |
| Workflow filename | `publish.yml` (filename only, case-sensitive, with `.yml`) |
| Environment name | empty |
| Allowed actions | **must include "Allow npm publish"** |

### Two workflow settings that are load-bearing

**No `registry-url` on `setup-node`.** Setting it writes
`_authToken=${NODE_AUTH_TOKEN}` into the runner's `.npmrc` and exports
`GITHUB_TOKEN` in its place; npm then prefers that credential and never performs
the OIDC exchange. The first attempt at this repository failed exactly that way:
provenance signed, then the registry answered `E404` on the PUT.

**Node 24, not 22.** OIDC needs npm ≥ 11.5.1; Node 22 ships npm 10.x.

The workflow asserts that no static credential is present, so this cannot
regress quietly.

---

## 7. When publishing fails

| Symptom | Cause |
|---|---|
| `E404 Not Found - PUT ...` **and** provenance signed fine | a static credential suppressed OIDC (§6). Check `registry-url` and the Node version. |
| `ENEEDAUTH` / `Unable to authenticate` | trusted-publisher config mismatch: wrong repo, workflow filename, or package |
| `You cannot publish over the previously published versions` | **authentication worked**; the version already exists. Bump it. |
| Workflow stopped after `pack`, nothing published | that was a `workflow_dispatch` run, which publishes nothing by design |

Publishing is only proven when the tarball downloads:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://registry.npmjs.org/@alfredhuang211/dsh-webdav-sync/-/dsh-webdav-sync-<version>.tgz
```

`npm publish` prints success *before* the tarball is servable — measured 1.5 to 6
minutes on first releases.

---

## 8. Installing the result

```bash
dsh plugin --profile desktop add @alfredhuang211/dsh-webdav-sync
```

**A fresh release is not installed by default.** pnpm holds back recently
published versions; naming the version explicitly makes DSH add a
`minimumReleaseAgeExclude` entry to the profile and proceed. Measured here: right
after 0.2.3 was published, an unversioned install produced 0.2.2.

**Verify with `--dump-config`**, which proves the layer loaded:

```bash
dsh --profile desktop --dump-config | grep '== @alfredhuang211/'
```
