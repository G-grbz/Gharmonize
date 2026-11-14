package com.gharmonize.player.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.data.Album
import com.gharmonize.player.data.Artist
import com.gharmonize.player.data.OnlineSearchResult
import com.gharmonize.player.data.Playlist
import com.gharmonize.player.data.SearchResult
import com.gharmonize.player.data.Shelf
import com.gharmonize.player.data.Track
import com.gharmonize.player.data.mapObjects
import com.gharmonize.player.data.parseAlbum
import com.gharmonize.player.data.parseArtist
import com.gharmonize.player.data.parseOnline
import com.gharmonize.player.data.parseTrack
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale

class LoadState<T>(val value: T?, val error: Throwable?, val loading: Boolean, val reload: () -> Unit)

/** Loads data for a screen; `reload()` runs it again. */
@Composable
fun <T> rememberLoad(vararg keys: Any?, load: suspend () -> T): LoadState<T> {
  var value by remember(*keys) { mutableStateOf<T?>(null) }
  var error by remember(*keys) { mutableStateOf<Throwable?>(null) }
  var loading by remember(*keys) { mutableStateOf(true) }
  var tick by remember(*keys) { mutableIntStateOf(0) }
  LaunchedEffect(*keys, tick) {
    loading = true
    error = null
    try { value = load() } catch (e: Exception) { error = e }
    loading = false
  }
  return LoadState(value, error, loading) { tick++ }
}

// ---- Home ------------------------------------------------------------------------------

private val PERSONAL = Regex("^(new-from-your-artists|missing-|fans-|radio-|genre-)")

private class HomeData(val stats: JSONObject?, val library: List<Shelf>, val shelfKeys: Map<String, String>)

@Composable
fun HomeScreen(state: AppState) {
  var showQueue by rememberSaveable { mutableStateOf(false) }
  if (showQueue) QueueSheet(state) { showQueue = false }
  val home = rememberLoad("home") {
    val o = state.api.home()
    val keys = mutableMapOf<String, String>()
    val shelves = o.optJSONArray("shelves").mapObjects { s ->
      val kind = s.optString("kind")
      val id = s.optString("id")
      keys[id] = s.optString("title")
      val items = s.optJSONArray("items")
      when (kind) {
        "tracks" -> Shelf(id, s.optString("title"), kind, tracks = items.mapObjects(::parseTrack), vars = s.optJSONObject("titleVars"))
        "albums" -> Shelf(id, s.optString("title"), kind, albums = items.mapObjects(::parseAlbum))
        "artists" -> Shelf(id, s.optString("title"), kind, artists = items.mapObjects(::parseArtist))
        "genres" -> Shelf(id, s.optString("title"), kind, genres = items.mapObjects { it.optString("name") })
        else -> null
      }
    }
    HomeData(o.optJSONObject("stats"), shelves, keys)
  }
  val discover = rememberLoad("discover") {
    val o = state.api.discover(Locale.getDefault().language)
    o.optJSONArray("shelves").mapObjects { it }
  }

  var insightsKey by remember { mutableIntStateOf(0) }
  val hasMusic = (home.value?.stats?.optInt("tracks") ?: 0) > 0
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    item {
      Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(greeting(state.me?.displayName ?: ""), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
          home.value?.stats?.let { s ->
            if (s.optInt("tracks") > 0) Text(stringResource(R.string.home_stats, s.optInt("tracks"), s.optInt("albums"), s.optInt("artists")),
              style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
        IconButton(onClick = { state.navigate(Route.Stats) }) { Icon(FluentIcons.BarChart, stringResource(R.string.stats_title)) }
        IconButton(onClick = { home.reload(); discover.reload(); insightsKey++ }) { Icon(FluentIcons.Refresh, stringResource(R.string.refresh)) }
      }
    }
    item {
      Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AssistChip(onClick = { state.navigate(Route.Playlists) }, label = { Text(stringResource(R.string.playlists)) }, leadingIcon = { Icon(FluentIcons.LibraryMusic, null, Modifier.size(18.dp)) })
        AssistChip(onClick = { showQueue = true }, label = { Text(stringResource(R.string.queue)) }, leadingIcon = { Icon(FluentIcons.QueueMusic, null, Modifier.size(18.dp)) })
      }
    }
    if (home.loading && home.value == null) item { Loading() }
    home.error?.let { e -> item { ErrorBox(state.errorText(e)) { home.reload() } } }
    val lib = home.value?.library.orEmpty()
    val online = discover.value.orEmpty()
    val personal = online.filter { PERSONAL.containsMatchIn(it.optString("id")) }
    val global = online.filterNot { PERSONAL.containsMatchIn(it.optString("id")) }
    // Library first, then "for you" online shelves, then both interleaved.
    lib.take(1).forEach { shelf -> item(key = "l-${shelf.id}") { LibraryShelf(state, shelf) } }
    if (hasMusic) item(key = "mixes") { HomeInsights(state, insightsKey) }
    lib.drop(1).take(1).forEach { shelf -> item(key = "l-${shelf.id}") { LibraryShelf(state, shelf) } }
    if (hasMusic) item(key = "teaser") { StatsTeaser(state, insightsKey) }
    personal.forEach { s -> item(key = "d-${s.optString("id")}") { DiscoverShelf(state, s) } }
    val rest = lib.drop(2)
    for (i in 0 until maxOf(rest.size, global.size)) {
      rest.getOrNull(i)?.let { shelf -> item(key = "l-${shelf.id}") { LibraryShelf(state, shelf) } }
      global.getOrNull(i)?.let { s -> item(key = "d-${s.optString("id")}") { DiscoverShelf(state, s) } }
    }
    if (discover.loading && discover.value == null && home.value != null) item { Loading() }
    if (home.value != null && lib.isEmpty() && online.isEmpty() && !discover.loading) item { EmptyText(stringResource(R.string.home_empty)) }
  }
}

