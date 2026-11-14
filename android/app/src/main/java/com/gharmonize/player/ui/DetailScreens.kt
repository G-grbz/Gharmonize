package com.gharmonize.player.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Button
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.mapObjects
import com.gharmonize.player.data.parseOnline

@Composable
fun AlbumScreen(state: AppState, id: Long) {
  val data = rememberLoad("album", id) { state.api.album(id) }
  val album = data.value
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (album == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      HeaderBlock(album.artwork, stringResource(R.string.kind_album), album.title,
        listOfNotNull(album.artist.ifBlank { null }, album.year?.toString(), stringResource(R.string.count_songs, album.trackCount), fmtTime(album.duration)).joinToString(" · ")) {
        PlayShuffle(state, album.tracks)
        SavePlaylistButton(state, album.tracks.map { it.id }, album.title)
        album.artistId?.let { aid -> OutlinedButton(onClick = { state.navigate(Route.Artist(aid)) }) { Text(stringResource(R.string.go_to_artist)) } }
      }
    }
    itemsIndexed(album.tracks, key = { _, t -> "at-${t.id}" }) { i, t -> TrackRow(state, album.tracks, i, showArt = false, number = t.trackNo ?: (i + 1)) }
  }
}

@Composable
fun ArtistScreen(state: AppState, id: Long) {
  val data = rememberLoad("artist", id) { state.api.artist(id) }
  val artist = data.value
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (artist == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      HeaderBlock(artist.artwork, stringResource(R.string.kind_artist), artist.name,
        stringResource(R.string.count_songs, artist.trackCount), round = true) {
        PlayShuffle(state, artist.topTracks + artist.singles)
        OutlinedButton(onClick = { state.navigate(Route.OnlineArtist(null, artist.name)) }) { Text(stringResource(R.string.more_online)) }
      }
    }
    if (artist.topTracks.isNotEmpty()) {
      item { SectionTitle(stringResource(R.string.popular)) }
      itemsIndexed(artist.topTracks, key = { _, t -> "top-${t.id}" }) { i, _ -> TrackRow(state, artist.topTracks, i) }
    }
    if (artist.albums.isNotEmpty()) item { ShelfRow(stringResource(R.string.albums), artist.albums) { _, a -> AlbumCard(state, a) } }
    if (artist.singles.isNotEmpty()) {
      item { SectionTitle(stringResource(R.string.singles)) }
      itemsIndexed(artist.singles, key = { _, t -> "sg-${t.id}" }) { i, _ -> TrackRow(state, artist.singles, i) }
    }
    if (artist.appearsOn.isNotEmpty()) item { ShelfRow(stringResource(R.string.appears_on), artist.appearsOn) { _, a -> AlbumCard(state, a) } }
  }
}

@Composable
fun PlaylistScreen(state: AppState, id: Long) {
  val data = rememberLoad("playlist", id) { state.api.playlist(id) }
  val pl = data.value
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (pl == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      HeaderBlock(if (pl.trackCount > 0) pl.artwork else null, stringResource(R.string.kind_playlist), pl.name,
        listOfNotNull(pl.owner.ifBlank { null }, stringResource(R.string.count_songs, pl.trackCount), fmtTime(pl.duration)).joinToString(" · ")) {
        PlayShuffle(state, pl.tracks)
        SavePlaylistButton(state, pl.tracks.map { it.id }, pl.name)
      }
    }
    if (pl.tracks.isEmpty()) item { EmptyText(stringResource(R.string.empty_list)) }
    itemsIndexed(pl.tracks, key = { i, t -> "pt-$i-${t.id}" }) { i, _ -> TrackRow(state, pl.tracks, i) }
  }
}

/** Deezer / YouTube Music / Spotify album or playlist with library state per song. */
@Composable
fun OnlineAlbumScreen(state: AppState, item: OnlineItem) {
  val data = rememberLoad("online-album", item.url) {
    val o = if (item.kind == "playlist") state.api.onlinePlaylist(item) else state.api.onlineAlbum(item)
    val header = (o.optJSONObject("album") ?: o.optJSONObject("playlist"))?.let(::parseOnline) ?: item
    header to o.optJSONArray("tracks").mapObjects(::parseOnline)
  }
  val pair = data.value
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (pair == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    val (header, tracks) = pair
    val owned = tracks.count { it.libraryTrackId != null }
    item {
      HeaderBlock(header.artworkUrl, providerName(header.provider), header.title,
        listOfNotNull(header.artist.ifBlank { null }, stringResource(R.string.owned_of, owned, tracks.size)).joinToString(" · ")) {
        val playable = tracks.indexOfFirst { it.libraryTrackId != null || it.previewUrl != null }
        FilledIconButton(onClick = { if (playable >= 0) state.playOnline(tracks, playable) }, enabled = playable >= 0) {
          Icon(FluentIcons.PlayArrow, stringResource(R.string.play))
        }
        header.libraryAlbumId?.let { lid ->
          OutlinedButton(onClick = { state.navigate(Route.Album(lid)) }) {
            Icon(FluentIcons.LibraryMusic, null); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.open_in_library))
          }
        }
        if (state.canDownload && owned < tracks.size) {
          Button(onClick = { state.download(header.copy(kind = item.kind, trackCount = tracks.size)) }) {
            Icon(FluentIcons.Download, null); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.download))
          }
        }
      }
    }
    itemsIndexed(tracks, key = { i, t -> "ot-$i-${t.id}" }) { i, _ -> OnlineTrackRow(state, tracks, i) }
  }
}

@Composable
fun OnlineArtistScreen(state: AppState, id: String?, name: String?) {
  val data = rememberLoad("online-artist", id, name) { state.api.onlineArtist(id, name) }
  val o = data.value
  val parsed = remember(o) {
    o?.let {
      Triple(
        it.optJSONObject("artist")?.let(::parseOnline),
        it.optJSONArray("topTracks").mapObjects(::parseOnline),
        it.optJSONArray("albums").mapObjects(::parseOnline) + it.optJSONArray("singles").mapObjects(::parseOnline),
      )
    }
  }
  val related = remember(o) { o?.optJSONArray("related").mapObjects(::parseOnline) }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (parsed == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    val (artist, top, albums) = parsed
    item {
      HeaderBlock(artist?.artworkUrl, providerName(artist?.provider ?: "deezer"), artist?.title ?: name.orEmpty(),
        stringResource(R.string.missing_albums, o?.optInt("missingAlbums") ?: 0), round = true) {
        artist?.libraryArtistId?.let { lid ->
          OutlinedButton(onClick = { state.navigate(Route.Artist(lid)) }) { Text(stringResource(R.string.open_in_library)) }
        }
      }
    }
    if (top.isNotEmpty()) {
      item { SectionTitle(stringResource(R.string.popular)) }
      itemsIndexed(top.take(10), key = { i, t -> "ott-$i-${t.id}" }) { i, _ -> OnlineTrackRow(state, top, i) }
    }
    if (albums.isNotEmpty()) item { ShelfRow(stringResource(R.string.albums), albums) { i, _ -> OnlineCard(state, albums, i) } }
    if (!related.isNullOrEmpty()) item { ShelfRow(stringResource(R.string.related), related) { i, _ -> OnlineCard(state, related, i) } }
  }
}

fun providerName(provider: String) = when (provider) {
  "deezer" -> "Deezer"
  "youtube" -> "YouTube Music"
  "spotify" -> "Spotify"
  else -> provider
}
