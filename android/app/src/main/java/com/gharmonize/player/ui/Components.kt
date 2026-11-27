package com.gharmonize.player.ui

import android.annotation.SuppressLint
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gharmonize.player.R
import com.gharmonize.player.data.Album
import com.gharmonize.player.data.Artist
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.Track
import org.json.JSONObject

fun fmtTime(seconds: Double): String {
  val s = (seconds + 0.5).toLong().coerceAtLeast(0)
  val h = s / 3600
  val m = (s % 3600) / 60
  val sec = s % 60
  return if (h > 0) "%d:%02d:%02d".format(h, m, sec) else "%d:%02d".format(m, sec)
}

/** Server shelf titles: "recentlyPlayed" → shelf_recentlyPlayed, "player.discover.fansOf" → disc_fansOf. */
@SuppressLint("DiscouragedApi")
@Composable
fun shelfTitle(key: String?, vars: JSONObject? = null, fallback: String = ""): String {
  val ctx = LocalContext.current
  if (key.isNullOrBlank()) return fallback
  val name = if (key.startsWith("player.discover.")) "disc_" + key.removePrefix("player.discover.") else "shelf_$key"
  val id = ctx.resources.getIdentifier(name, "string", ctx.packageName)
  if (id == 0) return fallback.ifBlank { key }
  val arg = vars?.let { it.optString("artist").ifBlank { it.optString("genre").ifBlank { it.optString("country") } } } ?: ""
  return ctx.getString(id, arg)
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier, subtitle: String? = null) {
  Column(modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
    Text(text, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
    if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

@Composable
fun Loading(modifier: Modifier = Modifier) {
  Box(modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
fun ErrorBox(text: String, onRetry: () -> Unit) {
  Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Icon(FluentIcons.ErrorOutline, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(40.dp))
    Text(text, style = MaterialTheme.typography.bodyMedium)
    OutlinedButton(onClick = onRetry) {
      Icon(FluentIcons.Refresh, null)
      Spacer(Modifier.width(6.dp))
      Text(stringResource(R.string.retry))
    }
  }
}

@Composable
fun EmptyText(text: String) {
  Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
    Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

// ---- cards ----------------------------------------------------------------------------

/**
 * Cover layout, the same as the web cards: status badges are tabs cut into
 * the top corners of the cover (start = in library, end = Mix) and the
 * action (download) sits bottom-start.
 */
@Composable
fun Card(
  title: String, subtitle: String, art: String?, round: Boolean = false,
  start: (@Composable () -> Unit)? = null, end: (@Composable () -> Unit)? = null, action: (@Composable () -> Unit)? = null,
  onClick: () -> Unit
) {
  Column(Modifier.width(140.dp).clickable(onClick = onClick).padding(6.dp)) {
    Box {
      Artwork(art, Modifier.fillMaxWidth().aspectRatio(1f), shape = if (round) CircleShape else MaterialTheme.shapes.medium, size = 300,
        placeholder = if (round) FluentIcons.Person else FluentIcons.Album)
      if (start != null) Box(Modifier.align(Alignment.TopStart).padding(if (round) 4.dp else 0.dp)) { start() }
      if (end != null) Box(Modifier.align(Alignment.TopEnd).padding(if (round) 4.dp else 0.dp)) { end() }
      if (action != null) Box(Modifier.align(Alignment.BottomStart).padding(6.dp)) { action() }
    }
    Spacer(Modifier.height(6.dp))
    Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
  }
}

@Composable
fun <T> ShelfRow(title: String, items: List<T>, subtitle: String? = null, card: @Composable (Int, T) -> Unit) {
  if (items.isEmpty()) return
  SectionTitle(title, subtitle = subtitle)
  LazyRow(contentPadding = PaddingValues(horizontal = 10.dp)) {
    itemsIndexed(items) { i, item -> card(i, item) }
  }
}

@Composable
fun AlbumCard(state: AppState, album: Album, onPick: (() -> Unit)? = null) =
  Card(album.title, listOfNotNull(album.year?.toString(), album.artist.ifBlank { null }).joinToString(" · "), album.artwork) {
    onPick?.invoke()
    state.navigate(Route.Album(album.id))
  }

@Composable
fun ArtistCard(state: AppState, artist: Artist, onPick: (() -> Unit)? = null) =
  // Followed from an online page, no songs here yet: open the online page.
  Card(artist.name, stringResource(R.string.kind_artist), artist.artwork, round = true) {
    onPick?.invoke()
    state.navigate(if (artist.onlineOnly) Route.OnlineArtist(null, artist.name) else Route.Artist(artist.id))
  }

@Composable
fun TrackCard(state: AppState, tracks: List<Track>, index: Int, onPick: (() -> Unit)? = null) {
  val t = tracks[index]
  Card(t.title, t.artist, t.artwork) { onPick?.invoke(); state.player.play(tracks, index) }
}

@Composable
fun OnlineCard(state: AppState, items: List<OnlineItem>, index: Int, onPick: (() -> Unit)? = null) {
  val item = items[index]
  val owned = item.libraryTrackId != null || (item.kind == "album" && item.libraryComplete)
  val round = item.kind == "artist"
  val start: (@Composable () -> Unit)? = when {
    owned -> { { CornerBadge(CornerSide.Start, round) { Icon(FluentIcons.Check, stringResource(R.string.in_library), modifier = Modifier.size(14.dp)) } } }
    item.kind == "track" && !item.previewUrl.isNullOrBlank() -> { { CornerBadge(CornerSide.Start, round, color = Color.Black.copy(alpha = 0.62f), content = Color.White) { Text(stringResource(R.string.preview), fontSize = 11.sp, fontWeight = FontWeight.ExtraBold) } } }
    else -> null
  }
  val end: (@Composable () -> Unit)? = if (item.isMix) { { CornerBadge(CornerSide.End, round) { Text(stringResource(R.string.mix_kind), fontSize = 11.sp, fontWeight = FontWeight.ExtraBold) } } } else null
  val action: (@Composable () -> Unit)? =
    if (!owned && state.canDownload && item.downloadable && item.kind in setOf("track", "album", "playlist")) { { DownloadButton(state, item, small = true) } } else null
  Card(item.title, item.artist, item.artworkUrl, round = round, start = start, end = end, action = action) {
    onPick?.invoke()
    when (item.kind) {
      "album", "playlist" -> state.navigate(Route.OnlineAlbum(item))
      "artist" -> if (item.libraryArtistId != null) state.navigate(Route.Artist(item.libraryArtistId))
        else state.navigate(Route.OnlineArtist(if (item.provider == "deezer") item.id else null, item.title))
      else -> state.playOnline(items, index)
    }
  }
}

enum class CornerSide { Start, End }

/** A tab cut into a top corner of a square cover (a pill on round covers). */
@Composable
fun CornerBadge(
  side: CornerSide, round: Boolean = false,
  color: Color = MaterialTheme.colorScheme.primary, content: Color = MaterialTheme.colorScheme.onPrimary,
  body: @Composable () -> Unit
) {
  val outer = 10.dp
  val inner = 12.dp
  val shape = when {
    round -> CircleShape
    side == CornerSide.Start -> RoundedCornerShape(topStart = outer, bottomEnd = inner)
    else -> RoundedCornerShape(topEnd = outer, bottomStart = inner)
  }
  Surface(shape = shape, color = color, contentColor = content) {
    Box(Modifier.height(24.dp).widthIn(min = 28.dp).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) { body() }
  }
}

@Composable
fun OwnedBadge() {
  Surface(shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
    Icon(FluentIcons.CheckCircle, stringResource(R.string.in_library), tint = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.size(22.dp).padding(2.dp))
  }
}

/** Download control; shows live progress for downloads started on this phone. */
@Composable
fun DownloadButton(state: AppState, item: OnlineItem, small: Boolean = false) {
  val row = state.downloadsByUrl[item.url]
  val status = row?.status ?: item.downloadStatus
  val progress = row?.progress ?: item.downloadProgress
  val active = status in setOf("queued", "resolving", "downloading", "indexing")
  val done = status == "completed" || status == "exists"
  Surface(shape = CircleShape, color = if (small) MaterialTheme.colorScheme.surface.copy(alpha = 0.85f) else MaterialTheme.colorScheme.surfaceVariant) {
    Box(Modifier.size(if (small) 30.dp else 36.dp).clickable(enabled = !active && !done) { state.download(item) }, contentAlignment = Alignment.Center) {
      when {
        active -> CircularProgressIndicator(progress = { (progress / 100f).coerceIn(0.05f, 1f) }, modifier = Modifier.size(if (small) 22.dp else 26.dp), strokeWidth = 3.dp)
        done -> Icon(FluentIcons.CheckCircle, stringResource(R.string.in_library), tint = MaterialTheme.colorScheme.primary)
        else -> Icon(FluentIcons.Download, stringResource(R.string.download), modifier = Modifier.size(if (small) 18.dp else 22.dp))
      }
    }
  }
}

// ---- rows -----------------------------------------------------------------------------------

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TrackRow(state: AppState, tracks: List<Track>, index: Int, showArt: Boolean = true, number: Int? = null, selection: SongSelection? = null, playSingle: Boolean = false, onPick: (() -> Unit)? = null) {
  val t = tracks[index]
  val playingId = state.player.current?.mediaId
  val isCurrent = playingId == "t:${t.id}"
  var menu by remember { mutableStateOf(false) }
  var favorite by remember(t.id, t.favorite) { mutableStateOf(t.favorite) }
  val selecting = selection?.active == true
  SwipeToSelect(selection, t.id) {
  Row(
    Modifier.fillMaxWidth()
      .combinedClickable(
        // With a selection: long press (or a swipe to the right) starts
        // selecting, taps then toggle.
        onClick = {
          if (selecting) selection?.toggle(t.id)
          else {
            onPick?.invoke()
            if (playSingle) state.player.play(listOf(t)) else state.player.play(tracks, index)
          }
        },
        onLongClick = { when { selecting -> selection?.toggle(t.id); selection != null -> selection.start(t.id); else -> menu = true } },
      )
      .padding(start = if (selecting) 4.dp else 16.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (selecting) androidx.compose.material3.Checkbox(checked = t.id in selection!!.ids, onCheckedChange = { selection.toggle(t.id) })
    if (number != null) {
      Text("$number", modifier = Modifier.width(28.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
    if (showArt) {
      Artwork(t.artwork, Modifier.size(48.dp), size = 128)
      Spacer(Modifier.width(12.dp))
    }
    Column(Modifier.weight(1f)) {
      Text(t.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge,
        color = if (isCurrent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
      Row(verticalAlignment = Alignment.CenterVertically) {
        OnPhoneMark(t.id)
        Text(listOfNotNull(t.artist.ifBlank { null }, if (t.duration > 0) fmtTime(t.duration) else null).joinToString(" · "),
          maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
    if (!selecting) {
      IconButton(onClick = { state.setFavorite(t.id, !favorite) { favorite = it }; favorite = !favorite }) {
        Icon(if (favorite) FluentIcons.Favorite else FluentIcons.FavoriteBorder, stringResource(R.string.like),
          tint = if (favorite) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
      }
      Box {
        IconButton(onClick = { menu = true }) { Icon(FluentIcons.MoreVert, stringResource(R.string.more)) }
        TrackMenu(state, t, menu) { menu = false }
      }
    }
  }
  }
}

@Composable
fun TrackMenu(state: AppState, t: Track, expanded: Boolean, onDismiss: () -> Unit) {
  var save by remember { mutableStateOf(false) }
  var refresh by remember { mutableStateOf(false) }
  if (save) SavePlaylistDialog(state, listOf(t.id), onDismiss = { save = false })
  if (refresh) RefreshOnlineDialog(state, RefreshTarget(t.id, t.title, t.artist, t.duration, t.artwork), onDismiss = { refresh = false })
  DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
    DropdownMenuItem(text = { Text(stringResource(R.string.play_next)) }, onClick = { state.player.playNext(t); state.messageRes(R.string.queued_next, t.title); onDismiss() })
    DropdownMenuItem(text = { Text(stringResource(R.string.add_to_queue)) }, onClick = { state.player.addToQueue(t); state.messageRes(R.string.queued, t.title); onDismiss() })
    DropdownMenuItem(text = { Text(stringResource(R.string.save_to_playlist)) }, onClick = { save = true; onDismiss() })
    val ctx = androidx.compose.ui.platform.LocalContext.current
    if (com.gharmonize.player.playback.Offline.isOnPhone(t.id)) {
      DropdownMenuItem(text = { Text(stringResource(R.string.offline_remove_one)) }, onClick = { com.gharmonize.player.playback.Offline.remove(ctx, listOf(t.id)); onDismiss() })
    } else {
      DropdownMenuItem(text = { Text(stringResource(R.string.offline_save)) }, onClick = {
        if (com.gharmonize.player.playback.Offline.download(ctx, listOf(t)) > 0) state.messageRes(R.string.offline_queued, 1)
        onDismiss()
      })
    }
    t.albumId?.let { id -> DropdownMenuItem(text = { Text(stringResource(R.string.go_to_album)) }, onClick = { state.navigate(Route.Album(id)); onDismiss() }) }
    // "A, B": one entry per artist.
    if (t.artists.size > 1) t.artists.forEach { a ->
      DropdownMenuItem(text = { Text(stringResource(R.string.go_to_artist_named, a.name)) }, onClick = { state.navigate(Route.Artist(a.id)); onDismiss() })
    } else t.artistId?.let { id -> DropdownMenuItem(text = { Text(stringResource(R.string.go_to_artist)) }, onClick = { state.navigate(Route.Artist(id)); onDismiss() }) }
    // Admins: replace the file with a version picked online.
    if (state.canRefreshOnline) DropdownMenuItem(text = { Text(stringResource(R.string.refresh_online)) }, onClick = { refresh = true; onDismiss() })
  }
}

/**
 * Online track row: owned → play, preview → 30 s clip, otherwise download.
 * With a [selection]: long press or a swipe to the right starts selecting.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun OnlineTrackRow(state: AppState, items: List<OnlineItem>, index: Int, playSingle: Boolean = false, onPick: (() -> Unit)? = null, selection: OnlineSelection? = null) {
  val item = state.withDownload(items[index])
  val owned = item.libraryTrackId != null
  val selecting = selection?.active == true
  val pickThis: () -> Unit = { if (selection?.active == true) selection.toggle(index) else selection?.start(index) }
  val row: @Composable () -> Unit = {
  Row(
    Modifier.fillMaxWidth()
      .combinedClickable(
        onClick = {
          if (selecting) selection?.toggle(index)
          else { onPick?.invoke(); if (playSingle) state.playOnline(listOf(item), 0) else state.playOnline(items, index) }
        },
        onLongClick = if (selection != null) pickThis else null,
      )
      .padding(start = if (selecting) 4.dp else 16.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (selecting) androidx.compose.material3.Checkbox(checked = index in selection!!.picked, onCheckedChange = { selection.toggle(index) })
    Artwork(item.artworkUrl, Modifier.size(48.dp), size = 128)
    Spacer(Modifier.width(12.dp))
    Column(Modifier.weight(1f)) {
      Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge,
        color = if (owned) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f))
      val extra = when {
        owned -> stringResource(R.string.in_library)
        item.previewUrl != null -> stringResource(R.string.preview)
        else -> null
      }
      Text(listOfNotNull(item.artist.ifBlank { null }, extra).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis,
        style = MaterialTheme.typography.bodySmall, color = if (owned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
    when {
      owned -> OwnedBadge()
      selecting -> {}
      state.canDownload -> DownloadButton(state, item)
    }
    // Admins: the library copy of an owned song can be replaced with another version.
    val trackId = item.libraryTrackId
    if (trackId != null && state.canRefreshOnline && !selecting) {
      var menu by remember { mutableStateOf(false) }
      var refresh by remember { mutableStateOf(false) }
      if (refresh) RefreshOnlineDialog(state, RefreshTarget(trackId, item.title, item.artist, item.duration, item.artworkUrl), onDismiss = { refresh = false })
      Box {
        IconButton(onClick = { menu = true }) { Icon(FluentIcons.MoreVert, stringResource(R.string.more)) }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
          DropdownMenuItem(text = { Text(stringResource(R.string.refresh_online)) }, onClick = { refresh = true; menu = false })
        }
      }
    }
  }
  }
  if (selection == null) row() else SwipeToPick(picked = index in selection.picked, key = index, onPick = pickThis, content = row)
}

/** Suggestion row: tap plays (library or preview), + adds it to the playlist. */
@Composable
fun SuggestionRow(state: AppState, items: List<OnlineItem>, index: Int, onAdd: () -> Unit) {
  val item = state.withDownload(items[index])
  val owned = item.libraryTrackId != null
  val row = state.downloadsByUrl[item.url]
  val pending = row != null && !owned
  Row(
    Modifier.fillMaxWidth().clickable { state.playOnline(items, index) }.padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Artwork(item.artworkUrl, Modifier.size(48.dp), size = 128)
    Spacer(Modifier.width(12.dp))
    Column(Modifier.weight(1f)) {
      Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
      Text(listOfNotNull(item.artist.ifBlank { null }, stringResource(if (owned) R.string.in_library else R.string.suggest_new)).joinToString(" · "),
        maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall,
        color = if (owned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
    when {
      pending -> DownloadButton(state, item)
      owned || state.canDownload -> IconButton(onClick = onAdd) { Icon(FluentIcons.Add, stringResource(R.string.suggest_add), tint = MaterialTheme.colorScheme.primary) }
    }
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun HeaderBlock(art: String?, kind: String, title: String, meta: String, round: Boolean = false, footer: (@Composable () -> Unit)? = null, actions: @Composable () -> Unit) {
  Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    Artwork(art, Modifier.size(200.dp), shape = if (round) CircleShape else MaterialTheme.shapes.large, size = 600,
      placeholder = if (round) FluentIcons.Person else FluentIcons.Album)
    Spacer(Modifier.height(16.dp))
    Text(kind, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black, maxLines = 2, overflow = TextOverflow.Ellipsis)
    if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(12.dp))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { actions() }
    footer?.invoke()
  }
}

@Composable
fun FullScreenBox(content: @Composable () -> Unit) = Box(Modifier.fillMaxSize()) { content() }
