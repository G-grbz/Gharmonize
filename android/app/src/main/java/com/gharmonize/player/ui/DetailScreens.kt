package com.gharmonize.player.ui

import androidx.compose.foundation.layout.height
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.activity.compose.BackHandler
import kotlinx.coroutines.launch
import org.json.JSONObject
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.material3.IconButton
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
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
  val missing = rememberLoad("album-missing", id) { runCatching { state.api.albumMissing(id) }.getOrNull() }
  val album = data.value
  val selection = rememberSongSelection("album-$id")
  SelectionScaffold(state, album?.tracks.orEmpty(), selection, album?.title.orEmpty()) { pad ->
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = pad)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (album == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      HeaderBlock(album.artwork, stringResource(R.string.kind_album), album.title,
        listOfNotNull(album.artist.ifBlank { null }, album.year?.toString(), stringResource(R.string.count_songs, album.trackCount), fmtTime(album.duration)).joinToString(" · ")) {
        PlayShuffle(state, album.tracks)
        SavePlaylistButton(state, album.tracks.map { it.id }, album.title)
        if (album.artists.size > 1) album.artists.forEach { a -> OutlinedButton(onClick = { state.navigate(Route.Artist(a.id)) }) { Text(a.name) } }
        else album.artistId?.let { aid -> OutlinedButton(onClick = { state.navigate(Route.Artist(aid)) }) { Text(stringResource(R.string.go_to_artist)) } }
      }
    }
    itemsIndexed(album.tracks, key = { _, t -> "at-${t.id}" }) { i, t -> TrackRow(state, album.tracks, i, showArt = false, number = t.trackNo ?: (i + 1), selection = selection) }
    // Songs of this album that are not in the library yet.
    val gaps = missing.value
    if (gaps != null && gaps.found && gaps.missing.isNotEmpty()) {
      item {
        SectionTitle(stringResource(R.string.album_missing_title), subtitle = stringResource(R.string.album_missing_text, gaps.missing.size, gaps.total))
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          if (state.canDownload) Button(onClick = { state.downloadAll(gaps.missing, title = album.title) }) {
            Icon(FluentIcons.Download, null, modifier = Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.download_missing, gaps.missing.size))
          }
          gaps.onlineAlbum?.let { online -> OutlinedButton(onClick = { state.navigate(Route.OnlineAlbum(online)) }) { Text(stringResource(R.string.full_album)) } }
        }
      }
      itemsIndexed(gaps.missing, key = { i, t -> "miss-$i-${t.id}" }) { i, _ -> OnlineTrackRow(state, gaps.missing, i) }
    }
  }
}
}

/** Online rows of an artist page (Deezer): the same rows as the online page. */
private class OnlineArtistRows(o: JSONObject) {
  val artist = o.optJSONObject("artist")?.let(::parseOnline)
  val provider = providerName(artist?.provider ?: "deezer")
  val fans = o.optJSONObject("artist")?.optLong("fans") ?: 0L
  val top = o.optJSONArray("topTracks").mapObjects(::parseOnline)
  val albums = o.optJSONArray("albums").mapObjects(::parseOnline)
  val singles = o.optJSONArray("singles").mapObjects(::parseOnline)
  val related = o.optJSONArray("related").mapObjects(::parseOnline)
}

/**
 * One artist page for library and online: the library rows plus every row of
 * the online page (popular, albums, singles & EPs, related). [preOnline] is
 * the online answer when the online page already loaded it.
 */
