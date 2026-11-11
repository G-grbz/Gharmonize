# Installation (Local / Desktop)

Local Node.js and Electron desktop workflows are the **primary, full-featured** usage path for Gharmonize. Docker is available as an alternative — see [DOCKER.md](DOCKER.md).

---

## Requirements

| Requirement | Version / Notes | Description |
| --- | --- | --- |
| Node.js | >= 22.12 | Required only for running or building from source |
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

On first start, Gharmonize generates a random admin password, stores only its scrypt hash, and writes the one-time password to `INITIAL_ADMIN_PASSWORD.txt` with restrictive permissions. Change it after first login.


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

This starts the local server, Electron window, and system tray together. The **Show** and **Quit** tray actions are available in source launches and all packaged desktop formats.

For a browser-only server without Electron or a tray (including headless deployments):

```bash
npm run server
```

For development, run `npm run dev` in one terminal and `npm run desktop:dev` in another. The desktop development window explicitly attaches to the watched server.

On current builds, Gharmonize checks runtime binaries at startup and downloads or updates them automatically when needed. If you'd rather prefetch the toolchain manually, see [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md).

The browser-only server exposes the UI at:

- `http://localhost:5174` — classic Web UI
- `http://localhost:5174/ytlive.html` — YTLive music UI (see [YTLIVE.md](YTLIVE.md))

---

## Default `.env` Locations for Packaged Desktop Builds

These paths are used by AppImage, DEB, RPM, Arch, and `.exe` builds when the app creates its default environment file:

| Platform | Path |
| --- | --- |
| Windows | `%appdata%\Gharmonize` |
| Linux | `~/.config/Gharmonize/` |

**There is no shared default password.** On first start, read the generated password from `INITIAL_ADMIN_PASSWORD.txt` in the application data directory, then change it from Settings.

You can edit environment variables later from the **Settings** panel.

---

## Linux Packages

GitHub tag releases publish x86-64 packages alongside the portable AppImage:

| Distribution | Package | Install the downloaded file |
| --- | --- | --- |
| Debian / Ubuntu | `.deb` | `sudo apt install ./Gharmonize-<version>-amd64.deb` |
| Fedora / compatible RPM distributions | `.rpm` | `sudo dnf install ./Gharmonize-<version>-x86_64.rpm` |
| Arch Linux | `.pkg.tar.zst` | `sudo pacman -U ./Gharmonize-<version>-x64.pkg.tar.zst` |

Use the actual version and filename from the release. Launch **Gharmonize** from the applications menu, or run `gharmonize` as your normal desktop user.

These packages install the Electron application directly under `/opt/Gharmonize`, with a desktop entry, application icons, and tray dependencies. They are built from the Electron application directory, independently of AppImage. No separate Node.js installation is needed. User settings and media stay in the user profile or configured `DATA_DIR`, not in `/opt`.

The desktop session must provide a tray host. KDE Plasma supports StatusNotifierItem; GNOME may require its **AppIndicator and KStatusNotifierItem Support** extension. Installing the indicator library alone does not enable a missing GNOME tray extension. If tray creation fails, Gharmonize keeps its window visible instead of hiding an inaccessible application.

Native packages are updated by installing the next release's package. GitHub release assets do not automatically configure an APT, DNF, or pacman repository. AppImage remains an independent portable option with its existing delta-update metadata.

---

## Build Commands

**All Linux formats (AppImage + DEB + RPM + Arch)**

```bash
npm run desktop:build:linux
```

Linux builds require RPM tooling (`rpmbuild`), `xz`, and `zstd` for the native formats. On Debian/Ubuntu build hosts, install `rpm libarchive-tools xz-utils zstd`; GitHub Actions installs the required tools automatically. Each native package is inspected before publication to verify its launcher, tray files and dependencies. Every format is included in the signed release checksum manifest and artifact attestations.

To build individual native formats:

```bash
npm run desktop:build:deb
npm run desktop:build:rpm
npm run desktop:build:arch
```

**AppImage (Linux only)**

```bash
npm run desktop:build:appimage
```

Official tagged Linux releases also publish a matching `.AppImage.zsync` file and embed GitHub Releases update information in the AppImage. Compatible AppImage update tools can therefore download only changed blocks instead of fetching the entire AppImage again. The release workflow repacks the Electron-generated AppImage with a pinned static AppImage runtime, so the published build does not require the legacy `libfuse2` runtime dependency.

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
