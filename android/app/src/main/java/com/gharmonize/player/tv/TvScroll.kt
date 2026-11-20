package com.gharmonize.player.tv

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider

/**
 * TV page scrolling.
 *  - Card rows settle a third from the top, so going down / up row by row
 *    always lands at the same height. The focused card grows a little
 *    (graphicsLayer scale) and its grown bounds are what is asked to be
 *    shown; without the slack that nudged the page up and down on every
 *    left / right press while the scale animated.
 *  - Small items (song rows) never scroll while comfortably on screen (not
 *    in the top / bottom 10 %) and then move just enough to get back in.
 */
@OptIn(ExperimentalFoundationApi::class)
private object TvPivotSpec : BringIntoViewSpec {
  private const val PIVOT = 0.3f
  private const val MARGIN = 0.1f
  private const val BIG = 0.25f
  private const val SCALE_SLACK = 0.07f

  override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
    if (containerSize <= 0f) return 0f
    // Taller than the screen: show its start.
    if (size >= containerSize) return offset
    // Card rows: always the pivot height. The focused card's grown bounds
    // differ from its real ones by a few %, so that much is ignored.
    if (size > containerSize * BIG) {
      var target = containerSize * PIVOT
      if (target + size > containerSize) target = containerSize - size
      val distance = offset - target
      return if (kotlin.math.abs(distance) <= size * SCALE_SLACK) 0f else distance
    }
    val top = containerSize * MARGIN
    val bottom = containerSize * (1f - MARGIN)
    if (offset >= top && offset + size <= bottom) return 0f
    return if (offset < top) offset - top else (offset + size) - bottom
  }
}

/** Vertical TV pages (lists, grids) scroll with the pivot rule. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TvPivotScroll(content: @Composable () -> Unit) {
  val default = LocalBringIntoViewSpec.current
  CompositionLocalProvider(LocalBringIntoViewSpec provides TvPivotSpec, LocalTvDefaultScroll provides default) { content() }
}

/** Card rows keep the platform's "just make it visible" scrolling sideways. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TvRowScroll(content: @Composable () -> Unit) {
  val default = LocalTvDefaultScroll.current ?: return content()
  CompositionLocalProvider(LocalBringIntoViewSpec provides default) { content() }
}

@OptIn(ExperimentalFoundationApi::class)
private val LocalTvDefaultScroll = androidx.compose.runtime.staticCompositionLocalOf<BringIntoViewSpec?> { null }