@Composable
fun ArtistScreen(state: AppState, id: Long, preOnline: JSONObject? = null) {
  val data = rememberLoad("artist", id) { state.api.artist(id) }
  val onlineName = data.value?.name
  val onlineLoad = rememberLoad("artist-online", id, onlineName, preOnline != null) {
    preOnline ?: onlineName?.let { n -> runCatching { state.api.onlineArtist(null, n) }.getOrNull() }
  }
  val online = remember(onlineLoad.value) { onlineLoad.value?.let(::OnlineArtistRows) }
  var sort by rememberSaveable(id) { mutableStateOf("album") }
  val songs = rememberLoad("artist-songs", id, sort) { state.api.artistTracks(id, sort) }
  // "All songs" → Online: loaded the first time the tab is opened.
  var onlineTab by rememberSaveable(id) { mutableStateOf(false) }
  var onlineOpened by rememberSaveable(id) { mutableStateOf(false) }
  val onlineSongsLoad = rememberLoad("artist-online-songs", id, onlineOpened, data.value?.name) {
    val n = data.value?.name
    if (onlineOpened && n != null) state.api.onlineArtistTracks(n) else null
  }
  val onlinePicked = remember(id) { androidx.compose.runtime.mutableStateListOf<String>() }
  val selection = rememberSongSelection(id)
  BackHandler(enabled = selection.active) { selection.stop() }
  val artist = data.value
  var followed by remember(id, artist?.favorite) { mutableStateOf(artist?.favorite == true) }
  var followBusy by remember(id) { mutableStateOf(false) }
  Box(Modifier.fillMaxSize()) {
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = if (selection.active) 140.dp else 24.dp)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (artist == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      val fans = online?.fans?.takeIf { it > 0 }?.let { stringResource(R.string.fans_count, java.text.NumberFormat.getIntegerInstance().format(it)) }
      // Biography inside the header, under the buttons (waits for the online
      // answer so it can use the exact Deezer artist).
      HeaderBlock(artist.artwork, stringResource(R.string.kind_artist), artist.name,
        listOfNotNull(stringResource(R.string.count_songs, artist.trackCount), fans).joinToString(" · "), round = true,
        footer = { if (!onlineLoad.loading) ArtistBio(state, artist.name, online?.artist?.takeIf { it.provider == "deezer" }?.id) }) {
        // Play / shuffle every song once the full list is there.
        PlayShuffle(state, songs.value ?: (artist.topTracks + artist.singles))
        // Follow: new albums and singles of this artist are announced.
        val toggleFollow: () -> Unit = {
          val next = !followed
          followBusy = true
          state.scope.launch {
            try {
              state.api.setArtistFollowed(artist.id, next)
              followed = next
              if (next) state.messageRes(R.string.artist_followed, artist.name)
            } catch (e: Exception) { state.message(state.errorText(e)) }
            followBusy = false
          }
        }
        if (followed) androidx.compose.material3.FilledTonalButton(onClick = toggleFollow, enabled = !followBusy) { Text(stringResource(R.string.follow_following)) }
        else OutlinedButton(onClick = toggleFollow, enabled = !followBusy) { Text(stringResource(R.string.follow_follow)) }
      }
    }
    // "Complete the discography" (only when something is missing).
    onlineLoad.value?.let { o -> item(key = "gaps") { DiscographyCard(state, o, artist.name, quietWhenComplete = true) } }
    if (artist.topTracks.isNotEmpty()) {
      item { SectionTitle(stringResource(R.string.popular)) }
      itemsIndexed(artist.topTracks, key = { _, t -> "top-${t.id}" }) { i, _ -> TrackRow(state, artist.topTracks, i, selection = selection) }
    }
    if (artist.albums.isNotEmpty()) item { ShelfRow(stringResource(R.string.albums), artist.albums) { _, a -> AlbumCard(state, a) } }
    // Online rows between the discography and the (long) song list.
    if (online != null) {
      val p = online.provider
      if (online.top.isNotEmpty()) {
        item { SectionTitle(stringResource(R.string.popular) + " · " + p) }
        val top = online.top.take(10)
        itemsIndexed(top, key = { i, t -> "ott-$i-${t.id}" }) { i, _ -> OnlineTrackRow(state, top, i) }
      }
      if (online.albums.isNotEmpty()) item { ShelfRow(stringResource(R.string.albums) + " · " + p, online.albums) { i, _ -> OnlineCard(state, online.albums, i) } }
      if (online.singles.isNotEmpty()) item { ShelfRow(stringResource(R.string.singles_eps) + " · " + p, online.singles) { i, _ -> OnlineCard(state, online.singles, i) } }
    }
    if (artist.trackCount > 0) artistSongsSection(state, artist.trackCount, songs, sort, { sort = it }, selection,
      onlineTab = onlineTab,
      onTab = if (online?.artist?.provider == "deezer") { on -> onlineTab = on; if (on) onlineOpened = true } else null,
      online = OnlineSongs(onlineSongsLoad, onlinePicked, artist.name))
    if (artist.singles.isNotEmpty()) {
      item { SectionTitle(stringResource(R.string.singles)) }
      itemsIndexed(artist.singles, key = { _, t -> "sg-${t.id}" }) { i, _ -> TrackRow(state, artist.singles, i, selection = selection) }
    }
    if (artist.appearsOn.isNotEmpty()) item { ShelfRow(stringResource(R.string.appears_on), artist.appearsOn) { _, a -> AlbumCard(state, a) } }
    if (online != null && online.related.isNotEmpty()) item { ShelfRow(stringResource(R.string.related), online.related) { i, _ -> OnlineCard(state, online.related, i) } }
  }
  // Popular songs and singles can be picked too (before "All songs" loads).
  if (selection.active) SongSelectionBar(state, (songs.value.orEmpty() + artist?.topTracks.orEmpty() + artist?.singles.orEmpty()).distinctBy { it.id },
    selection, artist?.name.orEmpty(), Modifier.align(Alignment.BottomCenter))
  }
}

