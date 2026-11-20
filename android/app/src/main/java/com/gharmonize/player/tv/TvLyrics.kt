package com.gharmonize.player.tv

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.ui.Loading
import com.gharmonize.player.ui.rememberLoad
import androidx.compose.ui.res.stringResource

/**
 * Lyrics beside the player. Synced lyrics follow the song: the current line
 * is lit and kept a little above the middle. Plain lyrics scroll slowly with
 * the song. The remote never lands in here (the controls keep the focus).
 */
@Composable
fun TvLyricsPanel(trackId: Long?, preview: Boolean, positionMs: Long, durationMs: Long, modifier: Modifier = Modifier) {
  if (trackId == null || preview) { TvLyricsNote(stringResource(R.string.lyrics_library_only), modifier); return }
  val data = rememberLoad("tv-lyrics", trackId) { App.instance.api.lyrics(trackId) }
  val lyrics = data.value
  when {
    data.loading && lyrics == null -> Box(modifier, contentAlignment = Alignment.Center) { Loading() }
    lyrics == null || (lyrics.lines.isEmpty() && lyrics.plain.isBlank()) -> TvLyricsNote(stringResource(R.string.no_lyrics), modifier)
    else -> {
      val synced = lyrics.synced && lyrics.lines.isNotEmpty()
      val lines = if (synced) lyrics.lines.map { it.text } else lyrics.plain.lines()
      val active = if (synced) lyrics.lines.indexOfLast { it.timeMs <= positionMs + 250 } else -1
      // Plain lyrics: the line about where the song is.
      val target = if (synced) active.coerceAtLeast(0)
        else if (durationMs > 0) ((positionMs.toFloat() / durationMs) * lines.size).toInt().coerceIn(0, (lines.size - 1).coerceAtLeast(0)) else 0
      val list = rememberLazyListState()
      LaunchedEffect(trackId, target) { runCatching { list.animateScrollToItem(target) } }
      BoxWithConstraints(modifier.focusProperties { canFocus = false }) {
        LazyColumn(
          Modifier.fillMaxSize(), state = list, userScrollEnabled = false,
          // The padding puts the scrolled-to line at about a third of the height.
          contentPadding = PaddingValues(top = maxHeight * 0.32f, bottom = maxHeight * 0.6f),
        ) {
          itemsIndexed(lines) { i, line ->
            val on = synced && i == active
            val past = synced && i < active
            val color by animateColorAsState(
              when {
                !synced -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.85f)
                on -> MaterialTheme.colorScheme.primary
                past -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f)
                else -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
              }, label = "lyric",
            )
            Text(
              line.ifBlank { "♪" }, color = color,
              style = if (on) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.headlineSmall,
              fontWeight = if (on) FontWeight.Black else FontWeight.SemiBold,
              modifier = Modifier.fillMaxWidth().padding(vertical = if (synced) 9.dp else 4.dp),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun TvLyricsNote(text: String, modifier: Modifier) {
  Box(modifier, contentAlignment = Alignment.Center) {
    Text(text, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}
