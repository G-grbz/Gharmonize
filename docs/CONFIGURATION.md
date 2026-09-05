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
Root directory for all application data. If empty, defaults to `process.cwd()` (the app's working directory).

Typical structure:
- `DATA_DIR/outputs/` → exported / processed files
- `DATA_DIR/uploads/` → uploaded files / merged chunks
- `DATA_DIR/local-inputs/` → source directory for `/api/local-files` (if enabled)

```dotenv
DATA_DIR=/var/lib/gharmonize
DATA_DIR=/home/youruser/gharmonize-data
```

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
Sensitive settings are encrypted at rest with AES-256-GCM. By default Gharmonize creates `.gharmonize-key` under `DATA_DIR` with mode `0600`. For production, keep the key separate from the database/configuration using either:

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
Selects the BtbN channel used by the automatic FFmpeg manager. `stable` is the default and selects the newest release-branch build. `master` is available only as an explicit opt-in. New candidates are runtime-tested before activation and a last-known-good pair is preserved for rollback.

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
