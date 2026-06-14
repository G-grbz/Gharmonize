# Cookies & Runtime Notes

Cookie support improves matching accuracy and helps with age-restricted or similar content.

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
- `YTDLP_COOKIES`
- `YTDLP_COOKIES_FROM_BROWSER`
- `YT_UI_FORCE_COOKIES`
- `YT_LANG`
- `YT_FORCE_IPV4`
- `YT_ACCEPT_LANGUAGE`
- `YT_DEFAULT_REGION`
- `YT_403_WORKAROUNDS`
- `YT_USE_MUSIC`
- `YTDLP_UA`
