package com.gharmonize.player.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.playback.AudioEq
import kotlin.math.roundToInt

private val PRESET_LABELS = mapOf(
  "flat" to R.string.eq_flat,
  "soft" to R.string.eq_soft,
  "bass_boost" to R.string.eq_bass_boost,
  "bass_reduce" to R.string.eq_bass_reduce,
  "treble_boost" to R.string.eq_treble_boost,
  "treble_reduce" to R.string.eq_treble_reduce,
  "vocal" to R.string.eq_vocal,
  "pop" to R.string.eq_pop,
  "rock" to R.string.eq_rock,
  "electronic" to R.string.eq_electronic,
  "hiphop" to R.string.eq_hiphop,
  "jazz" to R.string.eq_jazz,
  "classical" to R.string.eq_classical,
  "acoustic" to R.string.eq_acoustic,
  "loudness" to R.string.eq_loudness,
  "custom" to R.string.eq_custom,
)

private fun freqLabel(hz: Float): String = if (hz >= 1000) "${(hz / 1000).let { if (it % 1f == 0f) it.toInt().toString() else it.toString() }}k" else hz.toInt().toString()

private fun dbLabel(db: Float): String = (if (db > 0) "+" else "") + (if (db % 1f == 0f) db.toInt().toString() else "%.1f".format(db))

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EqualizerScreen(state: AppState) {
  val prefs = state.app.prefs
  var params by remember { mutableStateOf(AudioEq.params) }
  var preset by remember { mutableStateOf(AudioEq.preset) }
  fun save(next: AudioEq.Params, presetId: String = preset) {
    AudioEq.update(prefs, next, presetId)
    params = AudioEq.params
    preset = presetId
  }
  val p = params
  val enabled = p.enabled

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
      IconButton(onClick = { state.back() }) { Icon(FluentIcons.KeyboardArrowDown, stringResource(R.string.close), modifier = Modifier.rotate(90f)) }
      Text(stringResource(R.string.equalizer), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
      Switch(checked = enabled, onCheckedChange = { save(AudioEq.Params(it, p.gains, p.autoPreamp, p.manualPreampDb)) })
    }
    Text(stringResource(R.string.eq_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))

    Text(stringResource(R.string.eq_presets), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp))
    FlowRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      AudioEq.PRESETS.forEach { (id, gains) ->
        FilterChip(
          selected = preset == id,
          onClick = { save(AudioEq.Params(true, gains.copyOf(), p.autoPreamp, p.manualPreampDb), id) },
          label = { Text(stringResource(PRESET_LABELS[id] ?: R.string.eq_custom)) },
        )
      }
      if (preset == "custom") FilterChip(selected = true, onClick = {}, label = { Text(stringResource(R.string.eq_custom)) })
    }

    Row(
      Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 16.dp),
      horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
      AudioEq.FREQS.forEachIndexed { i, hz ->
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
          Text(dbLabel(p.gains[i]), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
          GainSlider(
            value = p.gains[i],
            enabled = enabled,
            onChange = { db ->
              val gains = p.gains.copyOf().also { it[i] = db }
              save(AudioEq.Params(true, gains, p.autoPreamp, p.manualPreampDb), "custom")
            },
            modifier = Modifier.height(220.dp).width(30.dp).padding(vertical = 6.dp),
          )
          Text(freqLabel(hz), style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center, maxLines = 1)
        }
      }
    }
    HorizontalDivider()
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
      Column(Modifier.weight(1f)) {
        Text(stringResource(R.string.eq_auto_preamp), style = MaterialTheme.typography.bodyLarge)
        Text(stringResource(R.string.eq_auto_preamp_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      Switch(checked = p.autoPreamp, onCheckedChange = { save(AudioEq.Params(p.enabled, p.gains, it, p.preampDb)) })
    }
    Column(Modifier.padding(horizontal = 16.dp)) {
      Text(stringResource(R.string.eq_preamp, dbLabel((p.preampDb * 2).roundToInt() / 2f)), style = MaterialTheme.typography.bodyMedium)
      Slider(
        value = p.preampDb,
        onValueChange = { save(AudioEq.Params(p.enabled, p.gains, false, (it * 2).roundToInt() / 2f)) },
        valueRange = -AudioEq.MAX_DB..6f,
        enabled = enabled && !p.autoPreamp,
      )
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.End) {
      TextButton(onClick = { save(AudioEq.Params(p.enabled, FloatArray(AudioEq.FREQS.size), true, 0f), "flat") }) { Text(stringResource(R.string.eq_reset)) }
    }
    Spacer(Modifier.height(8.dp))
  }
}

/** Vertical ±12 dB slider: drag or tap; snaps to 0.5 dB, and near 0 to 0. */
@Composable
private fun GainSlider(value: Float, enabled: Boolean, onChange: (Float) -> Unit, modifier: Modifier = Modifier) {
  val colors = MaterialTheme.colorScheme
  val change = rememberUpdatedState(onChange)
  val active = if (enabled) colors.primary else colors.onSurfaceVariant.copy(alpha = 0.5f)
  val track = colors.outlineVariant
  Canvas(
    modifier.pointerInput(enabled) {
      if (!enabled) return@pointerInput
      awaitEachGesture {
        val down = awaitFirstDown()
        down.consume()
        fun dbAt(y: Float): Float {
          val f = 1f - (y / size.height).coerceIn(0f, 1f)
          val db = (f * 2 - 1) * AudioEq.MAX_DB
          val snapped = (db * 2).roundToInt() / 2f
          return if (kotlin.math.abs(snapped) < 0.75f) 0f else snapped
        }
        var last = dbAt(down.position.y)
        change.value(last)
        while (true) {
          val event = awaitPointerEvent()
          val c = event.changes.firstOrNull { it.id == down.id } ?: break
          if (!c.pressed) break
          val db = dbAt(c.position.y)
          if (db != last) { last = db; change.value(db) }
          c.consume()
        }
      }
    },
  ) {
    val x = size.width / 2
    val w = 4.dp.toPx()
    val zero = size.height / 2
    val y = zero - (value / AudioEq.MAX_DB) * (size.height / 2)
    drawLine(track, Offset(x, 0f), Offset(x, size.height), w, StrokeCap.Round)
    drawLine(track, Offset(x - 7.dp.toPx(), zero), Offset(x + 7.dp.toPx(), zero), 1.dp.toPx())
    if (value != 0f) drawLine(active, Offset(x, zero), Offset(x, y), w, StrokeCap.Round)
    drawCircle(active, 8.dp.toPx(), Offset(x, y))
  }
}
