<div align="center">

# <img width="128" height="128" alt="Gharmonize Logo" src="https://github.com/user-attachments/assets/adf9d2f8-a99b-43c8-9c37-d4a47f5b1e3f" />

# Gharmonize




https://github.com/user-attachments/assets/4083729e-3db9-4936-ac01-28c0f318aebe



### Download • Convert • Rip • Tag — with a Web UI + Desktop builds (AppImage/EXE)

Next-generation media processing, powered by yt-dlp, FFmpeg and deno.
Seamlessly download content from YouTube, YouTube Music, and major platforms like X, Facebook, Instagram, Vimeo, Dailymotion, and TikTok. Leverage Spotify, Apple Music, and Deezer for intelligent metadata matching and track discovery — then fetch high-quality media via yt-dlp. Includes DRM-free disc ripping, iPhone / Android ringtone output, and blazing-fast GPU-accelerated transcoding, all powered by a robust and reliable processing engine.

> **Spotify note:** Spotify is used for **metadata + matching** (track/playlist/album info). Gharmonize does **not** claim DRM bypass.

<img width="1666" height="899" alt="ss" src="https://github.com/user-attachments/assets/449c5f67-4240-4ca0-8da4-b2ca97a3b5bb" />

</div>

---

## Quick Start

### Local / Desktop (recommended)

For the most complete experience, prefer:

* `npm start`
* packaged **AppImage**
* packaged **EXE**

Docker is available as an **alternative deployment option**, but it does **not** currently provide full parity with local / desktop usage.

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize

BUILD_ELECTRON=1 npm i
npm start
```

Gharmonize now checks runtime binaries at startup and downloads or refreshes them automatically when needed. `npm run download:binaries` is still available if you want to prefetch binaries manually or prepare offline / portable builds.

### Docker Compose (alternative)

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize

sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cache,cookies,local-inputs}
sudo touch /opt/gharmonize/.env
sudo chmod -R a+rw /opt/gharmonize

# set at least ADMIN_PASSWORD and APP_SECRET in /opt/gharmonize/.env
docker compose pull
docker compose up -d
```

Open:

* `http://localhost:5174`

> `docker-compose.yml` uses `ggrbz/gharmonize:latest` by default. Switch it to `ggrbz/gharmonize:testing` if you want the test-stage image.

---

## What you get

* **YouTube / YouTube Music** downloads for single items, playlists, and mixes
* **X (Twitter) / Facebook / Instagram / Vimeo / Dailymotion / TikTok** download and conversion flows
* **Spotify, Apple Music, and Deezer** mapping for **track / playlist / album** workflows
* **Phone ringtone output** for **iPhone** and **Android** from supported download flows
* **Audio and video conversion** powered by **ffmpeg**
* **Fix A/V sync issues** using ready-made FPS presets for **AC3 / EAC3 / AAC**
* **GPU acceleration** for local video transcoding with **NVENC**, **VAAPI**, and **Intel QSV**
* **Disc ripping (DRM-free only)** with stream selection in the Web UI
* **Runtime binary management** for ffmpeg, ffprobe, mkvmerge, yt-dlp, and deno
* **Job engine** for batch processing, progress, and reliability

---

## Table of Contents

