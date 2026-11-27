package com.gharmonize.player.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TriStateCheckbox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.mapObjects
import com.gharmonize.player.data.parseOnline
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject

/*
 * "Complete the discography" (same as the web player): a card on artist pages
 * that opens a sheet listing every release the library lacks songs of
 * (albums, EPs, singles, compilations) plus missing popular songs. Everything
 * starts selected; a release's box selects all its missing songs and single
 * songs can be left out. The card plays a short "preparing" animation while
 * the list is read, so the sheet opens complete instead of with a loader.
 */

private class GapRelease(val item: OnlineItem, val recordType: String, val year: Int?, val trackCount: Int, val missing: Int, val tracks: List<OnlineItem>) {
  val songs: List<OnlineItem> = tracks.filter { it.libraryTrackId == null }
}

private class Gaps(val artistTitle: String, val releases: List<GapRelease>, val popular: List<OnlineItem>)

private fun parseGaps(o: JSONObject): Gaps {
  val releases = o.optJSONArray("releases").mapObjects { r ->
    GapRelease(
      item = parseOnline(r),
      recordType = r.optString("recordType", "album").ifBlank { "album" },
      year = r.optInt("year", 0).takeIf { it > 0 },
      trackCount = r.optInt("trackCount"),
      missing = r.optInt("missing"),
      tracks = r.optJSONArray("tracks").mapObjects(::parseOnline),
    )
  }
  return Gaps(o.optJSONObject("artist")?.optString("title").orEmpty(), releases, o.optJSONArray("popular").mapObjects(::parseOnline))
}

private val GROUPS = listOf(
  "album" to R.string.gaps_group_albums,
  "ep" to R.string.gaps_group_eps,
  "single" to R.string.gaps_group_singles,
  "compile" to R.string.gaps_group_compilations,
)

private fun groupOf(r: GapRelease) = if (GROUPS.any { it.first == r.recordType }) r.recordType else "album"

/** Banner text parts for the artist page; empty when nothing is missing. */
@Composable
private fun gapSummary(online: JSONObject): String {
  val albums = online.optJSONArray("albums").mapObjects { it }
  val total = albums.size
  val complete = albums.count { a -> a.optJSONObject("library")?.optBoolean("complete", true) == true }
  val partial = albums.count { a -> a.optJSONObject("library")?.let { !it.optBoolean("complete", true) } == true }
  val none = total - complete - partial
  val missingTop = online.optJSONArray("topTracks").mapObjects(::parseOnline).take(10).count { it.libraryTrackId == null }
  if (partial == 0 && none == 0 && missingTop == 0) return ""
  val parts = mutableListOf<String>()
  if (total > 0 && none == total) parts += stringResource(R.string.gaps_none_owned, total)
  else {
    if (complete > 0) parts += stringResource(R.string.gaps_albums_complete, complete)
    if (partial > 0) parts += stringResource(R.string.gaps_albums_partial, partial)
    if (none > 0) parts += stringResource(R.string.gaps_albums_missing, none)
  }
  if (missingTop > 0) parts += stringResource(R.string.gaps_tracks_missing, missingTop)
  return parts.joinToString(" · ")
}

/**
 * The artist page card. [quietWhenComplete]: show nothing (instead of "the
 * whole discography is here") when nothing is missing.
 */
