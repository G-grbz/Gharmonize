# Binary Management

Gharmonize supports two binary workflows for its runtime dependencies: **ffmpeg**, **ffprobe**, **mkvmerge**, **yt-dlp**, and **deno**.

---

## Automatic Runtime Management

- Default behavior outside Docker, unless you explicitly disable it
- Enabled in the provided Docker deployment through `GHARMONIZE_WEB_BINARIES_IN_DOCKER=1`
- Checks and refreshes **ffmpeg**, **ffprobe**, **mkvmerge**, **yt-dlp**, and **deno** at startup
- Keeps the current resolved binaries as a fallback if a refresh fails

This means manual setup is no longer required in the common case — on first launch (with internet access), Gharmonize fetches what it needs automatically.

---

## Optional Manual Prefetch

If you still want to download the toolchain into `build/bin/` manually, you can run:

```bash
npm run download:binaries
```

This is useful if you want to:

- prefill `build/bin/` yourself
- prepare a more offline-friendly local / desktop setup
- bundle a known toolset before creating a packaged desktop build

---

## Using Auto-Managed vs Custom Binaries

If you want Gharmonize to use the auto-managed or manually downloaded copies, leave the custom path variables empty in your `.env`:

```dotenv
FFMPEG_BIN=
FFPROBE_BIN=
MKVMERGE_BIN=
MKVPROPEDIT_BIN=
YTDLP_BIN=
DENO_BIN=
```

If you set these variables to explicit host paths, Gharmonize will prefer those paths instead. See [CONFIGURATION.md](CONFIGURATION.md) for the full `.env` reference.

---

## Age-Restricted YouTube Content

To download age-restricted content you need:

- cookies (browser extraction or `cookies.txt`)
- `deno`

In current builds, `deno` is usually handled automatically by the runtime binary manager. If you disable auto-management or force custom binary paths, make sure `DENO_BIN` resolves correctly.

For cookie setup details, see [COOKIES.md](COOKIES.md).
