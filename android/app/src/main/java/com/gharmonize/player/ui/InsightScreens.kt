package com.gharmonize.player.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.gharmonize.player.R
import com.gharmonize.player.data.ListeningStats
import com.gharmonize.player.data.Mix
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Calendar
import java.util.Locale

// ---- helpers -----------------------------------------------------------------------------

private fun num(n: Int): String = NumberFormat.getIntegerInstance().format(n)

/** Turkish plural suffix follows the spoken decade: 1990'lar, 1980'ler. */
private fun decadeLabel(decade: Int): String =
  if (Locale.getDefault().language == "tr") "$decade'" + (if (decade % 100 in setOf(10, 30, 40, 60, 90)) "lar" else "ler") else "$decade"


@Composable
fun mixTitle(mix: Mix): String = when (mix.kind) {
  "daily" -> stringResource(R.string.mix_daily, mix.number)
  "discover" -> stringResource(R.string.mix_discover)
  "liked" -> stringResource(R.string.mix_liked)
  "decade" -> stringResource(R.string.mix_decade, decadeLabel(mix.decade))
  else -> mix.id
}

@Composable
fun mixDescription(mix: Mix): String = when {
  mix.kind == "daily" && mix.artists.isNotEmpty() -> stringResource(R.string.mix_daily_desc, mix.artists.take(3).joinToString(", "))
  mix.kind == "discover" -> stringResource(R.string.mix_discover_desc)
  mix.kind == "liked" -> stringResource(R.string.mix_liked_desc)
  mix.kind == "decade" -> stringResource(R.string.mix_decade_desc, decadeLabel(mix.decade))
  else -> ""
}

private fun mixColor(mix: Mix): Color {
  val hues = mapOf("daily" to listOf(96f, 28f, 160f, 200f, 330f), "discover" to listOf(265f), "liked" to listOf(345f), "decade" to listOf(38f))
  val list = hues[mix.kind] ?: listOf(120f)
  return Color.hsl(list[(mix.number - 1).coerceAtLeast(0) % list.size], 0.55f, 0.32f)
}

/** 2×2 cover mosaic with the mix name on a colored band. */
@Composable
fun MixArt(mix: Mix, modifier: Modifier = Modifier, label: Boolean = true, big: Boolean = false) {
  val color = mixColor(mix)
  Box(modifier.clip(MaterialTheme.shapes.medium).background(color)) {
    val covers = mix.covers
    if (covers.size >= 4) {
      Column(Modifier.fillMaxSize()) {
        for (row in 0..1) Row(Modifier.weight(1f).fillMaxWidth()) {
          for (col in 0..1) Artwork(covers[row * 2 + col], Modifier.weight(1f).fillMaxHeight(), shape = RoundedCornerShape(0.dp), size = if (big) 300 else 160)
        }
      }
    } else if (covers.isNotEmpty()) {
      Artwork(covers[0], Modifier.fillMaxSize(), shape = RoundedCornerShape(0.dp), size = if (big) 600 else 300)
    } else {
      Icon(FluentIcons.AutoAwesome, null, tint = Color.White.copy(alpha = 0.8f), modifier = Modifier.align(Alignment.Center).size(40.dp))
    }
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to color.copy(alpha = 0.95f))))
    Box(Modifier.fillMaxHeight().width(5.dp).background(lerp(color, Color.White, 0.35f)))
    if (label) Text(mixTitle(mix), color = Color.White, fontWeight = FontWeight.Black, fontSize = if (big) 24.sp else 15.sp, lineHeight = if (big) 26.sp else 17.sp,
      modifier = Modifier.align(Alignment.BottomStart).padding(start = 12.dp, end = 8.dp, bottom = 10.dp), maxLines = 2)
  }
}