@Composable
fun DiscographyCard(state: AppState, online: JSONObject, artistName: String, quietWhenComplete: Boolean = false) {
  val text = gapSummary(online)
  val hasAlbums = (online.optJSONArray("albums")?.length() ?: 0) > 0
  val shape = RoundedCornerShape(16.dp)
  val modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)
  if (text.isEmpty()) {
    if (quietWhenComplete || !hasAlbums) return
    Surface(modifier, shape = shape, color = MaterialTheme.colorScheme.secondaryContainer) {
      Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(FluentIcons.CheckCircle, null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(14.dp))
        Text(stringResource(R.string.gaps_complete), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
      }
    }
    return
  }
  var preparing by remember { mutableStateOf(false) }
  var ready by remember { mutableStateOf(false) }
  var gaps by remember { mutableStateOf<Gaps?>(null) }
  val nothing = stringResource(R.string.gaps_nothing)
  val start: () -> Unit = start@{
    if (preparing || !state.canDownload) return@start
    preparing = true
    state.scope.launch {
      val began = System.currentTimeMillis()
      try {
        val artist = online.optJSONObject("artist")
        val id = artist?.optString("id")?.takeIf { artist.optString("provider") == "deezer" && it.isNotBlank() }
        val loaded = parseGaps(state.api.onlineArtistGaps(id, if (id == null) artistName else null))
        // One full round of the animation even when the answer was cached.
        val wait = 650 - (System.currentTimeMillis() - began)
        if (wait > 0) delay(wait)
        if (loaded.releases.isEmpty() && loaded.popular.isEmpty()) state.message(nothing)
        else {
          ready = true
          delay(180)
          gaps = loaded
        }
      } catch (e: Exception) {
        state.message(state.errorText(e))
      }
      preparing = false
      ready = false
    }
  }
  val accent = MaterialTheme.colorScheme.primary
  val nudge by animateFloatAsState(if (ready) 1.06f else 1f, label = "nudge")
  Surface(
    modifier.clip(shape).clickable(enabled = state.canDownload && !preparing, onClick = start),
    shape = shape,
    color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.55f),
  ) {
    Box {
      // The animations only exist while preparing (nothing runs otherwise).
      if (preparing) Sweep(Modifier.matchParentSize(), accent)
      Row(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        if (preparing) TwinklingIcon(accent) else Icon(FluentIcons.AutoAwesome, null, tint = accent, modifier = Modifier.size(24.dp))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
          Text(stringResource(R.string.gaps_title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
          Text(if (preparing) stringResource(R.string.gaps_preparing) else text, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (state.canDownload) {
          Spacer(Modifier.width(10.dp))
          Surface(shape = RoundedCornerShape(50), color = accent.copy(alpha = if (preparing && !ready) 0.55f else 1f),
            contentColor = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.scale(nudge)) {
            Row(Modifier.padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
              Text(stringResource(R.string.gaps_cta), style = MaterialTheme.typography.labelLarge)
              Icon(FluentIcons.ChevronRight, null, Modifier.size(18.dp))
            }
          }
        }
      }
    }
  }
  gaps?.let { g -> DiscographySheet(state, g) { gaps = null } }
}

/** A light band sweeping over the card while the list is prepared. */
@Composable
private fun Sweep(modifier: Modifier, accent: Color) {
  val sweep by rememberInfiniteTransition(label = "sweep")
    .animateFloat(-1f, 2f, infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing)), label = "x")
  Box(modifier.drawWithContent {
    val x = size.width * sweep
    drawRect(Brush.linearGradient(listOf(Color.Transparent, accent.copy(alpha = 0.22f), Color.Transparent),
      start = Offset(x - size.width * 0.35f, 0f), end = Offset(x + size.width * 0.35f, size.height)))
  })
}

