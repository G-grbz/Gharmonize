# Configuration (`.env` Reference)

Create a `.env` file in the project root. All variables below are optional unless noted otherwise — sensible defaults are used when a variable is left empty.

For Docker setups, Gharmonize generates an initial random admin credential on first start. Preserve the application master key and use HTTPS/reverse-proxy hardening for remote access (see [DOCKER.md](DOCKER.md)).

---

## Table of Contents

- [Preview / Fetch Limits](#preview--fetch-limits)
- [yt-dlp Binary & Download Behavior](#yt-dlp-binary--download-behavior)
- [Preview Cache](#preview-cache)
- [Upload Limits](#upload-limits)
- [Frontend UI](#frontend-ui)
- [Data Directories](#data-directories)
- [Spotify API](#spotify-api)
- [Title Cleaning](#title-cleaning)
- [Authentication & App Secret](#authentication--app-secret)
- [Cookies & yt-dlp Cookie Behavior](#cookies--yt-dlp-cookie-behavior)
- [YouTube / yt-dlp Language & Region](#youtube--yt-dlp-language--region)
- [Media Tagging / FFmpeg](#media-tagging--ffmpeg)

---

## Preview / Fetch Limits

### `PREVIEW_MAX_ENTRIES`
Maximum number of entries shown in Automix / playlist preview. Higher value → more entries → more processing time. Acts as a safety limit in case YouTube returns extremely long lists.

```dotenv
PREVIEW_MAX_ENTRIES=1000
```

### `AUTOMIX_ALL_TIMEOUT_MS`
Timeout (in ms) for fetching the entire Automix list in a single request. If this timeout is hit, the system falls back to paginated mode.

```dotenv
AUTOMIX_ALL_TIMEOUT_MS=45000
```

### `AUTOMIX_PAGE_TIMEOUT_MS`
Timeout (in ms) for each paginated Automix request (e.g., 50 items per page). Used when flat/one-shot mode times out.

```dotenv
AUTOMIX_PAGE_TIMEOUT_MS=45000
```

### `PLAYLIST_ALL_TIMEOUT_MS`
Timeout (in ms) for fetching a full playlist using `--flat-playlist`. Large playlists or slow YouTube may cause a fallback to page mode.

```dotenv
PLAYLIST_ALL_TIMEOUT_MS=35000
```

### `PLAYLIST_PAGE_TIMEOUT_MS`
Timeout (in ms) for each paginated playlist fetch (e.g., 50 items per page).

```dotenv
PLAYLIST_PAGE_TIMEOUT_MS=25000
```

### `PLAYLIST_META_TIMEOUT_MS`
Timeout (in ms) for fetching playlist metadata (title, total item count, etc.).

```dotenv
PLAYLIST_META_TIMEOUT_MS=30000
```

### `PLAYLIST_META_FALLBACK_TIMEOUT_MS`
Timeout (in ms) for the fallback metadata attempt (e.g., "if full metadata fails, try using only the first item").

```dotenv
PLAYLIST_META_FALLBACK_TIMEOUT_MS=20000
```

---

## yt-dlp Binary & Download Behavior

### `YTDLP_BIN`
Absolute path to the yt-dlp executable. If left empty, the app may try to resolve it from `PATH` or built-in locations.

```dotenv
YTDLP_BIN=/usr/local/bin/yt-dlp
# or on Windows:
YTDLP_BIN=C:\tools\yt-dlp.exe
```

### FFmpeg / FFprobe and NVIDIA compatibility

Packaged Electron uses bundled or managed FFmpeg/FFprobe, not an automatic
system `PATH` fallback. Explicit `FFMPEG_BIN` / `FFPROBE_BIN` overrides are still
honored. If a new managed FFmpeg fails NVIDIA driver compatibility checks,
Gharmonize retains an NVENC-tested active/last-known-good pair on the `stable`
channel. On a fresh installation without one, it tries up to three official
BtbN compatibility candidates: current older release branches first, then
archived snapshots. Candidates are grouped by the provider's current SDK bands:
13.1 (FFmpeg 8.2+), 13.0 (8.0/8.1), and 11.1 (older release branches).
When the runtime reports its available NVENC API, incompatible newer bands are
skipped. These version mappings are selection hints, not proof of compatibility.
It verifies their SHA-256 digests and runs a real H.264 NVENC encoding
probe before activating both tools together. Failed candidates never replace
the active pair. A successful compatibility pair is cached, so rejected updates
are not downloaded again on every startup; a manual refresh retries immediately.
If none passes, a latest pair that passed basic executable and software audio
conversion checks is retained instead: FFmpeg/FFprobe remain available, with
NVENC reported as unavailable. Absence of NVIDIA hardware or its driver does
not prevent installation. Failed downloads and failed basic conversion checks
are not accepted as working binaries. Linux and Windows use their own matching
archive formats; a working H.264 NVENC probe does not guarantee that a GPU
supports every other hardware codec or pixel format.

### Electron UI rendering (Linux / AppImage)

AppImage keeps Chromium's automatic GPU acceleration enabled by default.
Disabling it forces software compositing and can significantly increase CPU
usage while scrolling, independently of FFmpeg/NVENC compatibility.
If a particular graphics driver has rendering problems, opt out explicitly:

```dotenv
GHARMONIZE_DISABLE_HARDWARE_ACCELERATION=1
```

Remove the override or set it to `0` to use default GPU acceleration. Restart
the desktop app after changing it. `GHARMONIZE_OZONE_PLATFORM=x11` or `wayland`
can explicitly select the Linux display backend; neither overrides this setting.
Browser/Docker UI rendering is controlled by the browser, not these Electron
settings. Existing tray, resume and unresponsive-window recovery remain enabled.

### Binary extraction temporary files

`GHARMONIZE_BINARY_TMP_DIR` optionally selects the executable-capable parent
directory for runtime tool temporary files. By default this is `tmp/` inside
the managed binary cache. Gharmonize creates private per-instance subdirectories;
do not point this variable at a shared or world-writable directory. The location
is not forced to system `/tmp`, which can be mounted with `noexec` and prevent
PyInstaller-based yt-dlp executables from starting.

On Linux, yt-dlp processes run in dedicated process groups. Timeouts, watchdogs
and cancellation send SIGTERM first, with up to **5 seconds** for shutdown before
SIGKILL. A finished child cancels the delayed force-kill. Windows tree termination
similarly attempts `taskkill /T` before escalating to `/T /F`; Windows does not
provide POSIX signal semantics.

Linux runtime sessions record pending launches, process groups and their PID
namespace. Once all tracked groups have exited, leftover `_MEI*` extraction
directories can be reclaimed without touching active work. Startup and hourly
maintenance also collect inactive extractions older than one hour. Only private,
owned directories with the expected names are eligible; symlinks and unrelated
files are never followed or swept.

Legacy/untracked extractions additionally require readable Linux `/proc`
environment and memory-map information. If that inspection is incomplete, they
are retained rather than guessed inactive. Docker only collects complete managed
leases from its own PID namespace, not unknown host/sibling-container remnants.
Windows/macOS do not perform the Linux orphan sweep. Normal PyInstaller shutdown
remains the primary cleanup mechanism on all platforms. Configuration and download
files are not part of this cleanup.

### `YTDLP_EXTRA`
Extra yt-dlp arguments applied to all audio downloads (`downloadSelectedIds`, `downloadSelectedIdsParallel`, `downloadStandard` in audio mode). Space-separated string; each token becomes an argument.

```dotenv
YTDLP_EXTRA=--some-yt-dlp-flag --another-flag=1
```

### `YTDLP_ARGS_EXTRA`
Alternative name used when `YTDLP_EXTRA` is not defined.

Priority order:
1. `YTDLP_EXTRA`
2. `YTDLP_ARGS_EXTRA`
3. no extra args

```dotenv
YTDLP_ARGS_EXTRA=--some-yt-dlp-flag --another-flag=1
```

### `YTDLP_AUDIO_LIMIT_RATE`
Rate limit for single-video audio downloads (not playlist mode). Passed as `--limit-rate` to yt-dlp.

```dotenv
YTDLP_AUDIO_LIMIT_RATE=500K
YTDLP_AUDIO_LIMIT_RATE=1M
YTDLP_AUDIO_LIMIT_RATE=2M
```

---

## Preview Cache

### `PREVIEW_CACHE_TTL_MS`
Time-to-live (in ms) for playlist/automix preview results stored in memory. After this duration:
- `getCache(url)` treats the entry as expired
- the record is removed
- metadata/preview is fetched again

```dotenv
# 30 minutes
PREVIEW_CACHE_TTL_MS=1800000
```

---

## Upload Limits

### `UPLOAD_MAX_BYTES`
Maximum allowed upload file size. Used by multer as `limits.fileSize`. If invalid, the app logs a warning and falls back to ~1000 MB.

Supported formats:
- Pure number → treated as bytes (e.g., `104857600`)
- `<number>mb` → number × 1024 × 1024 (e.g., `100mb` → ~104 MB)

```dotenv
UPLOAD_MAX_BYTES=104857600
UPLOAD_MAX_BYTES=100mb
```

---

## Frontend UI

### `FRONTEND_UI`
Controls which interface is served from `/`.

- `classic` — existing Gharmonize web UI (default)
- `ytlive` — YouTube / YouTube Music focused YTLive UI (see [YTLIVE.md](YTLIVE.md))

Direct routes remain available either way:
- `/index.html`
- `/ytlive.html`

```dotenv
FRONTEND_UI=ytlive
```

### `YOUTUBE_QUICK_ADD_LIMIT`
Maximum number of playlist entries queued by the YTLive playlist **+** action. Valid range: `1`–`100`.

```dotenv
YOUTUBE_QUICK_ADD_LIMIT=50
```

### `YOUTUBE_DISCOVER_DEBUG`
Enables verbose server-side logging for YTLive YouTube discovery internals.

- `1` → enabled
- `0` → disabled

```dotenv
YOUTUBE_DISCOVER_DEBUG=0
```

---

## Data Directories

### `DATA_DIR`
Root directory for application storage. It is loaded before routes and workers
choose their paths. An explicit process/Compose environment value takes precedence
over `.env`; the user `.env` takes precedence over packaged defaults.

If empty, Node/Docker defaults to `process.cwd()` (the app's working directory).
Packaged Electron (Windows installer, portable EXE/folder, and Linux AppImage)
defaults to Electron's `userData` directory. A configured `DATA_DIR` is honored
in all three runtimes; it is no longer forced to the desktop profile directory.
Relative paths resolve against the working directory for Node/Docker and the
profile directory for packaged Electron. Absolute paths are recommended.

Typical structure:
- `DATA_DIR/outputs/` → exported / processed files
- `DATA_DIR/uploads/` → uploaded files / merged chunks
- `DATA_DIR/local-inputs/` → source directory for `/api/local-files` (if enabled)
- `DATA_DIR/temp/`, `cookies/` → temporary files and cookies
- `DATA_DIR/cache/` (Node/Docker) or `DATA_DIR/Cache/` (packaged Electron) → persisted jobs/cache; managed tools live in its `binaries/` subdirectory

Packaged Electron uses `Cache` to share the same top-level directory as
Chromium's `Cache_Data` and other browser caches when `DATA_DIR` is the default
profile directory. With a custom `DATA_DIR`, Chromium stays in the profile and
application caches use `DATA_DIR/Cache`. Existing lowercase `cache` directories
are not moved, deleted, or reused on case-sensitive systems: missing managed
tools download again at startup, and job history / saved YTLive lists start
fresh (the old files remain in place). Windows normally treats `Cache` and
`cache` as the same directory, so capitalization alone does not force a fresh
download there. Explicit `GHARMONIZE_WEB_CACHE_DIR`, `CACHE_DIR`,
`JOBS_STATE_DIR`, and `YTLIVE_DOWNLOAD_LISTS_DIR` overrides remain honored.

```dotenv
DATA_DIR=/var/lib/gharmonize
DATA_DIR=/home/youruser/gharmonize-data
# Windows: files are saved in D:/Gharmonize-data/outputs
DATA_DIR=D:/Gharmonize-data
```

In packaged Electron, edit `.env` in the existing Gharmonize profile
(`%APPDATA%/Gharmonize/.env` on Windows, normally
`~/.config/Gharmonize/.env` on Linux). This file and the default encryption key
remain in the profile even when storage moves, so saved encrypted credentials
remain usable. Chromium's session/profile also stays there. In Node/Docker,
settings are saved to the `.env` actually loaded (`ENV_USER_PATH`, `ENV_PATH`,
or the working-directory `.env`), not to a new file under `DATA_DIR`.

Restart the entire application after changing directory settings (including
quitting the Electron tray process). Existing outputs/cache are **not** moved
automatically. For Node/Docker, preserve the existing `.gharmonize-key` when
moving storage, or explicitly point `GHARMONIZE_MASTER_KEY_FILE` to it before
restarting; otherwise encrypted settings and sessions cannot use the old key.
The configured directory must be accessible/writable; an invalid path is not
silently replaced with another storage location.

### `OUTPUTS_DISPLAY_DIR`

Optional **display-only alias** for `DATA_DIR/outputs`. It does not change where
files are written, served, converted, retagged, or opened locally. If empty, the
UI shows the actual output directory. Relative aliases resolve under `DATA_DIR`;
absolute host paths (including Windows drive/UNC paths on a Linux container)
can be displayed without requiring them to exist inside the container.

There is currently no separate `OUTPUT_DIR` configuration variable. To change
storage in Electron/Node, set `DATA_DIR` (outputs are stored in its `outputs`
subdirectory). In Docker, change the output bind mount's **host side**:

```yaml
environment:
  - DATA_DIR=/usr/src/app
  - OUTPUTS_DISPLAY_DIR=/mnt/music-downloads
volumes:
  - /mnt/music-downloads:/usr/src/app/outputs
```

The container writes `/usr/src/app/outputs`; Docker stores those files in
`/mnt/music-downloads` on the host. Do not put an unmounted host path in the
container's `DATA_DIR`.

Retag works **in place** in the selected music directory; it never redirects
the music files to `outputs`. Its temporary assets use `DATA_DIR/temp`. Desktop
directory access still requires the trusted Electron bridge; web/Node/Docker
access still requires administrator authentication and is restricted to
`RETAG_ROOTS` when set. Without explicit roots, existing `/music`,
`LOCAL_INPUT_DIR`, and the actual `DATA_DIR/outputs` are offered. A display alias
is never added to the allowed retag roots.

### `LOCAL_INPUT_DIR`
Relative directory under `DATA_DIR` for local file browsing. Resolved as:

```text
path.resolve(DATA_DIR || process.cwd(), LOCAL_INPUT_DIR)
```

Used by:
- `/api/local-files` → recursively lists supported media
- `/api/probe/local` → only accepts files under this directory (security check)

Default (when empty) is usually `local-inputs`.

```dotenv
LOCAL_INPUT_DIR=local-inputs
LOCAL_INPUT_DIR=my-local-media
```

---

## Spotify API

### `SPOTIFY_CLIENT_ID`
Spotify Web API client ID. Obtain from the Spotify Developer Dashboard. Used when requesting access tokens.

> ❗ Do NOT commit real credentials to public repositories.

### `SPOTIFY_CLIENT_SECRET`
Spotify Web API client secret. Used together with `SPOTIFY_CLIENT_ID` to obtain access tokens.

> ❗ Keep this secret. Never expose in logs, frontend, or public repos.

### `SPOTIFY_MARKET`
Default market (country code) for Spotify API requests. Affects which tracks/albums are considered available.

```dotenv
SPOTIFY_MARKET=US
SPOTIFY_MARKET=FR
SPOTIFY_MARKET=DE
```

### `SPOTIFY_FALLBACK_MARKETS`
Comma-separated list of fallback markets. Logic example: try `SPOTIFY_MARKET` first; if not available there, try these markets in order.

```dotenv
SPOTIFY_FALLBACK_MARKETS=US,GB,DE,FR
```

### `SPOTIFY_DEBUG_MARKET`
Enable extra debug logging related to market selection and fallbacks.

- `1` → verbose logs (good for development)
- `0` → quiet (recommended for production)

```dotenv
SPOTIFY_DEBUG_MARKET=1
```

Spotify, Apple Music, and Deezer matching/download concurrency is controlled from the UI with the max concurrent downloads/conversions field.

## Deezer personalized smart tracklists

Gharmonize accepts Deezer `inspired-by-*` smart-tracklist URLs with or without a locale prefix, for example:

```text
https://www.deezer.com/smarttracklist/inspired-by-1
https://www.deezer.com/tr/smarttracklist/inspired-by-2
https://www.deezer.com/en/smarttracklist/inspired-by-3
https://www.deezer.com/fr/smarttracklist/inspired-by-4
```

### `DEEZER_ARL`

These lists are personalized, so Deezer returns their tracks only for a signed-in session. Copy the `arl` cookie value from a signed-in Deezer browser session into the **Spotify / Deezer** settings tab. Gharmonize validates it, stores it encrypted, masks it in the UI, and never includes it in exported job data or logs.

```dotenv
DEEZER_ARL=
```

> ❗ Treat `DEEZER_ARL` like a password. Do not commit or share it. If Deezer expires the session, replace it with a current cookie value.

### `PREFER_SPOTIFY_TAGS`
When writing tags (ID3, etc.), prefer metadata coming from Spotify.

- `1` → if both YouTube and Spotify metadata exist, favor Spotify's cleaner data
- `0` → favor YouTube (or other resolvers)

```dotenv
PREFER_SPOTIFY_TAGS=1
```

### `YT_SEARCH_RESULTS`
Number of yt-dlp search results to fetch per query (`ytsearchN`). Lower = faster mapping, but slightly higher risk of a wrong match. Recommended: `2` (fast) / `3` (safer).

### `YT_SEARCH_TIMEOUT_MS`
Per-search timeout in milliseconds for the mapping/search step. If a search hangs or YouTube is slow, it will abort after this time. Lower = snappier UI, but may cause more "not found" results on slow networks.

### `YT_SEARCH_STAGGER_MS`
Stagger delay (ms) applied when starting parallel searches. Helps avoid burst/throttle behavior by spacing out requests across concurrency slots. Lower = faster burst; higher = smoother and often fewer throttles/timeouts. Set to `0` to disable staggering.

---

## Title Cleaning

### `TITLE_CLEAN_PIPE`
If set to `1`, when a title contains the `|` character, the part **after** the last `|` is kept. This is applied before other `CLEAN_*` rules.

Example: `"Artist Name | Official Video"` → `"Official Video"`

```dotenv
TITLE_CLEAN_PIPE=1
```

### `CLEAN_SUFFIXES`
Comma-separated list of suffix tokens to remove from the end of titles.

Examples of matches:
- `"Song Name (Official)"` → suffix `Official`
- `"Artist - Track (Topic)"` → suffix `Topic`

```dotenv
CLEAN_SUFFIXES=topic,official
```

### `CLEAN_PHRASES`
Phrases to completely remove when they appear in title text.

Typical usage:
- `"Song Name (Official Video)"` → remove `Official Video`
- `"Artist - Track [official channel]"` → remove `official channel`

```dotenv
CLEAN_PHRASES="official channel,Official Video"
```

### `CLEAN_PARENS`
Words that, when found inside parentheses, cause that whole `(...)` segment to be removed.

Examples:
- `"Song Name (official)"` → remove `(official)`
- `"Song Name (topic)"` → remove `(topic)`

```dotenv
CLEAN_PARENS=official,topic
```

---

## Authentication & Secret Storage

### Admin password
On first start, Gharmonize generates a strong random admin password, stores only a **scrypt** hash, and writes the one-time credential to `INITIAL_ADMIN_PASSWORD.txt` with restrictive permissions. Change it from Settings after the first login and remove the one-time file when no longer needed.

`ADMIN_PASSWORD` is accepted only as a legacy migration input. Do not add a plaintext admin password to new deployments. `APP_SECRET` is no longer used for session signing.

### Application access modes

Gharmonize can keep the original behavior or require authentication before the application can be used:

```dotenv
GHARMONIZE_ACCESS_MODE=none
```

- `none` — the application opens normally. Existing administrator-only actions (Settings, protected local-file/disc operations, and similar routes) still require the admin session exactly as before.
- `admin` — the browser must establish an administrator session or an approved temporary-access session before dynamic Gharmonize routes are available. The check is enforced server-side as well as by the full-screen login gate.

When `admin` mode is selected, temporary use can be enabled:

```dotenv
GHARMONIZE_TEMP_ACCESS_ENABLED=1
GHARMONIZE_TEMP_ACCESS_HOURS=1
GHARMONIZE_TEMP_ACCESS_DAYS=0
GHARMONIZE_TEMP_ACCESS_MONTHS=0
GHARMONIZE_TEMP_ACCESS_YEARS=0
```

The duration fields are combined. Months are treated as 30 days and years as 365 days; the configured temporary session is capped at five years. At least one hour must be configured when temporary access is enabled.

A visitor can then choose **Request access** on the login screen. Gharmonize records the server-observed client IP (`req.ip`). Reverse proxies connected through loopback are trusted automatically; additional proxy networks are trusted only when `TRUST_PROXY` is enabled and their peers match `TRUSTED_PROXY_CIDRS`. Signed-in administrators see pending requests in the Classic **Access requests** jobs-bell tab and in the YTLive access bell. Requests remain pending until explicitly approved or rejected (a server restart or access-policy change clears the in-memory pending queue). Only one pending request or active temporary grant is allowed per observed IP. Rejected IPs are subject to a server-enforced 15-minute retry cooldown. Approval creates a persisted grant plus an HttpOnly, SameSite cookie bound to that grant, the client IP, expiration time, and the persistent access-policy revision. Active grants remain visible to administrators and can be revoked individually; revocation is enforced server-side immediately even if the client still holds an unexpired cookie. Temporary access permits normal application use but does **not** become an administrator session, so administrator-only routes remain protected. Active grants survive a normal server restart, while changing the access policy or admin password revokes them.

### Encryption master key
Sensitive settings are encrypted at rest with AES-256-GCM. By default Gharmonize creates `.gharmonize-key` under `DATA_DIR` with mode `0600`; packaged Electron keeps it in the existing profile directory when storage is moved. For production, keep the key separate from the database/configuration using either:

```dotenv
GHARMONIZE_MASTER_KEY=<32-byte key encoded as hex/base64>
# or
GHARMONIZE_MASTER_KEY_FILE=/secure/path/gharmonize.key
```

Preserve this key in backups. Encrypted settings cannot be recovered if it is lost.

For read-only/container deployments, the one-time initial credential file can be redirected to a writable protected volume:

```dotenv
GHARMONIZE_INITIAL_ADMIN_PASSWORD_FILE=/secure/runtime/INITIAL_ADMIN_PASSWORD.txt
```

---

## Cookies & yt-dlp Cookie Behavior

> For a full walkthrough of cookie behavior across local, desktop, and Docker installs, and age-restricted content requirements, see [COOKIES.md](COOKIES.md).

### `YT_STRIP_COOKIES`
Master switch that disables both `YTDLP_COOKIES` and `YTDLP_COOKIES_FROM_BROWSER` when set.

- `1` → disable all cookie-based usage
- `0` → allow cookie configuration below to take effect

```dotenv
YT_STRIP_COOKIES=0
```

### `YTDLP_COOKIES`
Path to `cookies.txt`. If empty, a default `cookies` directory may be used as a fallback. This keeps the YouTube/Gharmonize interface behavior consistent and allows downloading age-restricted (and similar) content.

```dotenv
YTDLP_COOKIES=./cookies/cookies.txt
YTDLP_COOKIES=/opt/gharmonize/cookies/cookies.txt
```

### `YTDLP_COOKIES_FROM_BROWSER`
If `cookies.txt` is not present in the cookies directory, and this variable is set, yt-dlp may try to import cookies from the specified browser. You must be logged into YouTube on the same server/machine where Gharmonize is installed (in a supported browser profile). This keeps the YouTube/Gharmonize interface behavior consistent and allows downloading age-restricted (and similar) content.

```dotenv
YTDLP_COOKIES_FROM_BROWSER=chrome
YTDLP_COOKIES_FROM_BROWSER=firefox
```

### `YT_UI_FORCE_COOKIES`
When `YT_STRIP_COOKIES=1` is enabled, this setting is used to keep YouTube lists consistent between YouTube and the Gharmonize UI. **This setting has no effect on downloads.** Requires `cookies.txt` or `YTDLP_COOKIES_FROM_BROWSER` to work.

```dotenv
YT_UI_FORCE_COOKIES=1   # enabled
YT_UI_FORCE_COOKIES=0   # disabled
```

---

## YouTube / yt-dlp Language & Region

### `YT_LANG`
Primary UI language (locale) to emulate for YouTube requests. Affects suggested content, subtitle/metadata language, and locale-based responses from YouTube. Leave empty to let YouTube decide automatically.

```dotenv
YT_LANG=en-US   # English (United States)
YT_LANG=de-DE   # German (Germany)
```

### `YT_FORCE_IPV4`
Forces requests to be made over IPv4 when enabled.

```dotenv
YT_FORCE_IPV4=1   # force IPv4
YT_FORCE_IPV4=0   # allow default behavior
```

### `YT_ACCEPT_LANGUAGE`
Exact value for the HTTP `Accept-Language` header. Like a browser, you can specify priorities with q-values. This influences which language YouTube prefers for content/subtitles.

```dotenv
YT_ACCEPT_LANGUAGE=en-US,en;q=0.9,fr;q=0.8
```

### `YT_DEFAULT_REGION`
Region / country code (ISO 3166-1 alpha-2) used for geolocation-related behavior. Passed to yt-dlp as `--geo-bypass-country=<code>`. Helps with region-locked videos, e.g. "pretend we are in US".

```dotenv
YT_DEFAULT_REGION=US
```

### `ENRICH_SPOTIFY_FOR_YT`
When converting YouTube videos, optionally enrich metadata using Spotify.

- `1` → enabled (pull extra info like genre, label, year, ISRC, etc. when possible)
- `0` → disabled (use YouTube + existing resolvers only)

```dotenv
ENRICH_SPOTIFY_FOR_YT=1
```

### `YT_403_WORKAROUNDS`
Toggle special handling for HTTP 403 Forbidden errors from YouTube.

- `0` → disabled
- `1` → enabled (recommended in many environments)

```dotenv
YT_403_WORKAROUNDS=1
```

### `YT_USE_MUSIC`
Controls whether downloads are made against `youtube.com` or `music.youtube.com`.

- `0` → normal youtube.com
- `1` → music.youtube.com (YouTube Music)

```dotenv
YT_USE_MUSIC=1
```

### `YTDLP_UA`
User-Agent string used by yt-dlp when talking to YouTube. A stable, commonly-used Chrome UA often works best.

```dotenv
YTDLP_UA=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36
```

---

## Media Tagging / FFmpeg

### Music matching tolerance
Spotify, Apple Music, Deezer, TIDAL and pasted-list matching share the same
YouTube identity and duration checks. Collaborator credits (`feat.`, `ft.`, commas
and `&`) and explicitly labelled original-project/soundtrack context are normalized
for matching only; musical versions such as live, acoustic, remix and numbered
versions remain distinct.

With strong title/artist evidence, the default duration tolerance is the larger
of **45 seconds** or **22%** of the source duration. Candidates must also be between
**65% and 145%** of the source length. Weaker text matches require a closer duration:
the larger of **12 seconds** or **6%**. This allows ordinary intro/outro and release
differences without matching a one-minute excerpt to a full song or compilation.
Existing `MAPPED_MUSIC_YT_DURATION_*` and `MAPPED_MUSIC_YT_TIGHT_DURATION_*`
environment overrides still take precedence. Failed searches are cached for only
30 seconds, so retrying later does not require restarting the application.

### `MP3_WRITE_XING`
MP3 duration and seek headers (Xing/Info) are enabled by default. This prevents
players from showing an estimated, incorrect duration for variable-bitrate files.
VBR conversions, ringtones, retagging and lyrics embedding always write this header.
The legacy value `0` disables it only for explicitly constant-bitrate conversions;
leaving this variable unset is recommended.

### `MEDIA_COMMENT`
Any text you place here will be written into the ID3 comment tag of generated files.

```dotenv
MEDIA_COMMENT=Created with Gharmonize
```

### `FFMPEG_BIN`
Path to the ffmpeg executable. If left empty, the app may attempt to find `ffmpeg` from `PATH` or use a downloaded binary if available. See [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md).

```dotenv
FFMPEG_BIN=/usr/local/bin/ffmpeg
FFMPEG_BIN=C:\ffmpeg\bin\ffmpeg.exe
```

### `GHARMONIZE_FFMPEG_CHANNEL`
Selects the BtbN channel used by the automatic FFmpeg manager. `stable` is the default and selects the newest compatible release-branch build. `master` is an unrestricted explicit opt-in to the latest development snapshot: it does **not** silently downgrade to an older stable build just because NVENC is unavailable. Settings displays a warning below the master selection: NVIDIA hardware encoding currently requires an API-13.1-compatible driver; software conversion remains available on incompatible devices. New candidates must still pass executable and software conversion checks, and a last-known-good pair is preserved for rollback. Switching channels takes effect on the next binary refresh or restart, even if the old channel's cache is still fresh.

```dotenv
GHARMONIZE_FFMPEG_CHANNEL=stable
```

---

## Leaving Binary Paths Empty (Auto-Managed)

If you want Gharmonize to use the auto-managed or manually downloaded copies, leave custom path variables empty:

```dotenv
FFMPEG_BIN=
FFPROBE_BIN=
MKVMERGE_BIN=
MKVPROPEDIT_BIN=
YTDLP_BIN=
DENO_BIN=
```

If you set these variables to explicit host paths, Gharmonize will prefer those paths instead. See [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md) for the full picture.


### Security and reverse proxy settings

```env
GHARMONIZE_HOST=127.0.0.1
TRUST_PROXY=0
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
GHARMONIZE_MASTER_KEY_FILE=/secure/path/gharmonize.key
GHARMONIZE_ALLOW_PRIVATE_URLS=0
GHARMONIZE_ALLOW_UNSAFE_YTDLP_ARGS=0
```

`GHARMONIZE_HOST` defaults to loopback. Docker explicitly sets `0.0.0.0`. A reverse proxy whose direct connection reaches Gharmonize from loopback (`127.0.0.0/8` or `::1`) is trusted automatically so the real client address can be derived safely from forwarded headers. Enable `TRUST_PROXY` only for additional proxy networks, and list those direct proxy peers in `TRUSTED_PROXY_CIDRS`. Direct LAN/WAN clients are never allowed to make their own forwarded headers trusted merely by setting them. Sensitive Settings values are encrypted at rest with AES-256-GCM using the Gharmonize master key. Keep the key separate from broadly accessible backups.
