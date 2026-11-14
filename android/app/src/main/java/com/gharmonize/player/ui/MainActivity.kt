package com.gharmonize.player.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.PairLink
import com.gharmonize.player.data.PairLinks
import com.gharmonize.player.playback.PlayerController
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  private val pendingLink = mutableStateOf<PairLink?>(null)
  private val resumeTick = androidx.compose.runtime.mutableIntStateOf(0)

  override fun attachBaseContext(newBase: android.content.Context) {
    super.attachBaseContext(com.gharmonize.player.AppLocale.wrap(newBase))
  }

  override fun onResume() {
    super.onResume()
    resumeTick.intValue += 1
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Reopened from recents (or recreated), the activity gets its original
    // intent again: that pairing link was used already.
    val fromHistory = ((intent?.flags ?: 0) and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
    if (savedInstanceState == null && !fromHistory) pendingLink.value = linkFrom(intent)
    if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    setContent { Root(pendingLink.value, resumeTick.intValue) { pendingLink.value = null } }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    linkFrom(intent)?.let { pendingLink.value = it }
  }

  /** gharmonize://pair?link=<encoded pairing link> or a direct pairing http link. */
  private fun linkFrom(intent: Intent?): PairLink? {
    val data = intent?.data ?: return null
    val raw = data.getQueryParameter("link") ?: data.toString()
    return PairLinks.parse(raw)
  }
}

@Composable
private fun Root(link: PairLink?, resumeTick: Int, onLinkUsed: () -> Unit) {
  val app = App.instance
  var theme by remember { mutableStateOf(app.prefs.theme) }
  var signedIn by remember { mutableStateOf(app.prefs.signedIn) }
  val signedOutTick by app.signedOut.collectAsState()
  LaunchedEffect(signedOutTick) { if (signedOutTick > 0) signedIn = false }

  GharmonizeTheme(theme) {
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
      if (!signedIn || link != null) {
        ConnectScreen(link, onLinkFailed = if (signedIn) onLinkUsed else null) {
          onLinkUsed()
          signedIn = true
        }
      } else {
        MainUi(theme, resumeTick, onTheme = { theme = it; app.prefs.theme = it }) {
          app.prefs.signOut()
          signedIn = false
        }
      }
    }
  }
}

@Composable
private fun MainUi(theme: String, resumeTick: Int, onTheme: (String) -> Unit, onSignOut: () -> Unit) {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  val player = remember { PlayerController(context.applicationContext) }
  val state = remember { AppState(context, scope, player) }
  DisposableEffect(Unit) {
    player.connect()
    onDispose { player.release() }
  }
  val activeServer by App.instance.servers.active.collectAsState()
  LaunchedEffect(activeServer) { if (activeServer != null) state.refreshServers() }
  LaunchedEffect(Unit) {
    state.loadMe()
    state.refreshDownloads()
    state.startPolling()
  }
  // Rights can change while the app is in the background (e.g. downloads
  // allowed by an admin): re-read them whenever the app comes back.
  LaunchedEffect(resumeTick) { if (resumeTick > 1) state.loadMe() }
  BackHandler(enabled = state.stack.size > 1) { state.back() }

  val top = state.top
  if (top == Route.NowPlaying) {
    NowPlayingScreen(state)
    return
  }
  if (top is Route.Wrapped) {
    WrappedScreen(state, top.year)
    return
  }
  Scaffold(
    snackbarHost = { SnackbarHost(state.snackbar) },
    bottomBar = {
      Column {
        MiniPlayer(state)
        NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
          val tabs = listOf(
            Triple(Route.Home, FluentIcons.Home, R.string.nav_home),
            Triple(Route.Search, FluentIcons.Search, R.string.nav_search),
            Triple(Route.Library, FluentIcons.LibraryMusic, R.string.nav_library),
            Triple(Route.Downloads, FluentIcons.Download, R.string.nav_downloads),
            Triple(Route.Settings, FluentIcons.Settings, R.string.nav_settings),
          )
          val root = state.stack.first()
          tabs.forEach { (route, icon, label) ->
            NavigationBarItem(
              selected = root == route,
              onClick = { state.navigate(route) },
              icon = { Icon(icon, null) },
              label = { Text(stringResource(label), maxLines = 1) },
            )
          }
        }
      }
    },
  ) { padding ->
    Box(Modifier.padding(padding).fillMaxSize()) {
      when (val r = top) {
        Route.Home -> HomeScreen(state)
        Route.Search -> SearchScreen(state)
        Route.Library -> LibraryScreen(state)
        Route.Playlists -> PlaylistsScreen(state)
        Route.Downloads -> DownloadsScreen(state)
        Route.Settings -> SettingsScreen(state, theme, onTheme) {
          scope.launch {
            state.api.logout()
            onSignOut()
          }
        }
        Route.Liked -> LikedScreen(state)
        is Route.Album -> AlbumScreen(state, r.id)
        is Route.Artist -> ArtistScreen(state, r.id)
        is Route.Playlist -> PlaylistScreen(state, r.id)
        is Route.OnlineAlbum -> OnlineAlbumScreen(state, r.item)
        is Route.OnlineArtist -> OnlineArtistScreen(state, r.id, r.name)
        is Route.Mix -> MixScreen(state, r.id)
        Route.Stats -> StatsScreen(state)
        is Route.Wrapped -> Unit
        Route.NowPlaying -> Unit
      }
    }
  }
}
