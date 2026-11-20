package com.gharmonize.player.ui

import android.text.format.Formatter
import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.media3.exoplayer.offline.Download
import com.gharmonize.player.R
import com.gharmonize.player.data.Track
import com.gharmonize.player.playback.Offline
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val ACTIVE = setOf(Download.STATE_QUEUED, Download.STATE_DOWNLOADING, Download.STATE_RESTARTING)

/** "Save on the phone" for a list of songs: download / progress / saved (tap to remove). */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun OfflineButton(state: AppState, tracks: List<Track>) {
  val context = LocalContext.current
  val ids = tracks.map { it.id }
  val done = ids.count { Offline.states[it] == Download.STATE_COMPLETED }
  val active = ids.filter { Offline.states[it] in ACTIVE }
  var confirm by remember { mutableStateOf(false) }
  if (confirm) {
    AlertDialog(
      onDismissRequest = { confirm = false },
      title = { Text(stringResource(R.string.offline_remove_title)) },
      text = { Text(stringResource(R.string.offline_remove_text, done)) },
      confirmButton = {
        TextButton(onClick = { Offline.remove(context, ids); confirm = false }) { Text(stringResource(R.string.offline_remove)) }
      },
      dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
    )
  }
  IconButton(enabled = tracks.isNotEmpty(), onClick = {
    when {
      active.isNotEmpty() -> state.messageRes(R.string.offline_in_progress, done, ids.size)
      ids.isNotEmpty() && done == ids.size -> confirm = true
      else -> {
        val n = Offline.download(context, tracks)
        if (n > 0) state.messageRes(R.string.offline_queued, n)
      }
    }
  }) {
    when {
      active.isNotEmpty() -> {
        val pct = ((done * 100 + active.sumOf { Offline.progress[it] ?: 0 }) / ids.size.coerceAtLeast(1)).coerceIn(0, 100)
        Box(contentAlignment = Alignment.Center) {
          CircularProgressIndicator(progress = { (pct / 100f).coerceAtLeast(0.04f) }, modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
          Icon(FluentIcons.Download, null, modifier = Modifier.size(14.dp))
        }
      }
      ids.isNotEmpty() && done == ids.size ->
        Icon(FluentIcons.CheckCircle, stringResource(R.string.offline_saved), tint = MaterialTheme.colorScheme.primary)
      else -> Icon(FluentIcons.Download, stringResource(R.string.offline_save))
    }
  }
}

/** Small mark next to a song that is saved on the phone. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun OnPhoneMark(trackId: Long) {
  when (Offline.states[trackId]) {
    Download.STATE_COMPLETED -> Icon(FluentIcons.CheckCircle, stringResource(R.string.offline_saved), tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp).padding(end = 2.dp))
    in ACTIVE -> CircularProgressIndicator(progress = { ((Offline.progress[trackId] ?: 0) / 100f).coerceAtLeast(0.05f) }, modifier = Modifier.size(12.dp).padding(end = 2.dp), strokeWidth = 2.dp)
    else -> {}
  }
}

/** Everything saved on the phone; works without a connection. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun OfflineScreen(state: AppState) {
  val context = LocalContext.current
  val version = Offline.version.value
  var tracks by remember { mutableStateOf<List<Track>?>(null) }
  var used by remember { mutableStateOf(0L) }
  LaunchedEffect(version) {
    withContext(Dispatchers.IO) {
      val list = Offline.tracksOnPhone()
      val bytes = Offline.bytesUsed()
      withContext(Dispatchers.Main) { tracks = list; used = bytes }
    }
  }
  val pending = Offline.states.values.count { it in ACTIVE }
  val selection = rememberSongSelection("offline")
  BackHandler(enabled = selection.active) { selection.stop() }
  var confirmAll by remember { mutableStateOf(false) }
  if (confirmAll) {
    AlertDialog(
      onDismissRequest = { confirmAll = false },
      title = { Text(stringResource(R.string.offline_remove_all)) },
      text = { Text(stringResource(R.string.offline_remove_text, tracks?.size ?: 0)) },
      confirmButton = { TextButton(onClick = { Offline.removeAll(context); confirmAll = false }) { Text(stringResource(R.string.offline_remove)) } },
      dismissButton = { TextButton(onClick = { confirmAll = false }) { Text(stringResource(R.string.cancel)) } },
    )
  }
  val list = tracks.orEmpty()
  Box(Modifier.fillMaxSize()) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = if (selection.active) 140.dp else 24.dp)) {
      item {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
          Text(stringResource(R.string.offline_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
          Text(
            stringResource(R.string.offline_summary, list.size, Formatter.formatShortFileSize(context, used)),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
          if (pending > 0) {
            Spacer(Modifier.size(8.dp))
            Text(stringResource(R.string.offline_pending, pending), style = MaterialTheme.typography.bodySmall)
            LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 4.dp))
          }
          Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PlayShuffle(state, list, offline = false, downloadsOnly = true)
            Spacer(Modifier.weight(1f))
            if (list.isNotEmpty()) {
              TextButton(onClick = { selection.start() }) { Text(stringResource(R.string.select_songs)) }
              TextButton(onClick = { confirmAll = true }) { Text(stringResource(R.string.offline_remove_all)) }
            }
          }
        }
      }
      if (tracks == null) item { Loading() }
      else if (list.isEmpty() && pending == 0) item { EmptyText(stringResource(R.string.offline_empty)) }
      itemsIndexed(list, key = { _, t -> "off-${t.id}" }) { i, _ -> SelectableTrackRow(state, list, i, selection, downloadsOnly = true) }
    }
    if (selection.active) {
      SongSelectionBar(state, list, selection, stringResource(R.string.offline_title), Modifier.align(Alignment.BottomCenter),
        onRemove = { picked -> Offline.remove(context, picked.map { it.id }) }, downloadsOnly = true)
    }
  }
}

/** Library entry: "On this phone (N songs)". */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun OfflineEntry(state: AppState) {
  val saved = Offline.states.values.count { it == Download.STATE_COMPLETED }
  ListRow(
    icon = { Icon(FluentIcons.Download, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp)) },
    title = stringResource(R.string.offline_title),
    subtitle = stringResource(R.string.count_songs, saved),
  ) { state.navigate(Route.Offline) }
}
