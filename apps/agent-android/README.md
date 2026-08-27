# ReyDesk Android Agent

Remote-control endpoint agent for Android phones and tablets: screenshare over
WebRTC plus tap/drag/scroll injection and typed-text delivery, wired into the
same relay protocol as the Windows/macOS desktop agent.

## Capabilities

| Capability | Status | Mechanism |
| --- | --- | --- |
| Screen sharing | ✅ | `ScreenCapturerAndroid` (MediaProjection), H.264/VP8 send-only transceiver |
| Tap / drag / scroll injection | ✅ | AccessibilityService gesture dispatch (`canPerformGestures`) |
| Right-click context menus | ✅ | Long-press stroke |
| Typed text | ✅* | ReyDesk IME bridge — endpoint switches keyboard once per session |
| Back / Home / Recents keys | ✅ | Global accessibility actions (`Escape`, `Home`, `F5`) |
| Clipboard sync, terminal, file transfer | ❌ v1 | Platform limits; endpoints return `clipboard_error` like the desktop agent does when unavailable |

The session permission set requested on consent is exactly
`["view_screen", "control_input"]`; the server intersects it with what the
technician asked for, so view-only sessions still work.

## Session flow

```
Technician starts session on enrolled Android device
   └─ GET /agent/sessions (agent polls while app is open)
       └─ ConsentActivity: Allow / Deny
           └─ Allow -> system MediaProjection dialog
               └─ POST /agent/sessions/:id/consent {granted:true,...}
                   └─ CaptureService (foreground):
                        WSS /ws join -> answer SDP offer -> stream screen
                        input datachannel -> gestures / IME text
```

Dead-peer recovery mirrors the Rust agent: duplicate offers are ignored while
the peer is healthy; a failed/disconnected peer is replaced by the fresh offer,
and reconnects request a fresh join token from `POST .../reconnect` (3 attempts).

## Building

```bash
cd apps/agent-android
gradle wrapper --gradle-version 8.9   # once; generates the gradlew binary
./gradlew assembleDebug          # APK at app/build/outputs/apk/debug/
./gradlew assembleRelease        # unsigned until you add signing config
```

Opening the folder in Android Studio instead will install the Gradle wrapper
automatically on first sync.

Requires JDK 17 and an Android SDK 34 toolchain. The WebRTC runtime is the
prebuilt `io.getstream:stream-webrtc-android` artifact — no NDK checkout
needed.

## Enrolling a device

Two ways, both using the existing tenant credentials from
**Devices → Deploy or enrol device**:

1. **Enrollment code** — enter the 12-digit code in the app's first screen.
2. **Deep link** — scan/print `reydesk://enrol?token=<12-digit code>`; opening
   it prefills the app. Fleet tokens work identically for MDM pushes.

The enrolled identity appears as `device_type = mobile`, `os = Android`, so the
devices list, sessions, and alerts treat it like any other endpoint. It counts
against the plan's device cap just like desktop agents.

## Endpoint requirements (per device)

- Android 10+ (API 29)
- During first control session: enable **ReyDesk remote control** in
  Accessibility settings (the app deep-links there) and optionally switch the
  active keyboard to **ReyDesk keyboard** for typed text.
- Battery: the agent only polls for sessions while its activity is visible;
  an always-on poll needs an OEM battery allowlist. Document this to users.

## Known limitations (v1)

- No clipboard, file-transfer, terminal, or monitor switching (single display).
- Pointer precision depends on the captured resolution reported by
  MediaProjection; DPI-scaled reporting matches the screen pixels sent.
- Session pickup requires the app open (push-triggered wake is future work).
