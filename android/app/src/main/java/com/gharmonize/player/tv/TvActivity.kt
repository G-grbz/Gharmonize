package com.gharmonize.player.tv

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.media3.common.Player
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.Album
import com.gharmonize.player.data.HomeCache
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.Artist
import com.gharmonize.player.data.Playlist
import com.gharmonize.player.data.Track
import com.gharmonize.player.data.mapObjects
import com.gharmonize.player.data.parseAlbum
import com.gharmonize.player.data.parseArtist
import com.gharmonize.player.data.parseTrack
import com.gharmonize.player.playback.PlayerController
import com.gharmonize.player.ui.Artwork
import com.gharmonize.player.ui.ErrorBox
import com.gharmonize.player.ui.FluentIcons
import com.gharmonize.player.ui.GharmonizeTheme
import com.gharmonize.player.ui.Loading
import com.gharmonize.player.ui.MixArt
import com.gharmonize.player.ui.fmtTime
import com.gharmonize.player.ui.mixTitle
import com.gharmonize.player.ui.rememberLoad
import com.gharmonize.player.ui.shelfTitle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Gharmonize on Google TV / Android TV: the same app (same playback service,
 * caches and server connection) with a big-screen, remote-friendly UI. It is
 * signed in from the phone (Settings → Connect a TV).
 */
class TvActivity : ComponentActivity() {
  override fun attachBaseContext(newBase: android.content.Context) {
    super.attachBaseContext(com.gharmonize.player.AppLocale.wrap(newBase))
  }

  private val uiScope = kotlinx.coroutines.MainScope()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    TvLaunch.take(intent)
    TvTheme.load(App.instance.prefs)
    setContent {
      GharmonizeTheme(if (TvTheme.dark) "dark" else "light") {
        Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
          var signedIn by remember { mutableStateOf(App.instance.prefs.signedIn) }
          val signedOutTick by App.instance.signedOut.collectAsState()
          LaunchedEffect(signedOutTick) { if (signedOutTick > 0) { signedIn = false; TvChannels.clear(this@TvActivity) } }
          if (!signedIn) TvPairScreen { signedIn = true; refreshHomeScreenRows() }
          else TvMain(onSignOut = { App.instance.prefs.signOut(); signedIn = false; TvChannels.clear(this@TvActivity) })
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    TvLaunch.take(intent)
  }

  override fun onStart() {
    super.onStart()
    refreshHomeScreenRows()
  }

  override fun onDestroy() {
    uiScope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
    super.onDestroy()
  }

  /**
   * TV home screen rows: refreshed whenever the app comes to the front. The
   * second row ("Recently played") needs the user's OK once.
   */
  private fun refreshHomeScreenRows() {
    if (!App.instance.prefs.signedIn || !TvChannels.supported(this)) return
    uiScope.launch {
      val ids = runCatching { TvChannels.sync(applicationContext) }.getOrDefault(emptyMap())
      val recent = ids[TvChannels.RECENT] ?: return@launch
      val prefs = App.instance.prefs
      val asked = prefs.tvAskedChannels.orEmpty().split(',')
      if ("$recent" in asked) return@launch
      prefs.tvAskedChannels = (asked + "$recent").filter { it.isNotBlank() }.joinToString(",")
      @Suppress("DEPRECATION")
      runCatching {
        startActivityForResult(Intent(androidx.tvprovider.media.tv.TvContractCompat.ACTION_REQUEST_CHANNEL_BROWSABLE)
          .putExtra(androidx.tvprovider.media.tv.TvContractCompat.EXTRA_CHANNEL_ID, recent), 41)
      }
    }
  }
}

/** What a home-screen row card asked the app to open ("mix:3", "album:5", "play:1,2,3|1"). */
object TvLaunch {
  var pending by mutableStateOf<String?>(null)

