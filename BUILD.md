# DeskOS Mobile App — Build Guide

DeskOS mobile app is built with [Capacitor](https://capacitorjs.com) — a native runtime that wraps the responsive web console in a native shell.

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
   keytool -genkey -v -keystore deskos-release.keystore \
     -alias deskos -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Add to `android/app/build.gradle`:
   ```groovy
   signingConfigs {
     release {
       storeFile file('../deskos-release.keystore')
       storePassword 'YOUR_STORE_PASSWORD'
       keyAlias 'deskos'
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
3. Update **Bundle Identifier** (e.g., `com.deskos.app`)
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

Push notifications require:
- **Android**: Firebase Cloud Messaging (FCM) — add `google-services.json` to `android/app/`
- **iOS**: Apple Push Notification Service (APNs) — configure in Xcode Capabilities

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
deskos/
├── apps/web/          # React web console (Capacitor webDir)
├── android/           # Android native project
├── ios/               # iOS native project
├── capacitor.config.ts
├── BUILD.md           # This file
└── package.json
```
