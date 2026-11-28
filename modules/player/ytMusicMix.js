const MIX_TTL_MS = 6 * 60 * 60 * 1000
const FALLBACK_TTL_MS = 5 * 60 * 1000

export function youTubeMusicMixRef(url) {
  try {
    const link = new URL(url)
    if (link.origin !== 'https://music.youtube.com' || !['/watch', '/playlist'].includes(link.pathname)) return null
    const playlistId = link.searchParams.get('list')
    const videoId = link.searchParams.get('v')
    if (!/^RD(?!CLAK)[A-Za-z0-9_-]+$/.test(playlistId || '')) return null
    if (videoId && !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null
    return { playlistId, videoId }
  } catch { return null }
}

// Discovery and download preparation use the same queue for each Music mix seed.
export function createYouTubeMusicMixReader(cache, loadYt = () => import('../yt.js')) {
  return async function readYouTubeMusicMix(url) {
    const ref = youTubeMusicMixRef(url)
    if (!ref) return null
    const key = `yt:music-mix:${ref.playlistId}:${ref.videoId || ''}`
    const result = await cache.wrap(key, MIX_TTL_MS, async () => {
      const yt = await loadYt()
      const music = await yt.extractYouTubeMusicMix(ref).catch((error) => {
        // Some mixes cannot be opened with the public Music client.
        if ([400, 401, 403, 404].includes(error?.status)) return null
        throw error
      })
      if (music) return { playlist: music, fromMusic: true }
      return { playlist: await yt.extractAutomixAllFlat(url), fromMusic: false }
    }, { ttlFor: (entry) => entry.fromMusic ? MIX_TTL_MS : FALLBACK_TTL_MS })
    return result.playlist
  }
}
