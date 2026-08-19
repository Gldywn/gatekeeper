// Node rather than shell in the build script: the publish job runs on ubuntu where
// swiftc does not exist, and Windows contributors have no bash.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(
  here,
  "..",
  "notifier.noindex",
  "Gatekeeper.app",
  "Contents",
  "MacOS",
  "gatekeeper-notify",
);
const sources = ["main.swift", "Info.plist", "Gatekeeper.icns"].map((name) => join(here, name));

// Exits 0 before build.sh removes anything, so a skip never destroys a bundle that CI
// downloaded as an artifact.
function skip(reason) {
  console.log(`notifier: skipped, ${reason}`);
  process.exit(0);
}

if (process.platform !== "darwin") {
  skip("macOS only");
}

// Reports the toolchain without triggering the installer dialog that invoking swiftc
// directly would pop on a machine without it.
try {
  execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore" });
} catch {
  skip("Xcode command line tools are not installed (xcode-select --install)");
}

if (existsSync(binary)) {
  const built = statSync(binary).mtimeMs;
  if (sources.every((source) => statSync(source).mtimeMs <= built)) {
    skip("already up to date");
  }
}

execFileSync("bash", [join(here, "build.sh")], { stdio: "inherit" });
