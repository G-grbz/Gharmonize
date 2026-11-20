package com.gharmonize.player.tv

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type

/**
 * Up / down between card rows. The platform picks the geometrically closest
 * card, so from the 6th card of a row it could skip a shorter row above (no
 * card there) and land two rows up. Here up / down always go to the next row
 * on screen, back to the card last used in it (first card otherwise).
 * Only for pages that are rows and nothing else (the home page).
 */
class TvRowNav {
  internal class Entry(val requester: FocusRequester) {
    var top = 0f
    var focused = false
    // Lazy lists compose upcoming rows ahead of time without placing them.
    var placed = false
  }

  internal val entries = LinkedHashSet<Entry>()
  /** The remote was used on this page (then the page is left alone). */
  var touched = false
    internal set

  internal fun move(down: Boolean): Boolean {
    val current = entries.firstOrNull { it.focused } ?: return false
    val placed = entries.filter { it.placed && it !== current }
    val target = if (down) placed.filter { it.top > current.top + 1f }.minByOrNull { it.top }
      else placed.filter { it.top < current.top - 1f }.maxByOrNull { it.top }
    target ?: return false
    runCatching { target.requester.requestFocus() }
    // Not reachable after all: let the platform move focus as usual.
    return target.focused
  }
}

/** Focuses the topmost row on screen (its last used card); false if none yet. */
fun TvRowNav.focusTop(): Boolean {
  val top = entries.filter { it.placed }.minByOrNull { it.top } ?: return false
  runCatching { top.requester.requestFocus() }
  return top.focused
}

internal val LocalTvRowNav = staticCompositionLocalOf<TvRowNav?> { null }

/** Row-to-row up / down for everything inside (see [TvRowNav]). */
@Composable
fun TvRowNavigation(modifier: Modifier = Modifier, content: @Composable (Modifier, TvRowNav) -> Unit) {
  val nav = remember { TvRowNav() }
  CompositionLocalProvider(LocalTvRowNav provides nav) {
    content(modifier.onPreviewKeyEvent { e ->
      if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
      nav.touched = true
      when (e.key) {
        Key.DirectionDown -> nav.move(down = true)
        Key.DirectionUp -> nav.move(down = false)
        else -> false
      }
    }, nav)
  }
}
