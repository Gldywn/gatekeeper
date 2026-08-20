# Releasing

How a commit on `main` becomes an installable Gatekeeper: a plugin in the Beekeeper Studio
plugin manager, a server on npm, and a skill on `skills.sh`.

## One version for the whole repo

The plugin, the server and the shared wire contract are released together under a single
version and a single tag (`v0.1.0`), not per package. Two reasons:

- **The wire contract.** `packages/shared` is the protocol the plugin and the server speak
  to each other. Versioning them independently creates a compatibility matrix, and there
  is no case where you would want half of a Gatekeeper.
- **Beekeeper reads exactly one release.** The plugin manager calls
  `GET /repos/Gldywn/gatekeeper/releases/latest`, and GitHub defines "latest" as the most
  recent non-draft, non-prerelease release in the *whole repository*, sorted by
  `created_at`. With per-package releases, a server-only release would become "latest",
  find no `manifest.json` asset, and break plugin installs and updates for everyone until
  the next plugin release. One release per version removes the failure mode entirely.

`release-please` owns every version number. Do not hand-edit versions: the config bumps
the root `package.json`, all three package manifests, and `packages/plugin/manifest.json`
from one source of truth.

## The pipeline

```
  commit (conventional)          release-please              human                 users
 ┌──────────────────────┐  PR   ┌──────────────────┐        ┌────────┐
 │ feat: ...            │ ────► │ Release PR       │ ─────► │ merge  │
 │ fix: ...             │       │ bumps + CHANGELOG│        └────┬───┘
 └──────────────────────┘       └──────────────────┘             │
                                                                 ▼
                                              ┌──────────────────────────────────┐
                                              │ draft release v0.1.0 (no assets) │
                                              └──────────────┬───────────────────┘
                                                             │ release-plugin.yml
                                                             ▼
                                              ┌──────────────────────────────────┐
                                              │ + manifest.json                  │
                                              │ + gatekeeper-0.1.0.zip           │
                                              └──────────────┬───────────────────┘
                                                             │ human clicks Publish
                                              ┌──────────────▼───────────────────┐
                                              │ published release ──► Beekeeper  │
                                              │ publish-server.yml ──► npm stage │
                                              └──────────────┬───────────────────┘
                                                             │ human approves with 2FA
                                              ┌──────────────▼───────────────────┐
                                              │ npm stage approve ──► public     │
                                              └──────────────────────────────────┘
```

Three things about that shape are deliberate, not accidental:

- **The draft.** Assets are attached before a human ever sees the release, so an incomplete
  or failed build can never be served as "latest" to the plugin manager. This mirrors what
  Beekeeper's own `bks-ai-shell` and the starter template do.
- **The human publish is a real trigger.** Anything release-please creates with the default
  `GITHUB_TOKEN` (tag, release) does *not* start another workflow. That is a GitHub rule
  against recursive runs, documented in the release-please-action README. So the plugin
  build is chained inside `release-please.yml` rather than tag-triggered, and the npm
  publish hangs off the `release: published` event, which is attributed to you.
- **The npm publish is staged, not direct.** CI never makes a version public on its own: it
  uploads a staged version that stays invisible until a maintainer approves it with 2FA.
  A compromised workflow run can therefore waste a version number, not ship code to every
  `npx` user.

## One-time setup

These need a human with account access. None of them are in the repo.

- [x] **Make the repository public.** `npx skills add Gldywn/gatekeeper` and Beekeeper's
      registry both require it.
- [ ] **npm trusted publishing, stage-only.** Configured on npmjs.com to trust
      `Gldywn/gatekeeper` and the `publish-server.yml` workflow, with `npm stage publish`
      allowed and `npm publish` disallowed, so a workflow run can never make a version
      public by itself. No repository secret is involved: the workflow authenticates with
      the OIDC token granted by `id-token: write`. The publish step uses npm rather than
      pnpm because pnpm 11's OIDC token exchange 404s (pnpm/pnpm#11513), and npm is pinned
      to 11.15.0, the floor for staged publishing. `NPM_TOKEN` is read by nothing anymore
      and can be deleted once a release has validated this path end to end.
- [x] **Allow GitHub Actions to create pull requests** (Settings -> Actions -> General), or
      release-please cannot open its Release PR.

## Cutting a release

1. Land conventional commits on `main` (`feat:` bumps the minor while below 1.0.0, `fix:`
   the patch, `feat!:`/`BREAKING CHANGE` the major once past 1.0.0).
2. release-please opens or updates a Release PR. Review the version and CHANGELOG, merge it.
3. `release-please.yml` creates the **draft** release and immediately runs
   `release-plugin.yml`, which typechecks, builds, tests, and attaches:
   - `manifest.json` (loose, named exactly that)
   - `gatekeeper-<version>.zip` containing `dist/`, `manifest.json`, `LICENSE`, `README.md`
     with `manifest.json` at the zip root
4. Open the draft release, check both assets are there, click **Publish release**. Publish
   it as the latest release, not a prerelease.
5. `publish-server.yml` fires on that publish, builds the signed macOS notifier, and
   **stages** `@gldywn/gatekeeper-mcp-server` on npm with provenance. Staged means uploaded
   and invisible: nobody can install it yet, and the version number is now taken.
6. Approve the staged version with 2FA (`npm stage approve`, or the package page on
   npmjs.com). That approval is what makes it installable.
7. Verify (below).

If a step needs a retry, both workflows have a `workflow_dispatch` entry point that takes
the release tag. Re-running the publish is the way back from a failed or rejected staging,
since the `release: published` event fires only once.

### Forcing a version when nothing bumped

release-please only bumps on `feat:` and `fix:`. A `docs:`, `ci:` or `chore:` commit lands on
`main` and opens nothing, which is usually what you want.

