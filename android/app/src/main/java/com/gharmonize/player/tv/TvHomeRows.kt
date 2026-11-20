package com.gharmonize.player.tv

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.mapObjects
import com.gharmonize.player.data.parseOnline
import com.gharmonize.player.ui.ErrorBox
import com.gharmonize.player.ui.FluentIcons
import com.gharmonize.player.ui.Loading
import com.gharmonize.player.ui.rememberLoad
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/** One row of the TV home page: [group] is what the user shows / hides / moves. */
class TvHomeRow(val key: String, val group: String, val title: String, val content: @Composable () -> Unit)

/**
 * Which home rows show and in which order (kept on this TV). Rows are handled
 * by group, so rows that change every day ("Because you listened to X",
 * "Missing from Y") keep the user's choice.
 */
object TvHomeRows {
  private data class Choice(val group: String, val visible: Boolean)

  private val prefs get() = App.instance.prefs
  private var saved by mutableStateOf(load())
  /** Groups seen on the home page, in their default order, with a title. */
  val catalog = mutableStateListOf<Pair<String, String>>().apply { addAll(loadCatalog()) }

  private fun load(): List<Choice> = runCatching {
    val arr = JSONArray(prefs.tvHomeRows ?: "[]")
    (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.map { Choice(it.optString("g"), it.optBoolean("v", true)) }
  }.getOrDefault(emptyList())

  private fun loadCatalog(): List<Pair<String, String>> = runCatching {
    val arr = JSONArray(prefs.tvHomeCatalog ?: "[]")
    (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.map { it.optString("g") to it.optString("t") }
  }.getOrDefault(emptyList())

  private fun save(list: List<Choice>) {
    saved = list
    prefs.tvHomeRows = JSONArray(list.map { JSONObject().put("g", it.group).put("v", it.visible) }).toString()
  }

  fun isVisible(group: String) = saved.firstOrNull { it.group == group }?.visible ?: true

  /** Saved order first; groups never ordered go after their default neighbour. */
  fun order(defaults: List<String>): List<String> {
    val out = saved.map { it.group }.filter { it in defaults }.toMutableList()
    defaults.forEachIndexed { i, g ->
      if (g in out) return@forEachIndexed
      val prev = defaults.subList(0, i).lastOrNull { it in out }
      out.add(if (prev == null) 0 else out.indexOf(prev) + 1, g)
    }
    return out
  }

  /** The home rows to show, in the chosen order (rows of a group keep theirs). */
  fun arrange(rows: List<TvHomeRow>): List<TvHomeRow> {
    val groups = order(rows.map { it.group }.distinct())
    val rank = groups.withIndex().associate { it.value to it.index }
    return rows.withIndex().filter { isVisible(it.value.group) }
      .sortedWith(compareBy({ rank[it.value.group] ?: Int.MAX_VALUE }, { it.index })).map { it.value }
  }

  /** Called by the home page: remembers the rows it has (for the settings screen). */
  fun noteCatalog(rows: List<TvHomeRow>) {
    val fresh = rows.distinctBy { it.group }.map { it.group to it.title }
    val known = catalog.toMutableList()
    var changed = false
    fresh.forEachIndexed { i, (g, t) ->
      val at = known.indexOfFirst { it.first == g }
      if (at >= 0) { if (known[at].second != t && t.isNotBlank()) { known[at] = g to t; changed = true } }
      else {
        val prev = fresh.subList(0, i).lastOrNull { p -> known.any { it.first == p.first } }?.first
        known.add(if (prev == null) 0 else known.indexOfFirst { it.first == prev } + 1, g to t)
        changed = true
      }
    }
    if (!changed) return
    catalog.clear(); catalog.addAll(known)
    prefs.tvHomeCatalog = JSONArray(known.map { JSONObject().put("g", it.first).put("t", it.second) }).toString()
  }

  fun toggle(group: String) {
    val groups = order(catalog.map { it.first })
    save(groups.map { Choice(it, if (it == group) !isVisible(it) else isVisible(it)) })
  }

  fun move(group: String, by: Int) {
    val groups = order(catalog.map { it.first }).toMutableList()
    val i = groups.indexOf(group)
    val j = i + by
    if (i < 0 || j !in groups.indices) return
    groups.removeAt(i); groups.add(j, group)
    save(groups.map { Choice(it, isVisible(it)) })
  }

  fun reset() = save(emptyList())

  /** Group of a library shelf ("because-484" → "because"). */
  fun libraryGroup(id: String) = "h:" + id.replace(Regex("-\\d+$"), "")

  /** Group of an online shelf: per kind when it names an artist / genre. */
  fun onlineGroup(shelf: JSONObject): String {
    val id = shelf.optString("id")
    val key = shelf.optString("titleKey")
    return "d:" + if (shelf.optJSONObject("titleVars") != null && key.isNotBlank() && !id.startsWith("yt-home-")) key else id
  }
}

/** Settings → home rows: OK shows / hides a row, ▲ ▼ move it. */
@Composable
fun TvHomeRowsScreen() {
  val first = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
  val groups = TvHomeRows.order(TvHomeRows.catalog.map { it.first })
  val titles = TvHomeRows.catalog.toMap()
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 44.dp, end = 36.dp, top = 36.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    item {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 10.dp)) {
        Text(stringResource(R.string.tv_home_rows), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.tv_home_rows_hint), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        TvButton(stringResource(R.string.tv_home_rows_reset), FluentIcons.Refresh) { TvHomeRows.reset() }
      }
    }
    if (groups.isEmpty()) item { Text(stringResource(R.string.tv_home_rows_empty), style = MaterialTheme.typography.titleMedium) }
    itemsIndexed(groups, key = { _, g -> g }) { i, g ->
      val visible = TvHomeRows.isVisible(g)
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        TvFocusable({ TvHomeRows.toggle(g) }, (if (i == 0) Modifier.focusRequester(first) else Modifier).weight(1f), shape = RoundedCornerShape(16.dp), scaleOnFocus = 1.02f) { focused ->
          Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (focused) 0f else 0.5f), RoundedCornerShape(16.dp)).padding(horizontal = 22.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Icon(if (visible) FluentIcons.CheckCircle else FluentIcons.Close, null, Modifier.size(26.dp),
              tint = if (visible) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(16.dp))
            Text(titles[g].orEmpty().ifBlank { g }, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
              color = if (visible) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Text(stringResource(if (visible) R.string.tv_row_shown else R.string.tv_row_hidden), style = MaterialTheme.typography.titleSmall,
              color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
        TvMoveButton(FluentIcons.KeyboardArrowDown, stringResource(R.string.tv_row_up), up = true, enabled = i > 0) { TvHomeRows.move(g, -1) }
        TvMoveButton(FluentIcons.KeyboardArrowDown, stringResource(R.string.tv_row_down), up = false, enabled = i < groups.size - 1) { TvHomeRows.move(g, 1) }
      }
    }
  }
}

