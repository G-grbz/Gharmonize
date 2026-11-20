package com.gharmonize.player.tv

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.Track
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.gharmonize.player.ui.Artwork
import com.gharmonize.player.ui.FluentIcons
import com.gharmonize.player.ui.fmtTime

/**
 * Something the remote can focus: grows a little and gets an accent frame
 * when focused; OK / Enter clicks it.
 */
@Composable
fun TvFocusable(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  shape: Shape = RoundedCornerShape(14.dp),
  scaleOnFocus: Float = 1.06f,
  content: @Composable (focused: Boolean) -> Unit,
) {
  val interaction = remember { MutableInteractionSource() }
  val focused by interaction.collectIsFocusedAsState()
  val scale by animateFloatAsState(if (focused) scaleOnFocus else 1f, label = "tv-focus")
  Box(
    modifier
      .graphicsLayer { scaleX = scale; scaleY = scale }
      .clip(shape)
      .then(if (focused) Modifier.border(BorderStroke(3.dp, MaterialTheme.colorScheme.primary), shape) else Modifier)
      .background(if (focused) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f) else androidx.compose.ui.graphics.Color.Transparent, shape)
      .clickable(interactionSource = interaction, indication = null, onClick = onClick),
  ) { content(focused) }
}

/** Cover card for rows and grids. */
@Composable
fun TvCard(
  title: String, subtitle: String, art: String?, width: Dp = 190.dp, round: Boolean = false, placeholder: ImageVector = FluentIcons.Album,
  modifier: Modifier = Modifier, badge: (@Composable () -> Unit)? = null, artContent: (@Composable () -> Unit)? = null, onClick: () -> Unit,
) {
  TvFocusable(onClick, modifier.width(width), shape = RoundedCornerShape(16.dp)) {
    Column(Modifier.padding(8.dp)) {
      Box {
        if (artContent != null) Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(12.dp))) { artContent() }
        else Artwork(art, Modifier.fillMaxWidth().aspectRatio(1f), shape = if (round) CircleShape else RoundedCornerShape(12.dp), size = 300, placeholder = placeholder)
        if (badge != null) Box(Modifier.align(Alignment.TopEnd).padding(8.dp)) { badge() }
      }
      Spacer(Modifier.height(8.dp))
      Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
      if (subtitle.isNotBlank()) Text(subtitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

/** A titled horizontal row of cards. */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
fun <T> TvRow(title: String, items: List<T>, card: @Composable (Int, T) -> Unit) {
  if (items.isEmpty()) return
  Column(Modifier.padding(vertical = 10.dp)) {
    Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 16.dp, bottom = 6.dp))
    // Room for the focused card to grow without being cut at the row's edge.
    // Inside a TvRowNavigation page the row registers itself: up / down
    // then go row by row and come back to the card last used here.
    val rowNav = LocalTvRowNav.current
    val entry = remember(rowNav) { rowNav?.let { TvRowNav.Entry(FocusRequester()) } }
    if (rowNav != null && entry != null) DisposableEffect(rowNav, entry) {
      rowNav.entries += entry
      onDispose { rowNav.entries -= entry }
    }
    val navModifier = if (entry == null) Modifier else Modifier
      .onGloballyPositioned { entry.top = it.positionInRoot().y; entry.placed = it.isAttached }
      .onFocusChanged { entry.focused = it.hasFocus }
      .focusRequester(entry.requester)
      .focusRestorer()
    TvRowScroll {
      LazyRow(navModifier, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        itemsIndexed(items) { i, item -> card(i, item) }
      }
    }
  }
}