@Composable
fun PlaylistScreen(state: AppState, id: Long) {
  val data = rememberLoad("playlist", id) { state.api.playlist(id) }
  var round by remember { mutableIntStateOf(0) }
  val suggestions = rememberLoad("playlist-suggest", id, round) { runCatching { state.api.playlistSuggestions(id, round) }.getOrNull() }
  val added = remember(round) { mutableStateListOf<String>() }
  val pl = data.value
  val selection = rememberSongSelection("playlist-$id")
  // Your own playlist: the picked songs can be taken out of it.
  val removeFromPlaylist: ((List<com.gharmonize.player.data.Track>) -> Unit)? =
    if (pl?.editable == true) { picked -> state.removeFromPlaylist(id, picked) { data.reload() } } else null
  SelectionScaffold(state, pl?.tracks.orEmpty(), selection, pl?.name.orEmpty(), removeFromPlaylist) { pad ->
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = pad)) {
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
    itemsIndexed(pl.tracks, key = { i, t -> "pt-$i-${t.id}" }) { i, _ -> TrackRow(state, pl.tracks, i, selection = selection) }
    // "Goes well with this playlist" (only on your own playlists).
    val list = suggestions.value
    if (pl.editable && !list.isNullOrEmpty()) {
      item {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Box(Modifier.weight(1f)) {
            SectionTitle(stringResource(R.string.suggest_title), subtitle = stringResource(if (state.canDownload) R.string.suggest_hint_download else R.string.suggest_hint))
          }
          IconButton(onClick = { round++ }) { Icon(FluentIcons.Refresh, stringResource(R.string.suggest_refresh)) }
        }
      }
      itemsIndexed(list, key = { i, o -> "ps-$round-$i-${o.url}" }) { i, o ->
        if (o.url !in added) SuggestionRow(state, list, i) {
          state.addSuggestion(pl.id, o) { ok -> if (ok) { added.add(o.url); if (state.withDownload(o).libraryTrackId != null) data.reload() } }
        }
      }
    }
  }
}
}

