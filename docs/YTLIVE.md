# YTLive Music UI

YTLive is a dedicated music interface for YouTube and YouTube Music. It is available alongside the classic Gharmonize UI and focuses on search, playback, playlist inspection, and fast queueing into the existing conversion pipeline.

<img width="1684" height="934" alt="YTLive Screenshot" src="https://github.com/user-attachments/assets/34945652-9c72-4bc6-9c78-b01302aba81b" />

---

## Opening YTLive

Open it directly:

- `http://localhost:5174/ytlive.html`

You can also switch from the classic UI with the **YTLive** toolbar button. From YTLive, use the **Classic UI** sidebar link to return to the original interface.

To make YTLive the default page served from `/`, set in your `.env`:

```dotenv
FRONTEND_UI=ytlive
```

---

## What YTLive Supports

- YouTube search with track / playlist / album filters
- Discovery presets and infinite loading
- Quick play or queue by pasted YouTube / YouTube Music URL
- Embedded playback plus an "Open on YouTube" fallback for videos that block embeds
- Output controls for format, quality, sample rate, lyrics, ZIP creation, and playlist concurrency
- Playlist preview with individual track add buttons
- YouTube Music home shelves when cookies are available
- Live queue status through `/api/queue/status`

---

## Playlist Quick-Add Limit

Playlist quick-add is capped by `YOUTUBE_QUICK_ADD_LIMIT`. Set it between `1` and `100` to control how many playlist entries the YTLive playlist **+** action queues at once. See [CONFIGURATION.md](CONFIGURATION.md).

---

## YouTube Music Home Shelves

Personal YouTube Music shelves require a usable cookie source — either `cookies.txt` or browser cookie extraction on a local / desktop install.

- Docker can use `cookies.txt`, but **cannot** extract cookies from a host browser profile inside the container.

For full details on cookie behavior across environments, see [COOKIES.md](COOKIES.md).
