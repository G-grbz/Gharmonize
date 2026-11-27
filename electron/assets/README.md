# Tray icon assets

The "Original" tray mode uses the colored tray icon below; the app icon
(`build/icon.ico` on Windows, `build/icon.png` on Linux) is only its fallback.

The PNGs are raster exports of the user-supplied vector originals:

- `public/src/gharmonize-tray-color.svg` → `gharmonize-tray-color.png`
- `public/src/gharmonize-tray.svg` → `gharmonize-tray-dark.png`
- `public/src/gharmonize-tray-light.svg` → `gharmonize-tray-light.png`

Electron's `nativeImage` does not decode SVG. These committed 128×128 transparent
PNGs are included by the existing `electron/**` packaging rule; the application
creates cached native representations for standard and high-DPI displays. No
renderer, external converter, or download is required at runtime or on Windows.

After editing the vectors, regenerate the PNGs from the repository root using
`rsvg-convert` (librsvg):

```sh
rsvg-convert -w 128 -h 128 -o electron/assets/gharmonize-tray-color.png public/src/gharmonize-tray-color.svg
rsvg-convert -w 128 -h 128 -o electron/assets/gharmonize-tray-dark.png public/src/gharmonize-tray.svg
rsvg-convert -w 128 -h 128 -o electron/assets/gharmonize-tray-light.png public/src/gharmonize-tray-light.svg
```
