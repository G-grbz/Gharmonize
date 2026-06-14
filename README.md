<div align="center">

<img width="128" height="128" alt="Gharmonize Logo" src="https://github.com/user-attachments/assets/adf9d2f8-a99b-43c8-9c37-d4a47f5b1e3f" />

# Gharmonize

https://github.com/user-attachments/assets/4083729e-3db9-4936-ac01-28c0f318aebe

### Download • Convert • Rip • Tag — with a Web UI + Desktop builds (AppImage/EXE)

Next-generation media processing, powered by **yt-dlp**, **FFmpeg** and **deno**.

Seamlessly download content from YouTube, YouTube Music, and major platforms like X, Facebook, Instagram, Vimeo, Dailymotion, and TikTok. Leverage Spotify, Apple Music, and Deezer for intelligent metadata matching and track discovery — then fetch high-quality media via yt-dlp. Includes DRM-free disc ripping, iPhone / Android ringtone output, and blazing-fast GPU-accelerated transcoding, all powered by a robust and reliable processing engine.

> **Spotify note:** Spotify is used for **metadata + matching** (track/playlist/album info). Gharmonize does **not** claim DRM bypass.

<img width="1666" height="899" alt="Gharmonize Screenshot" src="https://github.com/user-attachments/assets/449c5f67-4240-4ca0-8da4-b2ca97a3b5bb" />

</div>

---

## Quick Start

**Local / Desktop (recommended)**

```bash
git clone https://github.com/G-grbz/Gharmonize
cd Gharmonize

BUILD_ELECTRON=1 npm i
npm start
```

Then open **http://localhost:5174**

Gharmonize checks runtime binaries (ffmpeg, ffprobe, mkvmerge, yt-dlp, deno) at startup and downloads or refreshes them automatically when needed.

For Docker, NVIDIA/NVENC setups, and packaged AppImage/EXE builds, see:

- 📦 [docs/INSTALLATION.md](docs/INSTALLATION.md) — local/desktop setup & build commands
- 🐳 [docs/DOCKER.md](docs/DOCKER.md) — Docker Compose, Docker run, NVIDIA/NVENC

---

## What You Get

- **YouTube / YouTube Music** downloads for single items, playlists, and mixes
- **YTLive** — a dedicated music-first UI for YouTube discovery, playback, and queueing
- **X (Twitter) / Facebook / Instagram / Vimeo / Dailymotion / TikTok** download and conversion flows
- **Spotify, Apple Music, and Deezer** mapping for track / playlist / album workflows
- **Phone ringtone output** for iPhone (`.m4r`) and Android (`.mp3`)
- **Audio and video conversion** powered by FFmpeg, with FPS/A-V sync presets for AC3 / EAC3 / AAC
- **GPU acceleration** for local transcoding — NVENC, VAAPI, Intel QSV
- **DRM-free disc ripping** with stream selection in the Web UI
- **Runtime binary management** for ffmpeg, ffprobe, mkvmerge, yt-dlp, and deno
- **Job engine** for batch processing, progress tracking, and reliability

Full details in [docs/FEATURES.md](docs/FEATURES.md).

---

## Documentation

| Guide | Description |
| --- | --- |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Requirements, local/desktop setup, build commands |
| [docs/DOCKER.md](docs/DOCKER.md) | Docker Compose, Docker run, NVIDIA/NVENC |
| [docs/FEATURES.md](docs/FEATURES.md) | Full feature list and supported sources |
| [docs/YTLIVE.md](docs/YTLIVE.md) | YTLive music UI guide |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Full `.env` variable reference |
| [docs/BINARY_MANAGEMENT.md](docs/BINARY_MANAGEMENT.md) | ffmpeg / yt-dlp / deno binary handling |
| [docs/COOKIES.md](docs/COOKIES.md) | Cookies, age-restricted content, environment comparison |
| [docs/HOMEPAGE_WIDGET.md](docs/HOMEPAGE_WIDGET.md) | Homepage dashboard widget setup |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues & fixes |
| [LICENSE](LICENSE) | License & redistribution rules |
| [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) | Bundled third-party tool licenses |

---

## Companion Tool: G-TMCE

For users who want a more advanced MKV finishing workflow after ripping or extracting DRM-free media, check out **G-TMCE**:

🔗 https://github.com/G-grbz/G-TMCE

G-TMCE is a cross-platform MKV creation and extraction GUI for Linux and Windows. It focuses on professional remux workflows with TMDB metadata, automatic `tags.xml` generation, artwork downloads, chapter generation, language-aware audio/subtitle handling, forced/SDH subtitle detection, and MKVToolNix automation.

Gharmonize is designed for downloading, conversion, ripping, tagging, and batch processing. G-TMCE can be used as a companion tool when you want to prepare polished MKV outputs for media libraries and home media servers.

---

## Disclaimer

This software is provided "as is", without warranty of any kind. Use it at your own risk.

---

## License

Gharmonize is licensed under the **PolyForm Noncommercial License 1.0.0**.

- Full terms and redistribution rules: [LICENSE.md](LICENSE.md)
- Licenses for bundled third-party tools (FFmpeg, MKVToolNix, yt-dlp, deno): [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