* [Overview](#overview)
* [Features](#features)
* [Requirements](#requirements)
* [Quick Start (Local)](#quick-start-local)
* [Quick Start (Docker Compose)](#quick-start-docker-compose)
* [Optional: NVIDIA / NVENC in Docker](#optional-nvidia--nvenc-in-docker)
* [Alternative Installation Using Docker Run](#alternative-installation-using-docker-run)
* [Binary Management](#binary-management)
* [Cookie and Runtime Notes](#cookie-and-runtime-notes)
* [Environment Variables (.env)](#environment-variables-env)
* [Gharmonize Homepage Widget](#gharmonize-homepage-widget)
* [Notes & Troubleshooting](#notes--troubleshooting)
* [License](#license)
* [Third-Party Licenses](#third-party-licenses)

---

## Overview

**Gharmonize** is a media automation toolkit running as a Node.js server with an optional Electron desktop shell.

It combines downloading, mapping, conversion, tagging, disc processing, and batch job management behind a single Web UI. On current builds, runtime tools such as **ffmpeg**, **ffprobe**, **mkvmerge**, **yt-dlp**, and **deno** can be checked, downloaded, and refreshed automatically at application startup, so manual setup is no longer required in the common case.

License details are available in **Third-Party Licenses** and `LICENSES.md`.

---

## Features

### Supported Sources

* **YouTube / YouTube Music**
* **Spotify**
* **Apple Music**
* **Deezer**
* **X (Twitter)**
* **Facebook**
* **Instagram**
* **Vimeo**
* **Dailymotion**
* **TikTok**

### Music Mapping and Collections

* Spotify, Apple Music, and Deezer support **track / playlist / album** workflows
* Automatic mapping from supported music-service items to YouTube / YouTube Music sources
* Optional preference for Spotify metadata during tagging

### Phone Ringtone Output

* Export ringtone-ready files for **iPhone** and **Android**
* Works with supported download flows, including collection-based music links where available
* **Automatic** mode picks the strongest section
* **Manual** mode lets you choose the start point
* iPhone output uses **`.m4r`** with up to **40 seconds**
* Android output uses **`.mp3`** with up to **60 seconds**

### Audio and Video Processing

* ffmpeg-based conversion with reliability-first defaults
* Convert to **mp3 / flac / wav / ogg / opus / m4a / alac / mp4 / mkv**
* Ready-made **FPS adjustment presets** for **AC3 / EAC3 / AAC** sync fixes
* Hardware acceleration for local video transcoding with **NVIDIA NVENC**, **VAAPI**, and **Intel Quick Sync (QSV)**

### Disc Ripping (DRM-free only)

* Rip non-DRM optical discs such as DVD / Blu-ray into audio or video files
* Uses ffmpeg and MKVToolNix under the hood
* Disc analysis and stream selection are available from the Web UI

### Deployment and Runtime

* Local Node.js and Electron desktop workflows are the primary full-featured usage path
* Docker image deployment with published `latest` and `testing` tags as an alternative setup
* Runtime settings panel and `.env` configuration
* Automatic runtime binary download / refresh with fallback to existing binaries

---

## Requirements

| Requirement | Version / Notes | Description |
| --- | --- | --- |
| Node.js | >= 20 | Required for local / Electron usage |
| Docker Engine + Docker Compose | Current | Required for Docker deployment |
| Internet access on first launch | Recommended | Lets Gharmonize fetch or refresh runtime binaries automatically |
| Spotify API Keys | Optional | Enables Spotify Web API based matching and metadata |

> If you set custom binary paths such as `FFMPEG_BIN`, `FFPROBE_BIN`, `MKVMERGE_BIN`, `YTDLP_BIN`, or `DENO_BIN`, Gharmonize will use those instead of the auto-managed copies.

---

## Quick Start (Docker Compose)

Docker deployment is provided as an alternative setup. If you want the most complete feature set, prefer `npm start` or the packaged AppImage / EXE builds instead.

### 1. Clone the repository

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize
```

### 2. Prepare folders and files

The commands below use `/opt/gharmonize`. If you prefer another location, update both the shell commands and the bind mounts in `docker-compose.yml`.

```bash
sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cache,cookies,local-inputs}
sudo touch /opt/gharmonize/.env
sudo chmod -R a+rw /opt/gharmonize
```

### 3. Configure `.env`

Set at least `ADMIN_PASSWORD` and `APP_SECRET` inside `/opt/gharmonize/.env`.

Generate a random `APP_SECRET` with:

```bash
openssl rand -hex 32
```

### 4. Choose the Docker image tag

The default compose file uses:

```yaml
image: ggrbz/gharmonize:latest
```

Available tags:

* `ggrbz/gharmonize:latest` for the regular published image
* `ggrbz/gharmonize:testing` for the test-stage image

### 5. Start the stack

```bash
docker compose pull
docker compose up -d
```

### 6. Open the UI

[http://localhost:5174](http://localhost:5174)

### 7. Runtime binaries in Docker

The provided `docker-compose.yml` enables runtime binary management inside the container:

* Gharmonize checks binaries automatically when the app starts
* Missing or outdated tools can be downloaded / refreshed automatically
* Downloaded runtime binaries are cached under `/opt/gharmonize/cache`

If a refresh fails, Gharmonize keeps the currently resolved binaries as fallback instead of hard-failing the whole app.

---

## Optional: NVIDIA / NVENC in Docker

If you want NVENC inside Docker, install the NVIDIA driver and NVIDIA Container Toolkit on the host first.

Then update `docker-compose.yml`:

* Comment out or remove `user: "${PUID:-1000}:${PGID:-1000}"`
* Enable `user: "0:0"`
* Enable `privileged: true`
* Enable `runtime: nvidia`
* Enable `NVIDIA_VISIBLE_DEVICES=all`
* Enable `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`

Relevant compose section:

```yaml
services:
  web:
    image: ggrbz/gharmonize:latest
    container_name: Gharmonize
    user: "0:0"
    privileged: true
    runtime: nvidia
    group_add:
      - "${RUN_MEDIA_GID:-65534}"
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
      - NODE_ENV=production
      - PORT=${PORT:-5174}
      - YTDLP_EXTRA=--force-ipv4
      - GHARMONIZE_WEB_BINARIES_IN_DOCKER=1
      - GHARMONIZE_WEB_CACHE_DIR=/usr/src/app/cache/binaries
      - PUID=${PUID:-1000}
      - PGID=${PGID:-1000}
      - DATA_DIR=/usr/src/app
      - OUTPUTS_DISPLAY_DIR=/opt/gharmonize/outputs
```

After the edit:

```bash
docker compose up -d
```

On some hosts, NVENC inside Docker only works reliably when the container runs with the root user plus the enabled `privileged` and `runtime: nvidia` settings above.

---

## Alternative Installation Using Docker Run

### 1. Prepare folders and files

```bash
sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cache,cookies,local-inputs}
sudo touch /opt/gharmonize/.env
sudo chmod -R a+rw /opt/gharmonize
```

### 2. Run the container

```bash
docker run -d \
  --name Gharmonize \
  --restart unless-stopped \
  --user 1000:1000 \
  --group-add 65534 \
  -p 5174:5174 \
  -e NODE_ENV=production \
  -e PORT=5174 \
  -e YTDLP_EXTRA=--force-ipv4 \
  -e GHARMONIZE_WEB_BINARIES_IN_DOCKER=1 \
  -e GHARMONIZE_WEB_CACHE_DIR=/usr/src/app/cache/binaries \
  -e PUID=1000 \
  -e PGID=1000 \
  -e DATA_DIR=/usr/src/app \
  -e OUTPUTS_DISPLAY_DIR=/opt/gharmonize/outputs \
  -v /opt/gharmonize/uploads:/usr/src/app/uploads \
  -v /opt/gharmonize/outputs:/usr/src/app/outputs \
  -v /opt/gharmonize/temp:/usr/src/app/temp \
  -v /opt/gharmonize/cache:/usr/src/app/cache \
  -v /opt/gharmonize/local-inputs:/usr/src/app/local-inputs \
  -v /opt/gharmonize/cookies:/usr/src/app/cookies \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

To use the test-stage image, replace the final image reference with `ggrbz/gharmonize:testing`.

### 3. NVIDIA / NVENC variant

For NVIDIA, do **not** keep the non-root `--user 1000:1000` setting. Use the container as root and enable NVIDIA runtime access:

```bash
docker run -d \
  --name Gharmonize \
  --restart unless-stopped \
  --user 0:0 \
  --privileged \
  --runtime=nvidia \
  -p 5174:5174 \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
  -e NODE_ENV=production \
  -e PORT=5174 \
  -e YTDLP_EXTRA=--force-ipv4 \
  -e GHARMONIZE_WEB_BINARIES_IN_DOCKER=1 \
  -e GHARMONIZE_WEB_CACHE_DIR=/usr/src/app/cache/binaries \
  -e PUID=1000 \
  -e PGID=1000 \
  -e DATA_DIR=/usr/src/app \
  -e OUTPUTS_DISPLAY_DIR=/opt/gharmonize/outputs \
  -v /opt/gharmonize/uploads:/usr/src/app/uploads \
  -v /opt/gharmonize/outputs:/usr/src/app/outputs \
  -v /opt/gharmonize/temp:/usr/src/app/temp \
  -v /opt/gharmonize/cache:/usr/src/app/cache \
  -v /opt/gharmonize/local-inputs:/usr/src/app/local-inputs \
  -v /opt/gharmonize/cookies:/usr/src/app/cookies \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

> Do not forget to set `ADMIN_PASSWORD` and `APP_SECRET` in `/opt/gharmonize/.env`.

---

## Quick Start (Local)

### 1. Clone the repository

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize
```

### 2. Create or edit `.env`

To use the UI configuration flow, set `ADMIN_PASSWORD` and `APP_SECRET`.

Generate `APP_SECRET` with:

```bash
openssl rand -hex 32
```

### 3. Install dependencies

**Linux**

```bash
BUILD_ELECTRON=1 npm i
```

**Windows (CMD)**

```cmd
set BUILD_ELECTRON=1
npm i
```

### 4. Start the application

```bash
npm start
```

On current builds, Gharmonize checks runtime binaries at startup and downloads or updates them automatically when needed.

### Default `.env` locations for packaged desktop builds

These paths are used only by AppImage / `.exe` builds when the app creates its default environment file:

* **Windows:** `%appdata%\Gharmonize`
* **Linux:** `~/.config/Gharmonize/`
* **Default Password:** `123456`

You can edit environment variables later from the Settings panel.

### Build commands

**AppImage (Linux only)**

```bash
npm run desktop:build:appimage
```

**NSIS installer (Windows)**

```bash
npm run desktop:build:nsis
```

**Portable Windows build**

```bash
npm run desktop:build:portable
```

**Build both Windows variants**

```bash
npm run desktop:build:all
```

> If you install the Windows build under `Program Files`, you may need to create `temp`, `outputs`, and `uploads` directories manually and grant write permissions.

---

## Binary Management

Gharmonize now supports two binary workflows.

### Automatic runtime management

* Default behavior outside Docker, unless you explicitly disable it
* Enabled in the provided Docker deployment through `GHARMONIZE_WEB_BINARIES_IN_DOCKER=1`
* Checks and refreshes **ffmpeg**, **ffprobe**, **mkvmerge**, **yt-dlp**, and **deno** at startup
* Keeps the current resolved binaries as fallback if a refresh fails

### Optional manual prefetch

If you still want to download the toolchain into `build/bin/` manually, you can use:

```bash
npm run download:binaries
```

This is useful if you want to:

* prefill `build/bin/` yourself
* prepare a more offline-friendly local / desktop setup
* bundle a known toolset before creating a packaged desktop build

If you want Gharmonize to use the auto-managed or manually downloaded copies, leave custom path variables empty:

```dotenv
FFMPEG_BIN=
FFPROBE_BIN=
MKVMERGE_BIN=
MKVPROPEDIT_BIN=
YTDLP_BIN=
DENO_BIN=
```

If you set those variables to explicit host paths, Gharmonize will prefer those paths instead.

---

## Cookie and Runtime Notes

### Cookie behavior

Cookie support improves matching accuracy and helps with age-restricted or similar content.

* **Docker:** browser cookie extraction is not available inside the container; use `cookies.txt` if needed
* **Local / desktop:** browser cookie extraction is available when supported on the host platform
* **Windows:** Chrome cookie extraction may fail while the browser is running; Firefox or another supported browser is usually safer

### Age-restricted YouTube content

To download age-restricted content you need:

* cookies (browser extraction or `cookies.txt`)
* `deno`

In current builds, `deno` is usually handled automatically by the runtime binary manager. If you disable auto-management or force custom binary paths, make sure `DENO_BIN` resolves correctly.

### Environment comparison

| Environment | Browser cookie extraction | `cookies.txt` | Binary management |
| --- | --- | --- | --- |
| Docker | No | Optional | Auto-managed in the provided compose / run setup |
| Local (Node.js) | Yes | Optional | Auto-managed by default |
| AppImage / EXE | Yes | Optional | Auto-managed by default |
| Manual / custom binaries | Depends on your setup | Optional | Use `*_BIN` env vars or `npm run download:binaries` |

---

## Environment Variables (.env)

Create a `.env` file in the project root:

```dotenv
########################################
# Preview / Fetch Limits
########################################

PREVIEW_MAX_ENTRIES=
# Maximum number of entries shown in Automix / playlist preview.
# Higher value → more entries → more processing time.
# Acts as a safety limit in case YouTube returns extremely long lists.
# Example:
#   PREVIEW_MAX_ENTRIES=1000


AUTOMIX_ALL_TIMEOUT_MS=
# Timeout (in ms) for fetching the entire Automix list in a single request.
# If this timeout is hit, the system falls back to paginated mode.
# Example:
#   AUTOMIX_ALL_TIMEOUT_MS=45000


AUTOMIX_PAGE_TIMEOUT_MS=
# Timeout (in ms) for each paginated Automix request (e.g., 50 items per page).
# Used when flat/one-shot mode times out.
# Example:
#   AUTOMIX_PAGE_TIMEOUT_MS=45000


PLAYLIST_ALL_TIMEOUT_MS=
# Timeout (in ms) for fetching a full playlist using --flat-playlist.
# Large playlists or slow YouTube may cause a fallback to page mode.
# Example:
#   PLAYLIST_ALL_TIMEOUT_MS=35000


PLAYLIST_PAGE_TIMEOUT_MS=
# Timeout (in ms) for each paginated playlist fetch (e.g., 50 items per page).
# Example:
#   PLAYLIST_PAGE_TIMEOUT_MS=25000


PLAYLIST_META_TIMEOUT_MS=
# Timeout (in ms) for fetching playlist metadata (title, total item count, etc.).
# Example:
#   PLAYLIST_META_TIMEOUT_MS=30000


PLAYLIST_META_FALLBACK_TIMEOUT_MS=
# Timeout (in ms) for the fallback metadata attempt
# (e.g., "if full metadata fails, try using only the first item").
# Example:
#   PLAYLIST_META_FALLBACK_TIMEOUT_MS=20000


########################################
# yt-dlp Binary & Download Behavior
########################################

YTDLP_BIN=
# Absolute path to the yt-dlp executable.
# If left empty, the app may try to resolve it from PATH or built-in locations.
# Examples:
#   YTDLP_BIN=/usr/local/bin/yt-dlp
#   YTDLP_BIN=C:\\tools\\yt-dlp.exe


YTDLP_EXTRA=
# Extra yt-dlp arguments applied to all audio downloads
# (downloadSelectedIds, downloadSelectedIdsParallel, downloadStandard in audio mode).
# Space-separated string; each token becomes an argument.
# Example:
#   YTDLP_EXTRA=--some-yt-dlp-flag --another-flag=1


YTDLP_ARGS_EXTRA=
# Alternative name used when YTDLP_EXTRA is not defined.
# Priority order:
#   1) YTDLP_EXTRA
#   2) YTDLP_ARGS_EXTRA
#   3) no extra args
# Example:
#   YTDLP_ARGS_EXTRA=--some-yt-dlp-flag --another-flag=1


YTDLP_AUDIO_LIMIT_RATE=
# Rate limit for single-video audio downloads (not playlist mode).
# Passed as --limit-rate to yt-dlp.
# Examples:
#   YTDLP_AUDIO_LIMIT_RATE=500K
#   YTDLP_AUDIO_LIMIT_RATE=1M
#   YTDLP_AUDIO_LIMIT_RATE=2M


########################################
# Preview Cache
########################################

PREVIEW_CACHE_TTL_MS=
# Time-to-live (in ms) for playlist/automix preview results stored in memory.
# After this duration:
#   - getCache(url) treats the entry as expired,
#   - the record is removed,
#   - metadata/preview is fetched again.
# Example (30 minutes):
#   PREVIEW_CACHE_TTL_MS=1800000


########################################
# Upload Limits
########################################

UPLOAD_MAX_BYTES=
# Maximum allowed upload file size.
# Supported formats:
#   - pure number → treated as bytes          (e.g., 104857600)
#   - "<number>mb" → number * 1024 * 1024    (e.g., 100mb → ~104 MB)
# Used by multer as limits.fileSize.
# If invalid, the app logs a warning and falls back to ~1000 MB.
# Examples:
#   UPLOAD_MAX_BYTES=104857600
#   UPLOAD_MAX_BYTES=100mb


########################################
# Data Directories
########################################

DATA_DIR=
# Root directory for all application data.
# Typical structure:
#   DATA_DIR/outputs/       → exported / processed files
#   DATA_DIR/uploads/       → uploaded files / merged chunks
#   DATA_DIR/local-inputs/  → source directory for /api/local-files (if enabled)
# If empty, defaults to process.cwd() (the app’s working directory).
# Examples:
#   DATA_DIR=/var/lib/gharmonize
#   DATA_DIR=/home/youruser/gharmonize-data


LOCAL_INPUT_DIR=
# Relative directory under DATA_DIR for local file browsing.
# Resolved as: path.resolve(DATA_DIR || process.cwd(), LOCAL_INPUT_DIR)
# Used by:
#   - /api/local-files → recursively lists supported media
#   - /api/probe/local → only accepts files under this directory (security check)
# Default (when empty) is usually "local-inputs".
# Examples:
#   LOCAL_INPUT_DIR=local-inputs
#   LOCAL_INPUT_DIR=my-local-media


########################################
# Spotify API
########################################

SPOTIFY_CLIENT_ID=
# Spotify Web API client ID.
# Obtain from Spotify Developer Dashboard.
# Used when requesting access tokens.
# ❗ Do NOT commit real credentials to public repositories.


SPOTIFY_CLIENT_SECRET=
# Spotify Web API client secret.
# Used together with SPOTIFY_CLIENT_ID to obtain access tokens.
# ❗ Keep this secret. Never expose in logs, frontend, or public repos.


SPOTIFY_MARKET=
# Default market (country code) for Spotify API requests.
# Affects which tracks/albums are considered available.
# Examples:
#   SPOTIFY_MARKET=US
#   SPOTIFY_MARKET=FR
#   SPOTIFY_MARKET=DE


SPOTIFY_FALLBACK_MARKETS=
# Comma-separated list of fallback markets.
# Logic example:
#   - Try SPOTIFY_MARKET first
#   - If not available there, try these markets in order.
# Examples:
#   SPOTIFY_FALLBACK_MARKETS=US,GB,DE,FR


SPOTIFY_DEBUG_MARKET=
# Enable extra debug logging related to market selection and fallbacks.
#   1 → verbose logs (good for development)
#   0 → quiet (recommended for production)
# Example:
#   SPOTIFY_DEBUG_MARKET=1


PREFER_SPOTIFY_TAGS=
# When writing tags (ID3, etc.), prefer metadata coming from Spotify.
# Behavior:
#   1 → If both YouTube and Spotify metadata exist, favor Spotify’s cleaner data.
#   0 → Favor YouTube (or other resolvers).
# Example:
#   PREFER_SPOTIFY_TAGS=1

YT_SEARCH_RESULTS=
# Number of yt-dlp search results to fetch per query (ytsearchN).
# Lower = faster mapping, but slightly higher risk of a wrong match.
# Recommended: 2 (fast) / 3 (safer).

YT_SEARCH_TIMEOUT_MS=
# Per-search timeout in milliseconds for the mapping/search step.
# If a search hangs or YouTube is slow, it will abort after this time.
# Lower = snappier UI, but may cause more "not found" on slow networks.

YT_SEARCH_STAGGER_MS=
# Stagger delay (ms) applied when starting parallel searches.
# Helps avoid burst/throttle behavior by spacing out requests across concurrency slots.
# Lower = faster burst; higher = smoother and often fewer throttles/timeouts.
# Set to 0 to disable staggering.


########################################
# Title Cleaning
########################################

TITLE_CLEAN_PIPE=
# If set to 1, when a title contains the '|' character,
# the part AFTER the last '|' is kept.
# Example:
#   "Artist Name | Official Video" → "Official Video"
# This is applied before other CLEAN_* rules.
# Example:
#   TITLE_CLEAN_PIPE=1


CLEAN_SUFFIXES=
# Comma-separated list of suffix tokens to remove from the END of titles.
# Examples of matches:
#   "Song Name (Official)" → suffix "Official"
#   "Artist - Track (Topic)" → suffix "Topic"
# Example:
#   CLEAN_SUFFIXES=topic,official


CLEAN_PHRASES=
# Phrases to completely remove when they appear in title text.
# Typical usage:
#   "Song Name (Official Video)"     → remove "Official Video"
#   "Artist - Track [official channel]" → remove "official channel"
# Example:
#   CLEAN_PHRASES="official channel,Official Video"


CLEAN_PARENS=
# Words that, when found inside parentheses, cause that whole "(...)" segment to be removed.
# Examples:
#   "Song Name (official)" → remove "(official)"
#   "Song Name (topic)"    → remove "(topic)"
# Example:
#   CLEAN_PARENS=official,topic


########################################
# Authentication & App Secret
########################################

ADMIN_PASSWORD=
# Password for admin panel / protected endpoints.
# Keep this out of logs and public repositories.
# For production, use a long, random, strong password.
# Example:
#   ADMIN_PASSWORD=change_this_in_production


APP_SECRET=
# Global secret key for the application.
# May be used for JWT signing, session cookies, CSRF tokens, etc.
# Must be long, random, and kept private.
# Example (DO NOT reuse this exact string):
#   APP_SECRET=your_super_long_random_hex_or_base64_value


########################################
# Cookies & yt-dlp Cookie Behavior
########################################

YT_STRIP_COOKIES=
# Master switch that disables both YTDLP_COOKIES and YTDLP_COOKIES_FROM_BROWSER when set.
# Typical behavior:
#   1 → disable all cookie-based usage
#   0 → allow cookie configuration below to take effect
# Example:
#   YT_STRIP_COOKIES=0


YTDLP_COOKIES=
# Path to cookies.txt.
# If empty, a default "cookies" directory may be used as fallback.
# This is to keep the YouTube/Gharmonize interface behavior consistent and to allow downloading age-restricted (and similar) content.
# Examples:
#   YTDLP_COOKIES=./cookies/cookies.txt
#   YTDLP_COOKIES=/opt/gharmonize/cookies/cookies.txt


YTDLP_COOKIES_FROM_BROWSER=
# If cookies.txt is not present in the cookies directory,
# and this variable is set, yt-dlp may try to import cookies from the specified browser.
# You must be logged into YouTube on the same server/machine where Gharmonize is installed (in a supported browser profile).
# This is to keep the YouTube/Gharmonize interface behavior consistent and to allow downloading age-restricted (and similar) content.
# Examples:
#   YTDLP_COOKIES_FROM_BROWSER=chrome
#   YTDLP_COOKIES_FROM_BROWSER=firefox

YT_UI_FORCE_COOKIES=
# When YT_STRIP_COOKIES=1 is enabled, this setting is used to keep YouTube lists consistent between YouTube and the Gharmonize UI.
# This setting has no effect on downloads.
# Requires cookies.txt or YTDLP_COOKIES_FROM_BROWSER to work.
#
# Example usage:
#   YT_UI_FORCE_COOKIES=1  # enabled
#   YT_UI_FORCE_COOKIES=0  # disabled

########################################
# YouTube / yt-dlp Language & Region
########################################

YT_LANG=
# Primary UI language (locale) to emulate for YouTube requests.
# This affects:
#   • Suggested content
#   • Subtitle/metadata language
#   • Locale-based responses from YouTube
# Leave empty to let YouTube decide automatically.
# Example usage:
#   YT_LANG=en-US   # English (United States)
#   YT_LANG=de-DE   # German (Germany)


YT_FORCE_IPV4=
# Forces requests to be made over IPv4 when enabled.
# Example:
#   YT_FORCE_IPV4=1   # force IPv4
#   YT_FORCE_IPV4=0   # allow default behavior


YT_ACCEPT_LANGUAGE=
# Exact value for the HTTP "Accept-Language" header.
# Like a browser, you can specify priorities with q-values.
# This influences which language YouTube prefers for content/subtitles.
# Example:
#   YT_ACCEPT_LANGUAGE=en-US,en;q=0.9,fr;q=0.8


YT_DEFAULT_REGION=
# Region / country code (ISO 3166-1 alpha-2) used for geolocation-related behavior.
# Passed to yt-dlp as:
#   --geo-bypass-country=<code>
# Helps with region-locked videos, e.g. "pretend we are in US".
# Example:
#   YT_DEFAULT_REGION=US


ENRICH_SPOTIFY_FOR_YT=
# When converting YouTube videos, optionally enrich metadata using Spotify:
#   1 → enabled (pull extra info like genre, label, year, ISRC, etc. when possible)
#   0 → disabled (use YouTube + existing resolvers only)
# Example:
#   ENRICH_SPOTIFY_FOR_YT=1


YT_403_WORKAROUNDS=
# Toggle special handling for HTTP 403 Forbidden errors from YouTube.
#   0 = disabled
#   1 = enabled (recommended in many environments)
# Example:
#   YT_403_WORKAROUNDS=1


YT_USE_MUSIC=
# Controls whether downloads are made against youtube.com or music.youtube.com.
#   0 → normal youtube.com
#   1 → music.youtube.com (YouTube Music)
# Example:
#   YT_USE_MUSIC=1


YTDLP_UA=
# User-Agent string used by yt-dlp when talking to YouTube.
# A stable, commonly-used Chrome UA often works best.
# Example:
#   YTDLP_UA=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36


########################################
# Media Tagging / FFmpeg
########################################

MEDIA_COMMENT=
# Any text you place here will be written into the ID3 comment tag of generated files.
# Example:
#   MEDIA_COMMENT=Created with Gharmonize


FFMPEG_BIN=
# Path to the ffmpeg executable.
# If left empty, the app may attempt to find "ffmpeg" from PATH
# or use a downloaded binary if available.
# Examples:
#   FFMPEG_BIN=/usr/local/bin/ffmpeg
#   FFMPEG_BIN=C:\\ffmpeg\\bin\\ffmpeg.exe

```
---

# Gharmonize Homepage Widget

Add Gharmonize as a widget to your Homepage dashboard.

## Requirements

* Homepage ([https://gethomepage.dev](https://gethomepage.dev))
* Gharmonize running instance

## Generate Widget Key

Open Gharmonize settings panel and generate a `HOMEPAGE_WIDGET_KEY`.

## Example Configuration

Add this to your `services.yaml` (or any Homepage service config file):

```yaml
- Gharmonize:
    icon: http://ip:port/src/logo.png
    href: http://ip:port/
    description: Jobs / Queue
    widget:
      type: customapi
      url: http://ip:port/api/homepage
      method: GET
      refreshInterval: 1000
      display: block
      headers:
        X-Widget-Key: YOUR_HOMEPAGE_WIDGET_KEY
        X-Lang: en
      mappings:
        - label: Active
          field: activeCount
          format: number
        - label: Queue
          field: queueCount
          format: number
        - label: Progress
          field: currentProgressText
          format: text
        - label: Completed
          field: completedCount
          format: number
        - label: Processing
          field: processingCount
          format: number
        - label: Error
          field: errorCount
          format: number
        - label: Now
          field: currentPhaseText
          format: text
        - label: Job ID
          field: currentId
          format: text
        - label: Updated
          field: ts
          format: relativeDate
          locale: en
          style: short
          numeric: auto
        - label: Time
          field: ts
          format: date
```

## Supported Languages

`X-Lang` supports: `en`, `de`, `fr`, `tr`.

## Available Fields

You can freely choose which fields you want to display. Simply add or remove mappings based on your needs.

| Field               | Description                            |
| ------------------- | -------------------------------------- |
| activeCount         | Number of currently active jobs        |
| queueCount          | Number of jobs waiting in queue        |
| currentProgressText | Current job progress graph             |
| completedCount      | Total completed jobs                   |
| processingCount     | Jobs currently being processed         |
| errorCount          | Jobs failed with error                 |
| currentPhaseText    | Current processing phase               |
| currentId           | Currently running Job ID               |
| ts                  | Last update timestamp                  |

## API Endpoint

`/api/homepage` returns real‑time job and queue status for Homepage widgets.

---


## Notes & Troubleshooting

* **yt-dlp not found** → Install yt-dlp or use Docker image.
* **403 / SABR issues** → Adjust flags like `--http-chunk-size`, use cookies if needed.
* **Spotify personalized Mix not supported** → Copy items to a normal playlist.
* **Uploads limit** → 100MB max (configurable in `app.js`).

---

## License

# PolyForm Noncommercial License 1.0.0

Copyright (c) 2026 G-grbz

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to use, copy, modify, and distribute the Software for noncommercial purposes only.

The Software may not be used for any commercial purpose, including but not limited to providing paid services, selling, sublicensing, or embedding in commercial products, without prior written permission from the copyright holder.

Redistribution must retain this license and attribution to the original author.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## ✔ Redistribution Rules (Important)

If you redistribute this project (modified or unmodified):

1. It **must** be done as a **public GitHub fork**.
   → Direct copy → new repo açmak → yayınlamak **yasaktır**.

2. You **must credit the original author:**
   **“Based on work by G-grbz”**

3. You **must include a link to the original repository:**
   **[https://github.com/G-grbz/Gharmonize](https://github.com/G-grbz/Gharmonize)**

4. You **must clearly indicate modifications:**
   **“Modified by XYZ”**

5. You **must obtain *written permission* from the original author (G-grbz) for:**

   * Any commercial usage
   * Any redistribution outside of a GitHub fork
   * Any re-branding or re-publication under a new project name

These conditions **cannot be removed, overridden, or ignored**.

---

## ⚠ Disclaimer

This software is provided “as is”, without warranty of any kind.
Use it at your own risk.

---

## Third-Party Licenses

Gharmonize bundles several third-party command-line tools in its desktop and Docker builds:

* **FFmpeg / FFprobe**
* **MKVToolNix** tools:

  * `mkvmerge`
  * `mkvextract`
  * `mkvinfo`
  * `mkvpropedit`
* **yt-dlp**
* **deno**

These tools are *not* licensed under MIT. They keep their original licenses:

* FFmpeg / FFprobe → GNU GPL/LGPL (depending on the specific build)
* MKVToolNix tools → GNU General Public License v2 (GPLv2)
* yt-dlp → The Unlicense (public domain)
* deno → MIT License

Detailed license texts are included in the distributed builds under:

* `build/licenses/FFmpeg-LICENSE.txt`
* `build/licenses/MKVToolNix-GPLv2.txt`
* `build/licenses/yt-dlp-Unlicense.txt`
* `build/licenses/Deno-LICENSE.txt`
