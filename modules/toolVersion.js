// Normalizes yt-dlp stable release/version strings for exact comparisons.
export function normalizeYtDlpVersion(value) {
  const match = String(value || "").trim().match(/(?:^|\b)v?(\d{4}\.\d{2}\.\d{2})(?:\b|$)/i);
  return match ? match[1] : "";
}

// Checks whether an installed yt-dlp version matches a GitHub release tag.
export function isSameYtDlpRelease(installedVersion, releaseTag) {
  const installed = normalizeYtDlpVersion(installedVersion);
  const release = normalizeYtDlpVersion(releaseTag);
  return !!installed && !!release && installed === release;
}


// Normalizes Deno CLI versions and GitHub release tags for exact comparisons.
export function normalizeDenoVersion(value) {
  const match = String(value || "").trim().match(/(?:^|\b)v?(\d+\.\d+\.\d+)(?:\b|$)/i);
  return match ? match[1] : "";
}

// Checks whether an installed Deno version matches a GitHub release tag.
export function isSameDenoRelease(installedVersion, releaseTag) {
  const installed = normalizeDenoVersion(installedVersion);
  const release = normalizeDenoVersion(releaseTag);
  return !!installed && !!release && installed === release;
}
