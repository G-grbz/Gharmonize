<div align="center">

# <img width="128" height="128" alt="Gharmonize Logo" src="https://github.com/user-attachments/assets/adf9d2f8-a99b-43c8-9c37-d4a47f5b1e3f" />

# Gharmonize -  YouTube / Spotify Downloader & Converter

<img width="1666" height="899" alt="ss" src="https://github.com/user-attachments/assets/449c5f67-4240-4ca0-8da4-b2ca97a3b5bb" />

</div>


## 📘 Table of Contents

* [Overview](#overview)
* [Features](#features)
* [Requirements](#requirements)
* [Environment Variables (.env)](#environment-variables-env)
* [Quick Start (Local – Node & npm)](#quick-start-local--node--npm)
* [Quick Start (Docker Compose)](#quick-start-docker-compose)
* [Notes & Troubleshooting](#notes--troubleshooting)
* [License](#license)

---

## Overview

**Gharmonize** is a media automation toolkit that runs as a Node.js server with an optional Electron desktop shell. 

Gharmonize bundles several third-party command-line tools (FFmpeg/FFprobe, MKVToolNix tools, yt-dlp) to provide reliable downloading, ripping and transcoding.  
For detailed license information, see the **Third-Party Licenses** section and the `LICENSES.md` file in this repository.

---

## Features

* **YouTube & YouTube Music**
  * yt-dlp integration with SABR / 403 workarounds
  * Support for single videos, playlists, and mixes
  * Customizable yt-dlp arguments via environment variables

* **Spotify Integration**
  * Spotify Web API support (track / playlist / album)
  * Automatic mapping from Spotify items to YouTube
  * Optional preference for Spotify metadata when tagging

* **Disc Ripping (DRM-free only)**
  * Rip non-DRM optical discs (e.g., DVD/Blu-ray) into audio/video files
  * Uses ffmpeg and MKVToolNix tools under the hood
  * Disc analysis and stream selection via the web UI

* **Audio & Video Conversion**
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
  * `.env`-driven configuration for server, YouTube, Spotify and processing behavior

---

## Requirements

| Requirement      | Version  | Description              |
| ---------------- | -------- | ------------------------ |
| Node.js          | >= 20    | Required                 |
| ffmpeg           | Any      | Included in Docker image |
| yt-dlp           | Latest   | Included in Docker image |
| Spotify API Keys | Optional | For Spotify mapping      |

---

## Environment Variables (.env)

Create a `.env` file in the project root:

```dotenv
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# YouTube behavior
YT_USE_MUSIC=1
YT_FORCE_IPV4=1
YT_403_WORKAROUNDS=0
YT_LANG=en-US
YT_DEFAULT_REGION=
YT_ACCEPT_LANGUAGE="en-US,en;q=0.8"

# yt-dlp tweaks
YTDLP_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
YTDLP_COOKIES=./cookies/cookies.txt
YTDLP_COOKIES_FROM_BROWSER=chrome
YTDLP_EXTRA="--http-chunk-size 16M --concurrent-fragments 1"
YT_STRIP_COOKIES=1

# App auth & behavior
ADMIN_PASSWORD=123456
APP_SECRET=
PREFER_SPOTIFY_TAGS=1
TITLE_CLEAN_PIPE=1

# Spotify region preferences
SPOTIFY_MARKET=US
SPOTIFY_FALLBACK_MARKETS=TR,GB,DE,FR

# Server
PORT=5174

# Local media directory (optional)
LOCAL_INPUT_DIR=/path/to/local-inputs
# Optional: If not set, the app will use the default built-in local-inputs directory.
# Media placed in this folder becomes selectable in the UI without uploading (admin-only).

```

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

* **Windows:** `C:\Users\<Username>\AppData\Roaming\Gharmonize`
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
      - /opt/gharmonize/cookies/cookies.txt:/usr/src/app/cookies/cookies.txt:ro
      - /opt/gharmonize/.env:/usr/src/app/.env
      - /home:/home:ro
      - /run/media:/run/media:ro
    restart: unless-stopped
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
  -v /opt/gharmonize/cookies/cookies.txt:/usr/src/app/cookies/cookies.txt:ro \
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
  -v /opt/gharmonize/cookies/cookies.txt:/usr/src/app/cookies/cookies.txt:ro \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
  -v /home:/home:ro \
  -v /run/media:/run/media:ro \
  ggrbz/gharmonize:latest
```

> **Note:** Don’t forget to add `ADMIN_PASSWORD` and `APP_SECRET` values to the `.env` file located in `/opt/gharmonize/` directory.

---

## Notes & Troubleshooting

* **yt-dlp not found** → Install yt-dlp or use Docker image.
* **403 / SABR issues** → Adjust flags like `--http-chunk-size`, use cookies if needed.
* **Spotify personalized Mix not supported** → Copy items to a normal playlist.
* **Uploads limit** → 100MB max (configurable in `app.js`).

---

## License

This project (Gharmonize’s own source code) is licensed under the **MIT License**.

See the [LICENSE](./LICENSE) file for the full text.

---

## Third-Party Licenses

Gharmonize bundles several third-party command-line tools in its desktop and Docker builds:

- **FFmpeg / FFprobe**
- **MKVToolNix** tools:
  - `mkvmerge`
  - `mkvextract`
  - `mkvinfo`
  - `mkvpropedit`
- **yt-dlp**

These tools are *not* licensed under MIT. They keep their original licenses:

- FFmpeg / FFprobe → GNU GPL/LGPL (depending on the specific build)
- MKVToolNix tools → GNU General Public License v2 (GPLv2)
- yt-dlp → The Unlicense (public domain)

Detailed license texts are included in the distributed builds under:

- `build/licenses/FFmpeg-LICENSE.txt`
- `build/licenses/MKVToolNix-GPLv2.txt`
- `build/licenses/yt-dlp-Unlicense.txt`

---
