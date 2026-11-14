package com.gharmonize.player.ui

import android.content.Context
import android.media.AudioManager
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

val PROGRESS_STYLES = listOf("ring", "classic", "bold", "minimal", "wave")

private val Played = Color.White
private val Rest = Color.White.copy(alpha = 0.25f)

/**
 * Linear seek bar in the "bold", "minimal" or "wave" look (the "classic" look
 * stays the Material slider). Tap or drag anywhere on it to seek.
 */
@Composable
fun StyledSeekBar(
  style: String,
  fraction: Float,
  bins: FloatArray?,
  onDrag: (Float) -> Unit,
  onCommit: (Float) -> Unit,
  modifier: Modifier = Modifier,
) {
  var dragging by remember { mutableStateOf(false) }
  val drag = rememberUpdatedState(onDrag)
  val commit = rememberUpdatedState(onCommit)
  val height = when (style) { "wave" -> 46.dp; else -> 32.dp }
  Canvas(
    modifier.fillMaxWidth().height(height).pointerInput(Unit) {
      awaitEachGesture {
        val down = awaitFirstDown()
        down.consume()
        dragging = true
        var f = (down.position.x / size.width).coerceIn(0f, 1f)
        drag.value(f)
        while (true) {
          val event = awaitPointerEvent()
          val change = event.changes.firstOrNull { it.id == down.id } ?: break
          if (!change.pressed) break
          f = (change.position.x / size.width).coerceIn(0f, 1f)
          if (change.positionChange() != Offset.Zero) drag.value(f)
          change.consume()
        }
        dragging = false
        commit.value(f)
      }
    },
  ) {
    val cy = size.height / 2
    when (style) {
      "wave" -> {
        val barW = 3.dp.toPx()
        val gap = 2.dp.toPx()
        val n = max(8, ((size.width + gap) / (barW + gap)).toInt())
        val step = (size.width - barW) / (n - 1)
        for (i in 0 until n) {
          val v = bins?.let { sampleBins(it, i, n) } ?: 0.18f
          val h = max(2.dp.toPx(), v * size.height)
          val x = i * step
          drawRoundRect(
            if ((x + barW / 2) / size.width <= fraction) Played else Rest,
            topLeft = Offset(x, cy - h / 2), size = Size(barW, h), cornerRadius = CornerRadius(barW / 2),
          )
        }
      }
      "minimal" -> {
        val h = 2.dp.toPx()
        drawLine(Rest, Offset(0f, cy), Offset(size.width, cy), h)
        drawLine(Played, Offset(0f, cy), Offset(size.width * fraction, cy), h)
        if (dragging) drawCircle(Played, 6.dp.toPx(), Offset(size.width * fraction, cy))
      }
      else -> { // bold
        val h = 9.dp.toPx()
        drawLine(Rest, Offset(h / 2, cy), Offset(size.width - h / 2, cy), h, StrokeCap.Round)
        val end = (size.width * fraction).coerceIn(h / 2, size.width - h / 2)
        if (fraction > 0f) drawLine(Played, Offset(h / 2, cy), Offset(end, cy), h, StrokeCap.Round)
        drawCircle(Played, (if (dragging) 10 else 8).dp.toPx(), Offset(end, cy))
      }
    }
  }
}

private fun sampleBins(bins: FloatArray, i: Int, n: Int): Float {
  val from = i * bins.size / n
  val to = max(from + 1, (i + 1) * bins.size / n)
  var m = 0f
  for (j in from until min(to, bins.size)) if (bins[j] > m) m = bins[j]
  return m
}

