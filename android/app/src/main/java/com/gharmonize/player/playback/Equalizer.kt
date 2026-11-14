package com.gharmonize.player.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import com.gharmonize.player.data.Prefs
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.tanh

/**
 * 10-band graphic equalizer settings. The processing runs inside the player
 * (not the phone's audio effects), so it sounds the same on every device and
 * never touches other apps.
 */
object AudioEq {
  val FREQS = floatArrayOf(31f, 62f, 125f, 250f, 500f, 1000f, 2000f, 4000f, 8000f, 16000f)
  const val MAX_DB = 12f

  class Params(val enabled: Boolean, val gains: FloatArray, val autoPreamp: Boolean, val manualPreampDb: Float) {
    /** Boosts are compensated so they can't push the music into clipping. */
    val preampDb: Float get() = if (autoPreamp) -max(0f, gains.maxOrNull() ?: 0f) else manualPreampDb
    val isNeutral: Boolean get() = !enabled || (gains.all { it == 0f } && preampDb == 0f)
  }

  /** Preset id → gains (dB) for [FREQS]. "custom" keeps the user's own curve. */
  val PRESETS: List<Pair<String, FloatArray>> = listOf(
    "flat" to floatArrayOf(0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f, 0f),
    "soft" to floatArrayOf(0f, 0f, 0f, 0f, 0f, -0.5f, -1.5f, -3f, -2.5f, -1.5f),
    "bass_boost" to floatArrayOf(6f, 5.5f, 4.5f, 3f, 1.5f, 0f, 0f, 0f, 0f, 0f),
    "bass_reduce" to floatArrayOf(-6f, -5f, -4f, -2.5f, -1f, 0f, 0f, 0f, 0f, 0f),
    "treble_boost" to floatArrayOf(0f, 0f, 0f, 0f, 0f, 1f, 2.5f, 4f, 5f, 6f),
    "treble_reduce" to floatArrayOf(0f, 0f, 0f, 0f, 0f, -1f, -2.5f, -4f, -5f, -6f),
    "vocal" to floatArrayOf(-2f, -2f, -1f, 0.5f, 2.5f, 3.5f, 3.5f, 2f, 0.5f, -1f),
    "pop" to floatArrayOf(-1f, 0f, 1.5f, 3f, 3.5f, 2.5f, 1f, 0f, -0.5f, -1f),
    "rock" to floatArrayOf(4.5f, 3.5f, 2f, 0.5f, -1f, -1f, 0.5f, 2f, 3.5f, 4.5f),
    "electronic" to floatArrayOf(5f, 4.5f, 2f, 0f, -1.5f, 1f, 0.5f, 1.5f, 4f, 5f),
    "hiphop" to floatArrayOf(5f, 4.5f, 2f, 3f, -1f, -1f, 1f, -0.5f, 1.5f, 3f),
    "jazz" to floatArrayOf(3f, 2f, 1f, 2f, -1.5f, -1.5f, 0f, 1f, 2f, 3f),
    "classical" to floatArrayOf(4f, 3f, 2.5f, 2f, -1f, -1f, 0f, 2f, 3f, 3.5f),
    "acoustic" to floatArrayOf(3.5f, 3f, 2.5f, 1f, 1.5f, 1.5f, 2.5f, 3f, 2.5f, 1.5f),
    "loudness" to floatArrayOf(5f, 4f, 1.5f, 0f, -1f, 0f, -0.5f, 1f, 4f, 4.5f),
  )

  @Volatile var params = Params(false, FloatArray(FREQS.size), true, 0f)
    private set
  @Volatile var preset: String = "flat"
    private set

  fun load(prefs: Prefs) {
    val gains = prefs.eqGains.takeIf { it.size == FREQS.size } ?: FloatArray(FREQS.size)
    params = Params(prefs.eqEnabled, gains, prefs.eqAutoPreamp, prefs.eqPreamp)
    preset = prefs.eqPreset
  }

  fun update(prefs: Prefs, next: Params, presetId: String = preset) {
    val gains = FloatArray(FREQS.size) { i -> next.gains.getOrElse(i) { 0f }.coerceIn(-MAX_DB, MAX_DB) }
    params = Params(next.enabled, gains, next.autoPreamp, next.manualPreampDb.coerceIn(-MAX_DB, 6f))
    preset = presetId
    prefs.eqEnabled = next.enabled
    prefs.eqGains = gains
    prefs.eqAutoPreamp = next.autoPreamp
    prefs.eqPreamp = params.manualPreampDb
    prefs.eqPreset = presetId
  }
}