@Composable
fun MixCard(state: AppState, mix: Mix) {
  Column(Modifier.width(150.dp).clickable { state.navigate(Route.Mix(mix.id)) }.padding(6.dp)) {
    MixArt(mix, Modifier.fillMaxWidth().aspectRatio(1f))
    Spacer(Modifier.height(6.dp))
    Text(mixTitle(mix), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
    Text(mixDescription(mix), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
  }
}

/** Home: "Mixes for you" row plus the weekly listening teaser. */
@Composable
fun HomeInsights(state: AppState, reloadKey: Int) {
  val mixes = rememberLoad("mixes", reloadKey) { state.api.mixes() }
  mixes.value?.let { list ->
    ShelfRow(stringResource(R.string.home_mixes), list, subtitle = stringResource(R.string.home_mixes_sub)) { _, m -> MixCard(state, m) }
  }
}

@Composable
fun StatsTeaser(state: AppState, reloadKey: Int) {
  val week = rememberLoad("week", reloadKey) { state.api.stats("week") }
  val s = week.value ?: return
  if (s.plays == 0) return
  Surface(
    onClick = { state.navigate(Route.Stats) },
    shape = MaterialTheme.shapes.large,
    color = MaterialTheme.colorScheme.secondaryContainer,
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
  ) {
    Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
      Box(Modifier.size(46.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
        Icon(FluentIcons.BarChart, null, tint = MaterialTheme.colorScheme.onPrimary)
      }
      Spacer(Modifier.width(14.dp))
      Column(Modifier.weight(1f)) {
        Text(stringResource(R.string.stats_teaser, num(s.minutes)), fontWeight = FontWeight.Bold)
        s.topArtists.firstOrNull()?.let { Text(stringResource(R.string.stats_teaser_top, it.name), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
      }
      Icon(FluentIcons.ChevronRight, null)
    }
  }
}

// ---- mix screen ----------------------------------------------------------------------------

@Composable
fun MixScreen(state: AppState, id: String) {
  val data = rememberLoad("mix", id) { state.api.mix(id) }
  // New songs (not in the library yet) that fit the mix.
  val online = rememberLoad("mix-online", id) { runCatching { state.api.mixOnline(id) }.getOrDefault(emptyList()) }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    val (mix, tracks) = data.value ?: run { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        MixArt(mix, Modifier.size(210.dp), big = true)
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.mix_kind), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(mixTitle(mix), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black)
        Text(mixDescription(mix), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Text(listOf(stringResource(R.string.count_songs, tracks.size), fmtTime(mix.duration),
          stringResource(if (mix.kind == "discover") R.string.mix_refresh_weekly else R.string.mix_refresh_daily)).joinToString(" · "),
          style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        Row(Modifier.padding(top = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) { PlayShuffle(state, tracks) }
      }
    }
    itemsIndexed(tracks, key = { _, t -> "mx-${t.id}" }) { i, _ -> TrackRow(state, tracks, i) }
    online.value?.takeIf { it.isNotEmpty() }?.let { items ->
      item { SectionTitle(stringResource(R.string.mix_online_title), subtitle = stringResource(R.string.mix_online_hint)) }
      itemsIndexed(items, key = { _, o -> "mo-${o.url}" }) { i, _ -> OnlineTrackRow(state, items, i) }
    }
  }
}

// ---- statistics -----------------------------------------------------------------------------

private val RANGES = listOf("week" to R.string.stats_range_week, "month" to R.string.stats_range_month, "year" to R.string.stats_range_year, "all" to R.string.stats_range_all)

@Composable
private fun traitTitle(trait: String): String = stringResource(when (trait) {
  "nightOwl" -> R.string.trait_night_owl
  "earlyBird" -> R.string.trait_early_bird
  "dayListener" -> R.string.trait_day
  "eveningListener" -> R.string.trait_evening
  "explorer" -> R.string.trait_explorer
  "loyal" -> R.string.trait_loyal
  else -> R.string.trait_balanced
})

@Composable
private fun traitText(trait: String): String = stringResource(when (trait) {
  "nightOwl" -> R.string.trait_night_owl_desc
  "earlyBird" -> R.string.trait_early_bird_desc
  "dayListener" -> R.string.trait_day_desc
  "eveningListener" -> R.string.trait_evening_desc
  "explorer" -> R.string.trait_explorer_desc
  "loyal" -> R.string.trait_loyal_desc
  else -> R.string.trait_balanced_desc
})

private fun fmtDay(key: String?): String = runCatching {
  LocalDate.parse(key).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(Locale.getDefault()))
}.getOrDefault(key ?: "")

@Composable
private fun StatTile(value: String, label: String, modifier: Modifier = Modifier, accent: Boolean = false) {
  Surface(modifier, shape = MaterialTheme.shapes.large, color = if (accent) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh) {
    Column(Modifier.padding(14.dp)) {
      Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black,
        color = if (accent) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface, maxLines = 1)
      Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
  }
}

@Composable
private fun Bars(values: List<Int>, labels: List<String>) {
  val max = (values.maxOrNull() ?: 0).coerceAtLeast(1)
  val peak = values.indexOf(values.maxOrNull() ?: 0)
  Row(Modifier.fillMaxWidth().height(130.dp).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.Bottom) {
    values.forEachIndexed { i, v ->
      val f = (v.toFloat() / max).coerceIn(0.02f, 1f)
      Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
        if (f < 1f) Spacer(Modifier.weight(1f - f))
        Box(Modifier.fillMaxWidth().weight(f).clip(RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))
          .background(if (i == peak && v > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHighest))
        Text(labels[i], style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, fontSize = 10.sp)
      }
    }
  }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StatsScreen(state: AppState) {
  var range by rememberSaveable { mutableStateOf("month") }
  val data = rememberLoad("stats", range) { state.api.stats(range) }
  val years = rememberLoad("years") { state.api.statYears() }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    item {
      Column(Modifier.padding(16.dp)) {
        Text(stringResource(R.string.stats_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.stats_subtitle), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(RANGES.size) { i ->
          val (key, label) = RANGES[i]
          FilterChip(selected = range == key, onClick = { range = key }, label = { Text(stringResource(label)) })
        }
      }
    }
    years.value?.let { list ->
      val thisYear = Calendar.getInstance().get(Calendar.YEAR)
      val year = if (thisYear in list) thisYear else list.firstOrNull()
      if (year != null) item { WrappedBanner(state, year) }
    }
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    val s = data.value ?: run { if (data.loading) item { Loading() }; return@LazyColumn }
    if (s.plays == 0) {
      item { EmptyText(stringResource(R.string.stats_empty)) }
      return@LazyColumn
    }
    item {
      Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
          StatTile(num(s.minutes), stringResource(R.string.stats_minutes), Modifier.weight(1f), accent = true)
          StatTile(num(s.plays), stringResource(R.string.stats_plays), Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
          StatTile(num(s.uniqueTracks), stringResource(R.string.stats_unique_tracks), Modifier.weight(1f))
          StatTile(num(s.uniqueArtists), stringResource(R.string.stats_unique_artists), Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
          StatTile(pluralStringFor(s.streakCurrent), stringResource(R.string.stats_streak), Modifier.weight(1f))
          StatTile(num(s.newArtists), stringResource(R.string.stats_new_artists), Modifier.weight(1f))
        }
        if (s.traits.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          s.traits.forEach { trait ->
            Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.tertiaryContainer) {
              Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Text(traitTitle(trait), fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onTertiaryContainer)
                Text(traitText(trait), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onTertiaryContainer)
              }
            }
          }
        }
      }
    }
    if (s.topArtists.isNotEmpty()) item {
      SectionTitle(stringResource(R.string.stats_top_artists))
      LazyRow(contentPadding = PaddingValues(horizontal = 10.dp)) {
        itemsIndexed(s.topArtists) { i, a ->
          Column(Modifier.width(112.dp).clickable { state.navigate(Route.Artist(a.id)) }.padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Box {
              Artwork(a.artwork, Modifier.fillMaxWidth().aspectRatio(1f), shape = CircleShape, size = 256, placeholder = FluentIcons.Person)
              Box(Modifier.size(26.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
                Text("${i + 1}", color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Black, fontSize = 13.sp)
              }
            }
            Spacer(Modifier.height(6.dp))
            Text(a.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.stats_plays_n, num(a.plays)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }
    }
    if (s.topTracks.isNotEmpty()) {
      val tracks = s.topTracks.map { it.first }
      item { SectionTitle(stringResource(R.string.stats_top_tracks)) }
      itemsIndexed(tracks, key = { _, t -> "st-${t.id}" }) { i, _ -> TrackRow(state, tracks, i, number = i + 1) }
    }
    if (s.topAlbums.isNotEmpty()) item { ShelfRow(stringResource(R.string.stats_top_albums), s.topAlbums) { _, a -> AlbumCard(state, a) } }
    item {
      SectionTitle(stringResource(R.string.stats_by_hour))
      Bars(s.hours, s.hours.indices.map { if (it % 4 == 0) "%02d".format(it) else "" })
      SectionTitle(stringResource(R.string.stats_by_weekday))
      Bars(s.weekdays, DayOfWeek.entries.map { it.getDisplayName(TextStyle.SHORT, Locale.getDefault()) })
    }
    if (s.topGenres.isNotEmpty()) item {
      SectionTitle(stringResource(R.string.stats_top_genres))
      val max = s.topGenres.maxOf { it.second }.coerceAtLeast(1)
      Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        s.topGenres.forEach { (name, plays) ->
          Row(verticalAlignment = Alignment.CenterVertically) {
            Text(name, Modifier.width(110.dp), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Box(Modifier.weight(1f).height(10.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
              Box(Modifier.fillMaxWidth(plays.toFloat() / max).fillMaxHeight().clip(CircleShape).background(MaterialTheme.colorScheme.primary))
            }
            Text(num(plays), Modifier.width(44.dp), textAlign = TextAlign.End, style = MaterialTheme.typography.bodySmall)
          }
        }
      }
    }
    item {
      Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        s.busiestDay?.let { Fact(stringResource(R.string.stats_busiest_day), "${fmtDay(it)} · ${stringResource(R.string.stats_minutes_short, num(s.busiestMinutes))}") }
        Fact(stringResource(R.string.stats_longest_streak), pluralStringFor(s.streakLongest))
        Fact(stringResource(R.string.stats_active_days), num(s.activeDays))
        if (s.newArtistNames.isNotEmpty()) Fact(stringResource(R.string.stats_new_artists_list), s.newArtistNames.joinToString(", "))
      }
    }
  }
}

@Composable
private fun pluralStringFor(days: Int): String = LocalContext.current.resources.getQuantityString(R.plurals.days, days, num(days))

@Composable
private fun Fact(label: String, value: String) {
  Row {
    Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    Text(value, Modifier.weight(1.2f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End)
  }
}

@Composable
private fun WrappedBanner(state: AppState, year: Int) {
  Box(
    Modifier.fillMaxWidth().padding(16.dp).clip(RoundedCornerShape(18.dp))
      .background(Brush.linearGradient(listOf(Color(0xFF1D4ED8), Color(0xFF2563EB), Color(0xFF6A5ACD))))
      .clickable { state.navigate(Route.Wrapped(year)) }.padding(20.dp),
  ) {
    Column {
      Text(stringResource(R.string.wrapped_kicker).uppercase(), color = Color.White.copy(alpha = 0.85f), fontWeight = FontWeight.ExtraBold, fontSize = 12.sp, letterSpacing = 2.sp)
      Text(stringResource(R.string.wrapped_banner, year), color = Color.White, fontWeight = FontWeight.Black, fontSize = 26.sp)
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.wrapped_open), color = Color.White, fontWeight = FontWeight.Bold)
        Icon(FluentIcons.ChevronRight, null, tint = Color.White)
      }
    }
  }
}

// ---- yearly story ----------------------------------------------------------------------------

private class Slide(val colors: List<Color>, val summary: Boolean = false, val content: @Composable () -> Unit)

private const val SLIDE_MS = 7000

@Composable
fun WrappedScreen(state: AppState, year: Int) {
  val data = rememberLoad("wrapped", year) { state.api.wrapped(year) }
  val s = data.value
  Box(Modifier.fillMaxSize().background(Color(0xFF0D1B3A))) {
    when {
      data.error != null -> Box(Modifier.statusBarsPadding()) { ErrorBox(state.errorText(data.error)) { data.reload() } }
      s == null -> Loading(Modifier.align(Alignment.Center))
      s.plays == 0 -> Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(stringResource(R.string.wrapped_empty, year), color = Color.White, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
      }
      else -> Story(state, s, year)
    }
    IconButton(onClick = { state.back() }, modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 14.dp)) {
      Icon(FluentIcons.Close, stringResource(R.string.close), tint = Color.White)
    }
  }
}

@Composable
private fun Story(state: AppState, s: ListeningStats, year: Int) {
  val slides = buildSlides(state, s, year)
  var index by remember { mutableIntStateOf(0) }
  var paused by remember { mutableStateOf(false) }
  val progress = remember { Animatable(0f) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(index, paused) {
    if (paused) { progress.stop(); return@LaunchedEffect }
    if (index >= slides.lastIndex) { progress.snapTo(1f); return@LaunchedEffect }
    val remaining = ((1f - progress.value) * SLIDE_MS).toInt()
    progress.animateTo(1f, tween(remaining, easing = LinearEasing))
    index += 1
    progress.snapTo(0f)
  }
  val go = { next: Int -> if (next in slides.indices) { index = next; scope.launch { progress.snapTo(0f) } } }
  val slide = slides[index]
  Box(
    Modifier.fillMaxSize()
      .background(Brush.linearGradient(slide.colors))
      .pointerInput(index, slides.size) {
        detectTapGestures(
          onPress = { paused = true; tryAwaitRelease(); paused = false },
          onTap = { offset -> if (offset.x < size.width * 0.3f) go(index - 1) else go(index + 1) },
        )
      },
  ) {
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(16.dp)) {
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        slides.indices.forEach { i ->
          Box(Modifier.weight(1f).height(3.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.3f))) {
            val f = when { i < index -> 1f; i == index -> progress.value; else -> 0f }
            Box(Modifier.fillMaxWidth(f).fillMaxHeight().background(Color.White))
          }
        }
      }
      Text(stringResource(R.string.wrapped_brand, year), color = Color.White, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(top = 14.dp))
      Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) { slide.content() }
      }
    }
  }
}

