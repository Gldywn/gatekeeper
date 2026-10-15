#!/usr/bin/env node
// Only the release workflows set GATEKEEPER_RELEASE_TAG, so any other build is dev and
// can never be mistaken for a release. Shared by the plugin's vite.config and the server build.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(cwd, args) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return out && out.length <= 200 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function buildIdentity(dir, version, releaseTag) {
  if (releaseTag) {
    if (releaseTag !== `v${version}`) {
      throw new Error(`GATEKEEPER_RELEASE_TAG is ${releaseTag} but ${dir} is at ${version}.`);
    }
    return { version };
  }
  const sha = git(dir, ["rev-parse", "--short", "HEAD"]);
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dev = {};
  if (sha) dev.sha = sha;
  // A detached checkout answers the literal "HEAD", which names nothing.
  if (branch && branch !== "HEAD") dev.branch = branch;
  return { version, dev };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    console.error("usage: node scripts/build-identity.mjs <package dir> <out file>");
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  const identity = buildIdentity(resolve(dir), version, process.env.GATEKEEPER_RELEASE_TAG);
  writeFileSync(resolve(dir, out), `${JSON.stringify(identity)}\n`);
}