@Composable
private fun TwinklingIcon(accent: Color) {
  val motion = rememberInfiniteTransition(label = "twinkle")
  val turn by motion.animateFloat(0f, 360f, infiniteRepeatable(tween(1100, easing = LinearEasing)), label = "turn")
  val pulse by motion.animateFloat(1f, 1.18f, infiniteRepeatable(tween(550), RepeatMode.Reverse), label = "pulse")
  Icon(FluentIcons.AutoAwesome, null, tint = accent, modifier = Modifier.size(24.dp).graphicsLayer {
    rotationZ = turn
    scaleX = pulse
    scaleY = pulse
  })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DiscographySheet(state: AppState, gaps: Gaps, onDismiss: () -> Unit) {
  // Picked songs by link; only missing songs can be picked and all start picked.
  val picked = remember(gaps) {
    mutableStateMapOf<String, Boolean>().apply {
      for (r in gaps.releases) for (s in r.songs) put(s.url, true)
      for (s in gaps.popular) put(s.url, true)
    }
  }
  val open = remember(gaps) { mutableStateMapOf<String, Boolean>() }
  val albumSongs = remember(gaps) { gaps.releases.filter { it.recordType != "single" }.flatMap { it.songs }.map { it.url }.toSet() }
  // A single's song that a picked album song covers is downloaded once.
  fun covered(song: OnlineItem): Boolean {
    val twin = song.raw.optString("sameAs").takeIf { it.isNotBlank() && it in albumSongs } ?: return false
    return picked[twin] == true
  }
  fun isPicked(song: OnlineItem) = picked[song.url] == true
  fun setAll(songs: List<OnlineItem>, on: Boolean) { for (s in songs) picked[s.url] = on }
  fun tri(songs: List<OnlineItem>): ToggleableState {
    val n = songs.count(::isPicked)
    return when { n == 0 -> ToggleableState.Off; n == songs.size -> ToggleableState.On; else -> ToggleableState.Indeterminate }
  }
  val chosen = gaps.releases.map { r -> r to r.songs.filter { isPicked(it) && !covered(it) } }
  val popularChosen = gaps.popular.filter(::isPicked)
  val trackTotal = chosen.sumOf { it.second.size } + popularChosen.size
  val releaseTotal = chosen.count { it.second.isNotEmpty() }
  val lead = remember(gaps) { gaps.releases.sumOf { r -> r.songs.count { s -> s.raw.optString("sameAs").let { it.isBlank() || it !in albumSongs } } } + gaps.popular.size }
  val everything = remember(gaps) { gaps.releases.flatMap { it.songs } + gaps.popular }
  val groupTitle = stringResource(R.string.gaps_group_title, gaps.artistTitle)

  ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = MaterialTheme.colorScheme.surfaceContainer) {
    Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
      Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(gaps.artistTitle, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
          Text(stringResource(R.string.gaps_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        }
        IconButton(onClick = onDismiss) { Icon(FluentIcons.Close, stringResource(R.string.close)) }
      }
      Text(stringResource(R.string.gaps_lead, lead), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
      Row(Modifier.fillMaxWidth().clickable { setAll(everything, tri(everything) != ToggleableState.On) }.padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        TriStateCheckbox(state = tri(everything), onClick = { setAll(everything, tri(everything) != ToggleableState.On) })
        Text(stringResource(R.string.gaps_select_all), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
      }
      HorizontalDivider()
      LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((type, label) in GROUPS) {
          val own = gaps.releases.filter { groupOf(it) == type }
          if (own.isEmpty()) continue
          val songs = own.flatMap { it.songs }
          item(key = "g-$type") { GroupHead(stringResource(label), songs.size, tri(songs)) { setAll(songs, tri(songs) != ToggleableState.On) } }
          items(own, key = { "r-${it.item.url}" }) { r ->
            ReleaseRow(r, tri(r.songs), r.songs.count(::isPicked), open[r.item.url] == true,
              onToggle = { setAll(r.songs, tri(r.songs) != ToggleableState.On) },
              onExpand = { open[r.item.url] = open[r.item.url] != true },
              isPicked = ::isPicked, onPick = { s, on -> picked[s.url] = on })
          }
        }
        if (gaps.popular.isNotEmpty()) {
          item(key = "g-popular") {
            GroupHead(stringResource(R.string.gaps_group_popular), gaps.popular.size, tri(gaps.popular)) { setAll(gaps.popular, tri(gaps.popular) != ToggleableState.On) }
          }
          item(key = "popular") {
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
              Column(Modifier.padding(vertical = 4.dp)) {
                gaps.popular.forEach { s -> SongRow(s, null, isPicked(s)) { on -> picked[s.url] = on } }
              }
            }
          }
        }
      }
      HorizontalDivider()
      Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.gaps_picked, trackTotal, releaseTotal), style = MaterialTheme.typography.bodySmall,
          color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        Spacer(Modifier.width(6.dp))
        Button(enabled = trackTotal > 0, onClick = {
          // One download per release (only the picked songs unless all of it) and one per popular song.
          val items = mutableListOf<OnlineItem>()
          val only = mutableMapOf<String, List<OnlineItem>>()
          for ((r, songs) in chosen) {
            if (songs.isEmpty()) continue
            items += r.item.copy(kind = "album", trackCount = r.trackCount, libraryTrackId = null)
            if (songs.size < r.trackCount) only[r.item.url] = songs.map { it.copy(album = r.item.title) }
          }
          items += popularChosen.map { it.copy(kind = "track") }
          state.downloadAll(items, groupTitle, only = only, onQueued = onDismiss)
        }) { Text(stringResource(R.string.gaps_download, trackTotal)) }
      }
    }
  }
}

