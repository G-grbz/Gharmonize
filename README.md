<div align="center">

# <img width="128" height="128" alt="Gharmonize Logo" src="https://github.com/user-attachments/assets/adf9d2f8-a99b-43c8-9c37-d4a47f5b1e3f" />

# Gharmonize



https://github.com/user-attachments/assets/94f23b28-afae-4d42-ada4-783ecfb321dc



### Download • Convert • Rip • Tag — with a Web UI + Desktop builds (AppImage/EXE)

Fast, modular media processing powered by yt-dlp and ffmpeg: downloads from YouTube/YouTube Music and supported platforms (X, Facebook, Instagram, Vimeo, Dailymotion, TikTok), Spotify-based metadata matching, DRM-free disc ripping, and GPU-accelerated conversions — all driven by a reliable job engine.

> **Spotify note:** Spotify is used for **metadata + matching** (track/playlist/album info). Gharmonize does **not** claim DRM bypass.

<img width="1666" height="899" alt="ss" src="https://github.com/user-attachments/assets/449c5f67-4240-4ca0-8da4-b2ca97a3b5bb" />

</div>

---

## ⚡ Quick Start

### Docker Compose (recommended)

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize

# prepare folders (default: /opt/gharmonize)
sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cookies,local-inputs}
sudo touch /opt/gharmonize/.env /opt/gharmonize/cookies/cookies.txt
sudo chmod -R a+rw /opt/gharmonize

# set at least ADMIN_PASSWORD + APP_SECRET in /opt/gharmonize/.env
# start
docker compose up -d --build
```

Open:

* `http://localhost:5174`

### Local (Node & npm)

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize

# Linux
BUILD_ELECTRON=1 npm i
npm start
```

---

## ✅ What you get (at a glance)

* **YouTube / YouTube Music** downloads (single, playlist, mixes) via **yt-dlp**
* **X (Twitter) / Facebook / Instagram / Vimeo / Dailymotion / TikTok** support (download/convert flows)
* **Spotify integration** for metadata + mapping to YouTube (track / playlist / album)
* **Audio & video conversion** powered by **ffmpeg**, with reliability-first presets
* **Fix A/V sync issues** using **FPS adjustment presets** for **AC3 / EAC3 / AAC**
* **GPU acceleration** for local video transcoding: **NVENC**, **VAAPI**, **Intel QSV**
* **Disc ripping (DRM-free only)** using ffmpeg + MKVToolNix, with stream selection in Web UI
* **Job engine** for batch processing, progress, and reliability

---

## 📘 Table of Contents

* [Overview](#overview)
* [Features](#features)
* [Requirements](#requirements)
* [Quick Start (Local – Node & npm)](#quick-start-local--node--npm)
* [Quick Start (Docker Compose)](#quick-start-docker-compose)
* [Docker vs Local Usage Notes](#docker-vs-local-usage-notes)
* [Environment Variables (.env)](#environment-variables-env)
* [Gharmonize Homepage Widget](#gharmonize-homepage-widget)
* [Notes & Troubleshooting](#notes--troubleshooting)
* [License](#license)
* [Third-Party Licenses](#third-party-licenses)

---

## Overview

**Gharmonize** is a media automation toolkit running as a Node.js server with an optional Electron desktop shell.
It bundles multiple third‑party utilities (FFmpeg, MKVToolNix, yt-dlp, deno etc.) to provide:

* High‑reliability downloading
* Disc/media processing
* Transcoding with GPU acceleration
* Smart metadata extraction and automatic tagging

License details are available in **Third-Party Licenses** and `LICENSES.md`.

---

## Features

### *YouTube & YouTube Music*

* yt-dlp integration with SABR / 403 workarounds
* Support for single videos, playlists, and mixes
* Customizable yt-dlp arguments via environment variables

### *Social Platforms*

* Support for:

  * **X (Twitter)**
  * **Facebook**
  * **Instagram**
  * **Vimeo**
  * **Dailymotion**
  * **TikTok**

### *Spotify Integration*

* Spotify Web API support (track / playlist / album)
* Automatic mapping from Spotify items to YouTube
* Optional preference for Spotify metadata when tagging

### *Disc Ripping (DRM-free only)*

* Rip non-DRM optical discs (e.g., DVD/Blu-ray) into audio/video files
* Uses ffmpeg and MKVToolNix tools under the hood
* Disc analysis and stream selection via the web UI

### *Audio & Video Conversion*

* ffmpeg-based conversion with focus on reliability
* Convert to **mp3 / flac / wav / ogg**, or pass through **mp4** without re-encoding when possible
* Ready-made **FPS adjustment presets** for **AC3 / EAC3 / AAC** audio to fix or prevent sync issues
* Transcode arbitrary local video files with hardware acceleration:

  * **NVIDIA NVENC**
  * **VAAPI**
  * **Intel Quick Sync (QSV)**

* **Local & Uploaded Media**

  * File uploads handled via **Multer**
  * Optional local media directory (`LOCAL_INPUT_DIR`) for selecting files without uploading
  * Admin-only access for local inputs

* **Deployment & Config**

  * Docker image & Docker Compose setup
  * Settings API for runtime configuration from the UI
  * Electron builds for Windows/Linux
  * `.env`-driven configuration for server, YouTube, Spotify and processing behavior

---

## Requirements

| Requirement      | Version  | Description              |
| ---------------- | -------- | ------------------------ |
| Node.js          | >= 20    | Required                 |
| ffmpeg           | Any      | Included in Docker       |
| yt-dlp           | Latest   | Included in Docker       |
| Spotify API Keys | Optional | Enables Spotify metadata |

---

## Quick Start (Local – Node & npm)

#### 1. Clone the Repository and Enter the Directory

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize
```

