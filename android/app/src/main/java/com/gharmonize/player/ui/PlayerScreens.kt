package com.gharmonize.player.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TextButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.SliderDefaults
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import com.gharmonize.player.App
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.media3.common.Player
import com.gharmonize.player.R
import com.gharmonize.player.data.Lyrics
import kotlinx.coroutines.delay

/** Current playback position, refreshed while visible. */
@Composable
fun rememberPosition(state: AppState, intervalMs: Long = 500): Pair<Long, Long> {
  var pos by remember { mutableLongStateOf(0L) }
  var dur by remember { mutableLongStateOf(0L) }
  LaunchedEffect(state.player.current, state.player.isPlaying) {
    while (true) {
      pos = state.player.position
      dur = state.player.duration
      delay(intervalMs)
    }
  }
  return pos to dur
}

/** Horizontal swipe → next (left) / previous (right). */
fun Modifier.swipeTracks(state: AppState, threshold: Float = 110f): Modifier = pointerInput(state) {
  var total = 0f
  detectHorizontalDragGestures(
    onDragStart = { total = 0f },
    onHorizontalDrag = { change, amount -> total += amount; change.consume() },
    onDragEnd = {
      if (total < -threshold) state.player.next() else if (total > threshold) state.player.previous()
      total = 0f
    },
  )
}

/** Upward gesture opens the queue; the sheet handles downward dismissal and list scrolling. */
fun Modifier.queueSwipe(onOpen: () -> Unit): Modifier = pointerInput(Unit) {
  var distance = 0f
  val threshold = 72.dp.toPx()
  detectVerticalDragGestures(
    onDragStart = { distance = 0f },
    onVerticalDrag = { change, amount -> distance += amount; change.consume() },
    onDragEnd = { if (distance < -threshold) onOpen(); distance = 0f },
  )
}

@Composable
private fun GradientPlayButton(playing: Boolean, size: Int, onClick: () -> Unit) {
  Box(
    Modifier.size(size.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.18f)).padding((size / 13).dp)
      .clip(CircleShape).background(Brush.linearGradient(AccentGradient)).clickable(onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Icon(if (playing) FluentIcons.Pause else FluentIcons.PlayArrow, stringResource(R.string.play), tint = Color.White, modifier = Modifier.size((size * 0.45).dp))
  }
}

@Composable
private fun RoundButton(icon: ImageVector, label: String, size: Int = 48, tint: Color = Color.White, onClick: () -> Unit) {
  Box(Modifier.size(size.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.14f)).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
    Icon(icon, label, tint = tint, modifier = Modifier.size((size * 0.5).dp))
  }
}

@Composable
fun MiniPlayer(state: AppState) {
  val item = state.player.current ?: return
  val meta = item.mediaMetadata
  var queueOpen by rememberSaveable { mutableStateOf(false) }
  if (queueOpen) QueueSheet(state) { queueOpen = false }
  val (pos, dur) = rememberPosition(state, 1000)
  Surface(
    color = MaterialTheme.colorScheme.surfaceContainerHigh,
    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    shape = RoundedCornerShape(22.dp),
    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp).queueSwipe { queueOpen = true }.swipeTracks(state, 80f).clickable { state.navigate(Route.NowPlaying) },
  ) {
    Column(Modifier.background(Brush.linearGradient(listOf(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), Color.Transparent)))) {
      Row(Modifier.padding(start = 8.dp, end = 6.dp, top = 8.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Artwork(meta.artworkUri?.toString()?.let(::refFromUri), Modifier.size(46.dp), shape = CircleShape, size = 128)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
          Text(meta.title?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Bold)
          Text(meta.artist?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton(onClick = { state.player.previous() }, modifier = Modifier.size(40.dp)) {
          Icon(FluentIcons.SkipPrevious, stringResource(R.string.previous), modifier = Modifier.size(22.dp))
        }
        Box(Modifier.size(44.dp).clip(CircleShape).background(Brush.linearGradient(AccentGradient)).clickable { state.player.toggle() }, contentAlignment = Alignment.Center) {
          Icon(if (state.player.isPlaying) FluentIcons.Pause else FluentIcons.PlayArrow, stringResource(R.string.play), tint = Color.White, modifier = Modifier.size(26.dp))
        }
        IconButton(onClick = { state.player.next() }, modifier = Modifier.size(40.dp)) {
          Icon(FluentIcons.SkipNext, stringResource(R.string.next), modifier = Modifier.size(22.dp))
        }
      }
      LinearProgressIndicator(
        progress = { if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f },
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 6.dp).height(2.dp).clip(CircleShape),
        trackColor = MaterialTheme.colorScheme.outline,
      )
    }
  }
}

