package com.gharmonize.player.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import androidx.compose.foundation.combinedClickable
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.Track

/** Multi-selection of songs: long press or swipe a song to the right. */
class SongSelection {
  var active by mutableStateOf(false)
    private set
  val ids = mutableStateListOf<Long>()

  fun start(first: Long? = null) {
    active = true
    if (first != null && first !in ids) ids.add(first)
  }

  fun stop() {
    active = false
    ids.clear()
  }

  fun toggle(id: Long) {
    if (id in ids) ids.remove(id) else ids.add(id)
  }

  /** Selected songs in list order. */
  fun pick(tracks: List<Track>): List<Track> {
    val set = ids.toSet()
    return tracks.filter { it.id in set }
  }
}

@Composable
fun rememberSongSelection(key: Any?): SongSelection = remember(key) { SongSelection() }

/**
 * Multi-selection of an online list (album, playlist, mix): rows are picked
 * by position, so songs listed twice stay apart. Same gestures as
 * [SongSelection].
 */
class OnlineSelection {
  var active by mutableStateOf(false)
    private set
  val picked = mutableStateListOf<Int>()

  fun start(first: Int? = null) {
    active = true
    if (first != null && first !in picked) picked.add(first)
  }

  fun stop() {
    active = false
    picked.clear()
  }

  fun toggle(index: Int) {
    if (index in picked) picked.remove(index) else picked.add(index)
  }

  fun pickWhere(items: List<OnlineItem>, test: (OnlineItem) -> Boolean) {
    picked.clear()
    picked.addAll(items.indices.filter { test(items[it]) })
  }

  /** Selected rows in list order. */
  fun pick(items: List<OnlineItem>): List<OnlineItem> = picked.sorted().mapNotNull { items.getOrNull(it) }
}

@Composable
fun rememberOnlineSelection(key: Any?): OnlineSelection = remember(key) { OnlineSelection() }

/**
 * Swipe a song to the right to select it (or unselect it): the first swipe
 * starts selecting, like a long press. A tick shows behind the row while
 * dragging; past the threshold the phone ticks and the row is picked on
 * release. Vertical scrolling is not affected (the drag only starts once
 * the finger moved sideways).
 */
@Composable
fun SwipeToSelect(selection: SongSelection?, id: Long, content: @Composable () -> Unit) {
  if (selection == null) { content(); return }
  SwipeToPick(picked = id in selection.ids, key = id, onPick = { if (selection.active) selection.toggle(id) else selection.start(id) }, content = content)
}

/** The swipe gesture of [SwipeToSelect] for any list: [onPick] runs past the threshold. */
@Composable
fun SwipeToPick(picked: Boolean, key: Any, onPick: () -> Unit, content: @Composable () -> Unit) {
  val pick by androidx.compose.runtime.rememberUpdatedState(onPick)
  val density = androidx.compose.ui.platform.LocalDensity.current
  val threshold = with(density) { 72.dp.toPx() }
  val start = with(density) { 20.dp.toPx() }
  val offset = remember { androidx.compose.animation.core.Animatable(0f) }
  val scope = androidx.compose.runtime.rememberCoroutineScope()
  val haptics = androidx.compose.ui.platform.LocalHapticFeedback.current
  val tint = MaterialTheme.colorScheme.primary
  val fill = MaterialTheme.colorScheme.primaryContainer
  Box(Modifier.fillMaxWidth()) {
    if (offset.value > 0f) {
      val progress = ((offset.value - start) / (threshold - start)).coerceIn(0f, 1f)
      Box(
        Modifier.matchParentSize().drawBehind { drawRect(fill.copy(alpha = 0.35f + 0.5f * progress), size = androidx.compose.ui.geometry.Size(offset.value, size.height)) },
        contentAlignment = Alignment.CenterStart,
      ) {
        Icon(
          if (picked) FluentIcons.Close else FluentIcons.CheckCircle,
          stringResource(R.string.select_swipe),
          tint = tint,
          modifier = Modifier.padding(start = 18.dp).graphicsLayer { alpha = progress; scaleX = 0.7f + 0.3f * progress; scaleY = scaleX },
        )
      }
    }
    Box(
      Modifier
        .offset { androidx.compose.ui.unit.IntOffset(offset.value.roundToInt(), 0) }
        .pointerInput(key) {
          var armed = false
          detectHorizontalDragGestures(
            onDragStart = { armed = false },
            onDragEnd = {
              if (offset.value >= threshold) pick()
              scope.launch { offset.animateTo(0f) }
            },
            onDragCancel = { scope.launch { offset.animateTo(0f) } },
          ) { change, amount ->
            change.consume()
            val next = (offset.value + amount).coerceIn(0f, threshold * 1.5f)
            if (!armed && next >= threshold) { armed = true; haptics.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress) }
            if (armed && next < threshold) armed = false
            scope.launch { offset.snapTo(next) }
          }
        },
    ) { content() }
  }
}