#### 2. Create the .env File

To enable UI configuration, fill in `ADMIN_PASSWORD` and `APP_SECRET`. You can generate a secure `APP_SECRET` using the following command:

```bash
openssl rand -hex 32
```

---

### 3. Installation Commands

**Linux**

```bash
BUILD_ELECTRON=1 npm i
```

**Windows (CMD)**

```cmd
set BUILD_ELECTRON=1
npm i
```

---

### Default .env Locations (AppImage or .exe only)

These paths are **not** general application directories. They are created automatically only when running AppImage or Windows .exe builds, and store the default-generated `.env` file:

* **Windows:** `%appdata%\Gharmonize`
* **Linux:** `~/.config/Gharmonize/`
* **Default Password:** `123456`

You can edit environment variables in the Settings panel. Windows users should add the file paths for ffmpeg and yt-dlp to their environment variables.

---

### Run Without Building

To run the application without building:

> **Optional:** If you do **not** want to use ffmpeg, ffprobe, yt-dlp, and mkvmerge tools from your host system — or if you prefer using the tested, verified versions — you can run:
>
> ```bash
> npm run download:binaries
> ```
>
> This command downloads the required third‑party binaries into the app directory so the application can use them internally.
>
> **Note:** While this step is *optional* when using **Run Without Building** (`npm start`), it is **strongly recommended for AppImage and Windows .exe builds** to ensure consistent, validated binary versions.
>
> **Important:** If you use `npm run download:binaries`, you must **remove or clear** any manually set binary paths in your `.env` file (`FFMPEG_PATH`, `FFPROBE_PATH`, `YTDLP_PATH`, etc.). Otherwise, the app will try to use the system tools instead of the downloaded ones.

```bash
npm start
```

---

### Build Commands

**Build AppImage (Linux only):**

```bash
npm run desktop:build:appimage
```

**Build NSIS (Windows Installer):**

```bash
npm run desktop:build:nsis
```

> **Note:** If you choose *Install for all users* (which installs under *Program Files*), you must manually create the `temp`, `outputs`, and `uploads` folders inside the installation directory and grant read/write permissions.
>
> Alternatively, install to a custom directory outside *Program Files* or *Program Files (x86)*.

**Build Portable (Windows standalone):**

```bash
npm run desktop:build:portable
```

**Build both Windows versions (NSIS + Portable):**

