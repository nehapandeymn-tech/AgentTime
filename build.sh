#!/bin/bash
# Builds build/Agent Companions.app. ./build.sh --install also copies it to /Applications.
set -euo pipefail
cd "$(dirname "$0")"
NODE="$(command -v node || true)"
if [[ -n "$NODE" ]]; then "$NODE" --test tests/core.test.js; else echo "node not found: skipping logic tests"; fi

APP="build/Agent Companions.app"
TARGET="$(uname -m)-apple-macos14.0"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 -target "$TARGET" Sources/Hook/main.swift -o "$APP/Contents/MacOS/companion-hook"
swiftc -O -swift-version 5 -target "$TARGET" Sources/App/main.swift -o "$APP/Contents/MacOS/Agent Companions"
cp Resources/Info.plist "$APP/Contents/"
cp -R web "$APP/Contents/Resources/web"
codesign --force --deep --sign - "$APP"
echo "built $APP"

if [[ "${1:-}" == "--install" ]]; then
  pkill -x "Agent Companions" || true
  rm -rf "/Applications/Agent Companions.app"
  cp -R "$APP" /Applications/
  echo "installed /Applications/Agent Companions.app"
fi
