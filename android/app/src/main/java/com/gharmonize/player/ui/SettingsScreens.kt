package com.gharmonize.player.ui

import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.BuildConfig
import com.gharmonize.player.R
import com.gharmonize.player.data.DownloadRow
import kotlinx.coroutines.launch

@Composable
fun DownloadsScreen(state: AppState) {
  LaunchedEffect(Unit) { state.refreshDownloads(); state.startPolling() }
  val rows = state.downloads
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    item { Text(stringResource(R.string.nav_downloads), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(16.dp)) }
    if (!state.canDownload) item { Text(stringResource(R.string.downloads_not_allowed), modifier = Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
    if (rows.isEmpty()) item { EmptyText(stringResource(R.string.downloads_empty)) }
    items(rows, key = { it.id }) { row -> DownloadRowView(state, row) }
  }
}

@Composable
private fun DownloadRowView(state: AppState, row: DownloadRow) {
  Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
    Artwork(row.artworkUrl, Modifier.size(52.dp), size = 128)
    Spacer(Modifier.width(12.dp))
    Column(Modifier.weight(1f)) {
      Text(row.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
      Text(listOfNotNull(row.artist.ifBlank { null }, statusText(row)).joinToString(" · "), style = MaterialTheme.typography.bodySmall,
        color = if (row.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
      if (row.active) LinearProgressIndicator(progress = { row.progress / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
    }
    when {
      row.active -> IconButton(onClick = { state.scope.launch { runCatching { state.api.cancelDownload(row.id) }; state.refreshDownloads() } }) { Icon(FluentIcons.Close, stringResource(R.string.cancel)) }
      row.status == "failed" || row.status == "canceled" -> IconButton(onClick = { state.scope.launch { runCatching { state.api.retryDownload(row.id) }; state.startPolling() } }) { Icon(FluentIcons.Refresh, stringResource(R.string.retry)) }
      row.trackIds.isNotEmpty() -> IconButton(onClick = { state.scope.launch { runCatching { state.api.tracksByIds(row.trackIds) }.onSuccess { state.player.play(it, 0) } } }) { Icon(FluentIcons.PlayArrow, stringResource(R.string.play)) }
    }
  }
}

@Composable
private fun statusText(row: DownloadRow): String = when (row.status) {
  "queued" -> stringResource(R.string.dl_queued)
  "resolving" -> stringResource(R.string.dl_resolving)
  "downloading" -> stringResource(R.string.dl_downloading, row.progress)
  "indexing" -> stringResource(R.string.dl_indexing)
  "completed" -> stringResource(R.string.dl_completed)
  "exists" -> stringResource(R.string.in_library)
  "canceled" -> stringResource(R.string.dl_canceled)
  "failed" -> row.error ?: stringResource(R.string.dl_failed)
  else -> row.status
}

private val QUALITIES = listOf("original", "high", "normal", "low", "saver")

@Composable
fun SettingsScreen(state: AppState, theme: String, onTheme: (String) -> Unit, onSignOut: () -> Unit) {
  val app = state.app
  val active by app.servers.active.collectAsState()
  var wifi by remember { mutableStateOf(app.prefs.qualityWifi) }
  var mobile by remember { mutableStateOf(app.prefs.qualityMobile) }
  var picker by remember { mutableStateOf<String?>(null) }
  var checking by remember { mutableStateOf(false) }
  var confirmSignOut by remember { mutableStateOf(false) }
  val language = remember { com.gharmonize.player.AppLocale.saved(app) }
  val activity = LocalContext.current as? android.app.Activity

  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    item { Text(stringResource(R.string.nav_settings), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(16.dp)) }
    item {
      SettingItem(stringResource(R.string.settings_account), "${state.me?.displayName ?: app.prefs.userJson?.optString("displayName") ?: ""} · ${app.prefs.serverName}")
      HorizontalDivider()
      Text(stringResource(R.string.settings_servers), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 16.dp, top = 12.dp))
    }
    items(app.prefs.servers) { base ->
      Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(base, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        if (base == active) Icon(FluentIcons.CheckCircle, stringResource(R.string.settings_connected), tint = MaterialTheme.colorScheme.primary)
      }
    }
    item {
      Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = {
          checking = true
          app.servers.invalidate()
          state.scope.launch {
            val ok = app.servers.current()
            checking = false
            state.message(ok?.let { state.app.getString(R.string.settings_connected_to, it) } ?: state.app.getString(R.string.error_unreachable))
          }
        }, enabled = !checking) { Text(stringResource(R.string.settings_check)) }
        Text(active?.let { stringResource(R.string.settings_connected_to, it) } ?: stringResource(R.string.settings_not_connected),
          style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      HorizontalDivider(Modifier.padding(top = 8.dp))
      SettingItem(stringResource(R.string.settings_quality_wifi), qualityLabel(wifi)) { picker = "wifi" }
      SettingItem(stringResource(R.string.settings_quality_mobile), qualityLabel(mobile)) { picker = "mobile" }
      SettingItem(stringResource(R.string.settings_theme), themeLabel(theme)) { picker = "theme" }
      SettingItem(stringResource(R.string.settings_language), languageLabel(language), stringResource(R.string.settings_language_hint)) { picker = "language" }
      HorizontalDivider()
      SettingItem(stringResource(R.string.sign_out), stringResource(R.string.sign_out_hint)) { confirmSignOut = true }
      SettingItem(stringResource(R.string.settings_version), BuildConfig.VERSION_NAME)
    }
  }

  picker?.let { which ->
    val options = when (which) { "theme" -> listOf("system", "dark", "light"); "language" -> com.gharmonize.player.AppLocale.CHOICES; else -> QUALITIES }
    val selected = when (which) { "wifi" -> wifi; "mobile" -> mobile; "language" -> language; else -> theme }
    AlertDialog(
      onDismissRequest = { picker = null },
      confirmButton = { TextButton(onClick = { picker = null }) { Text(stringResource(R.string.close)) } },
      title = { Text(stringResource(when (which) { "theme" -> R.string.settings_theme; "language" -> R.string.settings_language; "wifi" -> R.string.settings_quality_wifi; else -> R.string.settings_quality_mobile })) },
      text = {
        Column {
          options.forEach { opt ->
            Row(Modifier.fillMaxWidth().clickable {
              when (which) {
                "wifi" -> { wifi = opt; app.prefs.qualityWifi = opt }
                "mobile" -> { mobile = opt; app.prefs.qualityMobile = opt }
                // New language: texts and content (home, recommendations) follow.
                "language" -> if (opt != language) { com.gharmonize.player.AppLocale.apply(app, opt); activity?.recreate() }
                else -> onTheme(opt)
              }
              picker = null
            }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
              RadioButton(selected = opt == selected, onClick = null)
              Spacer(Modifier.width(8.dp))
              Text(when (which) { "theme" -> themeLabel(opt); "language" -> languageLabel(opt); else -> qualityLabel(opt) })
            }
          }
        }
      },
    )
  }
  if (confirmSignOut) {
    AlertDialog(
      onDismissRequest = { confirmSignOut = false },
      confirmButton = { TextButton(onClick = { confirmSignOut = false; onSignOut() }) { Text(stringResource(R.string.sign_out)) } },
      dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text(stringResource(R.string.cancel)) } },
      title = { Text(stringResource(R.string.sign_out)) },
      text = { Text(stringResource(R.string.sign_out_confirm)) },
    )
  }
}

@Composable
private fun SettingItem(title: String, value: String, hint: String? = null, onClick: (() -> Unit)? = null) {
  Column(Modifier.fillMaxWidth().let { if (onClick != null) it.clickable(onClick = onClick) else it }.padding(horizontal = 16.dp, vertical = 12.dp)) {
    Text(title, style = MaterialTheme.typography.bodyLarge)
    if (value.isNotBlank()) Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (!hint.isNullOrBlank()) Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}

@Composable
private fun languageLabel(code: String): String =
  if (code == com.gharmonize.player.AppLocale.SYSTEM) stringResource(R.string.language_system) else com.gharmonize.player.AppLocale.nativeName(code)

@Composable
private fun qualityLabel(q: String): String = stringResource(
  when (q) {
    "high" -> R.string.quality_high
    "normal" -> R.string.quality_normal
    "low" -> R.string.quality_low
    "saver" -> R.string.quality_saver
    else -> R.string.quality_original
  },
)

@Composable
private fun themeLabel(t: String): String = stringResource(
  when (t) {
    "dark" -> R.string.theme_dark
    "light" -> R.string.theme_light
    else -> R.string.theme_system
  },
)
