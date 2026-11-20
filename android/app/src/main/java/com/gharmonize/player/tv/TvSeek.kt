package com.gharmonize.player.tv

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.playback.PlayerController
import com.gharmonize.player.ui.fmtTime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Seeking with the remote. A press jumps 10 s; holding keeps going and
 * speeds up the longer it is held (10 s → 30 s per step). While held only the
 * target moves on screen; the player seeks once, on release, so a long hold
 * does not fire dozens of seeks at the stream.
 */
class TvSeeker(private val player: PlayerController, private val scope: CoroutineScope) {
  /** Where the song will jump to (null when not seeking). */
  var target by mutableStateOf<Long?>(null)
    private set
  /** Called with the new position after a seek (refreshes the bar at once). */
  var onSeek: (Long) -> Unit = {}
  private var job: Job? = null

  private fun clamp(ms: Long): Long {
    val d = player.duration
    return if (d > 0) ms.coerceIn(0, (d - 1_000).coerceAtLeast(0)) else ms.coerceAtLeast(0)
  }

  /** Key down: first 10 s step now, then faster steps while held. */
  fun press(direction: Int) {
    if (job != null) return
    target = clamp((target ?: player.position) + direction * STEP_MS)
    job = scope.launch {
      delay(HOLD_DELAY_MS)
      var n = 0
      while (true) {
        val step = (STEP_MS + n * ACCEL_MS).coerceAtMost(MAX_STEP_MS)
        target = clamp((target ?: player.position) + direction * step)
        n++
        delay(TICK_MS)
      }
    }
  }

  /** Key up: seek to the target. */
  fun release() {
    job?.cancel()
    job = null
    val to = target ?: return
    target = null
    player.seekTo(to)
    onSeek(to)
  }

  /** A click without key events (touch / mouse): one 10 s step. */
  fun jump(direction: Int) {
    val to = clamp(player.position + direction * STEP_MS)
    player.seekTo(to)
    onSeek(to)
  }

  companion object {
    const val STEP_MS = 10_000L
    private const val ACCEL_MS = 2_500L
    private const val MAX_STEP_MS = 30_000L
    private const val HOLD_DELAY_MS = 350L
    private const val TICK_MS = 170L
  }
}

private fun KeyEvent.isOk() = key == Key.DirectionCenter || key == Key.Enter || key == Key.NumPadEnter

/** Handles a held key as press / release; true when the event was used. */
private fun seekKey(e: KeyEvent, seeker: TvSeeker, direction: Int): Boolean = when (e.type) {
  KeyEventType.KeyDown -> { seeker.press(direction); true }
  KeyEventType.KeyUp -> { seeker.release(); true }
  else -> false
}

/** The progress bar: focus it and hold ◀ / ▶ to seek. */
@Composable
fun TvSeekBar(position: Long, duration: Long, seeker: TvSeeker) {
  val interaction = remember { MutableInteractionSource() }
  val focused by interaction.collectIsFocusedAsState()
  val target = seeker.target
  val shown = target ?: position
  val fraction = if (duration > 0) (shown.toFloat() / duration).coerceIn(0f, 1f) else 0f
  val primary = MaterialTheme.colorScheme.primary
  val hint = stringResource(R.string.tv_seek_hint)
  Column(
    Modifier.fillMaxWidth()
      .onPreviewKeyEvent { e ->
        when (e.key) {
          Key.DirectionLeft -> seekKey(e, seeker, -1)
          Key.DirectionRight -> seekKey(e, seeker, 1)
          else -> false
        }
      }
      .semantics { contentDescription = hint }
      .focusable(interactionSource = interaction)
      .then(if (focused) Modifier.background(primary.copy(alpha = 0.10f), RoundedCornerShape(14.dp)).border(2.dp, primary, RoundedCornerShape(14.dp)) else Modifier)
      .padding(horizontal = 12.dp, vertical = 10.dp),
  ) {
    BoxWithConstraints(Modifier.fillMaxWidth().height(22.dp), contentAlignment = Alignment.CenterStart) {
      val bar = if (focused) 12.dp else 8.dp
      Box(Modifier.fillMaxWidth().height(bar).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.16f), RoundedCornerShape(6.dp))) {
        Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(primary, RoundedCornerShape(6.dp)))
      }
      if (focused) {
        val thumb = 22.dp
        Box(Modifier.offset(x = (maxWidth - thumb) * fraction).size(thumb).background(primary, CircleShape).border(3.dp, MaterialTheme.colorScheme.surface, CircleShape))
      }
    }
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
      Text(fmtTime(shown / 1000.0), style = MaterialTheme.typography.titleMedium,
        color = if (target != null) primary else MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = if (target != null) FontWeight.Bold else FontWeight.Normal)
      Spacer(Modifier.weight(1f))
      when {
        target != null -> {
          val diff = (target - position) / 1000
          Text((if (diff >= 0) "+" else "−") + fmtTime(kotlin.math.abs(diff).toDouble()), style = MaterialTheme.typography.titleMedium, color = primary, fontWeight = FontWeight.Bold)
        }
        focused -> Text(hint, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      Spacer(Modifier.weight(1f))
      Text(if (duration > 0) fmtTime(duration / 1000.0) else "", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

/** −10 / +10 button: a press jumps 10 s, holding OK keeps seeking faster. */
@Composable
fun TvSeekButton(direction: Int, seeker: TvSeeker, compact: Boolean = false) {
  val size = if (compact) 46.dp else 54.dp
  val label = stringResource(if (direction < 0) R.string.tv_seek_back else R.string.tv_seek_forward)
  TvFocusable(
    { seeker.jump(direction) },
    Modifier.size(size)
      .onPreviewKeyEvent { e -> if (e.isOk()) seekKey(e, seeker, direction) else false }
      .semantics { contentDescription = label },
    shape = CircleShape, scaleOnFocus = 1.12f,
  ) { focused ->
    Box(Modifier.size(size).background(if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
      Text(if (direction < 0) "−10" else "+10", style = if (compact) MaterialTheme.typography.labelLarge else MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold,
        color = if (focused) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}
