plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.reydesk.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.reydesk.agent"
        // MediaProjection APIs used here require 29+; the adaptive icon and
        // continued-gesture API need 26+. We set minSdk 29 because every device
        // below 29 misses security patches relevant to remote control.
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-service:2.8.6")

    // Networking: HTTP + WebSocket against the ReyDesk API and relay.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Prebuilt libwebrtc with ScreenCapturerAndroid. io.getstream maintains the
    // fork that used to live at org.webrtc:google-webrtc.
    implementation("io.getstream:stream-webrtc-android:1.3.8")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.google.code.gson:gson:2.11.0")

    // Encrypted storage for the per-device enrolment token.
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