  fun take(intent: Intent?) {
    intent?.getStringExtra(TvChannels.EXTRA_OPEN)?.takeIf { it.length < 2000 }?.let { pending = it }
  }
}

// ---- pairing ----------------------------------------------------------------------------

@Composable
fun TvPairScreen(onPaired: () -> Unit) {
  val app = App.instance
  val receiver = remember { TvPairReceiver(app, onPaired) }
  var host by remember { mutableStateOf<String?>(null) }
  var noNetwork by remember { mutableStateOf(false) }
  DisposableEffect(Unit) {
    host = runCatching { receiver.start() }.getOrNull()
    noNetwork = host == null
    onDispose { receiver.stop() }
  }
  val link = host?.let { TvPairLink.build(it, receiver.nonce, TvPairReceiver.tvName()) }
  val qr = remember(link) { link?.let { TvPairReceiver.qr(it, 640) } }
  Row(Modifier.fillMaxSize().padding(64.dp), verticalAlignment = Alignment.CenterVertically) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(18.dp)) {
      Image(painterResource(R.drawable.gharmonize_logo), null, modifier = Modifier.size(120.dp))
      Text(stringResource(R.string.tv_pair_title), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
      Text(stringResource(R.string.tv_pair_steps), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
      if (noNetwork) Text(stringResource(R.string.tv_pair_no_network), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.error)
      host?.let { Text(stringResource(R.string.tv_pair_address, it), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
    Spacer(Modifier.width(48.dp))
    Box(Modifier.size(380.dp).background(androidx.compose.ui.graphics.Color.White, RoundedCornerShape(24.dp)).padding(18.dp), contentAlignment = Alignment.Center) {
      if (qr != null) Image(qr.asImageBitmap(), stringResource(R.string.tv_pair_title), modifier = Modifier.fillMaxSize())
      else Loading()
    }
  }
}

// ---- main -------------------------------------------------------------------------------

sealed interface TvRoute {
  data object Home : TvRoute
  data object Search : TvRoute
  data object Library : TvRoute
  data object NowPlaying : TvRoute
  data object Settings : TvRoute
  data class Album(val id: Long) : TvRoute
  data class Artist(val id: Long) : TvRoute
  data class Playlist(val id: Long) : TvRoute
  data class Mix(val id: String) : TvRoute
  data object Liked : TvRoute
  data object Downloads : TvRoute
  data class OnlineList(val item: OnlineItem) : TvRoute
  data class OnlineArtist(val id: String?, val name: String) : TvRoute
  data class Mood(val preset: String) : TvRoute
  data object HomeRows : TvRoute
}

class TvNav(val player: PlayerController, private val scope: CoroutineScope) {
  val stack = mutableStateListOf<TvRoute>(TvRoute.Home)
  /** Library tab (albums / artists / playlists), kept while browsing. */
  var libraryTab by mutableStateOf(0)
  /** From /me: whether this account may download. */
  var canDownload by mutableStateOf(false)
  /** Lists queued for download from this TV (button state). */
  val queued = mutableStateListOf<String>()
  /** Lyrics beside the player (kept while songs change). */
  var lyrics by mutableStateOf(App.instance.prefs.tvLyrics)
    private set

  /** The layout changes with the lyrics, so the button gets the focus back. */
  var focusLyricsButton = false

  fun toggleLyrics() { lyrics = !lyrics; App.instance.prefs.tvLyrics = lyrics; focusLyricsButton = true }

  private fun toast(res: Int, vararg args: Any) {
    val app = App.instance
    android.widget.Toast.makeText(app, app.getString(res, *args), android.widget.Toast.LENGTH_LONG).show()
  }
  val top get() = stack.last()
  fun go(route: TvRoute) {
    if (route in listOf(TvRoute.Home, TvRoute.Search, TvRoute.Library, TvRoute.Downloads, TvRoute.Settings)) { stack.clear(); stack.add(route) } else stack.add(route)
  }
  fun back(): Boolean = if (stack.size > 1) { stack.removeAt(stack.lastIndex); true } else false

  /** Plays a list from a song and shows the big now-playing screen. */
  fun play(tracks: List<Track>, index: Int = 0, shuffle: Boolean = false) {
    if (tracks.isEmpty()) return
    player.play(tracks, index, shuffle)
    go(TvRoute.NowPlaying)
  }

  /** Online songs: owned ones play from the library, others as 30 s previews. */
  fun playOnline(items: List<OnlineItem>, index: Int) {
    if (items.isEmpty()) return
    if (player.playOnline(items, index)) go(TvRoute.NowPlaying)
    else {
      val item = items.getOrNull(index) ?: return
      if (canDownload) toast(R.string.online_not_owned_download, item.title) else toast(R.string.online_no_preview)
    }
  }

  /** Albums, playlists and mixes open; artists open (library first); songs play. */
  fun openOnline(items: List<OnlineItem>, index: Int) {
    val item = items.getOrNull(index) ?: return
    when (item.kind) {
      "album", "playlist" -> go(TvRoute.OnlineList(item))
      "artist" -> item.libraryArtistId?.let { go(TvRoute.Artist(it)) } ?: go(TvRoute.OnlineArtist(if (item.provider == "deezer") item.id else null, item.title))
      else -> playOnline(items, index)
    }
  }

  fun download(item: OnlineItem, key: String) {
    scope.launch {
      try {
        val row = App.instance.api.requestDownload(item)
        queued.add(key)
        toast(if (row.status == "exists") R.string.download_exists else R.string.download_queued, item.title)
      } catch (e: Exception) {
        android.widget.Toast.makeText(App.instance, e.message ?: "", android.widget.Toast.LENGTH_LONG).show()
      }
    }
  }

  /** Mixes without a downloadable link: each missing song on its own. */
  fun downloadEach(items: List<OnlineItem>, key: String) {
    scope.launch {
      // One request: the server keeps songs over the queue limit waiting.
      val missing = items.filter { it.libraryTrackId == null && it.url.isNotBlank() }
      if (missing.isEmpty()) return@launch
      try {
        App.instance.api.requestDownloadGroup(missing)
        missing.forEach { queued.add(it.key) }
        queued.add(key)
        toast(R.string.group_queued, missing.size)
      } catch (e: Exception) {
        android.widget.Toast.makeText(App.instance, e.message ?: "", android.widget.Toast.LENGTH_LONG).show()
      }
    }
  }
}

@Composable
fun TvMain(onSignOut: () -> Unit) {
  val context = LocalContext.current
  val player = remember { PlayerController(context.applicationContext) }
  val scope = rememberCoroutineScope()
  val nav = remember { TvNav(player, scope) }
  LaunchedEffect(Unit) { runCatching { App.instance.api.me() }.onSuccess { nav.canDownload = it.canDownload } }
  DisposableEffect(Unit) {
    player.connect()
    onDispose { player.release() }
  }
  BackHandler(enabled = nav.stack.size > 1) { nav.back() }
  // A card on the TV home screen opened the app.
  // (Collected, not keyed on the value: clearing it must not cancel the work.)
  LaunchedEffect(Unit) {
    androidx.compose.runtime.snapshotFlow { TvLaunch.pending }.collect { p ->
    if (p == null) return@collect
    TvLaunch.pending = null
    val kind = p.substringBefore(':')
    val value = p.substringAfter(':')
    when (kind) {
      "mix" -> nav.go(TvRoute.Mix(value))
      "playlist" -> value.toLongOrNull()?.let { nav.go(TvRoute.Playlist(it)) }
      "album" -> value.toLongOrNull()?.let { nav.go(TvRoute.Album(it)) }
      "play" -> {
        val ids = value.substringBefore('|').split(',').mapNotNull { it.toLongOrNull() }
        val index = value.substringAfter('|', "0").toIntOrNull() ?: 0
        val tracks = runCatching { App.instance.api.tracksByIds(ids) }.getOrDefault(emptyList())
        // Opened from the TV home screen with the app closed: the player
        // service connects a moment later.
        var waited = 0
        while (!nav.player.connected && waited++ < 50) delay(100)
        val start = ids.getOrNull(index)?.let { id -> tracks.indexOfFirst { it.id == id } }?.takeIf { it >= 0 } ?: 0
        if (tracks.isNotEmpty()) nav.play(tracks, start)
      }
    }
    }
  }
  Row(Modifier.fillMaxSize()) {
    TvRail(nav)
    Box(Modifier.weight(1f).fillMaxHeight()) { TvPivotScroll {
      when (val r = nav.top) {
        TvRoute.Home -> TvHome(nav)
        TvRoute.Search -> TvSearch(nav)
        TvRoute.Library -> TvLibrary(nav)
        TvRoute.NowPlaying -> TvNowPlaying(nav)
        TvRoute.Settings -> TvSettings(nav, onSignOut)
        TvRoute.Downloads -> TvDownloads(nav)
        is TvRoute.OnlineList -> TvOnlineList(nav, r.item)
        is TvRoute.OnlineArtist -> TvOnlineArtist(nav, r.id, r.name)
        TvRoute.Liked -> TvTrackList(nav, "liked", stringResource(R.string.liked_songs), null, null) { App.instance.api.tracks("favorites=1&limit=500") }
        is TvRoute.Album -> TvAlbum(nav, r.id)
        is TvRoute.Artist -> TvArtist(nav, r.id)
        is TvRoute.Playlist -> TvPlaylist(nav, r.id)
        is TvRoute.Mix -> TvMixScreen(nav, r.id)
        is TvRoute.Mood -> TvMood(nav, r.preset)
        TvRoute.HomeRows -> TvHomeRowsScreen()
      }
    } }
  }
}

@Composable
private fun TvRail(nav: TvNav) {
  val items = listOf(
    Triple(TvRoute.Home, FluentIcons.Home, R.string.nav_home),
    Triple(TvRoute.Search, FluentIcons.Search, R.string.nav_search),
    Triple(TvRoute.Library, FluentIcons.LibraryMusic, R.string.nav_library),
    Triple(TvRoute.Downloads, FluentIcons.Download, R.string.nav_downloads),
    Triple(TvRoute.NowPlaying, FluentIcons.MusicNote, R.string.now_playing),
    Triple(TvRoute.Settings, FluentIcons.Settings, R.string.nav_settings),
  )
  Column(
    Modifier.fillMaxHeight().width(220.dp).background(MaterialTheme.colorScheme.surfaceContainer).padding(vertical = 28.dp, horizontal = 12.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 8.dp, bottom = 10.dp)) {
      Image(painterResource(R.drawable.gharmonize_logo), null, modifier = Modifier.size(44.dp))
      Spacer(Modifier.width(10.dp))
      Text("Gharmonize", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
    }
    for ((route, icon, label) in items) {
      val selected = nav.stack.firstOrNull() == route || nav.top == route
      TvFocusable({ nav.go(route) }, Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), scaleOnFocus = 1.03f) { focused ->
        Row(
          Modifier.fillMaxWidth().background(if (selected && !focused) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(12.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Icon(icon, null, tint = if (focused || selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
          Spacer(Modifier.width(14.dp))
          Text(stringResource(label), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
      }
    }
    Spacer(Modifier.weight(1f))
    TvMiniPlayer(nav)
  }
}

/** What is playing, in the menu: OK opens the big screen. */
@Composable
private fun TvMiniPlayer(nav: TvNav) {
  val item = nav.player.current ?: return
  val md = item.mediaMetadata
  TvFocusable({ nav.go(TvRoute.NowPlaying) }, Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), scaleOnFocus = 1.03f) {
    Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
      Artwork(md.artworkUri?.toString()?.removePrefix("ghp://artwork/")?.substringBefore("?"), Modifier.size(48.dp), size = 128)
      Spacer(Modifier.width(10.dp))
      Column(Modifier.weight(1f)) {
        Text(md.title?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        Text(md.artist?.toString().orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
  }
}

private fun artRef(t: Track) = t.artwork ?: t.albumId?.let { "album/$it" } ?: "track/${t.id}"

// ---- home ---------------------------------------------------------------------------------

@Composable
private fun TvHome(nav: TvNav) {
  val api = App.instance.api
  val home = rememberLoad("tv-home") { api.home() }
  val mixes = rememberLoad("tv-mixes") { runCatching { api.mixes() }.getOrDefault(emptyList()) }
  val playlists = rememberLoad("tv-playlists") { runCatching { api.playlists() }.getOrDefault(emptyList()) }
  // Online shelves (same as the phone): the last answer shows at once.
  val app = App.instance
  var partial by remember { mutableStateOf(false) }
  val discover = rememberLoad("tv-discover", initial = { HomeCache.read(app, "discover")?.optJSONArray("shelves").mapObjects { it } }) {
    val o = api.discover(Locale.getDefault().language)
    partial = o.optBoolean("partial")
    HomeCache.write(app, "discover", o)
    o.optJSONArray("shelves").mapObjects { it }
  }
  var retries by remember { mutableStateOf(0) }
  LaunchedEffect(partial, discover.loading) {
    if (partial && !discover.loading && retries < 2) { delay(8000); retries++; discover.reload() }
  }
  // Online shelves wait for the library ones, so the order does not jump.
  val online = if (home.value != null || home.error != null) discover.value.orEmpty() else emptyList()
  val onlineMixes = online.filter { it.optString("id").startsWith("mixes-") }
  val onlineRest = online.filterNot { it in onlineMixes }
  val hasYouTube = online.any { it.optString("source") == "youtube" || it.optString("id").startsWith("yt-") || it.optString("id") == "mixes-youtube" }

  // Every row in its default place; the user's order / hidden rows (Settings
  // → Home rows) are applied on top.
  val rows = buildList {
    val mixesTitle = stringResource(R.string.home_mixes)
    mixes.value?.takeIf { it.isNotEmpty() }?.let { list ->
      add(TvHomeRow("mixes", "mixes", mixesTitle) {
        TvRow(mixesTitle, list) { _, m ->
          TvCard(mixTitle(m), m.artists.take(3).joinToString(", "), null,
            artContent = { MixArt(m, Modifier.fillMaxSize(), label = false) }, onClick = { nav.go(TvRoute.Mix(m.id)) })
        }
      })
    }
    onlineMixes.forEach { s -> add(TvHomeRow("d-${s.optString("id")}", TvHomeRows.onlineGroup(s), discoverTitle(s)) { TvDiscoverShelf(nav, s) }) }
    val own = playlists.value.orEmpty().filter { it.editable }
    val shared = playlists.value.orEmpty().filterNot { it.editable }
    val ownTitle = stringResource(R.string.home_your_playlists)
    if (own.isNotEmpty()) add(TvHomeRow("playlists", "playlists", ownTitle) {
      TvRow(ownTitle, own) { _, p -> TvCard(p.name, p.owner, if (p.trackCount > 0) p.artwork else null, placeholder = FluentIcons.Playlist) { nav.go(TvRoute.Playlist(p.id)) } }
    })
    val moodsTitle = stringResource(R.string.home_moods)
    if (hasYouTube) add(TvHomeRow("moods", "moods", moodsTitle) {
      TvRow(moodsTitle, TV_MOODS) { _, preset -> TvMoodTile(preset) { nav.go(TvRoute.Mood(preset)) } }
    })
    val shelves = home.value?.optJSONArray("shelves").mapObjects { it }
    // Library and online shelves take turns.
    for ((n, s) in shelves.withIndex()) {
      onlineRest.getOrNull(n - 1)?.let { d -> add(TvHomeRow("d-${d.optString("id")}", TvHomeRows.onlineGroup(d), discoverTitle(d)) { TvDiscoverShelf(nav, d) }) }
      val id = s.optString("id")
      val title = shelfTitle(s.optString("title"), s.optJSONObject("titleVars"), fallback = s.optString("title"))
      val items = s.optJSONArray("items")
      val group = TvHomeRows.libraryGroup(id)
      when (s.optString("kind")) {
        "tracks" -> {
          val tracks = items.mapObjects(::parseTrack)
          add(TvHomeRow("h-$n-$id", group, title) { TvRow(title, tracks) { i, t -> TvCard(t.title, t.artist, artRef(t)) { nav.play(tracks, i) } } })
        }
        "albums" -> {
          val albums = items.mapObjects(::parseAlbum)
          add(TvHomeRow("h-$n-$id", group, title) { TvRow(title, albums) { _, a -> TvCard(a.title, a.artist, a.artwork) { nav.go(TvRoute.Album(a.id)) } } })
        }
        "artists" -> {
          val artists = items.mapObjects(::parseArtist)
          add(TvHomeRow("h-$n-$id", group, title) { TvRow(title, artists) { _, a -> TvCard(a.name, "", a.artwork, round = true, placeholder = FluentIcons.Person) { nav.go(TvRoute.Artist(a.id)) } } })
        }
      }
    }
    onlineRest.drop((shelves.size - 1).coerceAtLeast(0)).forEach { d -> add(TvHomeRow("d-${d.optString("id")}", TvHomeRows.onlineGroup(d), discoverTitle(d)) { TvDiscoverShelf(nav, d) }) }
    val sharedTitle = stringResource(R.string.home_shared_playlists)
    if (shared.isNotEmpty()) add(TvHomeRow("shared", "shared", sharedTitle) {
      TvRow(sharedTitle, shared) { _, p -> TvCard(p.name, p.owner, if (p.trackCount > 0) p.artwork else null, placeholder = FluentIcons.Playlist) { nav.go(TvRoute.Playlist(p.id)) } }
    })
  }
  val signature = rows.joinToString("|") { it.group + "=" + it.title }
  LaunchedEffect(signature) { if (rows.isNotEmpty()) TvHomeRows.noteCatalog(rows) }
  val shown = TvHomeRows.arrange(rows)
  val listState = androidx.compose.foundation.lazy.rememberLazyListState()
  TvRowNavigation { rowsModifier, rowNav ->
    // Until the remote is used, the page stays at its top with the first row
    // focused, also when rows arrive later and land above the focused one.
    val keys = shown.joinToString(",") { it.key }
    LaunchedEffect(keys) {
      if (rowNav.touched || shown.isEmpty()) return@LaunchedEffect
      listState.scrollToItem(0)
      repeat(30) { if (rowNav.touched || rowNav.focusTop()) return@LaunchedEffect; delay(100) }
    }
    LazyColumn(rowsModifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(start = 36.dp, end = 36.dp, top = 28.dp, bottom = 40.dp)) {
      // Every row has a stable key: rows arriving later (online shelves) are
      // inserted around the focused one instead of sliding it away.
      item(key = "title") { Text(stringResource(R.string.nav_home), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 8.dp, bottom = 8.dp)) }
      home.error?.let { e -> item(key = "error") { ErrorBox(e.message ?: "") { home.reload() } } }
      if (home.loading && home.value == null) item(key = "loading") { Loading() }
      shown.forEach { r -> item(key = r.key) { r.content() } }
      if (discover.loading && discover.value == null && home.value != null) item(key = "loading-online") { Loading() }
    }
  }
}

@Composable
private fun discoverTitle(s: org.json.JSONObject): String {
  val raw = s.optString("title").takeIf { !s.isNull("title") && it.isNotBlank() }
  return raw ?: shelfTitle(s.optString("titleKey"), s.optJSONObject("titleVars"))
}

// ---- lists --------------------------------------------------------------------------------

/** Header + Play / Shuffle + songs. `load` gives the songs. */
@Composable
private fun TvTrackList(nav: TvNav, key: String, title: String?, subtitle: String?, art: String?, load: suspend () -> List<Track>) {
  val data = rememberLoad("tv-list", key) { load() }
  val tracks = data.value.orEmpty()
  val playingId = nav.player.current?.mediaId
  val playFocus = remember { FocusRequester() }
  LaunchedEffect(key, tracks.isNotEmpty()) { if (tracks.isNotEmpty()) runCatching { playFocus.requestFocus() } }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 36.dp, end = 36.dp, top = 28.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    item {
      Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 18.dp)) {
        Artwork(art ?: tracks.firstOrNull()?.let(::artRef), Modifier.size(200.dp), shape = RoundedCornerShape(18.dp), size = 512)
        Spacer(Modifier.width(28.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(title ?: tracks.firstOrNull()?.album.orEmpty(), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
          Text(subtitle ?: stringResource(R.string.count_songs, tracks.size), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Row(horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(top = 8.dp)) {
            TvButton(stringResource(R.string.play), FluentIcons.PlayArrow, primary = true, modifier = Modifier.focusRequester(playFocus)) { nav.play(tracks, 0) }
            TvButton(stringResource(R.string.shuffle), FluentIcons.Shuffle) { nav.play(tracks, 0, shuffle = true) }
          }
        }
      }
    }
    data.error?.let { e -> item { ErrorBox(e.message ?: "") { data.reload() } } }
    if (data.loading && data.value == null) item { Loading() }
    itemsIndexed(tracks, key = { i, t -> "$i-${t.id}" }) { i, t -> TvTrackRow(t, i + 1, playingId == "t:${t.id}") { nav.play(tracks, i) } }
  }
}

@Composable
private fun TvAlbum(nav: TvNav, id: Long) {
  val album = rememberLoad("tv-album", id) { App.instance.api.album(id) }.value
  TvTrackList(nav, "album-$id", album?.title, listOfNotNull(album?.artist, album?.year?.toString()).joinToString(" · ").ifBlank { null }, album?.artwork) { App.instance.api.album(id).tracks }
}

@Composable
private fun TvPlaylist(nav: TvNav, id: Long) {
  val pl = rememberLoad("tv-playlist", id) { App.instance.api.playlist(id) }.value
  TvTrackList(nav, "pl-$id", pl?.name, pl?.owner?.ifBlank { null }, if ((pl?.trackCount ?: 0) > 0) pl?.artwork else null) { App.instance.api.playlist(id).tracks }
}

@Composable
private fun TvMixScreen(nav: TvNav, id: String) {
  val mix = rememberLoad("tv-mix", id) { App.instance.api.mix(id) }.value
  TvTrackList(nav, "mix-$id", mix?.first?.let { mixTitle(it) }, mix?.first?.artists?.take(3)?.joinToString(", "), null) { App.instance.api.mix(id).second }
}

@Composable
private fun TvArtist(nav: TvNav, id: Long) {
  val api = App.instance.api
  val data = rememberLoad("tv-artist", id) { api.artist(id) }
  val songs = rememberLoad("tv-artist-songs", id) { api.artistTracks(id, "plays") }
  val artist = data.value
  val tracks = songs.value.orEmpty()
  val playingId = nav.player.current?.mediaId
  val playFocus = remember { FocusRequester() }
  LaunchedEffect(id, artist != null) { if (artist != null) runCatching { playFocus.requestFocus() } }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 36.dp, end = 36.dp, top = 28.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    data.error?.let { e -> item { ErrorBox(e.message ?: "") { data.reload() } } }
    if (artist == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    item {
      Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 12.dp)) {
        Artwork(artist.artwork, Modifier.size(200.dp), shape = CircleShape, size = 512, placeholder = FluentIcons.Person)
        Spacer(Modifier.width(28.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.weight(1f)) {
          Text(artist.name, style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
          Text(stringResource(R.string.count_songs, artist.trackCount), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
          Row(horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(top = 8.dp)) {
            TvButton(stringResource(R.string.play), FluentIcons.PlayArrow, primary = true, modifier = Modifier.focusRequester(playFocus)) { nav.play(tracks, 0) }
            TvButton(stringResource(R.string.shuffle), FluentIcons.Shuffle) { nav.play(tracks, 0, shuffle = true) }
          }
          // Under the buttons, so its late arrival never moves them.
          TvArtistBio(artist.name, null)
        }
      }
    }
    if (artist.albums.isNotEmpty()) item { TvRow(stringResource(R.string.albums), artist.albums) { _, a -> TvCard(a.title, a.year?.toString().orEmpty(), a.artwork) { nav.go(TvRoute.Album(a.id)) } } }
    item { Text(stringResource(R.string.all_songs), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 8.dp, top = 12.dp, bottom = 6.dp)) }
    itemsIndexed(tracks, key = { i, t -> "$i-${t.id}" }) { i, t -> TvTrackRow(t, i + 1, playingId == "t:${t.id}") { nav.play(tracks, i) } }
  }
}

// ---- library ------------------------------------------------------------------------------

@Composable
private fun TvLibrary(nav: TvNav) {
  // Kept in nav: coming back from an album opens the same tab.
  var tab by nav::libraryTab
  // Opening (or coming back to) the library puts the remote on the open tab, not the menu.
  val tabFocus = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { tabFocus.requestFocus() } }
  val api = App.instance.api
  Column(Modifier.fillMaxSize().padding(start = 36.dp, end = 36.dp, top = 28.dp)) {
    Text(stringResource(R.string.nav_library), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(vertical = 16.dp)) {
      listOf(R.string.albums, R.string.artists, R.string.playlists, R.string.liked_songs).forEachIndexed { i, res ->
        TvButton(stringResource(res), primary = tab == i, modifier = if (i == tab) Modifier.focusRequester(tabFocus) else Modifier) { if (i == 3) nav.go(TvRoute.Liked) else tab = i }
      }
    }
    when (tab) {
      0 -> {
        val data = rememberLoad("tv-albums") { (0 until 4).flatMap { page -> runCatching { api.albums("recent", page * 60) }.getOrDefault(emptyList()) } }
        TvGrid(data.value.orEmpty(), data.loading) { a: Album -> TvCard(a.title, a.artist, a.artwork, width = 200.dp) { nav.go(TvRoute.Album(a.id)) } }
      }
      1 -> {
        val data = rememberLoad("tv-artists") { (0 until 3).flatMap { page -> runCatching { api.artists(page * 100) }.getOrDefault(emptyList()) } }
        TvGrid(data.value.orEmpty(), data.loading) { a: Artist -> TvCard(a.name, stringResource(R.string.count_songs, a.trackCount), a.artwork, width = 200.dp, round = true, placeholder = FluentIcons.Person) { nav.go(TvRoute.Artist(a.id)) } }
      }
      else -> {
        val data = rememberLoad("tv-playlists-grid") { api.playlists() }
        TvGrid(data.value.orEmpty(), data.loading) { p: Playlist -> TvCard(p.name, stringResource(R.string.count_songs, p.trackCount), if (p.trackCount > 0) p.artwork else null, width = 200.dp, placeholder = FluentIcons.Playlist) { nav.go(TvRoute.Playlist(p.id)) } }
      }
    }
  }
}

@Composable
private fun <T> TvGrid(items: List<T>, loading: Boolean, card: @Composable (T) -> Unit) {
  if (loading && items.isEmpty()) { Loading(); return }
  // About four columns on a 1080p TV (Adaptive counts the padding too).
  LazyVerticalGrid(GridCells.Adaptive(136.dp), contentPadding = PaddingValues(start = 14.dp, end = 14.dp, bottom = 40.dp, top = 12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
    items(items) { card(it) }
  }
}

// ---- search -------------------------------------------------------------------------------

@Composable
private fun TvSearch(nav: TvNav) {
  var query by remember { mutableStateOf("") }
  val api = App.instance.api
  var result by remember { mutableStateOf<com.gharmonize.player.data.SearchResult?>(null) }
  var online by remember { mutableStateOf<com.gharmonize.player.data.OnlineSearchResult?>(null) }
  var mixes by remember { mutableStateOf<com.gharmonize.player.data.ArtistMixes?>(null) }
  var lists by remember { mutableStateOf<List<OnlineItem>>(emptyList()) }
  var onlineLoading by remember { mutableStateOf(false) }
  var history by remember { mutableStateOf<com.gharmonize.player.data.SearchHistory?>(null) }
  val scope = rememberCoroutineScope()
  val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
  val typed = query.trim()
  // Nothing typed yet: the user's search history (shared with the phone and the web).
  LaunchedEffect(typed.length < 2) {
    if (typed.length < 2) history = runCatching { api.searchHistory() }.getOrNull() ?: history
  }
  // A result picked from this search is remembered together with the text.
  fun keepSearch(item: org.json.JSONObject?, text: String? = typed) { scope.launch { runCatching { api.rememberSearch(text, item) } } }
  fun libraryPick(kind: String, id: Long) = { keepSearch(org.json.JSONObject().put("source", "library").put("kind", kind).put("id", id)) }
  fun onlinePick(item: OnlineItem) = { keepSearch(org.json.JSONObject().put("source", "online").put("online", item.raw)) }
  LaunchedEffect(query) {
    val q = query.trim()
    if (q.length < 2) { result = null; online = null; mixes = null; lists = emptyList(); return@LaunchedEffect }
    delay(400)
    result = runCatching { api.search(q) }.getOrNull()
    // Online results follow the library ones (same order as the phone).
    onlineLoading = true
    mixes = null
    lists = emptyList()
    online = runCatching { api.onlineSearch(q) }.getOrNull()
    onlineLoading = false
    coroutineScope {
      launch { lists = runCatching { api.onlinePlaylists(q) }.getOrDefault(emptyList()) }
      launch { mixes = runCatching { api.artistMixes(q, Locale.getDefault().language) }.getOrNull() }
    }
  }
  val r = result
  val playingId = nav.player.current?.mediaId
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 36.dp, end = 36.dp, top = 28.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    item {
      // The remote's Down (or the keyboard's Search key) leaves the field for the results.
      OutlinedTextField(query, { query = it }, singleLine = true, placeholder = { Text(stringResource(R.string.search_hint)) },
        leadingIcon = { Icon(FluentIcons.Search, null) },
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { keepSearch(null); focusManager.moveFocus(androidx.compose.ui.focus.FocusDirection.Down) }),
        modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp).onPreviewKeyEvent { e ->
          if (e.type == KeyEventType.KeyDown && e.key == Key.DirectionDown) focusManager.moveFocus(androidx.compose.ui.focus.FocusDirection.Down) else false
        },
        textStyle = MaterialTheme.typography.titleLarge)
    }
    val h = history
    if (typed.length < 2 && h != null && (h.items.isNotEmpty() || h.queries.isNotEmpty())) {
      if (h.items.isNotEmpty()) item(key = "tv-sh-items") {
        TvRow(stringResource(R.string.search_recent), h.items) { _, pick ->
          // Picking it again moves it to the front.
          val again: (org.json.JSONObject) -> Unit = { keepSearch(it, null) }
          when {
            pick.track != null -> TvCard(pick.track.title, pick.track.artist, pick.track.artwork) {
              again(org.json.JSONObject().put("source", "library").put("kind", "track").put("id", pick.track.id)); nav.play(listOf(pick.track), 0)
            }
            pick.album != null -> TvCard(pick.album.title, pick.album.artist, pick.album.artwork) {
              again(org.json.JSONObject().put("source", "library").put("kind", "album").put("id", pick.album.id)); nav.go(TvRoute.Album(pick.album.id))
            }
            pick.artist != null -> TvCard(pick.artist.name, "", pick.artist.artwork, round = true, placeholder = FluentIcons.Person) {
              again(org.json.JSONObject().put("source", "library").put("kind", "artist").put("id", pick.artist.id)); nav.go(TvRoute.Artist(pick.artist.id))
            }
            pick.online != null -> TvOnlineCard(nav, listOf(pick.online), 0, onPick = { again(org.json.JSONObject().put("source", "online").put("online", pick.online.raw)) })
          }
        }
      }
      // OK searches the text again.
      itemsIndexed(h.queries.take(8), key = { _, text -> "tv-sh-q-$text" }) { _, text ->
        TvFocusable({ query = text }, Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp), scaleOnFocus = 1.01f) {
          Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(FluentIcons.History, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(20.dp))
            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(FluentIcons.ArrowUpLeft, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
      }
      item(key = "tv-sh-clear") {
        Box(Modifier.padding(start = 8.dp, top = 12.dp)) {
          TvButton(stringResource(R.string.search_clear), FluentIcons.Close) {
            history = com.gharmonize.player.data.SearchHistory(emptyList(), emptyList())
            scope.launch { runCatching { api.clearSearchHistory() } }
          }
        }
      }
    }
    if (r != null) {
      if (r.artists.isNotEmpty()) item { TvRow(stringResource(R.string.artists), r.artists) { _, a -> TvCard(a.name, "", a.artwork, round = true, placeholder = FluentIcons.Person) { libraryPick("artist", a.id)(); nav.go(TvRoute.Artist(a.id)) } } }
      if (r.albums.isNotEmpty()) item { TvRow(stringResource(R.string.albums), r.albums) { _, a -> TvCard(a.title, a.artist, a.artwork) { libraryPick("album", a.id)(); nav.go(TvRoute.Album(a.id)) } } }
      if (r.tracks.isNotEmpty()) item { Text(stringResource(R.string.songs), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(start = 8.dp, top = 8.dp, bottom = 6.dp)) }
      itemsIndexed(r.tracks.take(12), key = { i, t -> "$i-${t.id}" }) { i, t -> TvTrackRow(t, null, playingId == "t:${t.id}") { libraryPick("track", t.id)(); nav.play(r.tracks, i) } }
    }
    if (onlineLoading) item { Loading() }
    online?.let { o ->
      val playingTitle = nav.player.current?.mediaMetadata?.title?.toString()
      if (o.tracks.isNotEmpty()) item { TvSectionTitle(stringResource(R.string.search_online)) }
      itemsIndexed(o.tracks.take(10), key = { i, t -> "o-$i-${t.id}" }) { i, t -> TvOnlineTrackRow(t, null, playingTitle == t.title, nav) { onlinePick(t)(); nav.playOnline(o.tracks, i) } }
      mixes?.mixes?.takeIf { it.isNotEmpty() }?.let { m -> item { TvRow(stringResource(R.string.search_mixes, mixes?.artist ?: query), m) { i, x -> TvOnlineCard(nav, m, i, onPick = onlinePick(x)) } } }
      if (o.albums.isNotEmpty()) item { TvRow(stringResource(R.string.albums_online), o.albums) { i, x -> TvOnlineCard(nav, o.albums, i, onPick = onlinePick(x)) } }
      val pls = ((mixes?.playlists ?: emptyList()) + lists).distinctBy { it.key }
      if (pls.isNotEmpty()) item { TvRow(stringResource(R.string.playlists_online), pls) { i, x -> TvOnlineCard(nav, pls, i, onPick = onlinePick(x)) } }
      if (o.artists.isNotEmpty()) item { TvRow(stringResource(R.string.artists_online), o.artists) { i, x -> TvOnlineCard(nav, o.artists, i, onPick = onlinePick(x)) } }
    }
  }
}

// ---- now playing --------------------------------------------------------------------------

@Composable
private fun TvNowPlaying(nav: TvNav) {
  val p = nav.player
  val item = p.current
  var position by remember { mutableLongStateOf(0L) }
  // Synced lyrics need a finer clock than the progress bar.
  LaunchedEffect(item?.mediaId, nav.lyrics) {
    while (true) { position = p.position; delay(if (nav.lyrics) 200 else 500) }
  }
  if (item == null) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text(stringResource(R.string.tv_nothing_playing), style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    return
  }
  val md = item.mediaMetadata
  val extras = md.extras
  val preview = extras?.getBoolean("preview") == true
  val trackId = extras?.getLong("trackId")?.takeIf { it > 0 }
  val duration = p.duration
  val playFocus = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { playFocus.requestFocus() } }
  val seekScope = rememberCoroutineScope()
  val seeker = remember { TvSeeker(p, seekScope) }
  seeker.onSeek = { position = it }
  // No screensaver over the player while music plays.
  val view = androidx.compose.ui.platform.LocalView.current
  DisposableEffect(p.isPlaying) {
    view.keepScreenOn = p.isPlaying
    onDispose { view.keepScreenOn = false }
  }
  val ref = md.artworkUri?.toString()?.let { if (it.startsWith("ghp://artwork/")) it.removePrefix("ghp://artwork/").substringBefore("?") else it }
  androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxSize().padding(horizontal = 40.dp, vertical = 32.dp)) {
    if (nav.lyrics) {
      // Cover, song and controls on the left; the lyrics fill the right.
      val cover = minOf(maxHeight * 0.36f, maxWidth * 0.2f)
      val side = maxWidth * 0.46f
      Row(Modifier.fillMaxSize()) {
        Column(Modifier.width(side).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically)) {
          Artwork(ref, Modifier.size(cover), shape = RoundedCornerShape(20.dp), size = 600)
          Spacer(Modifier.height(4.dp))
          TvSongInfo(md, preview, compact = true)
          TvSeekBar(position, duration, seeker)
          TvControls(nav, playFocus, seeker, compact = true)
        }
        Spacer(Modifier.width(36.dp))
        TvLyricsPanel(trackId, preview, position, duration, Modifier.weight(1f).fillMaxHeight())
      }
    } else {
      // Sized from the screen: the cover takes about 40 % of the width.
      val cover = minOf(maxHeight - 40.dp, maxWidth * 0.4f)
      Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
        Artwork(ref, Modifier.size(cover), shape = RoundedCornerShape(24.dp), size = 600)
        Spacer(Modifier.width(36.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          TvSongInfo(md, preview, compact = false)
          Spacer(Modifier.height(8.dp))
          TvSeekBar(position, duration, seeker)
          Spacer(Modifier.height(4.dp))
          TvControls(nav, playFocus, seeker)
          // Up next
          val upNext = p.queue.drop(p.index + 1).take(3)
          if (upNext.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Text(stringResource(R.string.tv_up_next), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            upNext.forEachIndexed { i, m ->
              TvFocusable({ p.jumpTo(p.index + 1 + i) }, Modifier.fillMaxWidth(), shape = RoundedCornerShape(10.dp), scaleOnFocus = 1.01f) {
                Text("${m.mediaMetadata.title} · ${m.mediaMetadata.artist}", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
              }
            }
          }
        }
      }
    }
  }
}

@Composable
private fun TvSongInfo(md: androidx.media3.common.MediaMetadata, preview: Boolean, compact: Boolean) {
  if (preview) TvTag(stringResource(R.string.tv_preview_tag), FluentIcons.PlayArrow, strong = true)
  Text(md.title?.toString().orEmpty(), style = if (compact) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.headlineLarge,
    fontWeight = FontWeight.Black, maxLines = 2, overflow = TextOverflow.Ellipsis)
  Text(md.artist?.toString().orEmpty(), style = if (compact) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleLarge,
    color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
  if (!compact) Text(md.albumTitle?.toString().orEmpty(), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun TvControls(nav: TvNav, playFocus: FocusRequester, seeker: TvSeeker, compact: Boolean = false) {
  val p = nav.player
  val lyricsFocus = remember { FocusRequester() }
  LaunchedEffect(Unit) { if (nav.focusLyricsButton) { nav.focusLyricsButton = false; runCatching { lyricsFocus.requestFocus() } } }
  Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
    Row(horizontalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 10.dp), verticalAlignment = Alignment.CenterVertically) {
      TvIconButton(FluentIcons.Shuffle, stringResource(R.string.shuffle), active = p.shuffle, compact = compact) { p.toggleShuffle() }
      TvIconButton(FluentIcons.SkipPrevious, stringResource(R.string.previous), compact = compact) { p.previous() }
      Box(Modifier.focusRequester(playFocus)) {
        TvIconButton(if (p.isPlaying) FluentIcons.Pause else FluentIcons.PlayArrow, stringResource(R.string.play), big = true, compact = compact) { p.toggle() }
      }
      TvIconButton(FluentIcons.SkipNext, stringResource(R.string.next), compact = compact) { p.next() }
      TvIconButton(if (p.repeatMode == Player.REPEAT_MODE_ONE) FluentIcons.RepeatOne else FluentIcons.Repeat, stringResource(R.string.repeat), active = p.repeatMode != Player.REPEAT_MODE_OFF, compact = compact) { p.cycleRepeat() }
    }
    // Hold −10 / +10 (or ◀ ▶ on the bar) to keep seeking, faster the longer it is held.
    Row(horizontalArrangement = Arrangement.spacedBy(if (compact) 8.dp else 10.dp), verticalAlignment = Alignment.CenterVertically) {
      TvSeekButton(-1, seeker, compact)
      TvSeekButton(1, seeker, compact)
      if (!compact) Spacer(Modifier.width(4.dp))
      TvButton(stringResource(if (nav.lyrics) R.string.tv_lyrics_hide else R.string.lyrics), FluentIcons.QueueMusic, primary = nav.lyrics, modifier = Modifier.focusRequester(lyricsFocus)) { nav.toggleLyrics() }
    }
  }
}

// ---- settings -----------------------------------------------------------------------------

@Composable
private fun TvSettings(nav: TvNav, onSignOut: () -> Unit) {
  val app = App.instance
  val active by app.servers.active.collectAsState()
  val current = TvTheme.key
  val firstTheme = remember { FocusRequester() }
  LaunchedEffect(Unit) { runCatching { firstTheme.requestFocus() } }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 44.dp, end = 36.dp, top = 36.dp, bottom = 40.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
    item { Text(stringResource(R.string.nav_settings), style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold) }
    // Ready-made themes: dark ones, then light ones.
    item {
      Text(stringResource(R.string.tv_themes), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
      Text(stringResource(R.string.tv_themes_hint), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    for (dark in listOf(true, false)) {
      val group = TV_THEMES.filter { com.gharmonize.player.ui.paletteDef(it.palette).dark == dark }
      item {
        TvRowScroll {
        androidx.compose.foundation.lazy.LazyRow(contentPadding = PaddingValues(vertical = 12.dp, horizontal = 18.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
          itemsIndexed(group) { i, preset ->
            Box(if (dark && i == 0) Modifier.focusRequester(firstTheme) else Modifier) {
              TvThemeTile(preset, preset.key == current) { TvTheme.apply(preset.key, app.prefs) }
            }
          }
        }
        }
      }
    }
    item {
      Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(top = 12.dp)) {
        Text(stringResource(R.string.tv_home_rows), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(stringResource(R.string.tv_home_rows_hint), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TvButton(stringResource(R.string.tv_home_rows), FluentIcons.Home) { nav.go(TvRoute.HomeRows) }
      }
    }
    item {
      Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(top = 12.dp)) {
        Text(stringResource(R.string.tv_account), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("${app.prefs.userJson?.optString("displayName").orEmpty()} · ${app.prefs.serverName}", style = MaterialTheme.typography.titleLarge)
        Text(active ?: stringResource(R.string.settings_not_connected), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(stringResource(R.string.tv_signout_hint), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TvButton(stringResource(R.string.tv_signout), FluentIcons.Close) { onSignOut() }
      }
    }
  }
}
