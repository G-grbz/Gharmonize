# Tray icon assets

The original colored icon continues to use `build/icon.ico` on Windows and
`build/icon.png` on Linux (the existing extra resources in packaged builds).

The monochrome PNGs are raster exports of the user-supplied vector originals:

- `public/src/gharmonize-tray.svg` → `gharmonize-tray-dark.png`
- `public/src/gharmonize-tray-light.svg` → `gharmonize-tray-light.png`

Electron's `nativeImage` does not decode SVG. These committed 128×128 transparent
PNGs are included by the existing `electron/**` packaging rule; the application
creates cached native representations for standard and high-DPI displays. No
renderer, external converter, or download is required at runtime or on Windows.

After editing the vectors, regenerate the PNGs from the repository root using
`rsvg-convert` (librsvg):

```sh
rsvg-convert -w 128 -h 128 -o electron/assets/gharmonize-tray-dark.png public/src/gharmonize-tray.svg
rsvg-convert -w 128 -h 128 -o electron/assets/gharmonize-tray-light.png public/src/gharmonize-tray-light.svg
```
