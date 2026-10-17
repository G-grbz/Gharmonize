# Features

**Gharmonize** is a media automation toolkit running as a Node.js server with an optional Electron desktop shell. It combines downloading, mapping, conversion, tagging, disc processing, and batch job management behind a single Web UI.

On current builds, runtime tools such as **ffmpeg**, **ffprobe**, **mkvmerge**, **yt-dlp**, and **deno** are checked, downloaded, and refreshed automatically at application startup — manual setup is no longer required in the common case (see [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md)).

---

## Supported Sources

* YouTube / YouTube Music
* Spotify
* Apple Music
* Deezer
* X (Twitter)
* Facebook
* Instagram
* Vimeo
* Dailymotion
* TikTok

---

## Music Mapping and Collections

* Spotify, Apple Music, and Deezer support **track / playlist / album** workflows
* Deezer supports personalized, locale-prefixed or locale-free **`inspired-by-*` smart tracklists** through an encrypted `DEEZER_ARL` setting
* Automatic mapping from supported music-service items to YouTube / YouTube Music sources
* Optional preference for Spotify metadata during tagging (`PREFER_SPOTIFY_TAGS`, see [CONFIGURATION.md](CONFIGURATION.md))

---

## Dedicated YTLive Interface

A music-first interface for YouTube and YouTube Music workflows, including search tabs, discovery presets, embedded playback, and a shared job queue with the classic UI.

Full guide: [YTLIVE.md](YTLIVE.md)

---

## Job Stages and Timings

* Classic and YTLive job cards show elapsed time and a **Stages and timings** details button.
* Music mapping and selected YouTube/automix audio tracks report independent stages for matching, downloading, metadata, artwork, conversion, lyrics, and retagging where applicable. Other workflows show overall job stages; detailed per-track coverage is being expanded.
* Cached music matches are identified separately. Directory retag jobs have per-file timings, and video collection conversions have independent completion times. Cards and details follow the light/dark theme and keep long names contained; click a name in the details view to expand it.
* Parallel stages overlap, so total elapsed time is not the sum of all track durations. Retries, rate-limit waits, missing matches, failures, and cancellations are tracked separately in instrumented flows.
* Details are loaded on demand in 50-track pages, with up to 1,000 track histories per job. Use **Refresh** to fetch the latest stages; elapsed clocks do not trigger background network polling. Completed measurements are retained with job history; older jobs have no invented timings.

---

## Phone Ringtone Output

* Export ringtone-ready files for **iPhone** and **Android**
* Works with supported download flows, including collection-based music links where available
* **Automatic** mode picks the strongest section of the track
* **Manual** mode lets you choose the start point
* iPhone output uses **`.m4r`**, up to **40 seconds**
* Android output uses **`.mp3`**, up to **60 seconds**

---

## Audio and Video Processing

* FFmpeg-based conversion with reliability-first defaults
* Convert to **mp3 / flac / wav / ogg / opus / m4a / alac / mp4 / mkv**
* Ready-made **FPS adjustment presets** for **AC3 / EAC3 / AAC** sync fixes
* Video re-encoding uses the source's nominal FPS (or the selected FPS) as a constant frame rate and aligns re-encoded audio samples with their timestamps. Gaps, overlaps, and delayed audio starts are materialized as frames/samples instead of relying only on container timing. Stream-copy modes retain the copied tracks' original timing. Extracting raw tracks still discards codec-delay metadata, so a small fixed encoder delay may require correction when remuxing.
* Hardware acceleration for local video transcoding with **NVIDIA NVENC**, **VAAPI**, and **Intel Quick Sync (QSV)**

---

## Disc Ripping (DRM-free Only)

* Rip non-DRM optical discs such as DVD / Blu-ray into audio or video files
* Uses FFmpeg and MKVToolNix under the hood
* Disc analysis and stream selection are available from the Web UI

---

## Deployment and Runtime

* Local Node.js and Electron desktop workflows are the primary, full-featured usage path
* Docker image deployment through the official GHCR package (`ghcr.io/g-grbz/gharmonize`) with `latest` and versioned release tags as an alternative setup (see [DOCKER.md](DOCKER.md))
* Runtime settings panel and `.env` configuration (see [CONFIGURATION.md](CONFIGURATION.md))
* Automatic runtime binary download / refresh with fallback to existing binaries (see [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md))

---

## Companion Tool: G-TMCE

For users who want a more advanced MKV finishing workflow after ripping or extracting DRM-free media, check out **[G-TMCE](https://github.com/G-grbz/G-TMCE)**.

G-TMCE is a cross-platform MKV creation and extraction GUI for Linux and Windows. It focuses on professional remux workflows with TMDB metadata, automatic `tags.xml` generation, artwork downloads, chapter generation, language-aware audio/subtitle handling, forced/SDH subtitle detection, and MKVToolNix automation.

Gharmonize is designed for downloading, conversion, ripping, tagging, and batch processing. G-TMCE can be used as a companion tool when you want to prepare polished MKV outputs for media libraries and home media servers.
