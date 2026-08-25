# ReyDesk macOS helper

The macOS helper uses the same relay and WebRTC session protocol as the Windows agent. It captures the selected display through `xcap`; mouse, keyboard, and scroll control require a native macOS input backend and user-granted Accessibility permission.

## Current release gate

The API only advertises and serves a macOS package when `REYDESK_MAC_HELPER_BINARY` points to an existing, signed and notarized DMG. Do not publish an unsigned or partially implemented package: macOS must never receive a Windows executable, and the connect page clearly falls back to browser support when the DMG is unavailable.

## Build on macOS

```bash
./apps/agent/build-macos.sh
```

The script builds arm64 and Intel targets, combines them into a universal app, writes the Screen Recording and Accessibility usage descriptions, optionally signs with `REYDESK_MAC_SIGNING_IDENTITY`, optionally notarizes with `REYDESK_MAC_NOTARY_PROFILE`, and emits `artifacts/macos/reydesk-helper.dmg`.

Required release environment:

- `REYDESK_MAC_SIGNING_IDENTITY`: Developer ID Application certificate identity
- `REYDESK_MAC_NOTARY_PROFILE`: stored `notarytool` keychain profile
- `REYDESK_MAC_HELPER_BINARY`: absolute path to the resulting DMG in the API deployment

Users must approve Screen Recording for screen sharing and Accessibility for mouse/keyboard control. A support session remains attended and permission-scoped; the helper does not silently enable either permission.

## iPhone and iPad

iOS and iPadOS cannot run a general unattended desktop-control agent. Those devices use the browser support flow for consent, chat, and context sharing. They are not offered a misleading native download.
