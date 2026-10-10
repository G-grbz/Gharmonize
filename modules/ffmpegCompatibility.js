// Release metadata chooses candidates; only an actual runtime encoding probe
// can establish NVIDIA driver compatibility. A lower FFmpeg version alone is
// not sufficient because newer builds can use newer nv-codec-headers.
export function stableFfmpegAssets(release, target) {
  if (!target) return [];
  const escape = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^ffmpeg-n(\\d+(?:\\.\\d+)+)(?:-latest|-\\d+-g[a-f0-9]+)?-${escape(target.token)}-gpl(?:-[0-9.]+)?${escape(target.extension)}$`, 'i');
  return (Array.isArray(release?.assets) ? release.assets : [])
    .map((asset) => ({ asset, version: String(asset?.name || '').match(pattern)?.[1] }))
    .filter((item) => item.version)
    .sort((a, b) => {
      const aa = a.version.split('.').map(Number), bb = b.version.split('.').map(Number);
      for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        const diff = (bb[i] || 0) - (aa[i] || 0);
        if (diff) return diff;
      }
      return 0;
    })
    .map((item) => item.asset);
}

// BtbN's current build policy, not an intrinsic FFmpeg version requirement.
// This is a candidate-selection hint; activation still requires runtime tests.
export function ffmpegSdkTier(assetName) {
  const name = String(assetName || '');
  if (/^ffmpeg-master-latest-/i.test(name)) return '13.1';
  const match = name.match(/^ffmpeg-n(\d+)\.(\d+)(?:[.-])/i);
  if (!match) return null;
  const major = Number(match[1]), minor = Number(match[2]);
  if (major > 8 || (major === 8 && minor >= 2)) return '13.1';
  return major >= 8 ? '13.0' : '11.1';
}

export function nvencAvailableApi(detail) {
  const match = String(detail || '').match(/(?:Found:\s*|Loaded Nvenc version\s+)(\d+)\.(\d+)/i);
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

// One newest verified package per SDK band: don't spend the download budget
// on several 13.1 builds while a Kepler-compatible 11.1 branch is available.
export function compatibilityFfmpegAssets(release, target, availableApi = null) {
  const assets = stableFfmpegAssets(release, target).filter((asset) =>
    asset.browser_download_url && /^sha256:[a-f0-9]{64}$/i.test(asset.digest || ''));
  return ['13.1', '13.0', '11.1'].filter((tier) => !availableApi || Number(tier) <= Number(availableApi))
    .map((tier) => assets.find((asset) => ffmpegSdkTier(asset.name) === tier)).filter(Boolean);
}

// Skip recent daily builds likely using the same incompatible headers. Try at
// most three archived snapshots, at least 30 days apart, newest first.
export function archivedFfmpegCandidates(releases, latest, target, options = {}) {
  let cutoff = Date.parse(latest?.published_at) - 30 * 86400_000;
  if (!Number.isFinite(cutoff)) return [];
  const candidates = [];
  for (const release of (Array.isArray(releases) ? releases : [])
    .filter((item) => !item?.draft && !item?.prerelease && item?.tag_name !== 'latest')
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))) {
    const date = Date.parse(release?.published_at);
    if (!Number.isFinite(date) || date > cutoff) continue;
    const assets = options.bySdk
      ? compatibilityFfmpegAssets(release, target, options.availableApi)
      : stableFfmpegAssets(release, target).slice(0, 1);
    for (const asset of assets) {
      if (!asset?.browser_download_url || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) continue;
      candidates.push({ release, asset });
      if (candidates.length === 3) return candidates;
    }
    if (!assets.length) continue;
    cutoff = date - 30 * 86400_000;
    if (candidates.length === 3) break;
  }
  return candidates;
}