/** Music stream volume (0..1), refreshed while visible, and a setter. */
@Composable
private fun rememberMusicVolume(): Pair<Float, (Float) -> Unit> {
  val context = LocalContext.current
  val audio = remember { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
  val maxVol = remember { max(1, audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)) }
  var volume by remember { mutableFloatStateOf(audio.getStreamVolume(AudioManager.STREAM_MUSIC) / maxVol.toFloat()) }
  var touchedAt by remember { mutableStateOf(0L) }
  // Hardware keys and other apps change it too.
  LaunchedEffect(Unit) {
    while (true) {
      delay(700)
      if (System.currentTimeMillis() - touchedAt > 1000) volume = audio.getStreamVolume(AudioManager.STREAM_MUSIC) / maxVol.toFloat()
    }
  }
  return volume to { v: Float ->
    touchedAt = System.currentTimeMillis()
    volume = v
    val step = (v * maxVol).roundToInt().coerceIn(0, maxVol)
    if (step != audio.getStreamVolume(AudioManager.STREAM_MUSIC)) runCatching { audio.setStreamVolume(AudioManager.STREAM_MUSIC, step, 0) }
  }
}

// Volume arc: from 40° below to 40° above 3 o'clock (degrees grow clockwise).
private const val VOL_BOTTOM = 40f
private const val VOL_SPAN = 80f
private const val VOL_RADIUS = 1.24f

/**
 * Round cover with optional controls on its frame: a progress ring (drag
 * around it to seek) and a volume arc on the right (slide along it). Touches
 * inside the cover are left alone, so swipes for next / previous still work.
 */
@Composable
fun CoverDial(
  artRef: String?,
  fraction: Float,
  ring: Boolean,
  volumeArc: Boolean,
  onSeekDrag: (Float) -> Unit,
  onSeekCommit: (Float) -> Unit,
  maxDiameter: Dp = 330.dp,
) {
  val (volume, setVolume) = rememberMusicVolume()
  var seekDrag by remember { mutableStateOf<Float?>(null) }
  var volDrag by remember { mutableStateOf<Float?>(null) }
  val seekDragCb = rememberUpdatedState(onSeekDrag)
  val seekCommitCb = rememberUpdatedState(onSeekCommit)
  val setVolumeCb = rememberUpdatedState(setVolume)
  val white = Color.White

  BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
    if (!ring && !volumeArc) {
      val diameter = minOf(maxWidth, maxHeight, maxDiameter)
      Box(Modifier.size(diameter).clip(CircleShape).background(white.copy(alpha = 0.12f)).border(2.dp, white.copy(alpha = 0.32f), CircleShape).padding(10.dp)) {
        Artwork(artRef, Modifier.fillMaxSize(), shape = CircleShape, size = 900)
      }
      return@BoxWithConstraints
    }
    // Leave room on the right for the volume arc and its speaker mark.
    val art = minOf(if (volumeArc) (maxWidth - 60.dp) / VOL_RADIUS else maxWidth * 0.9f, maxHeight - 12.dp, maxDiameter - 30.dp)
    val canvas = art * 1.5f
    Box(Modifier.requiredSize(canvas), contentAlignment = Alignment.Center) {
      Box(
        Modifier.size(art).clip(CircleShape).background(white.copy(alpha = 0.08f))
          .then(if (ring) Modifier else Modifier.border(2.dp, white.copy(alpha = 0.32f), CircleShape)).padding(12.dp),
      ) {
        Artwork(artRef, Modifier.fillMaxSize(), shape = CircleShape, size = 900)
      }
      Canvas(
        Modifier.fillMaxSize().pointerInput(ring, volumeArc) {
          awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            val c = Offset(size.width / 2f, size.height / 2f)
            val artR = size.width / 1.5f / 2f
            val ringR = artR - 1.dp.toPx()
            val volR = artR * VOL_RADIUS
            val d = down.position - c
            val dist = hypot(d.x, d.y)
            val angle = Math.toDegrees(atan2(d.y, d.x).toDouble()).toFloat()
            // The two bands are close: a touch goes to the nearer one.
            val toRing = if (ring) abs(dist - ringR) else Float.MAX_VALUE
            val toVol = if (volumeArc && d.x > 0 && angle <= VOL_BOTTOM + 18f && angle >= VOL_BOTTOM - VOL_SPAN - 18f) abs(dist - volR) else Float.MAX_VALUE
            val reach = max(22.dp.toPx(), ringR * 0.14f)
            val kind = when {
              toVol < toRing && toVol <= reach -> 2
              toRing <= reach -> 1
              else -> 0
            }
            if (kind == 0) return@awaitEachGesture
            down.consume()
            fun valueAt(p: Offset): Float {
              val a = Math.toDegrees(atan2((p - c).y, (p - c).x).toDouble()).toFloat()
              return if (kind == 1) ((a + 90f + 360f) % 360f) / 360f else ((VOL_BOTTOM - a) / VOL_SPAN).coerceIn(0f, 1f)
            }
            var value = valueAt(down.position)
            if (kind == 1) { seekDrag = value; seekDragCb.value(value) } else { volDrag = value; setVolumeCb.value(value) }
            while (true) {
              val event = awaitPointerEvent()
              val change = event.changes.firstOrNull { it.id == down.id } ?: break
              if (!change.pressed) break
              var next = valueAt(change.position)
              // No jump from the end of the song to its start (or back).
              if (kind == 1 && abs(next - value) > 0.5f) next = if (value > 0.5f) 1f else 0f
              value = next
              if (kind == 1) { seekDrag = value; seekDragCb.value(value) } else { volDrag = value; setVolumeCb.value(value) }
              change.consume()
            }
            if (kind == 1) { seekCommitCb.value(value); seekDrag = null } else volDrag = null
          }
        },
      ) {
        val c = center
        val artR = size.width / 1.5f / 2f
        if (ring) drawProgressRing(c, artR - 1.dp.toPx(), seekDrag ?: fraction, seekDrag != null)
        if (volumeArc) drawVolumeArc(c, artR * VOL_RADIUS, volDrag ?: volume, volDrag != null)
      }
    }
  }
}