@Composable
private fun greeting(name: String): String {
  val hour = remember { Calendar.getInstance().get(Calendar.HOUR_OF_DAY) }
  val res = when {
    hour < 5 -> R.string.greeting_night
    hour < 12 -> R.string.greeting_morning
    hour < 18 -> R.string.greeting_afternoon
    else -> R.string.greeting_evening
  }
  return stringResource(res, name).trim().trimEnd(',')
}

@Composable
private fun LibraryShelf(state: AppState, shelf: Shelf) {
  val title = shelfTitle(shelf.title, shelf.vars, fallback = shelf.title)
  when (shelf.kind) {
    "tracks" -> ShelfRow(title, shelf.tracks) { i, _ -> TrackCard(state, shelf.tracks, i) }
    "albums" -> ShelfRow(title, shelf.albums) { _, a -> AlbumCard(state, a) }
    "artists" -> ShelfRow(title, shelf.artists) { _, a -> ArtistCard(state, a) }
    "genres" -> if (shelf.genres.isNotEmpty()) {
      SectionTitle(title)
      LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(shelf.genres) { g ->
          AssistChip(onClick = {
            state.scope.launch {
              runCatching { state.api.tracks("genre=${java.net.URLEncoder.encode(g, "UTF-8")}&sort=random&limit=200") }
                .onSuccess { state.player.play(it, 0) }
            }
          }, label = { Text(g) })
        }
      }
    }
  }
}

@Composable
private fun DiscoverShelf(state: AppState, s: JSONObject) {
  val items = remember(s) { s.optJSONArray("items").mapObjects(::parseOnline) }
  val rawTitle = s.optString("title").takeIf { !s.isNull("title") && it.isNotBlank() }
  val title = rawTitle ?: shelfTitle(s.optString("titleKey"), s.optJSONObject("titleVars"))
  val sub = if (s.isNull("subtitleKey")) null else shelfTitle(s.optString("subtitleKey"))
  ShelfRow(title, items, subtitle = sub) { i, _ -> OnlineCard(state, items, i) }
}

// ---- Search ----------------------------------------------------------------------------

