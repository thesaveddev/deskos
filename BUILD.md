# ReyDesk Mobile App — Build Guide

ReyDesk mobile app is built with [Capacitor](https://capacitorjs.com) — a native runtime that wraps the responsive web console in a native shell.

The native shell now provides permission-aware primary tabs, nested-page back navigation, quick ticket creation, account actions, lock-screen access, theme switching, safe-area handling, and a More menu for secondary modules. Web Push remains a browser capability; native Android/iOS push registration and provider delivery require the FCM/APNs setup described below and are not enabled by the web service-worker path.

## Prerequisites

### Android
- **Android Studio** (latest stable) — [download](https://developer.android.com/studio)
- **Java JDK 17** (bundled with Android Studio)
- **Android SDK** (API 34+, installed via Android Studio SDK Manager)

### iOS (macOS only)
- **Xcode 15+** — from the Mac App Store
- **CocoaPods** — `sudo gem install cocoapods`
- **Apple Developer Account** — for signing and distribution

### Both platforms
- Node.js 18+ and npm

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Build the web app
npm run build --workspace @deskos/web

# 3. Sync web assets to native projects
npx cap sync
```

---

## Build Android APK

### Debug APK (no signing required)

```bash
cd android
./gradlew assembleDebug
# Output: android/app/build/outputs/apk/debug/app-debug.apk
```

### Release APK (unsigned)

```bash
cd android
./gradlew assembleRelease
# Output: android/app/build/outputs/apk/release/app-release-unsigned.apk
```

### Signed AAB (for Google Play)

1. Generate a keystore:
   ```bash
   keytool -genkey -v -keystore reydesk-release.keystore \
     -alias reydesk -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Add to `android/app/build.gradle`:
   ```groovy
   signingConfigs {
     release {
       storeFile file('../reydesk-release.keystore')
       storePassword 'YOUR_STORE_PASSWORD'
       keyAlias 'reydesk'
       keyPassword 'YOUR_KEY_PASSWORD'
     }
   }
   buildTypes {
     release {
       signingConfig signingConfigs.release
     }
   }
   ```

3. Build:
   ```bash
   cd android
   ./gradlew bundleRelease
   # Output: android/app/build/outputs/bundle/release/app-release.aab
   ```

4. Upload to [Google Play Console](https://play.google.com/console).

### Install on device via ADB

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Build iOS (macOS only)

```bash
cd ios
pod install
open App/App.xcconfig
# Or open in Xcode:
open App.xcworkspace
```

In Xcode:
1. Select the **App** target
2. Set your **Team** (Apple Developer account)
3. Update **Bundle Identifier** (e.g., `com.reydesk.app`)
4. Select a device or simulator
5. **Product → Run** (Cmd+R)

### Archive for App Store

1. **Product → Archive**
2. In the Organizer, click **Distribute App**
3. Choose **App Store Connect**
4. Follow the upload wizard

---

## Development mode

To test against a local dev server:

1. Start the web dev server:
   ```bash
   npm run dev --workspace @deskos/web
   ```

2. Update `capacitor.config.ts`:
   ```ts
   server: {
     url: 'http://YOUR_LOCAL_IP:5180',
     cleartext: true,
   }
   ```

3. Sync and run:
   ```bash
   npx cap sync
   cd android && ./gradlew installDebug  # Android
   # or open in Xcode for iOS
   ```

---

## Push notifications

The web console uses Web Push with VAPID keys. The Capacitor projects include the native push plugin, but a store-ready native push implementation still requires provider configuration and native token registration:

- **Android**: Firebase Cloud Messaging (FCM), `google-services.json` in `android/app/`, notification channel/icon configuration, and a server-side FCM sender.
- **iOS**: APNs capability, a valid team/bundle signing profile, APNs authentication key or certificate, and a server-side APNs sender.
- **Both**: request permission from an explicit in-app action, register each device token against the authenticated user, handle token rotation, and route notification taps to the relevant ReyDesk ticket/session.

Do not ship the native app claiming background push is complete until those provider and server-delivery steps are implemented and tested on physical devices. Browser push can be enabled from Settings → Notifications.

---

## Updating the app

After any web code change:

```bash
npm run build --workspace @deskos/web
npx cap sync
```

Then rebuild the native project (gradlew or Xcode).

---

## Project structure

```
reydesk/
├── apps/web/          # React web console (Capacitor webDir)
├── android/           # Android native project
├── ios/               # iOS native project
├── capacitor.config.ts
├── BUILD.md           # This file
└── package.json
```