private fun DrawScope.drawProgressRing(c: Offset, r: Float, f: Float, active: Boolean) {
  val topLeft = Offset(c.x - r, c.y - r)
  val arcSize = Size(r * 2, r * 2)
  drawCircle(Color(0x38E1F1FF), r, c, style = Stroke(3.dp.toPx()))
  if (f > 0f) drawArc(Color.White, -90f, 360f * f, false, topLeft, arcSize, style = Stroke(4.dp.toPx(), cap = StrokeCap.Round))
  val a = (-90.0 + 360.0 * f) * PI / 180.0
  drawCircle(Color.White, (if (active) 11 else 8).dp.toPx(), Offset(c.x + cos(a).toFloat() * r, c.y + sin(a).toFloat() * r))
}

private fun DrawScope.drawVolumeArc(c: Offset, r: Float, v: Float, active: Boolean) {
  val topLeft = Offset(c.x - r, c.y - r)
  val arcSize = Size(r * 2, r * 2)
  val stroke = Stroke(3.dp.toPx(), cap = StrokeCap.Round)
  drawArc(Color(0x38E1F1FF), VOL_BOTTOM - VOL_SPAN, VOL_SPAN, false, topLeft, arcSize, style = stroke)
  if (v > 0f) drawArc(Color.White, VOL_BOTTOM - v * VOL_SPAN, v * VOL_SPAN, false, topLeft, arcSize, style = stroke)
  val a = (VOL_BOTTOM - v * VOL_SPAN) * PI / 180.0
  drawCircle(Color.White, (if (active) 10 else 7).dp.toPx(), Offset(c.x + cos(a).toFloat() * r, c.y + sin(a).toFloat() * r))
  // Speaker mark beside the arc.
  val u = 1.dp.toPx()
  val sx = c.x + r + 20 * u
  val sy = c.y + r * 0.42f
  val tint = Color.White.copy(alpha = 0.75f)
  val body = Path().apply {
    moveTo(sx - 6 * u, sy - 3 * u); lineTo(sx - 3 * u, sy - 3 * u); lineTo(sx + 1 * u, sy - 7 * u)
    lineTo(sx + 1 * u, sy + 7 * u); lineTo(sx - 3 * u, sy + 3 * u); lineTo(sx - 6 * u, sy + 3 * u); close()
  }
  drawPath(body, tint)
  for (rr in listOf(5f, 9f)) {
    drawArc(tint, -40f, 80f, false, Offset(sx + u - rr * u, sy - rr * u), Size(2 * rr * u, 2 * rr * u), style = Stroke(1.5f * u))
  }
}
