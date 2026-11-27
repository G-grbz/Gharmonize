# Gharmonize Player

Gharmonize Player streams the music stored on your Gharmonize server to a web
browser or the native Android client. Both clients use the same accounts,
libraries and playlists. Keep the server running while listening.

> **Try it first:** the [live Gharmonize Player demo](https://g-grbz.github.io/demo/gharmonize/)
> runs in your browser with sample data; downloads are simulated.

| Component | Where it runs | What to install |
| --- | --- | --- |
| Music server and Web Player | Your computer or server | Gharmonize desktop, a source installation or Docker |
| Android Player Client | Your phone | The `Gharmonize-Player-Client` APK from the official releases |

## Set up the server

Install and start Gharmonize using either of these guides:

- [Desktop and source installation](INSTALLATION.md)
- [Docker installation](DOCKER.md)

Packaged desktop builds include their own Node.js runtime. For a browser-only
server from an existing source checkout, install its dependencies and start it:

```bash
npm ci
npm run server
```

In Gharmonize, open **Settings → System → Gharmonize Player** and enable Player.
It is disabled by default. The Player shortcut then appears in the Classic
and YTLive interfaces.

Open the shortcut or visit `/player/` on your Gharmonize server. With the default
local server port, the address is `http://localhost:5174/player/`.

### First account and music libraries

1. Complete the first Player account setup. Your existing Gharmonize
   administrator session or administrator password authorizes this step.
2. Use the new Player account to sign in to the web and Android clients.
3. Open **Administration → Libraries** to add music folders and scan them.
   Gharmonize's download folder is included automatically.
4. Use **Administration → Users & access** to manage additional accounts, library
   access and download permissions.

Library paths refer to folders on the server. In Docker, use a mounted container
path such as `/music`, rather than the corresponding host path. The process
running Gharmonize needs read access to these folders.

## Connect devices on your home network

The desktop application normally listens only on its own computer. Enable
**Let devices on the home network connect** in Gharmonize's Player settings
to start the separate Player listener. Its default port is `5175`.

For example, if the server's LAN address is `192.168.1.10`:

| Client | Address |
| --- | --- |
| Browser | `http://192.168.1.10:5175/player/` |
| Android manual connection | `http://192.168.1.10:5175` |

Use your server's actual address and configured port. Allow incoming connections
to that port in the server's firewall if needed. This listener serves the Player
and its API; it does not expose the Classic downloader interface.

With Docker, the published Gharmonize port can serve the Player directly. The
default Compose configuration publishes port `5174`, so the browser address is
`http://<server-address>:5174/player/` and the Android server address is
`http://<server-address>:5174`.

## Install and pair the Android client

1. Download the `Gharmonize-Player-Client` APK from
   [official GitHub Releases](https://github.com/G-grbz/Gharmonize/releases/latest)
   and install it on your phone.
2. Connect the phone to the same home network for the initial connection.
3. In the Web Player, open **Account → Devices → Pair a phone**.
4. Open the Android app's QR scanner and scan the displayed code.

You can also enter the server address and pairing code manually, or sign in
with your Player username and password. Pairing codes expire and can be used
only once. Scanning a pairing QR with the phone's camera opens the Web Player
in the browser instead of installing the Android app.

The QR includes known server addresses. The Android client selects a reachable
address and checks again when the phone's network changes. Remote listening
requires one of the remote access options below.

### Playback

The Web Player provides library browsing, playlists, favorites, queue management,
listening statistics, synchronized lyrics and selectable progress bar styles.
The Android client also provides background playback, notification and lock
screen controls, an equalizer and separate Wi-Fi/mobile streaming quality.

In the Android client, swipe up on the mini player or album cover to open the
queue. Swipe down from the queue sheet's handle to close it. Create playlists
from the library or save tracks, albums and the queue to an editable playlist.

Online discovery uses the enabled providers. Items already in your library play
from your server; supported unowned items may offer preview clips. Accounts with
download permission can add supported items through Gharmonize's download engine.

## Listen away from home

Remote access is configured on the server under
**Settings → System → Gharmonize Player**. Account sign-in or device pairing is
still required after external connections are enabled.

### Tailscale

Install Tailscale on the server and phone, connect both to the same tailnet and
select **Tailscale only** in Gharmonize's external connection settings. For the
desktop server, enable the Player listener as described above. Use the server's
Tailscale address, or select it when generating a pairing QR.

### Cloudflare Tunnel

Select **Cloudflare Tunnel** in Gharmonize's external connection settings.
Gharmonize starts the tunnel for its dedicated Player endpoint.

- **Quick tunnel:** no Cloudflare account is needed. The generated address can
  change after a restart; generate a new pairing link when that happens.
- **Named tunnel:** configure your tunnel to forward to the dedicated Player
  origin on the Gharmonize server (`http://127.0.0.1:5185` by default), then
  supply its token and public HTTPS hostname in the Player settings.

The Web Player's remote access panel shows the connection status and available
addresses. Create the phone's pairing QR with an address it can reach from
outside the home network.

### Environment configuration

For deployments managed through `.env`, the basic home-network setup is:

```dotenv
GHARMONIZE_PLAYER_ENABLED=1
GHARMONIZE_PLAYER_LISTEN=1
GHARMONIZE_PLAYER_PORT=5175
GHARMONIZE_PLAYER_REMOTE_ACCESS=off
```

Restart the server after editing its active `.env` file manually.

| Variable | Purpose |
| --- | --- |
| `GHARMONIZE_PLAYER_ENABLED` | Enables the Player service |
| `GHARMONIZE_PLAYER_LISTEN` | Enables the separate Player listener |
| `GHARMONIZE_PLAYER_PORT` | Port for the separate listener |
| `GHARMONIZE_PLAYER_REMOTE_ACCESS` | `off`, `tailscale`, `tunnel` or `any`; `any` permits internet connections |
| `GHARMONIZE_PLAYER_TUNNEL_MODE` | `quick` or `token` for a named Cloudflare tunnel |
| `GHARMONIZE_PLAYER_TUNNEL_TOKEN` | Token for a named tunnel |
| `GHARMONIZE_PLAYER_TUNNEL_URL` | Public HTTPS address for a named tunnel |
| `GHARMONIZE_PLAYER_TUNNEL_PORT` | Local Player origin port for Cloudflare Tunnel; defaults to `5185` |

## Troubleshooting

- **Player shortcut is missing:** enable Player in Gharmonize settings.
- **Phone cannot connect:** use the server's LAN address rather than `localhost`;
  check the Player listener, published Docker port and firewall access.
- **Connection works at home but not on mobile data:** configure remote access
  and pair with an address reachable from outside the home network.
- **Pairing code is rejected:** generate a fresh code; previously used or expired
  codes cannot establish a new session.
- **Music is missing:** check the server-side folder path, read permissions,
  library scan and the account's library access.
- **Download controls are unavailable:** grant download permission to the Player
  account and check which online providers are enabled.
- **Android update will not install over an older APK:** check that both APKs
  use the same signing key. Switching from a locally signed test APK to the
  official release key requires a reinstall.

## Build the Android client from source

Requirements: a JDK between 17 and 23 (17 recommended) and the Android SDK with
the Android 36 platform (installed with Android Studio, or with the command line
tools and `sdkmanager --licenses`). Linux and macOS:

```bash
android/scripts/build-apk.sh            # release APK
android/scripts/build-apk.sh --debug    # debug APK
```

The script needs no environment set up by hand. It:

- picks a suitable JDK even when the default `java` is older or newer (it looks
  at `JAVA_HOME`, `/usr/lib/jvm`, macOS `java_home`, Android Studio's bundled
  JDK and `~/.jdks`);
- finds the Android SDK (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, `sdk.dir` in
  `android/local.properties`, `~/Android/Sdk`, `~/Library/Android/sdk`),
  preferring one that already has the Android 36 platform;
- signs a release build with the release key when one is available (see below),
  otherwise with the local debug key, and says which one it used;
- prints the path of the finished APK
  (`android/app/build/outputs/apk/release/app-release.apk`).

Anything it finds can be overridden with `JAVA_HOME` / `ANDROID_HOME`, and extra
Gradle arguments follow `--`, for example `android/scripts/build-apk.sh -- --info`.

Running Gradle directly also works when `java` is JDK 17–23 and the SDK is set
through `ANDROID_HOME` or `android/local.properties`:

```bash
cd android
JAVA_HOME=/path/to/jdk-17 ./gradlew :app:assembleRelease
```

The error `Dependency requires at least JVM runtime version 11. This build uses a
Java 8 JVM` means Gradle started with an old default Java: use the script or set
`JAVA_HOME` as above. On Windows, run `gradlew.bat :app:assembleRelease` from
`android` with `JAVA_HOME` pointing at JDK 17.

### Signing

An APK only installs over an existing app signed with the same key. A release
build is signed with, in this order:

1. the key given in `GHP_KEYSTORE_FILE`, `GHP_KEYSTORE_PASSWORD`,
   `GHP_KEY_ALIAS` and `GHP_KEY_PASSWORD`;
2. `~/.gharmonize/gharmonize-player-release.jks` with the password in
   `~/.gharmonize/gharmonize-player-release.pass` (alias `gharmonize-player`), as
   created by `android/scripts/set-signing-secrets.sh` (script builds only);
3. otherwise the local debug key. Such an APK installs over APKs built on the same
   machine, not over official releases: uninstall the app first.

GitHub Actions publishes the Client APK using a persistent release key. The
required repository secrets are `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
Maintainers can configure them with
[`android/scripts/set-signing-secrets.sh`](../android/scripts/set-signing-secrets.sh).
Preserve the signing key and password together so future APKs can update the
installed app.