/** Deezer / YouTube Music / Spotify album or playlist with library state per song. */
@Composable
fun OnlineAlbumScreen(state: AppState, item: OnlineItem) {
  var followed by remember(item.key) { mutableStateOf<Long?>(null) }
  var following by remember(item.key) { mutableStateOf(false) }
  val data = rememberLoad("online-album", item.key) {
    val o = if (item.kind == "playlist") state.api.onlinePlaylist(item) else state.api.onlineAlbum(item)
    val header = (o.optJSONObject("album") ?: o.optJSONObject("playlist"))?.let(::parseOnline) ?: item
    followed = o.optJSONObject("follow")?.optLong("playlistId")?.takeIf { it > 0 }
    header to o.optJSONArray("tracks").mapObjects(::parseOnline)
  }
  val pair = data.value
  // Swipe a song to the right (or long press) to select songs.
  val selection = rememberOnlineSelection(item.key)
  OnlineSelectionScaffold(state, pair?.second.orEmpty(), selection, pair?.first?.title.orEmpty()) { pad ->
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = pad)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (pair == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    val (header, tracks) = pair
    val owned = tracks.count { it.libraryTrackId != null }
    item {
      val kindLabel = if (header.isMix) stringResource(R.string.kind_mix) + " · " + providerName(header.provider) else providerName(header.provider)
      HeaderBlock(header.artworkUrl, kindLabel, header.title,
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
        // Follow: kept in sync with a player playlist every day.
        if (item.kind == "playlist" && header.downloadable) {
          val playlistId = followed
          OutlinedButton(enabled = !following, onClick = {
            if (playlistId != null) state.navigate(Route.Playlist(playlistId))
            else {
              following = true
              state.scope.launch {
                try {
                  val f = state.api.followPlaylist(header)
                  followed = f.optLong("playlistId").takeIf { it > 0 }
                  state.messageRes(R.string.follow_started, header.title)
                } catch (e: Exception) { state.message(state.errorText(e)) }
                following = false
              }
            }
          }) { Text(stringResource(if (playlistId != null) R.string.follow_following else R.string.follow_follow)) }
        }
        if (state.canDownload && owned < tracks.size) {
          // Partly in the library: only the missing songs are downloaded.
          // Mixes without a downloadable link: each missing song on its own.
          val missing = tracks.filter { it.libraryTrackId == null }
          val partial = owned > 0
          Button(onClick = {
            if (header.downloadable) state.download(header.copy(kind = item.kind, trackCount = tracks.size), only = if (partial) missing else null)
            else state.downloadAll(tracks, title = header.title)
          }) {
            Icon(FluentIcons.Download, null); Spacer(Modifier.width(6.dp))
            Text(if (partial) stringResource(R.string.download_missing, missing.size) else stringResource(R.string.download))
          }
        }
      }
    }
    itemsIndexed(tracks, key = { i, t -> "ot-$i-${t.id}" }) { i, _ -> OnlineTrackRow(state, tracks, i, selection = selection) }
  }
  }
}

@Composable
fun OnlineArtistScreen(state: AppState, id: String?, name: String?) {
  val data = rememberLoad("online-artist", id, name) { state.api.onlineArtist(id, name) }
  val o = data.value
  val rows = remember(o) { o?.let(::OnlineArtistRows) }
  // In the library: one page for both.
  rows?.artist?.libraryArtistId?.let { lid -> ArtistScreen(state, lid, preOnline = o); return }
  var following by remember(o) { mutableStateOf(o?.optJSONObject("artist")?.optJSONObject("follow")?.optBoolean("following") == true) }
  var followBusy by remember(o) { mutableStateOf(false) }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (rows == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    val artist = rows.artist
    val title = artist?.title ?: name.orEmpty()
    item {
      val fans = rows.fans.takeIf { it > 0 }?.let { stringResource(R.string.fans_count, java.text.NumberFormat.getIntegerInstance().format(it)) }
      HeaderBlock(artist?.artworkUrl, stringResource(R.string.kind_artist) + " · " + rows.provider, title,
        listOfNotNull(fans).joinToString(" · "), round = true,
        footer = { ArtistBio(state, title, artist?.id?.takeIf { artist.provider == "deezer" }) }) {
        val playable = rows.top.indexOfFirst { it.libraryTrackId != null || it.previewUrl != null }
        if (playable >= 0) FilledIconButton(onClick = { state.playOnline(rows.top, playable) }) { Icon(FluentIcons.PlayArrow, stringResource(R.string.play)) }
        // Follow works for artists with no songs here yet too (new releases are announced).
        val toggle: () -> Unit = {
          val next = !following
          followBusy = true
          state.scope.launch {
            try {
              following = state.api.setOnlineArtistFollowed(title, artist?.id?.takeIf { artist.provider == "deezer" }, next)
              if (following) state.messageRes(R.string.artist_followed, title) else state.messageRes(R.string.artist_unfollowed, title)
            } catch (e: Exception) { state.message(state.errorText(e)) }
            followBusy = false
          }
        }
        if (following) androidx.compose.material3.FilledTonalButton(onClick = toggle, enabled = !followBusy) { Text(stringResource(R.string.follow_following)) }
        else OutlinedButton(onClick = toggle, enabled = !followBusy) { Text(stringResource(R.string.follow_follow)) }
      }
    }
    // Missing albums and popular songs (the header used to only count albums).
    o?.let { json -> item(key = "gaps") { DiscographyCard(state, json, title) } }
    if (rows.top.isNotEmpty()) {
      item { SectionTitle(stringResource(R.string.popular)) }
      val top = rows.top.take(10)
      itemsIndexed(top, key = { i, t -> "ott-$i-${t.id}" }) { i, _ -> OnlineTrackRow(state, top, i) }
    }
    if (rows.albums.isNotEmpty()) item { ShelfRow(stringResource(R.string.albums), rows.albums) { i, _ -> OnlineCard(state, rows.albums, i) } }
    if (rows.singles.isNotEmpty()) item { ShelfRow(stringResource(R.string.singles_eps), rows.singles) { i, _ -> OnlineCard(state, rows.singles, i) } }
    if (rows.related.isNotEmpty()) item { ShelfRow(stringResource(R.string.related), rows.related) { i, _ -> OnlineCard(state, rows.related, i) } }
  }
}

