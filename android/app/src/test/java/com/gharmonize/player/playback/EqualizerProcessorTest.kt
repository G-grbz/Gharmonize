package com.gharmonize.player.playback

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

@UnstableApi
class EqualizerProcessorTest {
  private val rate = 44100

  private fun setParams(p: AudioEq.Params) {
    val field = AudioEq::class.java.getDeclaredField("params")
    field.isAccessible = true
    field.set(AudioEq, p)
  }

  /** Feeds 1 s of a stereo 16-bit sine and returns the output RMS of the last half (dBFS). */
  private fun run(freq: Double, amp: Double, p: AudioEq.Params): Pair<Double, Double> {
    setParams(p)
    val proc = EqualizerProcessor()
    proc.configure(AudioProcessor.AudioFormat(rate, 2, C.ENCODING_PCM_16BIT))
    proc.flush()
    val frames = rate
    val input = ByteBuffer.allocateDirect(frames * 4).order(ByteOrder.nativeOrder())
    for (i in 0 until frames) {
      val v = (amp * sin(2 * PI * freq * i / rate) * 32767).toInt().toShort()
      input.putShort(v); input.putShort(v)
    }
    input.flip()
    proc.queueInput(input)
    val out = proc.output
    var sum = 0.0
    var n = 0
    var peak = 0.0
    var i = 0
    while (out.hasRemaining()) {
      val s = out.short / 32768.0
      if (i >= frames) { sum += s * s; n++; peak = maxOf(peak, abs(s)) }
      i++
    }
    return 20 * log10(sqrt(sum / n)) to peak
  }

  private fun flat() = AudioEq.Params(true, FloatArray(AudioEq.FREQS.size), false, 0f)

  @Test fun neutralPassesThrough() {
    val (base, _) = run(1000.0, 0.25, AudioEq.Params(false, FloatArray(10), true, 0f))
    val (flat, _) = run(1000.0, 0.25, flat())
    assertEquals(base, flat, 0.01)
  }

  @Test fun boostRaisesItsBandOnly() {
    val gains = FloatArray(10).also { it[5] = 6f } // +6 dB at 1 kHz
    val p = AudioEq.Params(true, gains, false, 0f)
    val (ref, _) = run(1000.0, 0.25, flat())
    val (boosted, _) = run(1000.0, 0.25, p)
    assertEquals(6.0, boosted - ref, 0.3)
    val (refLow, _) = run(62.0, 0.25, flat())
    val (low, _) = run(62.0, 0.25, p)
    assertTrue("far band barely moves", abs(low - refLow) < 0.5)
  }

  @Test fun autoPreampCompensatesBoostAndLimiterStopsClipping() {
    val gains = FloatArray(10).also { it[5] = 6f }
    val (ref, _) = run(1000.0, 0.25, flat())
    val (auto, _) = run(1000.0, 0.25, AudioEq.Params(true, gains, true, 0f))
    assertEquals(0.0, auto - ref, 0.3)
    // A full-scale sine boosted by 12 dB without headroom stays below 0 dBFS.
    val hot = FloatArray(10).also { it[5] = 12f }
    val (_, peak) = run(1000.0, 0.95, AudioEq.Params(true, hot, false, 0f))
    assertTrue("peak $peak", peak < 1.0)
  }
}