Sometimes you need a release anyway. The npm package page renders the `README.md` **inside
the published tarball**, not the one on `main`, so a fix to `packages/server/README.md` only
reaches npm through a new version. Same for anything shipped in the plugin zip.

To force one, put `Release-As: x.y.z` in the **body** of a commit that lands on `main`:

```bash
git commit --allow-empty -m "chore: release 0.1.1" -m "Release-As: 0.1.1"
```

`main` takes squash merges only, and this repo builds the squash message from the branch's
commit messages, so the footer travels with the commit. Keep it in the commit body rather
than the PR description, which is not what lands.

## Verifying a release

```bash
# Beekeeper's exact install contract: a manifest asset and a matching zip.
gh release view v0.1.0 --json assets --jq '.assets[].name'
#   expect: manifest.json  gatekeeper-0.1.0.zip

# The version in the manifest asset must equal the tag, and the id must equal the
# registry entry id, or the plugin manager refuses to install.
gh release download v0.1.0 --pattern manifest.json --output - | jq '{id, version, manifestVersion}'

# The one-line install path, from a clean cache. Only meaningful once the staged version
# has been approved: before that, npm has nothing to resolve.
npx -y @gldywn/gatekeeper-mcp-server@0.1.0 < /dev/null
#   expect: "[gatekeeper] broker on http://127.0.0.1:9999" then a clean exit
```

## Submitting to the Beekeeper Studio plugin registry

One-off, after the first release is published. The plugin manager reads its index from
[`beekeeper-studio/beekeeper-studio-plugins`](https://github.com/beekeeper-studio/beekeeper-studio-plugins).

**Which file: unresolved, and worth asking in the PR.** That repo holds two indexes, and
the app source reads both, tagging entries `official` or `community`
(`fetchOfficial()` / `fetchCommunity()` in `PluginRepositoryService.ts`):

- `plugins.json` currently lists the two first-party plugins (`bks-ai-shell`,
  `bks-er-diagram`). The [official publishing
  guide](https://docs.beekeeperstudio.io/plugin_development/publishing-plugins/) tells
  third parties to add their entry *here*.
- `community-plugins.json` is currently `[]` and has never listed anything, but its name
  and the app's `community` origin tag suggest it is where a third-party plugin belongs.

Follow the published instructions and open the PR against `plugins.json`, then say
explicitly in the PR body that you are happy to move the entry to
`community-plugins.json` if the maintainers prefer. The two files take an identical entry
shape, so moving it is a one-line change.

The entry to add:

```json
{
  "id": "gatekeeper",
  "name": "Gatekeeper",
  "author": "Gldywn",
  "description": "Human-approved SQL bridge between AI agents and Beekeeper Studio: read-only by default, with ephemeral human-armed write modes.",
  "repo": "Gldywn/gatekeeper"
}
```

`id` must match `packages/plugin/manifest.json`'s `id` exactly. The plugin manager installs
into a directory named after the registry `id` and refuses the install if the manifest
disagrees. `repo` points at this monorepo: nothing in the download contract cares about
repo layout, only about the release assets.

Before opening the PR, confirm the repo is public, a published release carries both assets,
and the README renders well, since the plugin manager fetches and displays it.

## From community plugin to official plugin

"Official" means Beekeeper Studio lists the plugin in `plugins.json` alongside its own and
takes it through their quality and security review. Nothing here is a blocker today; this
is what shortens that conversation when it happens.

Already true:

- **Spec-clean manifest.** `manifestVersion: 1` matching the `ManifestV0 | ManifestV1` type
  union in the app source, `author` in the `{name, url}` object form, a `base-tab` view
  (`TabType` is `"shell" | "base"`, so `base-tab` and `shell-tab` are the only two the code
  defines), and an accurate `minAppVersion: 5.4.0`. Nothing relies on undefined behavior.
  Two things in Beekeeper's own materials do, and are worth flagging to the maintainers:
  `bks-sample-plugin`, the starter template, ships `manifestVersion: 2`, which is not a
  defined version and only works because `convertToManifestV1()` passes any non-zero value
  straight through; and the shipping `bks-er-diagram` declares `"type": "plain-tab"`, which
  is not in the `TabType` union either.
- **Reproducible releases.** Every artifact is built in CI from a tagged commit, with a
  guard that the manifest version matches the tag, and npm provenance on the server.
- **A written security posture.** [`SECURITY.md`](../SECURITY.md) states the threat model,
  the same-user trust boundary, and the read-only database posture. The plugin is the only
  component that can call `runQuery`, so the risk gate lives where execution lives.
- **Tests.** The classifier, the sanitizer, the result caps and the queue state machine are
  covered; `pnpm run ci` is the gate.

Likely to come up in review, and worth preparing answers for:

- **Why the plugin talks to loopback at all.** No other Beekeeper plugin opens a network
  connection. The answer is the sandbox: a plugin iframe can only *initiate* requests, so
  the broker is how a query proposal reaches it. Point at the bearer token on every request,
  the `127.0.0.1` bind, and the `Host` header check that rejects DNS rebinding.
- **The hardcoded broker port.** The plugin talks to `9999` while the server accepts
  `GATEKEEPER_BROKER_PORT`. Today that mismatch fails silently. Making the port a plugin
  setting is the clean fix, and `settings` is a manifest field Beekeeper documents as
  planned, so this may become natural to adopt.
- **Bundle size.** The build emits one ~3.2 MB JS chunk (~680 kB gzipped) and Vite warns
  about it on every build. Code-splitting, or narrowing the SQL parser's dialect set, is
  the lever if they push back.
- **Permissions.** `permissions` is documented as planned. Expect to declare the plugin's
  capability needs once it ships, and to keep the declaration minimal.
