#!/bin/bash
# `.noindex` keeps Spotlight from indexing the bundle inside node_modules, the
# convention node-notifier adopted for the same reason.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="notifier"
OUT="notifier.noindex/Gatekeeper.app"
BIN="gatekeeper-notify"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$SRC/Info.plist" "$OUT/Contents/Info.plist"
cp "$SRC/Gatekeeper.icns" "$OUT/Contents/Resources/Gatekeeper.icns"

# Universal: an arm64-only binary cannot run on Intel, and an x86_64-only one makes a
# machine without Rosetta pop an install dialog when an agent submits a query.
for arch in arm64 x86_64; do
  swiftc -O -target "${arch}-apple-macos11.0" -o "$BUILD/${BIN}-${arch}" "$SRC/main.swift"
done
lipo -create -output "$OUT/Contents/MacOS/$BIN" "$BUILD/${BIN}-arm64" "$BUILD/${BIN}-x86_64"
chmod 755 "$OUT/Contents/MacOS/$BIN"

# Ad-hoc is enough: the API requires a signed executable, not a certificate, and
# nothing on the npm path applies the quarantine attribute that would force notarization.
codesign --force --sign - "$OUT"

echo "built $OUT"
lipo -info "$OUT/Contents/MacOS/$BIN"
codesign --verify --deep --strict --verbose=2 "$OUT"