/** "ghp://artwork/album/5?size=512" → "album/5"; plain URLs stay as they are. */
fun refFromUri(uri: String): String =
  if (uri.startsWith("ghp://artwork/")) uri.removePrefix("ghp://artwork/").substringBefore('?') else uri

@Composable
fun NowPlayingScreen(state: AppState) {
  val player = state.player
  val item = player.current
  if (item == null) {
    LaunchedEffect(Unit) { state.back() }
    return
  }
  val meta = item.mediaMetadata
  val extras = meta.extras
  val trackId = extras?.getLong("trackId")?.takeIf { it > 0 }
  val isPreview = extras?.getBoolean("preview") == true
  val artRef = meta.artworkUri?.toString()?.let(::refFromUri)
  var favorite by remember(item.mediaId, extras?.getBoolean("favorite")) { mutableStateOf(extras?.getBoolean("favorite") == true) }
  // 0 = cover, 1 = lyrics; queue and playlists live in a separate draggable sheet.
  var queueOpen by rememberSaveable { mutableStateOf(false) }
  var sheetTab by rememberSaveable { mutableStateOf(0) }
  if (queueOpen) QueueSheet(state, sheetTab) { queueOpen = false }
  val openSheet = { tab: Int -> sheetTab = tab; queueOpen = true }
  var mode by rememberSaveable { mutableStateOf(0) }
  val (pos, dur) = rememberPosition(state, 250)
  var dragging by remember { mutableStateOf(false) }
  var dragValue by remember { mutableFloatStateOf(0f) }
  val white = Color.White
  val dim = white.copy(alpha = 0.72f)
  val prefs = state.app.prefs
  val style = prefs.progressStyle.takeIf { it in PROGRESS_STYLES } ?: "ring"
  val fraction = if (dragging) dragValue else if (dur > 0) (pos.toFloat() / dur).coerceIn(0f, 1f) else 0f
  val bins by androidx.compose.runtime.produceState<FloatArray?>(null, trackId, style) {
    value = if (style == "wave" && trackId != null && !isPreview) state.waveform(trackId) else null
  }
  val seekDrag: (Float) -> Unit = { dragging = true; dragValue = it }
  val seekCommit: (Float) -> Unit = { player.seekTo((it * dur).toLong()); dragging = false }

  Box(
    Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF125A70), Color(0xFF0C1933), Color(0xFF373161))))
      .statusBarsPadding().navigationBarsPadding().padding(12.dp),
    contentAlignment = Alignment.Center,
  ) {
    Column(
      Modifier.widthIn(max = 500.dp).fillMaxSize().clip(RoundedCornerShape(28.dp))
        .background(Brush.linearGradient(listOf(Color(0xFFA2D5E3).copy(alpha = 0.32f), Color(0xFF9797C2).copy(alpha = 0.28f))))
        .border(1.dp, white.copy(alpha = 0.32f), RoundedCornerShape(28.dp)).padding(horizontal = 20.dp),
    ) {
      Row(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        RoundButton(FluentIcons.KeyboardArrowDown, stringResource(R.string.close), 44) { state.back() }
        Spacer(Modifier.width(8.dp))
        RoundButton(FluentIcons.Equalizer, stringResource(R.string.equalizer), 44, tint = if (com.gharmonize.player.playback.AudioEq.params.enabled) Color(0xFF93C5FD) else white) { state.navigate(Route.Equalizer) }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
          Text(stringResource(if (mode == 1) R.string.lyrics else R.string.now_playing), color = white, fontWeight = FontWeight.Bold)
        }
        RoundButton(FluentIcons.QueueMusic, stringResource(R.string.queue), 44) { openSheet(0) }
        Spacer(Modifier.width(8.dp))
        RoundButton(FluentIcons.Playlist, stringResource(R.string.playlists), 44) { openSheet(1) }
      }
      Box(Modifier.weight(1f).fillMaxWidth().padding(vertical = 14.dp).then(if (mode == 0) Modifier.queueSwipe { openSheet(0) }.swipeTracks(state) else Modifier), contentAlignment = Alignment.Center) {
        when (mode) {
          1 -> LyricsView(state, trackId, isPreview, pos)
          else -> CoverDial(artRef, fraction, ring = style == "ring", volumeArc = prefs.coverVolume, onSeekDrag = seekDrag, onSeekCommit = seekCommit)
        }
      }
      if (mode == 0) Row(Modifier.fillMaxWidth().clickable { openSheet(0) }.padding(bottom = 6.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        Icon(FluentIcons.KeyboardArrowDown, null, tint = dim, modifier = Modifier.size(16.dp).rotate(180f))
        Text(stringResource(R.string.queue_swipe_hint), color = dim, style = MaterialTheme.typography.labelSmall)
      }
      Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(40.dp))
        Column(Modifier.weight(1f).then(Modifier.queueSwipe { openSheet(0) }.swipeTracks(state)), horizontalAlignment = Alignment.CenterHorizontally) {
          Text(meta.title?.toString().orEmpty(), color = white, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
          Text(meta.artist?.toString().orEmpty() + if (isPreview) " · " + stringResource(R.string.preview) else "",
            color = dim, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.clickable(enabled = (extras?.getLong("artistId") ?: 0) > 0) { state.navigate(Route.Artist(extras!!.getLong("artistId"))) })
        }
        if (trackId != null) {
          IconButton(onClick = { favorite = !favorite; state.setFavorite(trackId, favorite) { favorite = it } }, modifier = Modifier.size(40.dp)) {
            Icon(if (favorite) FluentIcons.Favorite else FluentIcons.FavoriteBorder, stringResource(R.string.like), tint = if (favorite) Color(0xFFDEB9FF) else white)
          }
        } else Box(Modifier.size(40.dp))
      }
      val shownTime = fmtTime((if (dragging) dragValue * dur else pos.toFloat()) / 1000.0)
      // The ring shows progress around the cover; only the times stay here
      // (the linear bar returns while lyrics replace the cover).
      if (style == "ring" && mode == 0) Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 6.dp), horizontalArrangement = Arrangement.Center) {
        Text(shownTime, color = white, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        Text("  /  " + fmtTime(dur / 1000.0), color = dim, style = MaterialTheme.typography.labelLarge)
      } else Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 10.dp)) {
        Text(shownTime, color = dim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.width(40.dp), textAlign = TextAlign.Center)
        if (style == "bold" || style == "minimal" || style == "wave") {
          StyledSeekBar(style, fraction, bins, onDrag = seekDrag, onCommit = seekCommit, modifier = Modifier.weight(1f).padding(horizontal = 6.dp))
        } else Slider(
          value = fraction,
          onValueChange = seekDrag,
          onValueChangeFinished = { seekCommit(dragValue) },
          colors = SliderDefaults.colors(thumbColor = white, activeTrackColor = Color(0xFF8B9CF8), inactiveTrackColor = white.copy(alpha = 0.25f)),
          modifier = Modifier.weight(1f),
        )
        Text(fmtTime(dur / 1000.0), color = dim, style = MaterialTheme.typography.labelSmall, modifier = Modifier.width(40.dp), textAlign = TextAlign.Center)
      }
      Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        RoundButton(FluentIcons.SkipPrevious, stringResource(R.string.previous), 50) { player.previous() }
        GradientPlayButton(player.isPlaying, 76) { player.toggle() }
        RoundButton(FluentIcons.SkipNext, stringResource(R.string.next), 50) { player.next() }
      }
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
        IconButton(onClick = { player.toggleShuffle() }) {
          Icon(FluentIcons.Shuffle, stringResource(R.string.shuffle), tint = if (player.shuffle) Color(0xFF93C5FD) else dim)
        }
        Box(Modifier.weight(1f), contentAlignment = Alignment.BottomCenter) {
          Box(Modifier.clip(RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp)).background(white.copy(alpha = if (mode == 1) 0.32f else 0.22f)).clickable { mode = if (mode == 1) 0 else 1 }.padding(horizontal = 36.dp, vertical = 16.dp)) {
              Text(stringResource(R.string.lyrics), color = white, fontWeight = FontWeight.Bold)
          }
        }
        IconButton(onClick = { player.cycleRepeat() }) {
          Icon(if (player.repeatMode == Player.REPEAT_MODE_ONE) FluentIcons.RepeatOne else FluentIcons.Repeat, stringResource(R.string.repeat),
            tint = if (player.repeatMode != Player.REPEAT_MODE_OFF) Color(0xFF93C5FD) else dim)
        }
      }
    }
  }
}

