import path from 'node:path';

export const TRAY_ICON_MODES = Object.freeze(['original', 'dark', 'light', 'auto']);

export function normalizeTrayIconMode(value) {
  return TRAY_ICON_MODES.includes(value) ? value : 'original';
}

export function trayIconVariant(mode, nativeTheme, platform) {
  const selected = normalizeTrayIconMode(mode);
  if (selected !== 'auto') return selected;
  // Windows can use a light app theme with a dark taskbar (or vice versa).
  // Follow the system/taskbar setting, not Gharmonize's web-interface theme.
  const darkSystem = platform === 'win32'
    && typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === 'boolean'
    ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
    : nativeTheme.shouldUseDarkColors;
  return darkSystem ? 'light' : 'dark';
}

// Raster counterparts of public/src/gharmonize-tray*.svg are bundled alongside
// this module: nativeImage does not decode SVG. No renderer or polling is needed.
export function createTrayIconManager({ nativeImage, nativeTheme, platform,
  assetDir, originalIconPath, onWarning = console.warn }) {
  let mode = 'original';
  let target = null;
  let lastImage = null;
  const images = new Map();

  function getImage() {
    const variant = trayIconVariant(mode, nativeTheme, platform);
    if (variant === 'original') return originalIconPath;
    if (images.has(variant)) return images.get(variant);
    try {
      // Only allowlisted variants reach the filesystem; preferences are not paths.
      const source = nativeImage.createFromPath(path.join(assetDir, `gharmonize-tray-${variant}.png`));
      if (source.isEmpty()) throw new Error(`Empty ${variant} tray icon`);
      const image = nativeImage.createEmpty();
      const size = platform === 'win32' ? 16 : 24;
      for (const scaleFactor of [1, 1.25, 1.5, 2, 3, 4]) {
        const pixels = Math.round(size * scaleFactor);
        image.addRepresentation({ scaleFactor, buffer: source.resize({
          width: pixels, height: pixels, quality: 'best'
        }).toPNG() });
      }
      if (image.isEmpty()) throw new Error(`Could not decode ${variant} tray icon`);
      images.set(variant, image);
      return image;
    } catch (error) {
      onWarning('[tray] custom icon unavailable; using original:', error.message);
      return originalIconPath;
    }
  }

  function update() {
    if (!target || target.isDestroyed?.()) return;
    const image = getImage();
    if (lastImage === image) return;
    try {
      target.setImage(image);
      lastImage = image;
    } catch (error) {
      onWarning('[tray] icon update failed; keeping the existing tray:', error.message);
    }
  }

  function onThemeUpdated() {
    if (mode === 'auto') update();
  }

  return {
    get mode() { return mode; },
    setMode(value) { mode = normalizeTrayIconMode(value); update(); },
    getImage,
    attach(tray) {
      nativeTheme.removeListener('updated', onThemeUpdated);
      target = tray;
      lastImage = null;
      nativeTheme.on('updated', onThemeUpdated);
      update();
    },
    dispose() {
      nativeTheme.removeListener('updated', onThemeUpdated);
      target = null;
      lastImage = null;
    }
  };
}
