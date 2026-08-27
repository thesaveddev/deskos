# libwebrtc loads classes reflectively through JNI.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# Gson model classes are constructed reflectively.
-keepclassmembers class com.reydesk.agent.model.** { *; }

# OkHttp platform probes optional providers.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