```bash
npm run desktop:build:all
```

---

## Quick Start (Docker Compose)

### 1. Clone the Repository and Enter the Directory

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize
```

### 2. Create Required Folders and Files

The commands below assume the default directory `/opt/gharmonize`. If you want to use a different one, update the paths in the commands and under the `volumes:` section of your `docker-compose.yml` file. You can also switch the Docker image branch to either `latest` or `testing` if you prefer.

```bash
sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cookies}
sudo touch /opt/gharmonize/.env /opt/gharmonize/cookies/cookies.txt
sudo chmod -R a+rw /opt/gharmonize
```

### 3. Configure Environment Variables

In the `.env` file, you only need to set `ADMIN_PASSWORD` and `APP_SECRET`. All other settings can be adjusted later via the settings panel.

To generate a random `APP_SECRET`:

```bash
openssl rand -hex 32
```

### ⚡ Optional: Enable NVIDIA NVENC (hardware-accelerated video encoding)

If you have an NVIDIA GPU and want to use hardware-accelerated encoding (NVENC) inside the container:

1. Install the proprietary NVIDIA driver on the host.
2. Install the **NVIDIA Container Toolkit** so Docker can access your GPU.
3. Update your `docker-compose.yml` service like this:

```yaml
version: "3.9"
services:
  web:
    image: ggrbz/gharmonize:latest
    container_name: Gharmonize
    user: "${PUID:-1000}:${PGID:-1000}"
    # Enable access to the NVIDIA GPU
    gpus: all
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
      - NODE_ENV=production
      - PORT=${PORT:-5174}
      - YT_FORCE_IPV4=1
      - YT_APPLY_403_WORKAROUNDS=1
      - YTDLP_EXTRA=--force-ipv4
      - PUID=${PUID:-1000}
      - PGID=${PGID:-1000}
      - DATA_DIR=/usr/src/app
    ports:
      - "${PORT:-5174}:${PORT:-5174}"
    volumes:
      - /opt/gharmonize/uploads:/usr/src/app/uploads
      - /opt/gharmonize/outputs:/usr/src/app/outputs
      - /opt/gharmonize/temp:/usr/src/app/temp
      - /opt/gharmonize/local-inputs:/usr/src/app/local-inputs
      - /opt/gharmonize/cookies:/usr/src/app/cookies
      - /opt/gharmonize/.env:/usr/src/app/.env
      - /home:/home:ro
      - /run/media:/run/media:ro
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:${PORT:-5174}/ || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
```

### 4. Start with Docker Compose

```bash
docker compose up -d --build
```

### 5. Open in Browser

[http://localhost:5174](http://localhost:5174)

### 6. If You Encounter Permission Errors

Run the following command to reapply read/write permissions:

```bash
sudo chmod -R a+rw /opt/gharmonize
```

---

## 🐳 Alternative Installation Using Docker Run

### 1. Prepare Folders and Permissions

```bash
sudo mkdir -p /opt/gharmonize/{uploads,outputs,temp,cookies,local-inputs}
sudo touch /opt/gharmonize/.env /opt/gharmonize/cookies/cookies.txt
sudo chmod -R a+rw /opt/gharmonize
```

### 2. Run the Container

```bash
docker run -d \
  --name Gharmonize \
  -p 5174:5174 \
  -e NODE_ENV=production \
  -e PORT=5174 \
  -e YT_FORCE_IPV4=1 \
  -e YT_APPLY_403_WORKAROUNDS=1 \
  -e YTDLP_EXTRA="--force-ipv4" \
  -e PUID=1000 \
  -e PGID=1000 \
  -v /opt/gharmonize/uploads:/usr/src/app/uploads \
  -v /opt/gharmonize/outputs:/usr/src/app/outputs \
  -v /opt/gharmonize/temp:/usr/src/app/temp \
  -v /opt/gharmonize/local-inputs:/usr/src/app/local-inputs \
  -v /opt/gharmonize/cookies/:/usr/src/app/cookies/cookies.txt:ro \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

### With NVIDIA NVENC (optional)

