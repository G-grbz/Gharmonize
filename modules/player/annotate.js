// Adds "already in your library" and "downloading now" badges to online items,
// so every client can show play / download / progress consistently. Library
// matches are per user: a song in a library you cannot see is not "yours".
export function createAnnotator({ matcher, bridge }) {
  function libraryOf(item, userId) {
    if (item.kind === 'track') {
      const id = matcher.findTrack(item, userId)
      return id ? { trackId: id } : null
    }
    if (item.kind === 'album') {
      const album = matcher.findAlbum(item, userId)
      return album ? { albumId: album.id, trackCount: album.trackCount, complete: !item.trackCount || album.trackCount >= item.trackCount } : null
    }
    if (item.kind === 'artist') {
      const id = matcher.findArtist(item.title || item.artist, userId)
      return id ? { artistId: id } : null
    }
    return null
  }

  function items(list = [], userId) {
    const urls = list.filter((i) => i.kind !== 'artist').map((i) => i.url)
    const active = bridge.activeBySources(urls)
    const done = bridge.libraryBySources ? bridge.libraryBySources(urls, userId) : new Map()
    return list.map((item) => {
      let library = libraryOf(item, userId)
      // Metadata can differ between the store and the downloaded files
      // ("Wake Up" vs "Wake Up - Single"); an earlier download of this exact
      // link that is still in the library counts too.
      const ids = !library && done.get(item.url)
      if (ids?.length) {
        const albumId = item.kind === 'album' ? matcher.albumOfTrack?.(ids[0]) : null
        library = item.kind === 'track' ? { trackId: ids[0] } : { ...(albumId ? { albumId } : {}), trackIds: ids, trackCount: ids.length, complete: true }
      }
      return { ...item, library, download: active.get(item.url) || null }
    })
  }

  function shelves(list = [], userId) {
    return list.map((shelf) => ({ ...shelf, items: items(shelf.items, userId) }))
  }

  return { items, shelves }
}