@Composable
private fun Lead(text: String) = Text(text, color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp, textAlign = TextAlign.Center, lineHeight = 30.sp)

@Composable
private fun Huge(text: String, word: Boolean = false) = Text(text, color = Color.White, fontWeight = FontWeight.Black,
  fontSize = if (word) 56.sp else 92.sp, lineHeight = if (word) 60.sp else 96.sp, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)

@Composable
private fun Sub(text: String) = Text(text, color = Color.White.copy(alpha = 0.88f), fontSize = 16.sp, textAlign = TextAlign.Center)

@Composable
private fun Ranked(items: List<Triple<String, String?, String?>>, round: Boolean) {
  Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    items.take(5).forEachIndexed { i, (title, sub, art) ->
      Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (i == 0) Color.White.copy(alpha = 0.16f) else Color.Black.copy(alpha = 0.18f)).padding(8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text("${i + 1}", color = Color.White, fontWeight = FontWeight.Black, fontSize = 20.sp, modifier = Modifier.width(30.dp))
        Artwork(art, Modifier.size(50.dp), shape = if (round) CircleShape else MaterialTheme.shapes.small, size = 128, placeholder = if (round) FluentIcons.Person else FluentIcons.AutoAwesome)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
          Text(title, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 17.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
          if (!sub.isNullOrBlank()) Text(sub, color = Color.White.copy(alpha = 0.8f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
    }
  }
}

@Composable
private fun buildSlides(state: AppState, s: ListeningStats, year: Int): List<Slide> {
  val name = state.me?.displayName ?: ""
  val list = mutableListOf<Slide>()
  list += Slide(listOf(Color(0xFF0D1B3A), Color(0xFF3B82F6))) {
    Text("GHARMONIZE PLAYER", color = Color.White.copy(alpha = 0.85f), fontWeight = FontWeight.ExtraBold, letterSpacing = 3.sp, fontSize = 13.sp)
    Huge("$year")
    Lead(stringResource(R.string.wrapped_intro, name))
  }
  list += Slide(listOf(Color(0xFF102A2F), Color(0xFF2FB1A5))) {
    Lead(stringResource(R.string.wrapped_minutes_lead))
    Huge(num(s.minutes))
    Text(stringResource(R.string.wrapped_minutes_unit), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp)
    val days = s.minutes / 1440
    Sub(if (days >= 1) stringResource(R.string.wrapped_minutes_days, num(days)) else stringResource(R.string.wrapped_minutes_hours, num((s.minutes / 60).coerceAtLeast(1))))
    Sub(stringResource(R.string.wrapped_active_days, num(s.activeDays), num(s.plays)))
  }
  s.firstTrack?.let { t ->
    list += Slide(listOf(Color(0xFF2B1630), Color(0xFFB04FA1))) {
      Lead(stringResource(R.string.wrapped_first_lead))
      Artwork(t.artwork, Modifier.size(240.dp), shape = MaterialTheme.shapes.medium, size = 600)
      Text(t.title, color = Color.White, fontWeight = FontWeight.Black, fontSize = 30.sp, textAlign = TextAlign.Center)
      Sub(t.artist)
    }
  }
  s.topGenres.firstOrNull()?.let { (genre, _) ->
    list += Slide(listOf(Color(0xFF2C1D0E), Color(0xFFE5862F))) {
      Lead(stringResource(R.string.wrapped_genre_lead))
      Huge(genre, word = true)
      if (s.topGenres.size > 1) Sub(stringResource(R.string.wrapped_genre_rest, s.topGenres.drop(1).take(3).joinToString(", ") { it.first }))
    }
  }
  s.topArtists.firstOrNull()?.let { a ->
    list += Slide(listOf(Color(0xFF13182E), Color(0xFF5466D8))) {
      Lead(stringResource(R.string.wrapped_artist_lead))
      Artwork(a.artwork, Modifier.size(240.dp), shape = CircleShape, size = 600, placeholder = FluentIcons.Person)
      Text(a.name, color = Color.White, fontWeight = FontWeight.Black, fontSize = 30.sp, textAlign = TextAlign.Center)
      Sub(stringResource(R.string.wrapped_artist_plays, num(a.plays), num(a.minutes)))
    }
    if (s.topArtists.size >= 3) list += Slide(listOf(Color(0xFF13182E), Color(0xFFE45D8C))) {
      Lead(stringResource(R.string.wrapped_top_artists))
      Ranked(s.topArtists.map { Triple(it.name, null, it.artwork) }, round = true)
    }
  }
  s.topTracks.firstOrNull()?.let { (t, plays) ->
    list += Slide(listOf(Color(0xFF2E1111), Color(0xFFD84A3C))) {
      Lead(stringResource(R.string.wrapped_track_lead))
      Artwork(t.artwork, Modifier.size(240.dp), shape = MaterialTheme.shapes.medium, size = 600)
      Text(t.title, color = Color.White, fontWeight = FontWeight.Black, fontSize = 30.sp, textAlign = TextAlign.Center)
      Sub("${t.artist} · ${stringResource(R.string.wrapped_track_plays, num(plays))}")
    }
    if (s.topTracks.size >= 3) list += Slide(listOf(Color(0xFF2E1111), Color(0xFFF2C14E))) {
      Lead(stringResource(R.string.wrapped_top_tracks))
      Ranked(s.topTracks.map { Triple(it.first.title, it.first.artist, it.first.artwork) }, round = false)
    }
  }
  s.traits.firstOrNull()?.let { trait ->
    val peak = s.hours.indexOf(s.hours.maxOrNull() ?: 0)
    list += Slide(listOf(Color(0xFF0F1026), Color(0xFF6C4FD8))) {
      Lead(stringResource(R.string.wrapped_trait_lead))
      Huge(traitTitle(trait), word = true)
      Sub(traitText(trait))
      Sub(stringResource(R.string.wrapped_peak_hour, "%02d:00".format(peak)))
    }
  }
  if (s.streakLongest > 1) list += Slide(listOf(Color(0xFF2A1A07), Color(0xFFF08A24))) {
    Lead(stringResource(R.string.wrapped_streak_lead))
    Huge(num(s.streakLongest))
    Text(stringResource(R.string.wrapped_streak_unit), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp, textAlign = TextAlign.Center)
    s.busiestDay?.let { Sub(stringResource(R.string.wrapped_busiest, fmtDay(it), num(s.busiestMinutes))) }
  }
  list += Slide(listOf(Color(0xFF0D1B3A), Color(0xFF2563EB), Color(0xFF6A5ACD)), summary = true) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Color.Black.copy(alpha = 0.28f)).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Artwork(s.topArtists.firstOrNull()?.artwork, Modifier.size(64.dp), shape = CircleShape, size = 256, placeholder = FluentIcons.Person)
        Spacer(Modifier.width(12.dp))
        Column {
          Text("GHARMONIZE PLAYER · $year", color = Color.White.copy(alpha = 0.8f), fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.5.sp)
          Text(name, color = Color.White, fontWeight = FontWeight.Black, fontSize = 22.sp)
        }
      }
      Row {
        SummaryCol(stringResource(R.string.wrapped_sum_artists), s.topArtists.map { it.name }, Modifier.weight(1f))
        SummaryCol(stringResource(R.string.wrapped_sum_tracks), s.topTracks.map { it.first.title }, Modifier.weight(1f))
      }
      Row {
        Column(Modifier.weight(1f)) { SumLabel(stringResource(R.string.wrapped_sum_minutes)); Text(num(s.minutes), color = Color.White, fontWeight = FontWeight.Black, fontSize = 28.sp) }
        Column(Modifier.weight(1f)) { SumLabel(stringResource(R.string.wrapped_top_genre)); Text(s.topGenres.firstOrNull()?.first ?: "—", color = Color.White, fontWeight = FontWeight.Black, fontSize = 24.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
      }
    }
    Button(onClick = { state.back(); state.player.play(s.topTracks.map { it.first }, 0) },
      colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color(0xFF0D1B3A))) {
      Icon(FluentIcons.PlayArrow, null)
      Spacer(Modifier.width(6.dp))
      Text(stringResource(R.string.wrapped_play_top), fontWeight = FontWeight.Bold)
    }
  }
  return list
}

@Composable
private fun SumLabel(text: String) = Text(text.uppercase(), color = Color.White.copy(alpha = 0.75f), fontSize = 11.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 1.2.sp, modifier = Modifier.padding(bottom = 4.dp))

@Composable
private fun SummaryCol(label: String, items: List<String>, modifier: Modifier) {
  Column(modifier.padding(end = 8.dp)) {
    SumLabel(label)
    items.take(5).forEachIndexed { i, text -> Text("${i + 1}  $text", color = Color.White, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp) }
  }
}
