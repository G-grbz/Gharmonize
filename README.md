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

**Gharmonize** is a Node.js + ffmpeg powered server that can:

* Parse YouTube / YouTube Music links (single, playlist, automix)
* Map Spotify tracks, playlists, and albums to YouTube and download
* Convert to **mp3 / flac / wav / ogg**, or save **mp4** without re-encoding
* Embed tags & cover art when available
* Provide a minimal web UI and JSON API

---

## Features

* **yt-dlp** integration (SABR / 403 workarounds)
* **ffmpeg** conversion with reliability
* **Multer** for file uploads
* **Docker** image & Compose setup
* **Spotify Web API** support (playlist / album / track)
* **Settings API** for runtime config changes

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

#### 3. Installation Commands

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

#### Default .env Locations (AppImage or .exe only)

These paths are **not** general application directories. They are automatically created only when running the AppImage or Windows .exe builds, and they store the default-generated `.env` file:

* **Windows:** `C:\Users\<Username>\AppData\Roaming\Gharmonize`
* **Linux:** `~/.config/Gharmonize/`
* **Default Password** `123456`

You can change env variables in the Settings panel. Windows users should add the location of the ffmpeg and yt-dlp files to the env variable.

---

#### Run Without Building

```bash
npm start
```

---

#### Build Commands

**To build AppImage (Linux only):**

```bash
npm run desktop:build:appimage
```

**To build NSIS (Windows Installer only):**

```bash
npm run desktop:build:nsis
```

> **Note:** If you choose *Install for all users* (which installs under *Program Files*), you must manually create the folders `temp`, `outputs`, and `uploads` inside the installation directory and grant read/write permissions. Alternatively, install to a custom directory outside *Program Files* or *Program Files (x86)*.

**To build Portable (Windows standalone version):**

```bash
npm run desktop:build:portable
```

**To build both Windows versions (NSIS + Portable):**

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

The commands below assume the default directory `/opt/gharmonize`. If you want to use a different one, update the paths in the commands and under the `volumes:` section of your `docker-compose.yml` file.

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
  -v /opt/gharmonize/cookies:/usr/src/app/cookies \
  -v /opt/gharmonize/.env:/usr/src/app/.env \
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

**MIT License**

This project is licensed under the MIT License.

You are free to use, copy, modify, merge, publish, and distribute this software, provided that:

You credit the original author clearly.

A link to the original repository is included when possible.

Any modifications or changes are clearly indicated.

This software is provided “as is”, without warranty of any kind.
Use it at your own responsibility.

---