/** Screen with a song list: the selection bar at the bottom, back leaves selecting. */
@Composable
fun SelectionScaffold(
  state: AppState,
  tracks: List<Track>,
  selection: SongSelection,
  name: String,
  onRemoveFromPlaylist: ((List<Track>) -> Unit)? = null,
  content: @Composable (bottomPadding: androidx.compose.ui.unit.Dp) -> Unit,
) {
  androidx.activity.compose.BackHandler(enabled = selection.active) { selection.stop() }
  Box(androidx.compose.ui.Modifier.fillMaxSize()) {
    content(if (selection.active) 140.dp else 24.dp)
    if (selection.active) SongSelectionBar(state, tracks, selection, name, Modifier.align(Alignment.BottomCenter), onRemoveFromPlaylist = onRemoveFromPlaylist)
  }
}

val ARTIST_SONG_SORTS = listOf(
  "album" to R.string.sort_album,
  "alpha" to R.string.sort_alpha,
  "recent" to R.string.sort_recent,
  "plays" to R.string.sort_plays,
)

/** "All songs": every song of the artist in the library, sortable and selectable. */
/** The artist's songs online: the loaded list and the picked ones (keys). */
class OnlineSongs(val load: LoadState<List<OnlineItem>?>, val picked: androidx.compose.runtime.snapshots.SnapshotStateList<String>, val artistName: String = "")

fun LazyListScope.artistSongsSection(
  state: AppState,
  total: Int,
  songs: LoadState<List<Track>>,
  sort: String,
  onSort: (String) -> Unit,
  selection: SongSelection,
  onlineTab: Boolean = false,
  onTab: ((Boolean) -> Unit)? = null,
  online: OnlineSongs? = null,
) {
  item(key = "all-head") {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
      Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.all_songs), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(" · $total", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        if (!onlineTab) TextButton(onClick = { if (selection.active) selection.stop() else selection.start() }, enabled = !songs.value.isNullOrEmpty()) {
          Text(stringResource(if (selection.active) R.string.select_done else R.string.select_songs))
        }
      }
      // Library | Online (every song of the artist on Deezer).
      if (onTab != null) Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = !onlineTab, onClick = { onTab(false) }, label = { Text(stringResource(R.string.artist_songs_library)) })
        FilterChip(selected = onlineTab, onClick = { selection.stop(); onTab(true) }, label = { Text(stringResource(R.string.artist_songs_online)) })
      }
      if (!onlineTab) LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(ARTIST_SONG_SORTS) { (key, label) ->
          FilterChip(selected = sort == key, onClick = { if (sort != key) onSort(key) }, label = { Text(stringResource(label)) })
        }
      }
    }
  }
  if (onlineTab && online != null) { onlineSongsItems(state, online); return }
  val list = songs.value
  if (list == null) {
    if (songs.loading) item(key = "all-loading") { Loading() }
    return
  }
  itemsIndexed(list, key = { _, t -> "all-${t.id}" }) { i, _ -> SelectableTrackRow(state, list, i, selection) }
}