@Composable
private fun GroupHead(title: String, count: Int, toggle: ToggleableState, onClick: () -> Unit) {
  Row(Modifier.fillMaxWidth().padding(top = 8.dp).clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
    TriStateCheckbox(state = toggle, onClick = onClick)
    Text(title.uppercase(), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold,
      color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
    Text(stringResource(R.string.gaps_songs, count), style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 12.dp))
  }
}

@Composable
private fun ReleaseRow(
  r: GapRelease, toggle: ToggleableState, pickedCount: Int, expanded: Boolean,
  onToggle: () -> Unit, onExpand: () -> Unit, isPicked: (OnlineItem) -> Boolean, onPick: (OnlineItem, Boolean) -> Unit,
) {
  val turn by animateFloatAsState(if (expanded) 180f else 0f, label = "chevron")
  Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
    Column {
      Row(Modifier.fillMaxWidth().clickable(onClick = onExpand).padding(end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        TriStateCheckbox(state = toggle, onClick = onToggle)
        Artwork(r.item.artworkUrl, Modifier.size(44.dp), shape = RoundedCornerShape(6.dp), size = 128, placeholder = FluentIcons.Album)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
          Text(r.item.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
          val meta = listOfNotNull(
            r.year?.toString(),
            if (r.missing == r.trackCount) stringResource(R.string.gaps_songs, r.trackCount) else stringResource(R.string.gaps_missing_of, r.missing, r.trackCount),
          ).joinToString(" · ")
          Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
        }
        if (pickedCount in 1 until r.songs.size) {
          Text(stringResource(R.string.gaps_picked_of, pickedCount, r.songs.size), style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton(onClick = onExpand) {
          Icon(FluentIcons.KeyboardArrowDown, stringResource(if (expanded) R.string.gaps_hide_songs else R.string.gaps_show_songs), Modifier.rotate(turn))
        }
      }
      AnimatedVisibility(expanded, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
        Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHighest.copy(alpha = 0.4f)).padding(vertical = 4.dp)) {
          r.tracks.forEachIndexed { i, s -> SongRow(s, i + 1, s.libraryTrackId != null || isPicked(s)) { on -> onPick(s, on) } }
        }
      }
    }
  }
}

@Composable
private fun SongRow(song: OnlineItem, number: Int?, checked: Boolean, onPick: (Boolean) -> Unit) {
  val owned = song.libraryTrackId != null
  Row(
    Modifier.fillMaxWidth().clickable(enabled = !owned) { onPick(!checked) }.padding(end = 16.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Checkbox(checked = checked, onCheckedChange = if (owned) null else onPick, enabled = !owned)
    if (number != null) {
      Text("$number", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.width(24.dp))
    }
    Column(Modifier.weight(1f)) {
      Text(song.title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
        color = if (owned) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
      if (owned) Text(stringResource(R.string.gaps_owned), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
    }
    if (song.duration > 0) Text(fmtTime(song.duration), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}