/** A song row in a list: OK plays from here. */
@Composable
fun TvTrackRow(track: Track, number: Int?, current: Boolean, onClick: () -> Unit) {
  TvFocusable(onClick, Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), scaleOnFocus = 1.01f) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
      if (number != null) Text("$number", modifier = Modifier.width(44.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.titleMedium)
      Artwork(track.artwork, Modifier.size(56.dp), size = 128)
      Spacer(Modifier.width(16.dp))
      Column(Modifier.weight(1f)) {
        Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium,
          color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, fontWeight = if (current) FontWeight.Bold else FontWeight.Normal)
        Text(listOfNotNull(track.artist.ifBlank { null }, track.album.ifBlank { null }).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis,
          style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      if (track.duration > 0) Text(fmtTime(track.duration), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

/** Small label on a card or row (In library / Preview / Mix). */
@Composable
fun TvTag(text: String, icon: ImageVector? = null, strong: Boolean = false) {
  Row(
    Modifier.background(if (strong) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface.copy(alpha = 0.88f), RoundedCornerShape(20.dp))
      .padding(horizontal = 10.dp, vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    val tint = if (strong) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
    if (icon != null) { Icon(icon, null, tint = tint, modifier = Modifier.size(16.dp)); Spacer(Modifier.width(4.dp)) }
    Text(text, color = tint, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, maxLines = 1)
  }
}

/**
 * An online song row: OK plays it (from the library when owned, else a 30 s
 * preview). A song that is not in the library has its own download button
 * at the end of the row (Right on the remote).
 */
@Composable
fun TvOnlineTrackRow(item: OnlineItem, number: Int?, current: Boolean, nav: TvNav? = null, onClick: () -> Unit) {
  val owned = item.libraryTrackId != null
  val canDownload = nav != null && nav.canDownload && !owned && item.kind == "track" && item.url.isNotBlank()
  Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
    TvFocusable(onClick, Modifier.weight(1f), shape = RoundedCornerShape(12.dp), scaleOnFocus = 1.01f) {
      Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (number != null) Text("$number", modifier = Modifier.width(44.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.titleMedium)
        Artwork(item.artworkUrl, Modifier.size(56.dp), size = 128)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
          Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium,
            color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, fontWeight = if (current) FontWeight.Bold else FontWeight.Normal)
          Text(listOfNotNull(item.artist.ifBlank { null }, item.album.ifBlank { null }).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        when {
          owned -> TvTag(stringResource(R.string.in_library), FluentIcons.CheckCircle, strong = true)
          item.previewUrl != null -> TvTag(stringResource(R.string.preview), FluentIcons.PlayArrow)
        }
        if (item.duration > 0) { Spacer(Modifier.width(14.dp)); Text(fmtTime(item.duration), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
      }
    }
    if (canDownload) {
      Spacer(Modifier.width(10.dp))
      val queued = nav!!.queued.contains(item.key)
      val label = stringResource(if (queued) R.string.tv_download_queued_short else R.string.download)
      TvFocusable({ if (!queued) nav.download(item, item.key) }, Modifier.size(52.dp).semantics { contentDescription = label }, shape = CircleShape, scaleOnFocus = 1.12f) { focused ->
        Box(Modifier.size(52.dp).background(if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
          Icon(if (queued) FluentIcons.CheckCircle else FluentIcons.Download, label, modifier = Modifier.size(24.dp),
            tint = if (focused) MaterialTheme.colorScheme.onPrimary else if (queued) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
      }
    } else if (nav != null && nav.canDownload) Spacer(Modifier.width(62.dp))
  }
}

/** Round icon button for the remote (player controls, play/shuffle). */
@Composable
fun TvIconButton(icon: ImageVector, label: String, big: Boolean = false, active: Boolean = false, compact: Boolean = false, onClick: () -> Unit) {
  val size = if (compact) (if (big) 62.dp else 46.dp) else if (big) 74.dp else 54.dp
  TvFocusable(onClick, Modifier.size(size), shape = CircleShape, scaleOnFocus = 1.12f) { focused ->
    Box(
      Modifier.size(size).background(if (big || focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant, CircleShape),
      contentAlignment = Alignment.Center,
    ) {
      Icon(icon, label, tint = if (big || focused) MaterialTheme.colorScheme.onPrimary else if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(if (big) (if (compact) 30.dp else 36.dp) else if (compact) 22.dp else 26.dp))
    }
  }
}

/** Pill button with text for the remote. */
@Composable
fun TvButton(text: String, icon: ImageVector? = null, primary: Boolean = false, modifier: Modifier = Modifier, onClick: () -> Unit) {
  TvFocusable(onClick, modifier, shape = RoundedCornerShape(30.dp), scaleOnFocus = 1.08f) { focused ->
    Row(
      Modifier.background(if (primary || focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(30.dp))
        .padding(horizontal = 22.dp, vertical = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      val tint = if (primary || focused) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
      if (icon != null) { Icon(icon, null, tint = tint, modifier = Modifier.size(24.dp)); Spacer(Modifier.width(8.dp)) }
      // Buttons never break into two lines.
      Text(text, color = tint, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, softWrap = false)
    }
  }
}