/** Tap plays (or toggles while selecting); long press starts selecting. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SelectableTrackRow(state: AppState, tracks: List<Track>, index: Int, selection: SongSelection, downloadsOnly: Boolean = false) {
  val t = tracks[index]
  val checked = t.id in selection.ids
  val isCurrent = state.player.current?.mediaId == "t:${t.id}"
  var menu by remember { mutableStateOf(false) }
  SwipeToSelect(selection, t.id) {
  Row(
    Modifier.fillMaxWidth()
      .combinedClickable(
        onClick = { if (selection.active) selection.toggle(t.id) else state.player.play(tracks, index, downloadsOnly = downloadsOnly) },
        onLongClick = { if (selection.active) selection.toggle(t.id) else selection.start(t.id) },
      )
      .padding(start = if (selection.active) 4.dp else 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    if (selection.active) Checkbox(checked = checked, onCheckedChange = { selection.toggle(t.id) })
    Artwork(t.artwork, Modifier.size(48.dp), size = 128)
    Spacer(Modifier.width(12.dp))
    Column(Modifier.weight(1f)) {
      Text(t.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge,
        color = if (isCurrent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
      Row(verticalAlignment = Alignment.CenterVertically) {
        OnPhoneMark(t.id)
        Text(listOfNotNull(t.album.ifBlank { null }, if (t.duration > 0) fmtTime(t.duration) else null).joinToString(" · "),
          maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
    if (!selection.active) {
      Box {
        IconButton(onClick = { menu = true }) { Icon(FluentIcons.MoreVert, stringResource(R.string.more)) }
        TrackMenu(state, t, menu) { menu = false }
      }
    }
  }
  }
}

/** Bottom bar while selecting: play, queue, save to a playlist. */
@Composable
fun SongSelectionBar(
  state: AppState,
  tracks: List<Track>,
  selection: SongSelection,
  suggestedName: String,
  modifier: Modifier = Modifier,
  onRemove: ((List<Track>) -> Unit)? = null,
  downloadsOnly: Boolean = false,
  onRemoveFromPlaylist: ((List<Track>) -> Unit)? = null,
) {
  val context = androidx.compose.ui.platform.LocalContext.current
  val picked = selection.pick(tracks)
  val n = picked.size
  var save by remember { mutableStateOf(false) }
  if (save) SavePlaylistDialog(state, picked.map { it.id }, suggestedName, onDismiss = { save = false }, onSaved = { selection.stop() })
  Surface(
    modifier.fillMaxWidth().padding(12.dp),
    shape = MaterialTheme.shapes.large,
    color = MaterialTheme.colorScheme.secondaryContainer,
    tonalElevation = 3.dp,
  ) {
    Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { selection.stop() }) { Icon(FluentIcons.Close, stringResource(R.string.close)) }
        Text(
          if (n > 0) stringResource(R.string.selected_count, n) else stringResource(R.string.select_hint),
          fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        TextButton(onClick = {
          if (n == tracks.size) selection.ids.clear()
          else { selection.ids.clear(); selection.ids.addAll(tracks.map { it.id }) }
        }) { Text(stringResource(if (n == tracks.size && n > 0) R.string.select_none else R.string.select_all)) }
      }
      Row(Modifier.fillMaxWidth()) {
        BarAction(FluentIcons.PlayArrow, stringResource(R.string.play), n > 0) {
          state.player.play(picked, 0, downloadsOnly = downloadsOnly)
          selection.stop()
        }
        BarAction(FluentIcons.QueueMusic, stringResource(R.string.queue), n > 0) {
          picked.forEach { state.player.addToQueue(it) }
          state.messageRes(R.string.queued_many, n)
          selection.stop()
        }
        BarAction(FluentIcons.Playlist, stringResource(R.string.save_short), n > 0) { save = true }
        BarAction(FluentIcons.Favorite, stringResource(R.string.like), n > 0) {
          state.likeAll(picked.map { it.id }) { selection.stop() }
        }
        if (onRemoveFromPlaylist != null) {
          BarAction(FluentIcons.Close, stringResource(R.string.select_remove_playlist), n > 0) { onRemoveFromPlaylist(picked); selection.stop() }
        }
        if (onRemove != null) {
          BarAction(FluentIcons.Close, stringResource(R.string.offline_remove), n > 0) { onRemove(picked); selection.stop() }
        } else {
          BarAction(FluentIcons.Download, stringResource(R.string.offline_save_short), n > 0) {
            val added = com.gharmonize.player.playback.Offline.download(context, picked)
            if (added > 0) state.messageRes(R.string.offline_queued, added)
            selection.stop()
          }
        }
      }
    }
  }
}

