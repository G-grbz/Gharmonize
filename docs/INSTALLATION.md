# Installation (Local / Desktop)

Local Node.js and Electron desktop workflows are the **primary, full-featured** usage path for Gharmonize. Docker is available as an alternative — see [DOCKER.md](DOCKER.md).

---

## Requirements

| Requirement | Version / Notes | Description |
| --- | --- | --- |
| Node.js | >= 20 | Required for local / Electron usage |
| Docker Engine + Docker Compose | Current | Required for Docker deployment |
| Internet access on first launch | Recommended | Lets Gharmonize fetch or refresh runtime binaries automatically |
| Spotify API Keys | Optional | Enables Spotify Web API based matching and metadata |

> If you set custom binary paths such as `FFMPEG_BIN`, `FFPROBE_BIN`, `MKVMERGE_BIN`, `YTDLP_BIN`, or `DENO_BIN`, Gharmonize will use those instead of the auto-managed copies. See [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md).

---

## 1. Clone the repository

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize
```

## 2. Create or edit `.env`

To use the UI configuration flow, set `ADMIN_PASSWORD` and `APP_SECRET`.

Generate `APP_SECRET` with:

```bash
openssl rand -hex 32
```

See [CONFIGURATION.md](CONFIGURATION.md) for the full list of available environment variables.

## 3. Install dependencies

**Linux**

```bash
BUILD_ELECTRON=1 npm i
```

**Windows (CMD)**

```cmd
set BUILD_ELECTRON=1
npm i
```

## 4. Start the application

```bash
npm start
```

On current builds, Gharmonize checks runtime binaries at startup and downloads or updates them automatically when needed. If you'd rather prefetch the toolchain manually, see [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md).

Open the UI at:

- `http://localhost:5174` — classic Web UI
- `http://localhost:5174/ytlive.html` — YTLive music UI (see [YTLIVE.md](YTLIVE.md))

---

## Default `.env` Locations for Packaged Desktop Builds

These paths are used only by AppImage / `.exe` builds when the app creates its default environment file:

| Platform | Path |
| --- | --- |
| Windows | `%appdata%\Gharmonize` |
| Linux | `~/.config/Gharmonize/` |

**Default password:** `123456`

You can edit environment variables later from the **Settings** panel.

---

## Build Commands

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
