# Gharmonize Player for Android

Kotlin + Jetpack Compose + Media3 client for Gharmonize Player.

- Background playback with media notification, lock screen and headset controls
- Pairing with the QR code from the web player (Account → Devices → Pair a phone), a pairing code, or username/password
- Automatic server choice: the QR code carries every known address (home network, Tailscale, custom); the app uses whichever answers and re-checks when the phone's network changes
- Home (library + online shelves), search (library + Deezer / YouTube Music / Spotify), library, album / artist / playlist pages, online albums and artists, 30 s previews, downloads into the library, synced lyrics, queue, likes, play history
- Separate streaming quality for Wi-Fi and mobile data; dark / light / system theme; English and Turkish

## Server requirements

Gharmonize Player must be enabled in Gharmonize settings. Phones reach the server:

- **Home network** — Docker: the published Gharmonize port. Desktop app: turn on
  "Let devices on the home network connect" (player-only port, default 5175).
- **Away from home** — install Tailscale on the server and the phone, then allow
  external connections → "Tailscale only" in Gharmonize settings.

## Build

Requires JDK 17 and the Android SDK (platform 36, build-tools 35).

```bash
cd android
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
./gradlew :app:assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug key so it installs directly; use a
real signing config before publishing to a store.

## Player appearance

Version 0.4.1 uses the blue/violet listening-room background, a circular cover
constrained by both available width and height, and plain lyrics without cover art
behind the text. Controls use Fluent UI System Icons Regular 24, matching the web
player. Existing Android typography is preserved.

Fluent icon paths are shared with the web client via the mapping in
`../public/player/icons/mapping.json`; the APK includes the MIT license under
`assets/licenses/FluentUI.txt`.

## Queue and playlists (0.4.2)

- Swipe up on the mini player or on the cover to open the queue. Swipe down
  from the sheet handle to dismiss it; the queue list scrolls independently.
- The Home screen provides direct access to playlists and the queue.
- Create a playlist from the library, or save an album, playlist, track or
  queue to a new or existing editable playlist.
- Queue entries can be moved or removed; clearing upcoming tracks preserves
  the current track.
- Turkish and English labels use consistent playback and download terminology.

## Releases (GitHub Actions)

Every `vX.Y.Z` tag runs `.github/workflows/release.yml`, which also builds the
app and attaches `Gharmonize-Player-Android.vX.Y.Z.apk` to the GitHub release
(versionName `X.Y.Z`, versionCode `X*1000000 + Y*1000 + Z`; included in the
signed `SHA256SUMS` and the artifact attestations).

Phones only install an update signed with the same key as the installed app,
so the workflow needs four repository secrets: `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Set them once with:

```sh
android/scripts/set-signing-secrets.sh          # new release key in ~/.gharmonize (back it up!)
android/scripts/set-signing-secrets.sh --debug  # or this machine's debug key: CI APKs then
                                                # update locally built APKs without a reinstall
```

Local builds are unchanged: without the `GHP_KEYSTORE_*` environment variables
the release APK is signed with the local debug key.
