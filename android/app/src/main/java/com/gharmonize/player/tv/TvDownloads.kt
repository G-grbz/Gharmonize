package com.gharmonize.player.tv

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.DownloadRow
import com.gharmonize.player.ui.Artwork
import com.gharmonize.player.ui.FluentIcons
import com.gharmonize.player.ui.Loading
import com.gharmonize.player.ui.statusText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Downloads on the TV: the account's download queue with live progress.
 * OK on a finished download plays its songs; the button at the end of a row
 * cancels a running download or retries a failed one. The list refreshes
 * every 2 s while something runs (every 15 s otherwise), only while open.
 */
@Composable
fun TvDownloads(nav: TvNav) {
  val api = App.instance.api
  val scope = rememberCoroutineScope()
  var rows by remember { mutableStateOf<List<DownloadRow>?>(null) }
  var tick by remember { mutableStateOf(0) }
  LaunchedEffect(tick) {
    while (true) {
      runCatching { api.downloads() }.onSuccess { rows = it }
      delay(if (rows.orEmpty().any { it.active }) 2_000 else 15_000)
    }
  }
  val first = remember { FocusRequester() }
  var focused by remember { mutableStateOf(false) }
  LaunchedEffect(rows?.isNotEmpty()) { if (!focused && !rows.isNullOrEmpty()) { focused = runCatching { first.requestFocus() }.isSuccess } }

  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 36.dp, end = 36.dp, top = 28.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
    item {
      Text(stringResource(R.string.nav_downloads), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 8.dp, bottom = 8.dp))
      val active = rows.orEmpty().count { it.active }
      if (active > 0) Text(stringResource(R.string.tv_downloads_active, active), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 8.dp, bottom = 8.dp))
    }
    if (!nav.canDownload) item { Text(stringResource(R.string.downloads_not_allowed), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp, bottom = 8.dp)) }
    val list = rows
    when {
      list == null -> item { Loading() }
      list.isEmpty() -> item { Text(stringResource(R.string.downloads_empty), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp, top = 24.dp)) }
      else -> itemsIndexed(list, key = { _, r -> r.id }) { i, row ->
        TvDownloadRow(
          row, if (i == 0) Modifier.focusRequester(first) else Modifier,
          onPlay = {
            scope.launch { runCatching { api.tracksByIds(row.trackIds) }.onSuccess { if (it.isNotEmpty()) nav.play(it, 0) } }
          },
          onCancel = { scope.launch { runCatching { api.cancelDownload(row.id) }; tick++ } },
          onRetry = { scope.launch { runCatching { api.retryDownload(row.id) }; tick++ } },
        )
      }
    }
  }
}

@Composable
private fun TvDownloadRow(row: DownloadRow, modifier: Modifier, onPlay: () -> Unit, onCancel: () -> Unit, onRetry: () -> Unit) {
  val playable = row.trackIds.isNotEmpty() && (row.status == "completed" || row.status == "exists")
  val failed = row.status == "failed"
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    TvFocusable({ if (playable) onPlay() }, modifier.weight(1f), shape = RoundedCornerShape(12.dp), scaleOnFocus = 1.01f) {
      Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Artwork(row.artworkUrl, Modifier.size(64.dp), size = 160)
        Spacer(Modifier.width(18.dp))
        Column(Modifier.weight(1f)) {
          Text(row.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
          Text(listOfNotNull(row.artist.ifBlank { null }, statusText(row)).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyMedium, color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
          if (row.active) {
            Spacer(Modifier.height(8.dp))
            LinearProgressIndicator(progress = { (row.progress / 100f).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().height(6.dp))
          }
        }
        if (row.active && row.status == "downloading") { Spacer(Modifier.width(16.dp)); Text("${row.progress}%", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold) }
        if (playable) { Spacer(Modifier.width(16.dp)); TvTag(stringResource(R.string.play), FluentIcons.PlayArrow) }
      }
    }
    Spacer(Modifier.width(10.dp))
    when {
      row.active -> TvRowAction(FluentIcons.Close, stringResource(R.string.cancel), onCancel)
      failed || row.status == "canceled" -> TvRowAction(FluentIcons.Refresh, stringResource(R.string.retry), onRetry)
      else -> Spacer(Modifier.width(52.dp))
    }
  }
}

/** Round button at the end of a row (Right on the remote). */
@Composable
private fun TvRowAction(icon: ImageVector, label: String, onClick: () -> Unit) {
  TvFocusable(onClick, Modifier.size(52.dp).semantics { contentDescription = label }, shape = CircleShape, scaleOnFocus = 1.12f) { focused ->
    Box(Modifier.size(52.dp).background(if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
      Icon(icon, label, modifier = Modifier.size(24.dp), tint = if (focused) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}
