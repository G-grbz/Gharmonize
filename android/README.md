# Gharmonize Player for Android

A native Android client for the Gharmonize music server, built with Kotlin,
Jetpack Compose and Media3.

- Background playback with notification, lock screen and headset controls
- Music library, search, playlists, queue, synchronized lyrics and downloads
- Equalizer, playback appearance settings and separate Wi-Fi/mobile streaming quality
- QR code, pairing code or username/password sign-in
- English and Turkish interfaces

## Connect

Enable Player in Gharmonize settings and allow connections from devices on your
home network. In the web player, open **Account → Devices → Pair a phone**, then
scan the QR code in the Android app. Remote access uses the server's configured
Tailscale or Cloudflare connection.

## Build

Requires JDK 17 and the Android SDK. Configure the SDK through `ANDROID_HOME`
or `android/local.properties`, then run:

```bash
cd android
./gradlew :app:assembleRelease
```

The APK is written to `app/build/outputs/apk/release/app-release.apk`.
Local builds use the debug signing key unless a release key is configured.

## Release signing

GitHub Actions builds the APK as part of the project's release workflow. It
requires the repository secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
Use `scripts/set-signing-secrets.sh` to configure them. Keep the same signing
key for updates to install over an existing app.