/**
 * Bottom bar of an online list: songs in the library play, queue and get
 * liked from there; missing ones preview, download (or go into a playlist,
 * downloaded into it) and their links can be shared.
 */
@Composable
fun OnlineSelectionBar(
  state: AppState,
  items: List<OnlineItem>,
  selection: OnlineSelection,
  suggestedName: String,
  modifier: Modifier = Modifier,
) {
  val context = androidx.compose.ui.platform.LocalContext.current
  val picked = selection.pick(items).map(state::withDownload)
  val n = picked.size
  val owned = picked.filter { it.libraryTrackId != null }
  val ownedIds = owned.mapNotNull { it.libraryTrackId }.distinct()
  val playable = picked.filter { it.libraryTrackId != null || it.previewUrl != null }
  val missing = picked.filter { it.libraryTrackId == null }
  val wanted = missing.filter { item ->
    val known = state.downloadsByUrl[item.url]
    state.canDownload && item.url.isNotBlank() && (known == null || known.status == "failed" || known.status == "canceled")
  }
  val fetchable = if (state.canDownload) missing.filter { it.url.isNotBlank() } else emptyList()
  val links = picked.map { it.url }.filter { it.isNotBlank() }.distinct()
  val hasMissing = items.any { state.withDownload(it).libraryTrackId == null }
  val hasOwned = items.any { state.withDownload(it).libraryTrackId != null }
  var save by remember { mutableStateOf(false) }
  if (save) SavePlaylistDialog(state, ownedIds, suggestedName, onDismiss = { save = false }, allowExisting = true, onSaved = { id ->
    // Missing songs join the playlist as their downloads finish.
    if (fetchable.isNotEmpty()) state.downloadAll(fetchable, title = suggestedName.ifBlank { null }, playlistId = id)
    selection.stop()
  })
  Surface(
    modifier.fillMaxWidth().padding(12.dp),
    shape = MaterialTheme.shapes.large,
    color = MaterialTheme.colorScheme.secondaryContainer,
    tonalElevation = 3.dp,
  ) {
    Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { selection.stop() }) { Icon(FluentIcons.Close, stringResource(R.string.close)) }
        Text(
          if (n > 0) stringResource(R.string.selected_count, n) else stringResource(R.string.select_hint),
          fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (hasMissing && hasOwned) TextButton(onClick = { selection.pickWhere(items) { state.withDownload(it).libraryTrackId == null } }) {
          Text(stringResource(R.string.select_missing), maxLines = 1)
        }
        TextButton(onClick = {
          if (n == items.size) selection.picked.clear() else selection.pickWhere(items) { true }
        }) { Text(stringResource(if (n == items.size && n > 0) R.string.select_none else R.string.select_all), maxLines = 1) }
      }
      Row(Modifier.fillMaxWidth()) {
        BarAction(FluentIcons.PlayArrow, stringResource(R.string.play), playable.isNotEmpty()) {
          state.playOnline(playable, 0)
          selection.stop()
        }
        BarAction(FluentIcons.QueueMusic, stringResource(R.string.queue), owned.isNotEmpty()) {
          owned.mapNotNull { it.libraryTrack ?: state.trackFromOnline(it) }.forEach { state.player.addToQueue(it) }
          state.messageRes(R.string.queued_many, owned.size)
          selection.stop()
        }
        if (state.canDownload) {
          BarAction(FluentIcons.Download, if (wanted.isNotEmpty()) stringResource(R.string.download_count, wanted.size) else stringResource(R.string.download), wanted.isNotEmpty()) {
            state.downloadAll(wanted, title = suggestedName.ifBlank { null })
            selection.stop()
          }
        }
        BarAction(FluentIcons.Playlist, stringResource(R.string.save_short), ownedIds.isNotEmpty() || fetchable.isNotEmpty()) { save = true }
        BarAction(FluentIcons.Favorite, stringResource(R.string.like), ownedIds.isNotEmpty()) {
          state.likeAll(ownedIds) { selection.stop() }
        }
        BarAction(FluentIcons.Link, stringResource(R.string.share_links), links.isNotEmpty()) {
          val send = android.content.Intent(android.content.Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(android.content.Intent.EXTRA_SUBJECT, suggestedName)
            .putExtra(android.content.Intent.EXTRA_TEXT, links.joinToString("\n"))
          runCatching { context.startActivity(android.content.Intent.createChooser(send, null).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
          selection.stop()
        }
      }
    }
  }
}

/** Screen with an online song list: the selection bar at the bottom, back leaves selecting. */
@Composable
fun OnlineSelectionScaffold(
  state: AppState,
  items: List<OnlineItem>,
  selection: OnlineSelection,
  name: String,
  content: @Composable (bottomPadding: androidx.compose.ui.unit.Dp) -> Unit,
) {
  androidx.activity.compose.BackHandler(enabled = selection.active) { selection.stop() }
  Box(Modifier.fillMaxSize()) {
    content(if (selection.active) 140.dp else 24.dp)
    if (selection.active && items.isNotEmpty()) OnlineSelectionBar(state, items, selection, name, Modifier.align(Alignment.BottomCenter))
  }
}

/** Selection bar action: icon above a short label, equal width. */
@Composable
private fun androidx.compose.foundation.layout.RowScope.BarAction(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
  val tint = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
  Column(
    Modifier.weight(1f).clip(MaterialTheme.shapes.medium).clickable(enabled = enabled, onClick = onClick).padding(vertical = 8.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Icon(icon, null, tint = tint)
    Text(label, style = MaterialTheme.typography.labelMedium, color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis)
  }
}

/**
 * The artist's songs online: songs not in the library get a checkbox,
 * "select missing" ticks them all, one button downloads the picked ones.
 */
private fun LazyListScope.onlineSongsItems(state: AppState, online: OnlineSongs) {
  val list = online.load.value
  if (list == null) {
    if (online.load.loading) item(key = "on-loading") { Loading() }
    else item(key = "on-error") { EmptyText(stringResource(R.string.artist_online_failed)) }
    return
  }
  if (list.isEmpty()) { item(key = "on-empty") { EmptyText(stringResource(R.string.artist_online_none)) }; return }
  fun pickable(item: OnlineItem): Boolean {
    val known = state.downloadsByUrl[item.url]
    return state.canDownload && item.libraryTrackId == null && (known == null || known.status == "failed" || known.status == "canceled")
  }
  item(key = "on-tools") {
    val missing = list.count { it.libraryTrackId == null }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
      Text(stringResource(R.string.artist_online_count, list.size, missing), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      if (state.canDownload) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = {
          if (online.picked.isNotEmpty()) online.picked.clear()
          else online.picked.addAll(list.filter(::pickable).map { it.key })
        }) { Text(stringResource(if (online.picked.isEmpty()) R.string.artist_select_missing else R.string.artist_clear_picked)) }
        androidx.compose.material3.Button(enabled = online.picked.isNotEmpty(), onClick = {
          val chosen = list.filter { it.key in online.picked && pickable(it) }
          online.picked.clear()
          state.downloadAll(chosen, title = online.artistName.ifBlank { null }?.let { state.text(R.string.group_artist_songs, it) })
        }) { Text(stringResource(R.string.artist_download_picked, online.picked.size)) }
      }
    }
  }
  itemsIndexed(list, key = { i, t -> "on-$i-${t.key}" }) { i, item ->
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      if (state.canDownload) {
        if (pickable(item)) Checkbox(checked = item.key in online.picked, onCheckedChange = { on -> if (on) online.picked.add(item.key) else online.picked.remove(item.key) })
        else Spacer(Modifier.width(48.dp))
      }
      Box(Modifier.weight(1f)) { OnlineTrackRow(state, list, i) }
    }
  }
}
