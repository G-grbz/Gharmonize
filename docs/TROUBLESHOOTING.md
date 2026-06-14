# Troubleshooting

Common issues and how to resolve them.

---

## `yt-dlp not found`

Install yt-dlp manually, or use the Docker image, which manages binaries automatically. See [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md).

---

## 403 / SABR Issues

Adjust flags such as `--http-chunk-size` (via `YTDLP_EXTRA` / `YTDLP_ARGS_EXTRA`), and use cookies if needed.

Related settings:
- `YT_403_WORKAROUNDS` — enable special handling for HTTP 403 errors
- `YTDLP_COOKIES` / `YTDLP_COOKIES_FROM_BROWSER` — see [COOKIES.md](COOKIES.md)

Full reference: [CONFIGURATION.md](CONFIGURATION.md)

---

## Spotify Personalized Mix Not Supported

Spotify's personalized "Mix" playlists cannot be mapped directly. Copy the items into a normal playlist first, then use that playlist with Gharmonize.

---

## Upload Limit

The default upload limit is 100 MB, configurable via `UPLOAD_MAX_BYTES` in `app.js` / `.env`. See [CONFIGURATION.md](CONFIGURATION.md#upload-limits).

---

## Windows: Program Files Permissions

If you install a packaged Windows build under `Program Files`, you may need to create `temp`, `outputs`, and `uploads` directories manually and grant write permissions. See [INSTALLATION.md](INSTALLATION.md).

---

## Windows: Chrome Cookie Extraction Fails

Chrome cookie extraction may fail while the browser is running. Try Firefox or another supported browser instead. See [COOKIES.md](COOKIES.md).

---

## NVENC Not Working in Docker

On some hosts, NVENC inside Docker only works reliably when the container runs as root with `privileged: true` and `runtime: nvidia` enabled. See [DOCKER.md](DOCKER.md#optional-nvidia--nvenc-in-docker).