@Composable
private fun LyricsView(state: AppState, trackId: Long?, isPreview: Boolean, positionMs: Long) {
  if (trackId == null || isPreview) { EmptyText(stringResource(R.string.lyrics_library_only)); return }
  val data = rememberLoad("lyrics", trackId) { state.api.lyrics(trackId) }
  val lyrics: Lyrics? = data.value
  when {
    data.loading -> Loading()
    lyrics == null || (lyrics.lines.isEmpty() && lyrics.plain.isBlank()) -> EmptyText(stringResource(R.string.no_lyrics))
    lyrics.synced && lyrics.lines.isNotEmpty() -> {
      val active = lyrics.lines.indexOfLast { it.timeMs <= positionMs + 250 }
      val list = rememberLazyListState()
      LaunchedEffect(active) { if (active > 2) list.animateScrollToItem(active - 2) }
      LazyColumn(state = list, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 40.dp)) {
        itemsIndexed(lyrics.lines) { i, line ->
          Text(
            line.text.ifBlank { "♪" },
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color = if (i == active) Color.White else Color.White.copy(alpha = 0.45f),
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().clickable { state.player.seekTo(line.timeMs) }.padding(vertical = 8.dp),
          )
        }
      }
    }
    else -> LazyColumn(Modifier.fillMaxSize()) {
      itemsIndexed(lyrics.plain.lines()) { _, line -> Text(line.ifBlank { " " }, color = Color.White, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QueueSheet(state: AppState, initialTab: Int = 0, onDismiss: () -> Unit) {
  var save by remember { mutableStateOf(false) }
  var tab by rememberSaveable { mutableStateOf(initialTab) }
  val ids = state.player.queue.mapNotNull { it.mediaMetadata.extras?.getLong("trackId")?.takeIf { id -> id > 0 } }.distinct()
  // Opening a playlist navigates away; the sheet closes with it.
  val openedOn = remember { state.stack.size to state.top }
  LaunchedEffect(state.stack.size, state.top) { if ((state.stack.size to state.top) != openedOn) onDismiss() }
  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainer) {
    Column(Modifier.fillMaxWidth().fillMaxHeight(0.85f).padding(horizontal = 16.dp)) {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        SheetTab(stringResource(R.string.queue), tab == 0) { tab = 0 }
        Spacer(Modifier.width(6.dp))
        SheetTab(stringResource(R.string.playlists), tab == 1) { tab = 1 }
        Spacer(Modifier.weight(1f))
        if (tab == 0) Text("${state.player.queue.size}", style = MaterialTheme.typography.labelMedium)
        IconButton(onClick = onDismiss) { Icon(FluentIcons.Close, stringResource(R.string.close)) }
      }
      if (tab == 0) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
          TextButton(onClick = { save = true }, enabled = ids.isNotEmpty()) { Text(stringResource(R.string.save_to_playlist), style = MaterialTheme.typography.labelMedium) }
          TextButton(onClick = { state.player.clearUpcoming() }, enabled = state.player.index < state.player.queue.lastIndex) { Text(stringResource(R.string.queue_clear), style = MaterialTheme.typography.labelMedium) }
        }
        Box(Modifier.weight(1f)) { QueueView(state) }
      } else {
        Box(Modifier.weight(1f)) { PlaylistsTab(state) }
      }
    }
  }
  if (save) SavePlaylistDialog(state, ids, onDismiss = { save = false })
}