@Composable
fun SearchScreen(state: AppState) {
  var query by rememberSaveable { mutableStateOf("") }
  var local by remember { mutableStateOf<SearchResult?>(null) }
  var online by remember { mutableStateOf<OnlineSearchResult?>(null) }
  var onlineLoading by remember { mutableStateOf(false) }
  LaunchedEffect(query) {
    val q = query.trim()
    if (q.isEmpty()) { local = null; online = null; return@LaunchedEffect }
    delay(300)
    local = runCatching { state.api.search(q) }.getOrNull()
    onlineLoading = true
    delay(400)
    online = runCatching { state.api.onlineSearch(q) }.getOrNull()
    onlineLoading = false
  }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    item {
      OutlinedTextField(
        value = query, onValueChange = { query = it }, singleLine = true,
        leadingIcon = { Icon(FluentIcons.Search, null) },
        placeholder = { Text(stringResource(R.string.search_hint)) },
        modifier = Modifier.fillMaxWidth().padding(16.dp),
      )
    }
    local?.let { r ->
      if (r.tracks.isEmpty() && r.albums.isEmpty() && r.artists.isEmpty()) item { EmptyText(stringResource(R.string.search_no_local)) }
      if (r.artists.isNotEmpty()) item { ShelfRow(stringResource(R.string.artists), r.artists) { _, a -> ArtistCard(state, a) } }
      if (r.tracks.isNotEmpty()) {
        item { SectionTitle(stringResource(R.string.songs)) }
        itemsIndexed(r.tracks.take(10), key = { _, t -> "lt-${t.id}" }) { i, _ -> TrackRow(state, r.tracks, i) }
      }
      if (r.albums.isNotEmpty()) item { ShelfRow(stringResource(R.string.albums), r.albums) { _, a -> AlbumCard(state, a) } }
    }
    if (onlineLoading) item { Loading() }
    online?.let { r ->
      if (r.tracks.isNotEmpty() || r.albums.isNotEmpty()) item { SectionTitle(stringResource(R.string.search_online)) }
      itemsIndexed(r.tracks.take(12), key = { i, t -> "ot-$i-${t.id}" }) { i, _ -> OnlineTrackRow(state, r.tracks, i) }
      if (r.albums.isNotEmpty()) item { ShelfRow(stringResource(R.string.albums_online), r.albums) { i, _ -> OnlineCard(state, r.albums, i) } }
      if (r.artists.isNotEmpty()) item { ShelfRow(stringResource(R.string.artists_online), r.artists) { i, _ -> OnlineCard(state, r.artists, i) } }
    }
  }
}

// ---- Library ---------------------------------------------------------------------------

@Composable
fun LibraryScreen(state: AppState) {
  var tab by rememberSaveable { mutableIntStateOf(0) }
  val tabs = listOf(R.string.playlists, R.string.albums, R.string.artists, R.string.songs, R.string.recent)
  Column(Modifier.fillMaxSize()) {
    Text(stringResource(R.string.nav_library), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(16.dp))
    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      itemsIndexed(tabs) { i, res -> FilterChip(selected = tab == i, onClick = { tab = i }, label = { Text(stringResource(res)) }) }
    }
    Spacer(Modifier.height(8.dp))
    when (tab) {
      0 -> PlaylistsTab(state)
      1 -> AlbumsTab(state)
      2 -> ArtistsTab(state)
      3 -> TracksTab(state, "sort=alpha&limit=500")
      else -> TracksTab(state, null)
    }
  }
}

@Composable
fun PlaylistsTab(state: AppState) {
  val data = rememberLoad("playlists") { state.api.playlists() }
  var create by remember { mutableStateOf(false) }
  if (create) SavePlaylistDialog(state, emptyList(), onDismiss = { create = false }, onSaved = { data.reload(); state.navigate(Route.Playlist(it)) })
  LazyColumn(Modifier.fillMaxSize()) {
    item {
      androidx.compose.material3.TextButton(onClick = { create = true }, modifier = Modifier.padding(horizontal = 12.dp)) { Text(stringResource(R.string.create_playlist)) }
      ListRow(icon = { Icon(FluentIcons.Favorite, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(40.dp)) },
        title = stringResource(R.string.liked_songs), subtitle = stringResource(R.string.kind_playlist)) { state.navigate(Route.Liked) }
    }
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (data.loading && data.value == null) item { Loading() }
    items(data.value.orEmpty(), key = { "pl-${it.id}" }) { pl: Playlist ->
      ListRow(icon = { Artwork(if (pl.trackCount > 0) pl.artwork else null, Modifier.size(52.dp), size = 128, placeholder = FluentIcons.QueueMusic) },
        title = pl.name, subtitle = stringResource(R.string.count_songs, pl.trackCount) + if (!pl.editable) " · ${pl.owner}" else "") {
        state.navigate(Route.Playlist(pl.id))
      }
    }
  }
}