@Composable
private fun TvMoveButton(icon: ImageVector, label: String, up: Boolean, enabled: Boolean, onClick: () -> Unit) {
  TvFocusable({ if (enabled) onClick() }, Modifier.size(56.dp), shape = CircleShape, scaleOnFocus = 1.12f) { focused ->
    Box(Modifier.size(56.dp).background(if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
      Icon(icon, label, Modifier.size(28.dp).rotate(if (up) 180f else 0f),
        tint = (if (focused) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface).copy(alpha = if (enabled) 1f else 0.35f))
    }
  }
}

// ---- moods ----------------------------------------------------------------------------------

val TV_MOODS = listOf("energizing", "workout", "feel-good", "relax", "sad", "romance", "commute", "party", "focus", "sleep")

@Composable
fun moodName(preset: String): String = stringResource(when (preset) {
  "energizing" -> R.string.mood_energizing
  "workout" -> R.string.mood_workout
  "feel-good" -> R.string.mood_feel_good
  "relax" -> R.string.mood_relax
  "sad" -> R.string.mood_sad
  "romance" -> R.string.mood_romance
  "commute" -> R.string.mood_commute
  "party" -> R.string.mood_party
  "focus" -> R.string.mood_focus
  else -> R.string.mood_sleep
})

private fun moodColor(preset: String): Color {
  val hue = (TV_MOODS.indexOf(preset).coerceAtLeast(0) * 36f + 200f) % 360f
  return Color.hsl(hue, 0.45f, 0.38f)
}

/** A coloured mood tile for the home row. */
@Composable
fun TvMoodTile(preset: String, onClick: () -> Unit) {
  TvFocusable(onClick, Modifier.width(210.dp).height(110.dp), shape = RoundedCornerShape(18.dp)) {
    Box(Modifier.fillMaxSize().background(moodColor(preset), RoundedCornerShape(18.dp)).padding(18.dp), contentAlignment = Alignment.BottomStart) {
      Text(moodName(preset), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = Color.White)
    }
  }
}

/** One mood: its playlists / albums and songs (YouTube Music). */
@Composable
fun TvMood(nav: TvNav, preset: String) {
  val data = rememberLoad("tv-mood", preset) { App.instance.api.mood(preset, Locale.getDefault().language) }
  val items = remember(data.value) { data.value?.optJSONArray("items").mapObjects(::parseOnline) }
  val tracks = items.filter { it.kind == "track" }
  val lists = items.filter { it.kind != "track" }
  val playFocus = remember { FocusRequester() }
  LaunchedEffect(preset, data.value != null) { if (data.value != null) runCatching { playFocus.requestFocus() } }
  val playing = nav.player.current?.mediaMetadata?.title?.toString()
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 36.dp, end = 36.dp, top = 28.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    data.error?.let { e -> item { ErrorBox(e.message ?: "") { data.reload() } } }
    if (data.value == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 12.dp)) {
        Box(Modifier.size(200.dp).background(moodColor(preset), RoundedCornerShape(24.dp)), contentAlignment = Alignment.Center) {
          Text(moodName(preset).take(1), style = MaterialTheme.typography.displayLarge, fontWeight = FontWeight.Bold, color = Color.White)
        }
        Spacer(Modifier.width(28.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(stringResource(R.string.kind_mood) + " · YouTube Music", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
          Text(moodName(preset), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
          // YouTube songs have no preview: they play once downloaded.
          val first = tracks.indexOfFirst { it.libraryTrackId != null || it.previewUrl != null }
          val missing = tracks.filter { it.libraryTrackId == null }
          val key = "mood-$preset"
          Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            if (first >= 0) TvButton(stringResource(R.string.play), FluentIcons.PlayArrow, primary = true, modifier = Modifier.focusRequester(playFocus)) { nav.playOnline(tracks, first) }
            if (nav.canDownload && missing.isNotEmpty()) {
              val queued = nav.queued.contains(key)
              TvButton(stringResource(if (queued) R.string.tv_download_queued_short else R.string.download), if (queued) FluentIcons.CheckCircle else FluentIcons.Download,
                primary = first < 0, modifier = if (first < 0) Modifier.focusRequester(playFocus) else Modifier) { if (!queued) nav.downloadEach(missing, key) }
            }
          }
        }
      }
    }
    if (items.isEmpty()) item { Text(stringResource(R.string.mood_empty), style = MaterialTheme.typography.titleMedium) }
    if (lists.isNotEmpty()) item { TvRow(stringResource(R.string.mood_playlists), lists) { i, _ -> TvOnlineCard(nav, lists, i) } }
    if (tracks.isNotEmpty()) {
      item { TvSectionTitle(stringResource(R.string.songs)) }
      itemsIndexed(tracks, key = { i, t -> "mt-$i-${t.id}" }) { i, t -> TvOnlineTrackRow(t, i + 1, playing != null && playing == t.title, nav) { nav.playOnline(tracks, i) } }
    }
  }
}