/**
 * Applies [AudioEq] to the decoded PCM (16-bit or float): peaking filters,
 * pre-amplification and a soft limiter that only acts on the loudest peaks.
 */
@OptIn(UnstableApi::class)
class EqualizerProcessor : BaseAudioProcessor() {
  private var applied: AudioEq.Params? = null
  private var bands = 0
  // Per band: b0 b1 b2 a1 a2 (normalized); per band and channel: z1 z2.
  private var coef = FloatArray(0)
  private var state = FloatArray(0)
  private var preamp = 1f

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT && inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT) {
      return AudioProcessor.AudioFormat.NOT_SET
    }
    return inputAudioFormat
  }

  override fun onFlush() {
    applied = null
    state = FloatArray(0)
  }

  override fun onReset() {
    applied = null
    state = FloatArray(0)
    coef = FloatArray(0)
  }

  private fun prepare(p: AudioEq.Params) {
    val rate = inputAudioFormat.sampleRate.toFloat()
    val channels = inputAudioFormat.channelCount
    val active = AudioEq.FREQS.indices.filter { p.gains[it] != 0f && AudioEq.FREQS[it] < rate * 0.45f }
    val next = FloatArray(active.size * 5)
    active.forEachIndexed { n, i ->
      // RBJ cookbook peaking filter, about one octave wide.
      val a = 10.0.pow(p.gains[i] / 40.0)
      val w0 = 2.0 * PI * AudioEq.FREQS[i] / rate
      val alpha = sin(w0) / (2.0 * 1.41)
      val a0 = 1.0 + alpha / a
      next[n * 5] = ((1.0 + alpha * a) / a0).toFloat()
      next[n * 5 + 1] = ((-2.0 * cos(w0)) / a0).toFloat()
      next[n * 5 + 2] = ((1.0 - alpha * a) / a0).toFloat()
      next[n * 5 + 3] = ((-2.0 * cos(w0)) / a0).toFloat()
      next[n * 5 + 4] = ((1.0 - alpha / a) / a0).toFloat()
    }
    // Keep the filter memory when only the gains change, so there is no click.
    if (state.size != active.size * channels * 2 || active.size != bands) state = FloatArray(active.size * channels * 2)
    bands = active.size
    coef = next
    preamp = 10f.pow(p.preampDb / 20f)
    applied = p
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val remaining = inputBuffer.remaining()
    if (remaining == 0) return
    val p = AudioEq.params
    val out = replaceOutputBuffer(remaining)
    if (p.isNeutral) {
      out.put(inputBuffer)
      out.flip()
      return
    }
    if (applied !== p) prepare(p)
    val channels = inputAudioFormat.channelCount
    val isFloat = inputAudioFormat.encoding == C.ENCODING_PCM_FLOAT
    val src = inputBuffer.order(ByteOrder.nativeOrder())
    var ch = 0
    while (src.hasRemaining()) {
      var x = (if (isFloat) src.float else src.short / 32768f) * preamp
      for (b in 0 until bands) {
        val c = b * 5
        val s = (b * channels + ch) * 2
        val y = coef[c] * x + state[s]
        state[s] = coef[c + 1] * x - coef[c + 3] * y + state[s + 1]
        state[s + 1] = coef[c + 2] * x - coef[c + 4] * y
        x = y
      }
      x = softLimit(x)
      if (isFloat) out.putFloat(x) else out.putShort((x * 32767f).roundToInt().coerceIn(-32768, 32767).toShort())
      ch = if (ch + 1 == channels) 0 else ch + 1
    }
    out.flip()
  }

  private fun softLimit(x: Float): Float {
    val ax = abs(x)
    if (ax <= LIMIT) return x
    val over = LIMIT + (1f - LIMIT) * tanh((ax - LIMIT) / (1f - LIMIT))
    return if (x < 0) -over else over
  }

  private companion object {
    /** About -1 dBFS: everything below passes untouched. */
    const val LIMIT = 0.89f
  }
}