@Composable
private fun SheetTab(label: String, selected: Boolean, onClick: () -> Unit) {
  val colors = MaterialTheme.colorScheme
  Text(
    label,
    style = MaterialTheme.typography.titleMedium,
    fontWeight = FontWeight.Bold,
    color = if (selected) colors.onSurface else colors.onSurfaceVariant,
    modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(if (selected) colors.primary.copy(alpha = 0.14f) else Color.Transparent)
      .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp),
  )
}

@Composable
private fun QueueView(state: AppState) {
  val queue = state.player.queue
  val current = state.player.index
  val colors = MaterialTheme.colorScheme
  if (queue.isEmpty()) { EmptyText(stringResource(R.string.queue_empty)); return }
  val list = rememberLazyListState(initialFirstVisibleItemIndex = current.coerceIn(0, queue.lastIndex))
  LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
    itemsIndexed(queue, key = { i, m -> "q-$i-${m.mediaId}" }) { i, m ->
      var menu by remember { mutableStateOf(false) }
      Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (i == current) colors.primary.copy(alpha = 0.12f) else Color.Transparent).clickable { state.player.jumpTo(i) }.padding(vertical = 6.dp, horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Artwork(m.mediaMetadata.artworkUri?.toString()?.let(::refFromUri), Modifier.size(44.dp), size = 128)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
          Text(m.mediaMetadata.title?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium,
            color = if (i == current) colors.primary else colors.onSurface, fontWeight = if (i == current) FontWeight.Bold else null)
          Text(m.mediaMetadata.artist?.toString().orEmpty(), maxLines = 1, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
        }
        Box {
          IconButton(onClick = { menu = true }) { Icon(FluentIcons.MoreVert, stringResource(R.string.more)) }
          // Song actions are always there, also when it is the only song.
          val extras = m.mediaMetadata.extras
          val tid = extras?.getLong("trackId")?.takeIf { it > 0 }
          val albumId = extras?.getLong("albumId")?.takeIf { it > 0 }
          val artistId = extras?.getLong("artistId")?.takeIf { it > 0 }
          var save by remember { mutableStateOf(false) }
          if (save && tid != null) SavePlaylistDialog(state, listOf(tid), onDismiss = { save = false })
          DropdownMenu(menu, onDismissRequest = { menu = false }) {
            if (i > 0) DropdownMenuItem(text = { Text(stringResource(R.string.queue_move_up)) }, onClick = { state.player.move(i, i - 1); menu = false })
            if (i < queue.lastIndex) DropdownMenuItem(text = { Text(stringResource(R.string.queue_move_down)) }, onClick = { state.player.move(i, i + 1); menu = false })
            if (i != current) DropdownMenuItem(text = { Text(stringResource(R.string.remove)) }, onClick = { state.player.removeAt(i); menu = false })
            if (tid != null) DropdownMenuItem(text = { Text(stringResource(R.string.save_to_playlist)) }, onClick = { save = true; menu = false })
            albumId?.let { id -> DropdownMenuItem(text = { Text(stringResource(R.string.go_to_album)) }, onClick = { menu = false; state.navigate(Route.Album(id)) }) }
            artistId?.let { id -> DropdownMenuItem(text = { Text(stringResource(R.string.go_to_artist)) }, onClick = { menu = false; state.navigate(Route.Artist(id)) }) }
            if (i != current) DropdownMenuItem(text = { Text(stringResource(R.string.play)) }, onClick = { state.player.jumpTo(i); menu = false })
          }
        }
      }
    }
  }
}
