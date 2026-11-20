package com.gharmonize.player.tv

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.mapObjects
import com.gharmonize.player.data.parseOnline
import com.gharmonize.player.ui.Artwork
import com.gharmonize.player.ui.ErrorBox
import com.gharmonize.player.ui.FluentIcons
import com.gharmonize.player.ui.Loading
import com.gharmonize.player.ui.providerName
import com.gharmonize.player.ui.rememberLoad
import com.gharmonize.player.ui.shelfTitle
import org.json.JSONObject

// Online music on the TV: the discover shelves of the home page, online
// albums / playlists / mixes / artists, and online search results. Songs that
// are in the library play in full; the others play as 30 s previews.

/** A card for an online item: albums and lists open, songs play. */
@Composable
fun TvOnlineCard(nav: TvNav, items: List<OnlineItem>, index: Int, modifier: Modifier = Modifier) {
  val item = items[index]
  val owned = item.libraryTrackId != null || (item.kind == "album" && item.libraryComplete)
  val badge: (@Composable () -> Unit)? = when {
    owned -> { { TvTag(stringResource(R.string.in_library), FluentIcons.CheckCircle, strong = true) } }
    item.isMix -> { { TvTag(stringResource(R.string.kind_mix)) } }
    item.kind == "track" && item.previewUrl != null -> { { TvTag(stringResource(R.string.preview), FluentIcons.PlayArrow) } }
    else -> null
  }
  val subtitle = item.artist.ifBlank { providerName(item.provider) }
  TvCard(item.title, subtitle, item.artworkUrl, round = item.kind == "artist", placeholder = if (item.kind == "artist") FluentIcons.Person else FluentIcons.Album,
    modifier = modifier, badge = badge) { nav.openOnline(items, index) }
}

/** One discover shelf from /discover (title from its key). */
@Composable
fun TvDiscoverShelf(nav: TvNav, shelf: JSONObject) {
  val items = remember(shelf) { shelf.optJSONArray("items").mapObjects(::parseOnline) }
  val raw = shelf.optString("title").takeIf { !shelf.isNull("title") && it.isNotBlank() }
  val title = raw ?: shelfTitle(shelf.optString("titleKey"), shelf.optJSONObject("titleVars"))
  TvRow(title, items) { i, _ -> TvOnlineCard(nav, items, i) }
}