fun providerName(provider: String) = when (provider) {
  "deezer" -> "Deezer"
  "youtube" -> "YouTube Music"
  "spotify" -> "Spotify"
  "apple" -> "Apple Music"
  else -> provider
}

/**
 * Artist biography inside the artist header: four lines, "show more" opens
 * the whole text in a dialog; the source opens the article.
 */
@Composable
fun ArtistBio(state: AppState, name: String, deezerId: String?) {
  val lang = java.util.Locale.getDefault().language
  // Shown from memory at once when the header is built again after
  // scrolling away (it used to load again from nothing and push the page).
  val bio = rememberLoad("artist-bio", name, deezerId, initial = { state.api.cachedArtistBio(name, deezerId, lang) }) {
    state.api.cachedArtistBio(name, deezerId, lang) ?: runCatching { state.api.artistBio(name, deezerId, lang) }.getOrNull()
  }.value ?: return
  val text = bio.optString("text").ifBlank { return }
  var open by rememberSaveable(name) { mutableStateOf(false) }
  var overflow by rememberSaveable(name) { mutableStateOf(false) }
  val uri = androidx.compose.ui.platform.LocalUriHandler.current
  val url = bio.optString("url")
  val source = stringResource(R.string.bio_source, bio.optString("source", "Wikipedia"), bio.optString("lang").uppercase())
  Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
    Text(stringResource(R.string.artist_bio).uppercase(), style = MaterialTheme.typography.labelMedium,
      color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(6.dp))
    Text(text.replace(Regex("\\s+"), " "), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
      maxLines = 4, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
      onTextLayout = { overflow = it.hasVisualOverflow })
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      if (overflow) androidx.compose.material3.TextButton(onClick = { open = true }, contentPadding = PaddingValues(horizontal = 0.dp)) { Text(stringResource(R.string.show_more)) }
      Spacer(Modifier.weight(1f))
      Text(source, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.clickable(enabled = url.startsWith("https://")) { runCatching { uri.openUri(url) } }.padding(vertical = 12.dp))
    }
  }
  if (open) androidx.compose.material3.AlertDialog(
    onDismissRequest = { open = false },
    title = { Text(name) },
    text = {
      Column(Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState())) {
        Text(text, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(12.dp))
        Text(source, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    },
    confirmButton = { androidx.compose.material3.TextButton(onClick = { open = false }) { Text(stringResource(R.string.close)) } },
    dismissButton = if (url.startsWith("https://")) { { androidx.compose.material3.TextButton(onClick = { runCatching { uri.openUri(url) } }) { Text("Wikipedia") } } } else null,
  )
}
