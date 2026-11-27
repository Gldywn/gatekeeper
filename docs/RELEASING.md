# Releasing

How a commit on `main` becomes an installable Gatekeeper: a plugin in the Beekeeper Studio
plugin manager, a server on npm, and a skill on `skills.sh`.

## One version for the whole repo

Starting with the release after `v0.3.0`, the plugin, server, shared wire contract and all
three skills are versioned together under a single version and tag, not per package. Two reasons:

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
the root `package.json`, all three package manifests, `packages/plugin/manifest.json`
and the version in each `skills/*/SKILL.md` frontmatter
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

Both release workflows set `GATEKEEPER_RELEASE_TAG` for the whole job. It stamps the plugin
bundle and the server's `dist/build.json` as that release, and the build fails if the tag and
the package version disagree. Without it a release would call itself a dev build in the
plugin's version indicator, so `publish-server.yml` checks the stamp in the packed tarball.

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
   npmjs.com). That approval is what makes it installable. Approve it as soon as the
   workflow is done: from the moment of Publish, every plugin that starts shows the
   release as available, and the update skill defers updating the plugin and the server
   until npm serves it.
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

To force one, end a commit message with `Release-As: x.y.z` as its **last paragraph**:

```bash
git commit --allow-empty -m "chore: release 0.1.1" -m "Release-As: 0.1.1"
```

`main` takes squash merges only, and this repo builds the squash message from the branch's
commit messages. release-please reads `Release-As` only in the last paragraph of that squash
message, so put it in a pull request with a single commit, or in the last commit of the
branch, and check that it still ends the squash message before merging. A footer in an
earlier commit ends up mid-message and is ignored, and the PR description does not land.

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

Once the plugin is installed from the release, Settings > Version shows the release version
on the Plugin row, never `dev`. The bottom-left indicator sums up plugin and server
together, so it can read `dev` or a mismatch when the server comes from a checkout.

## The Beekeeper Studio plugin registry

Gatekeeper is listed in Beekeeper's community registry, `community-plugins.json` in
[`beekeeper-studio/beekeeper-studio-plugins`](https://github.com/beekeeper-studio/beekeeper-studio-plugins)
(added on 2026-08-29). The plugin manager reads that file and installs from this repo's
latest release, so a new release reaches users without touching the registry.

The entry, for reference:

```json
{
  "id": "gatekeeper",
  "name": "Gatekeeper",
  "author": "Gldywn",
  "description": "The database harness for AI agents. Stop gambling with your production database.",
  "repo": "Gldywn/gatekeeper"
}
```

`id` must match `packages/plugin/manifest.json`'s `id` exactly. The plugin manager installs
into a directory named after the registry `id` and refuses the install if the manifest
disagrees. `repo` points at this monorepo: nothing in the download contract cares about
repo layout, only about the release assets. Changing the name or the description is a pull
request to that registry.

The plugin manager fetches the root `README.md` and displays it. It renders Markdown with
`marked`, GitHub alerts, line breaks kept (`breaks: true`) and no heading ids, and from
Beekeeper 6.2 it rewrites relative links and images to this repo's default branch. So the
README keeps one line per paragraph, uses relative paths for repo files, and links to its own
headings through absolute GitHub URLs.

**Community plugins are off by default.** What a user sees depends on the Beekeeper version:

- 6.2 and later ship with official and community plugins turned off, and the user turns on
  Community Plugins in Tools > Manage Plugins > Configure. A plugin extracted by hand counts as
  a community plugin once Beekeeper fetches the community registry and matches its folder to the
  entry. Until then it shows as unlisted.
- 5.7 to 6.1 ship with the whole plugin system off (`pluginSystem.disabled = true` and
  `communityDisabled = true` in the shipped config), with no switch in the app.
- 5.4 and 5.5 read only `plugins.json`, so their plugin manager never lists Gatekeeper.

`docs/INSTALL.md` and the `install-gatekeeper` skill cover each case.

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