If you want to run the container with NVENC enabled:

```bash
docker run -d \
  --name Gharmonize \
  --gpus all \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
  -p 5174:5174 \
  -e NODE_ENV=production \
  -e PORT=5174 \
  -e YT_FORCE_IPV4=1 \
  -e YT_APPLY_403_WORKAROUNDS=1 \
  -e YTDLP_EXTRA="--force-ipv4" \
  -e PUID=1000 \
  -e PGID=1000 \
  -v /opt/gharmonize/uploads:/usr/src/app/uploads \
  -v /opt/gharmonize/outputs:/usr/src/app/outputs \
  -v /opt/gharmonize/temp:/usr/src/app/temp \
  -v /opt/gharmonize/cookies:/usr/src/app/cookies/cookies.txt:ro \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

> **Note:** Don’t forget to add `ADMIN_PASSWORD` and `APP_SECRET` values to the `.env` file located in `/opt/gharmonize/` directory.

---

## Docker vs Local Usage Notes

This section explains the differences between Docker and non-Docker setups.

---

### 🍪 Cookie Usage Notes

Cookie support improves YouTube–Gharmonize matching accuracy and allows downloading age-restricted or similar content.

* **Docker users**: Only `cookies.txt` is supported.
* **Windows users**:

  * Chrome cannot provide cookies while the browser is running due to platform limitations.
  * Sign in to YouTube using **Firefox or another supported browser**, then configure cookie access accordingly.
  * Set the `YTDLP_COOKIES_FROM_BROWSER` environment variable via the environment configuration or the settings panel.
* Outside of Docker (and when correctly configured on Windows as described above), a `cookies.txt` file is **not required**.

## 🍪 Cookie & Browser Behavior

### **Outside Docker**

Setting:

```dotenv
YTDLP_COOKIES_FROM_BROWSER=chrome
```

allows Gharmonize to extract YouTube cookies **directly from your browser**, enabling:

* Age-restricted content downloads
* No need for `cookies.txt`

You must be logged into YouTube on the same server/machine where Gharmonize is installed (in a supported browser profile).

### **Inside Docker**

Browser cookie extraction **cannot work** (Docker cannot access host browser profiles). Keep it empty:

```dotenv
YTDLP_COOKIES_FROM_BROWSER=
```

---

## 📦 Docker Usage

When using Docker, leave all binary paths in `.env` **empty**:

```dotenv
YTDLP_BIN=
FFMPEG_BIN=
DATA_DIR=
```

Docker images include:

* yt-dlp
* ffmpeg
* deno
* mkvmerge suite

**Docker is fully self‑contained.** No manual binary installation is required.

---

## 🖥️ Local Usage (Node.js / AppImage / EXE / Electron)

Outside Docker, install the required binaries:

```bash
npm run download:binaries
```

This installs into:

```
build/bin/
```

including:

* yt-dlp
* ffmpeg
* deno (**required for age‑restricted YouTube content**)

This step is **mandatory** for desktop builds.

---

## 🔞 Age‑Restricted YouTube Content

To download age‑restricted content, you need:

* Cookies (browser or cookies.txt), **AND**
* `deno` in `build/bin/` (Linux → `deno`, Windows → `deno.exe`)

Cookies alone are **not** sufficient.

Docker already bundles **deno**, so no extra setup is needed.

---

## 📊 Environment Comparison Table

| Environment                   | cookies.txt Required? | Browser Extraction | Binaries Needed?  | Notes                               |
| ----------------------------- | --------------------- | ------------------ | ----------------- | ----------------------------------- |
| **Docker**                    | Optional              | ❌ Disabled         | ❌ Included        | Leave binary paths empty            |
| **Local (Node.js)**           | Optional              | ✅ Yes              | ✅ Required        | Run `npm run download:binaries`     |
| **AppImage / EXE / Electron** | Optional              | ✅ Yes              | ✅ Required        | Must bundle binaries; deno required |
| **Age‑restricted videos**     | Not enough            | Helps              | **deno required** | Docker includes it                  |

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