@Composable
private fun AlbumsTab(state: AppState) {
  val data = rememberLoad("albums") { state.api.albums("recent") }
  LazyColumn(Modifier.fillMaxSize()) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (data.loading && data.value == null) item { Loading() }
    items(data.value.orEmpty(), key = { "al-${it.id}" }) { a: Album ->
      ListRow(icon = { Artwork(a.artwork, Modifier.size(52.dp), size = 128) }, title = a.title,
        subtitle = listOfNotNull(a.artist.ifBlank { null }, a.year?.toString()).joinToString(" · ")) { state.navigate(Route.Album(a.id)) }
    }
    if (data.value?.isEmpty() == true) item { EmptyText(stringResource(R.string.empty_library)) }
  }
}

@Composable
private fun ArtistsTab(state: AppState) {
  val data = rememberLoad("artists") { state.api.artists() }
  LazyColumn(Modifier.fillMaxSize()) {
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (data.loading && data.value == null) item { Loading() }
    items(data.value.orEmpty(), key = { "ar-${it.id}" }) { a: Artist ->
      ListRow(icon = { Artwork(a.artwork, Modifier.size(52.dp), shape = androidx.compose.foundation.shape.CircleShape, size = 128) },
        title = a.name, subtitle = stringResource(R.string.count_songs, a.trackCount)) { state.navigate(Route.Artist(a.id)) }
    }
  }
}

/** query == null → listening history. */
@Composable
private fun TracksTab(state: AppState, query: String?) {
  val data = rememberLoad("tracks", query) { if (query == null) state.api.recent() else state.api.tracks(query) }
  TrackListScreen(state, data, header = null)
}

@Composable
fun LikedScreen(state: AppState) {
  val data = rememberLoad("liked") { state.api.tracks("favorites=1&limit=500") }
  TrackListScreen(state, data, header = {
    HeaderBlock(null, stringResource(R.string.kind_playlist), stringResource(R.string.liked_songs),
      stringResource(R.string.count_songs, data.value?.size ?: 0)) { PlayShuffle(state, data.value.orEmpty()) }
  })
}

@Composable
fun TrackListScreen(state: AppState, data: LoadState<List<Track>>, header: (@Composable () -> Unit)?) {
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    header?.let { item { it() } }
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    if (data.loading && data.value == null) item { Loading() }
    val tracks = data.value.orEmpty()
    if (!data.loading && tracks.isEmpty() && data.error == null) item { EmptyText(stringResource(R.string.empty_list)) }
    itemsIndexed(tracks, key = { i, t -> "t-$i-${t.id}" }) { i, _ -> TrackRow(state, tracks, i) }
  }
}

@Composable
fun PlayShuffle(state: AppState, tracks: List<Track>) {
  FilledIconButton(onClick = { state.player.play(tracks, 0) }, enabled = tracks.isNotEmpty(), modifier = Modifier.size(56.dp)) {
    Icon(FluentIcons.PlayArrow, stringResource(R.string.play), modifier = Modifier.size(32.dp))
  }
  IconButton(onClick = { state.player.play(tracks, 0, shuffle = true) }, enabled = tracks.isNotEmpty()) {
    Icon(FluentIcons.Shuffle, stringResource(R.string.shuffle))
  }
}

@Composable
fun ListRow(icon: @Composable () -> Unit, title: String, subtitle: String, onClick: () -> Unit) {
  Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    icon()
    Spacer(Modifier.width(12.dp))
    Column(Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
      if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}
