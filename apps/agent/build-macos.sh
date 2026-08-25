#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="$ROOT/apps/Cargo.toml"
OUT="$ROOT/artifacts/macos"
APP="$OUT/ReyDesk Helper.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

mkdir -p "$MACOS" "$RES"

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
cargo build --release --manifest-path "$WORKSPACE" -p deskos-agent --target aarch64-apple-darwin
cargo build --release --manifest-path "$WORKSPACE" -p deskos-agent --target x86_64-apple-darwin
lipo -create \
  "$ROOT/apps/target/aarch64-apple-darwin/release/deskos-agent" \
  "$ROOT/apps/target/x86_64-apple-darwin/release/deskos-agent" \
  -output "$MACOS/reydesk-helper"
chmod 755 "$MACOS/reydesk-helper"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>ReyDesk Helper</string>
  <key>CFBundleExecutable</key><string>reydesk-helper</string>
  <key>CFBundleIdentifier</key><string>com.reydesk.helper</string>
  <key>CFBundleName</key><string>ReyDesk Helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSAppleEventsUsageDescription</key><string>ReyDesk uses accessibility controls only when you approve a support session.</string>
  <key>NSAccessibilityUsageDescription</key><string>ReyDesk needs Accessibility permission to control the Mac during an approved support session.</string>
  <key>NSScreenCaptureUsageDescription</key><string>ReyDesk needs Screen Recording permission to share this Mac during an approved support session.</string>
</dict></plist>
PLIST

IDENTITY="${REYDESK_MAC_SIGNING_IDENTITY:-}"
if [[ -n "$IDENTITY" ]]; then
  codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP"
else
  echo "Warning: REYDESK_MAC_SIGNING_IDENTITY is not set; package is unsigned." >&2
fi

rm -f "$OUT/reydesk-helper.dmg"
hdiutil create -volname "ReyDesk Helper" -srcfolder "$APP" -ov -format UDZO "$OUT/reydesk-helper.dmg" >/dev/null

if [[ -n "${REYDESK_MAC_NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$OUT/reydesk-helper.dmg" --keychain-profile "$REYDESK_MAC_NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT/reydesk-helper.dmg"
fi

shasum -a 256 "$OUT/reydesk-helper.dmg" > "$OUT/reydesk-helper.dmg.sha256"
echo "Created $OUT/reydesk-helper.dmg"
