# Cookies & Runtime Notes

Cookies are optional. They connect Gharmonize to a YouTube account, and Gharmonize uses that account only where it changes the result.

---

## When the Account Is Used

| Request | Account |
| --- | --- |
| Track list of a YouTube mix (`list=RD…`), which YouTube builds per account | First; without it if that fails |
| YTLive's signed-in YouTube Music home | Yes |
| A video YouTube refuses without an account (age-restricted, members-only) | Only after the anonymous try fails for that reason |
| Searches, song matching, downloads, tag lookups, the Player (home, discovery, search) | Never |

> [!WARNING]
> Use a secondary Google account, not your main one. Many automated requests can make YouTube temporarily restrict the account they come from.

---

## YouTube Request Guard

All YouTube requests (yt-dlp and YouTube Music) share one guard per server, because YouTube judges an IP address:

- **Parallel limit (always on):** at most 2 YouTube downloads at a time. The parallel setting of a job still controls how many ffmpeg conversions run at once.
- **Hourly budget and automatic pause (off by default):** set `YOUTUBE_HOURLY_BUDGET` (Settings → YouTube, for example `250`) to turn them on. Searches count about a third of a video; up to half of the budget runs at full speed, then the gap between requests grows gradually. A large batch slows down instead of hitting YouTube's limit (roughly 300 videos/hour without an account).
- **Pause on a bot check (only with a budget set):** when YouTube answers "Sign in to confirm you're not a bot", "automated queries" or HTTP 429, every YouTube request pauses for 30 minutes (longer if it happens again within 6 hours). Running songs show *Waiting* and continue afterwards; previews and searches report the pause instead of waiting.
- Pause and usage are kept in `cache/youtube-guard.json`, so a restart does not reset them.
- Each downloaded YouTube video's information is saved during the download and reused for tagging, so a video is not asked for twice.

---

## Cookie Behavior

- **Docker:** browser cookie extraction is not available inside the container; use `cookies.txt` if needed
- **Local / desktop:** browser cookie extraction is available when supported on the host platform
- **Windows:** Chrome cookie extraction may fail while the browser is running; Firefox or another supported browser is usually safer

---

## Age-Restricted YouTube Content

To download age-restricted content you need:

- cookies (browser extraction or `cookies.txt`)
- `deno`

In current builds, `deno` is usually handled automatically by the runtime binary manager. If you disable auto-management or force custom binary paths, make sure `DENO_BIN` resolves correctly. See [BINARY_MANAGEMENT.md](BINARY_MANAGEMENT.md).

---

## Environment Comparison

| Environment | Browser cookie extraction | `cookies.txt` | Binary management |
| --- | --- | --- | --- |
| Docker | No | Optional | Auto-managed in the provided compose / run setup |
| Local (Node.js) | Yes | Optional | Auto-managed by default |
| AppImage / EXE | Yes | Optional | Auto-managed by default |
| Manual / custom binaries | Depends on your setup | Optional | Use `*_BIN` env vars or `npm run download:binaries` |

---

## Related `.env` Variables

The following variables control cookie and language/region behavior. Full descriptions are in [CONFIGURATION.md](CONFIGURATION.md).

- `YT_STRIP_COOKIES`
- `YOUTUBE_HOURLY_BUDGET`
- `YTDLP_COOKIES`
- `YTDLP_COOKIES_FROM_BROWSER`
- `YT_UI_FORCE_COOKIES`
- `YT_LANG`
- `YT_FORCE_IPV4`
- `YT_ACCEPT_LANGUAGE`
- `YT_DEFAULT_REGION`
- `YT_403_WORKAROUNDS`
- `YTDLP_UA`