/** Online album, playlist or mix: Play (previews / owned songs), Download, songs. */
@Composable
fun TvOnlineList(nav: TvNav, item: OnlineItem) {
  val api = App.instance.api
  val data = rememberLoad("tv-online-list", item.key) {
    val o = if (item.kind == "playlist") api.onlinePlaylist(item) else api.onlineAlbum(item)
    val header = (o.optJSONObject("album") ?: o.optJSONObject("playlist"))?.let(::parseOnline) ?: item
    header to o.optJSONArray("tracks").mapObjects(::parseOnline)
  }
  val pair = data.value
  val playFocus = remember { FocusRequester() }
  LaunchedEffect(item.key, pair != null) { if (pair != null) runCatching { playFocus.requestFocus() } }
  val playing = nav.player.current?.mediaMetadata?.title?.toString()
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 36.dp, end = 36.dp, top = 28.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    data.error?.let { e -> item { ErrorBox(e.message ?: "") { data.reload() } } }
    if (pair == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    val (header, tracks) = pair
    val owned = tracks.count { it.libraryTrackId != null }
    item {
      Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 18.dp)) {
        Artwork(header.artworkUrl ?: item.artworkUrl, Modifier.size(200.dp), shape = RoundedCornerShape(18.dp), size = 512)
        Spacer(Modifier.width(28.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          val kind = if (header.isMix || item.isMix) stringResource(R.string.kind_mix) + " · " + providerName(header.provider) else providerName(header.provider)
          Text(kind, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
          Text(header.title.ifBlank { item.title }, style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
          Text(listOfNotNull(header.artist.ifBlank { null }, stringResource(R.string.owned_of, owned, tracks.size)).joinToString(" · "),
            style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Row(horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(top = 8.dp)) {
            val first = tracks.indexOfFirst { it.libraryTrackId != null || it.previewUrl != null }
            TvButton(stringResource(R.string.play), FluentIcons.PlayArrow, primary = true, modifier = Modifier.focusRequester(playFocus)) { nav.playOnline(tracks, first.coerceAtLeast(0)) }
            header.libraryAlbumId?.let { lid -> TvButton(stringResource(R.string.open_in_library), FluentIcons.LibraryMusic) { nav.go(TvRoute.Album(lid)) } }
            if (nav.canDownload && owned < tracks.size) {
              val queued = nav.queued.contains(item.key)
              TvButton(stringResource(if (queued) R.string.tv_download_queued_short else R.string.download), if (queued) FluentIcons.CheckCircle else FluentIcons.Download) {
                if (!queued) {
                  if (header.downloadable) nav.download(header.copy(kind = item.kind, trackCount = tracks.size), item.key)
                  else nav.downloadEach(tracks, item.key)
                }
              }
            }
          }
        }
      }
    }
    itemsIndexed(tracks, key = { i, t -> "ot-$i-${t.id}" }) { i, t -> TvOnlineTrackRow(t, i + 1, playing != null && playing == t.title, nav) { nav.playOnline(tracks, i) } }
  }
}

/** Online artist: popular songs, albums and similar artists. */
@Composable
fun TvOnlineArtist(nav: TvNav, id: String?, name: String) {
  val data = rememberLoad("tv-online-artist", id, name) { App.instance.api.onlineArtist(id, name) }
  val o = data.value
  val artist = remember(o) { o?.optJSONObject("artist")?.let(::parseOnline) }
  val top = remember(o) { o?.optJSONArray("topTracks").mapObjects(::parseOnline) }
  val albums = remember(o) { o?.optJSONArray("albums").mapObjects(::parseOnline) + o?.optJSONArray("singles").mapObjects(::parseOnline) }
  val related = remember(o) { o?.optJSONArray("related").mapObjects(::parseOnline) }
  val playFocus = remember { FocusRequester() }
  LaunchedEffect(name, o != null) { if (o != null) runCatching { playFocus.requestFocus() } }
  val playing = nav.player.current?.mediaMetadata?.title?.toString()
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 36.dp, end = 36.dp, top = 28.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    data.error?.let { e -> item { ErrorBox(e.message ?: "") { data.reload() } } }
    if (o == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 12.dp)) {
        Artwork(artist?.artworkUrl, Modifier.size(200.dp), shape = CircleShape, size = 512, placeholder = FluentIcons.Person)
        Spacer(Modifier.width(28.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
          Text(providerName(artist?.provider ?: "deezer"), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
          Text(artist?.title ?: name, style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
          o.optInt("missingAlbums").takeIf { it > 0 }?.let { Text(stringResource(R.string.missing_albums, it), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
          Row(horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(top = 8.dp)) {
            TvButton(stringResource(R.string.play), FluentIcons.PlayArrow, primary = true, modifier = Modifier.focusRequester(playFocus)) { nav.playOnline(top, 0) }
            artist?.libraryArtistId?.let { lid -> TvButton(stringResource(R.string.open_in_library), FluentIcons.LibraryMusic) { nav.go(TvRoute.Artist(lid)) } }
          }
          TvArtistBio(artist?.title ?: name, artist?.id?.takeIf { artist.provider == "deezer" })
        }
      }
    }
    if (top.isNotEmpty()) {
      item { TvSectionTitle(stringResource(R.string.popular)) }
      itemsIndexed(top.take(10), key = { i, t -> "ott-$i-${t.id}" }) { i, t -> TvOnlineTrackRow(t, i + 1, playing != null && playing == t.title, nav) { nav.playOnline(top, i) } }
    }
    if (albums.isNotEmpty()) item { TvRow(stringResource(R.string.albums), albums) { i, _ -> TvOnlineCard(nav, albums, i) } }
    if (related.isNotEmpty()) item { TvRow(stringResource(R.string.related), related) { i, _ -> TvOnlineCard(nav, related, i) } }
  }
}

@Composable
fun TvSectionTitle(text: String) {
  Text(text, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 8.dp, top = 12.dp, bottom = 6.dp))
}
