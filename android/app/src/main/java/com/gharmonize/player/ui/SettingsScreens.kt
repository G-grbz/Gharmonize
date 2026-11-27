package com.gharmonize.player.ui

import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
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
import com.gharmonize.player.data.DownloadGroup
import com.gharmonize.player.data.DownloadRow
import kotlinx.coroutines.launch

@Composable
fun DownloadsScreen(state: AppState) {
  LaunchedEffect(Unit) { state.refreshDownloads(); state.startPolling() }
  // Songs of a group are shown inside its entry, not on their own.
  val rows = state.downloads.filter { it.groupId == null }
  val groups = state.downloadGroups
  val expanded = remember { androidx.compose.runtime.mutableStateMapOf<String, List<DownloadRow>?>() }
  // An open group's song list follows the live rows.
  val live = state.downloads.filter { it.groupId != null }.associateBy { it.id }
  LaunchedEffect(groups) {
    for (id in expanded.keys.toList()) runCatching { state.api.groupSongs(id) }.getOrNull()?.let { expanded[id] = it }
  }
  val entries = (groups.map { it.createdAt to (it as Any) } + rows.map { it.createdAt to (it as Any) })
  val active = entries.filter { (_, e) -> if (e is DownloadGroup) e.active else (e as DownloadRow).active }.sortedByDescending { it.first }.map { it.second }
  val done = entries.filter { (_, e) -> if (e is DownloadGroup) !e.active else !(e as DownloadRow).active }.sortedByDescending { it.first }.map { it.second }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    item { Text(stringResource(R.string.nav_downloads), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(16.dp)) }
    if (!state.canDownload) item { Text(stringResource(R.string.downloads_not_allowed), modifier = Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
    if (entries.isEmpty()) item { EmptyText(stringResource(R.string.downloads_empty)) }
    for ((title, list) in listOf(R.string.downloads_active to active, R.string.downloads_history to done)) {
      if (list.isEmpty()) continue
      item(key = "h-$title") {
        Text(stringResource(title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp))
      }
      items(list, key = { e -> if (e is DownloadGroup) "g-${e.id}" else "d-${(e as DownloadRow).id}" }) { e ->
        if (e is DownloadGroup) {
          val songs = expanded[e.id]?.map { live[it.id] ?: it }
          DownloadGroupView(state, e, open = e.id in expanded, songs = songs, onToggle = {
            if (e.id in expanded) expanded.remove(e.id)
            else {
              expanded[e.id] = null
              state.scope.launch { expanded[e.id] = runCatching { state.api.groupSongs(e.id) }.getOrDefault(emptyList()) }
            }
          })
        } else DownloadRowView(state, e as DownloadRow)
      }
    }
  }
}

@Composable
private fun DownloadRowView(state: AppState, row: DownloadRow, child: Boolean = false) {
  Row(Modifier.fillMaxWidth().padding(horizontal = if (child) 8.dp else 16.dp, vertical = if (child) 4.dp else 8.dp), verticalAlignment = Alignment.CenterVertically) {
    if (!child) {
      Artwork(row.artworkUrl, Modifier.size(52.dp), size = 128)
      Spacer(Modifier.width(12.dp))
    }
    Column(Modifier.weight(1f)) {
      Text(row.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (child) FontWeight.Normal else FontWeight.SemiBold)
      Text(listOfNotNull(row.artist.ifBlank { null }, statusText(row)).joinToString(" · "), style = MaterialTheme.typography.bodySmall,
        color = if (row.status == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
      stepsText(row)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
      if (row.active && !child) LinearProgressIndicator(progress = { row.progress / 100f }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
    }
    when {
      row.active -> IconButton(onClick = { state.scope.launch { runCatching { state.api.cancelDownload(row.id) }; state.refreshDownloads() } }) { Icon(FluentIcons.Close, stringResource(R.string.cancel)) }
      row.status == "failed" || row.status == "canceled" -> IconButton(onClick = { state.scope.launch { runCatching { state.api.retryDownload(row.id) }; state.startPolling() } }) { Icon(FluentIcons.Refresh, stringResource(R.string.retry)) }
      row.trackIds.isNotEmpty() -> IconButton(onClick = { state.scope.launch { runCatching { state.api.tracksByIds(row.trackIds) }.onSuccess { state.player.play(it, 0, downloadsOnly = true) } } }) { Icon(FluentIcons.PlayArrow, stringResource(R.string.play)) }
    }
  }
}

/** Songs picked together: what downloads now, how many are done / left, its songs behind a toggle. */
@Composable
private fun DownloadGroupView(state: AppState, group: DownloadGroup, open: Boolean, songs: List<DownloadRow>?, onToggle: () -> Unit) {
  val c = group.counts
  val name = group.title ?: stringResource(R.string.group_untitled)
  val parts = listOfNotNull(
    stringResource(R.string.group_done_of, c.done, c.total),
    if (c.running > 0) stringResource(R.string.group_running, c.running) else null,
    if (c.queued > 0) stringResource(R.string.group_queued_n, c.queued) else null,
    if (c.waiting > 0) stringResource(R.string.group_waiting, c.waiting) else null,
    if (c.failed > 0) stringResource(R.string.group_failed, c.failed) else null,
    if (c.canceled > 0) stringResource(R.string.group_canceled, c.canceled) else null,
    if (c.skipped > 0) stringResource(R.string.group_skipped, c.skipped) else null,
  )
  Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Artwork(group.artworkUrl, Modifier.size(52.dp), size = 128)
      Spacer(Modifier.width(12.dp))
      Column(Modifier.weight(1f)) {
        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
        Text(stringResource(R.string.group_songs, c.total) + " · " + parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall,
          color = if (!group.active && c.failed > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3)
      }
      when {
        group.active -> IconButton(onClick = { state.cancelDownloadGroup(group.id) }) { Icon(FluentIcons.Close, stringResource(R.string.group_cancel_all)) }
        c.failed > 0 || c.canceled > 0 -> IconButton(onClick = { state.retryDownloadGroup(group.id) }) { Icon(FluentIcons.Refresh, stringResource(R.string.group_retry_failed)) }
      }
    }
    group.current?.let { cur ->
      Text(stringResource(R.string.group_now, listOf(cur.title, cur.artist).filter { it.isNotBlank() }.joinToString(" — ")) + " · " +
        phaseText(cur.status, cur.phase, cur.progress),
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, maxLines = 2, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(top = 6.dp))
    }
    if (group.active) LinearProgressIndicator(progress = { (group.progress / 100f).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
    if (!group.active && group.errors.isNotEmpty()) {
      for (e in group.errors.take(3)) Text(e, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    TextButton(onClick = onToggle, contentPadding = PaddingValues(horizontal = 0.dp)) {
      Icon(FluentIcons.KeyboardArrowDown, null, modifier = Modifier.size(18.dp).rotate(if (open) 180f else 0f))
      Spacer(Modifier.width(4.dp))
      Text(if (open) stringResource(R.string.group_hide_songs) else stringResource(R.string.group_show_songs, c.total))
    }
    if (open) {
      Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))) {
        when {
          songs == null -> Text("…", modifier = Modifier.padding(12.dp))
          songs.isEmpty() -> Text(stringResource(if (c.waiting > 0) R.string.group_all_waiting else R.string.group_no_songs), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp))
          // The running ones first, then the queue in its order.
          else -> songs.sortedWith(compareBy({ CHILD_RANK[it.status] ?: 3 }, { it.createdAt })).take(200).forEach { DownloadRowView(state, it, child = true) }
        }
      }
    }
  }
}

private val CHILD_RANK = mapOf("downloading" to 0, "indexing" to 0, "resolving" to 1, "queued" to 2)

/** "Song 5 of 12 · converting" for album / playlist jobs. */
@Composable
private fun stepsText(row: DownloadRow): String? {
  val s = row.steps ?: return null
  if (!row.active) return null
  return when {
    row.phase == "converting" -> stringResource(R.string.steps_converting, minOf(s.total, s.converted + 1), s.total)
    s.downloaded >= s.total -> stringResource(R.string.steps_downloaded, s.total)
    else -> stringResource(R.string.steps_downloading, minOf(s.total, s.downloaded + 1), s.total, s.downloaded)
  }
}

@Composable
private fun phaseText(status: String, phase: String?, progress: Int): String = when {
  status == "downloading" && phase == "converting" -> stringResource(R.string.dl_converting, progress)
  status == "downloading" && phase == "preparing" -> stringResource(R.string.dl_preparing)
  status == "downloading" -> stringResource(R.string.dl_downloading, progress)
  status == "resolving" -> stringResource(R.string.dl_resolving)
  status == "indexing" -> stringResource(R.string.dl_indexing)
  else -> stringResource(R.string.dl_queued)
}

@Composable
fun statusText(row: DownloadRow): String = when (row.status) {
  "queued" -> stringResource(if (row.waiting) R.string.group_waiting_song else R.string.dl_queued)
  "downloading" -> phaseText(row.status, row.phase, row.progress)
  "resolving" -> stringResource(R.string.dl_resolving)
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
  var offlineQ by remember { mutableStateOf(app.prefs.offlineQuality) }
  var crossfade by remember { mutableStateOf(app.prefs.crossfadeSeconds) }
  var offlineWifi by remember { mutableStateOf(app.prefs.offlineWifiOnly) }
  var releaseAuto by remember { mutableStateOf<Boolean?>(null) }
  androidx.compose.runtime.LaunchedEffect(Unit) { releaseAuto = runCatching { app.api.releaseSettings().optBoolean("autoDownload") }.getOrNull() }
  var progress by remember { mutableStateOf(app.prefs.progressStyle) }
  var coverVolume by remember { mutableStateOf(app.prefs.coverVolume) }
  var autoplay by remember { mutableStateOf(app.prefs.autoplay) }
  var picker by remember { mutableStateOf<String?>(null) }
  var checking by remember { mutableStateOf(false) }
  var confirmSignOut by remember { mutableStateOf(false) }
  val language = remember { com.gharmonize.player.AppLocale.saved(app) }
  val activity = LocalContext.current as? android.app.Activity
  val isDark = when (theme) { "dark" -> true; "light" -> false; else -> androidx.compose.foundation.isSystemInDarkTheme() }

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
      SettingItem(stringResource(R.string.settings_crossfade), if (crossfade > 0) stringResource(R.string.crossfade_seconds, crossfade) else stringResource(R.string.crossfade_off)) { picker = "crossfade" }
      // Sign a Google TV in to this account by scanning its QR code.
      TvLinkItem(state)
      // New releases of followed artists: download them automatically.
      val auto = releaseAuto
      if (auto != null && state.canDownload) {
        Row(Modifier.fillMaxWidth().clickable {
          releaseAuto = !auto
          state.scope.launch { runCatching { app.api.setReleaseAutoDownload(!auto) } }
        }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
          Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.notif_auto), style = MaterialTheme.typography.bodyLarge)
            Text(stringResource(R.string.notif_auto_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
          androidx.compose.material3.Switch(checked = auto, onCheckedChange = { v -> releaseAuto = v; state.scope.launch { runCatching { app.api.setReleaseAutoDownload(v) } } })
        }
      }
      // Songs saved on the phone.
      SettingItem(stringResource(R.string.offline_title), stringResource(R.string.offline_settings_hint)) { state.navigate(Route.Offline) }
      SettingItem(stringResource(R.string.settings_offline_quality), qualityLabel(offlineQ)) { picker = "offline" }
      Row(Modifier.fillMaxWidth().clickable { offlineWifi = !offlineWifi; com.gharmonize.player.playback.Offline.setWifiOnly(offlineWifi) }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(stringResource(R.string.settings_offline_wifi), style = MaterialTheme.typography.bodyLarge)
          Text(stringResource(R.string.settings_offline_wifi_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        androidx.compose.material3.Switch(checked = offlineWifi, onCheckedChange = { offlineWifi = it; com.gharmonize.player.playback.Offline.setWifiOnly(it) })
      }
      SettingItem(stringResource(R.string.equalizer), stringResource(if (com.gharmonize.player.playback.AudioEq.params.enabled) R.string.eq_on else R.string.eq_off)) { state.navigate(Route.Equalizer) }
      SettingItem(stringResource(R.string.settings_progress), progressLabel(progress)) { picker = "progress" }
      // The volume arc only exists around the ring: other styles don't offer it.
      if ((progress.takeIf { it in PROGRESS_STYLES } ?: "ring") == "ring") Row(Modifier.fillMaxWidth().clickable { coverVolume = !coverVolume; app.prefs.coverVolume = coverVolume }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(stringResource(R.string.settings_cover_volume), style = MaterialTheme.typography.bodyLarge)
          Text(stringResource(R.string.settings_cover_volume_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        androidx.compose.material3.Switch(checked = coverVolume, onCheckedChange = { coverVolume = it; app.prefs.coverVolume = it })
      }
      Row(Modifier.fillMaxWidth().clickable { autoplay = !autoplay; app.prefs.autoplay = autoplay }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
          Text(stringResource(R.string.settings_autoplay), style = MaterialTheme.typography.bodyLarge)
          Text(stringResource(R.string.settings_autoplay_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        androidx.compose.material3.Switch(checked = autoplay, onCheckedChange = { autoplay = it; app.prefs.autoplay = it })
      }
      SettingItem(stringResource(R.string.settings_theme), themeLabel(theme)) { picker = "theme" }
      SwatchRow(stringResource(R.string.settings_palette), stringResource(R.string.settings_palette_hint),
        PALETTES.map { Swatch(it.key, paletteLabel(it.key), listOf(it.bg, it.s4), square = true) }, Appearance.paletteFor(isDark)) { key ->
        Appearance.pick(app.prefs, key)
        // Picking a colour also picks its dark / light base.
        onTheme(if (paletteDef(key).dark) "dark" else "light")
      }
      SwatchRow(stringResource(R.string.settings_accent), stringResource(R.string.settings_accent_hint),
        ACCENTS.map { Swatch(it.key, accentLabel(it.key), listOf(it.dark, it.dark2)) }, Appearance.accent) { key ->
        Appearance.accent = key; app.prefs.accent = key
      }
      SettingItem(stringResource(R.string.settings_language), languageLabel(language), stringResource(R.string.settings_language_hint)) { picker = "language" }
      HorizontalDivider()
      SettingItem(stringResource(R.string.sign_out), stringResource(R.string.sign_out_hint)) { confirmSignOut = true }
      SettingItem(stringResource(R.string.settings_version), BuildConfig.VERSION_NAME)
    }
  }

  picker?.let { which ->
    val options = when (which) { "theme" -> listOf("system", "dark", "light"); "language" -> com.gharmonize.player.AppLocale.CHOICES; "progress" -> PROGRESS_STYLES; "crossfade" -> listOf("0", "2", "4", "6", "8", "12"); else -> QUALITIES }
    val selected = when (which) { "wifi" -> wifi; "mobile" -> mobile; "offline" -> offlineQ; "crossfade" -> crossfade.toString(); "language" -> language; "progress" -> progress; else -> theme }
    AlertDialog(
      onDismissRequest = { picker = null },
      confirmButton = { TextButton(onClick = { picker = null }) { Text(stringResource(R.string.close)) } },
      title = { Text(stringResource(when (which) { "theme" -> R.string.settings_theme; "progress" -> R.string.settings_progress; "language" -> R.string.settings_language; "wifi" -> R.string.settings_quality_wifi; "offline" -> R.string.settings_offline_quality; "crossfade" -> R.string.settings_crossfade; else -> R.string.settings_quality_mobile })) },
      text = {
        Column(Modifier.verticalScroll(rememberScrollState())) {
          options.forEach { opt ->
            Row(Modifier.fillMaxWidth().clickable {
              when (which) {
                "wifi" -> { wifi = opt; app.prefs.qualityWifi = opt }
                "mobile" -> { mobile = opt; app.prefs.qualityMobile = opt }
                "offline" -> { offlineQ = opt; app.prefs.offlineQuality = opt }
                "crossfade" -> { crossfade = opt.toInt(); app.prefs.crossfadeSeconds = crossfade }
                "progress" -> { progress = opt; app.prefs.progressStyle = opt }
                // New language: texts and content (home, recommendations) follow.
                "language" -> if (opt != language) { com.gharmonize.player.AppLocale.apply(app, opt); activity?.recreate() }
                else -> onTheme(opt)
              }
              picker = null
            }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
              RadioButton(selected = opt == selected, onClick = null)
              Spacer(Modifier.width(8.dp))
              Text(when (which) { "theme" -> themeLabel(opt); "language" -> languageLabel(opt); "progress" -> progressLabel(opt); "crossfade" -> if (opt == "0") stringResource(R.string.crossfade_off) else stringResource(R.string.crossfade_seconds, opt.toInt()); else -> qualityLabel(opt) })
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

private class Swatch(val key: String, val label: String, val colors: List<Color>, val square: Boolean = false)

/** A row of colour choices (player colour / accent), name of the current one below the title. */
@Composable
private fun SwatchRow(title: String, hint: String, swatches: List<Swatch>, selected: String, onPick: (String) -> Unit) {
  val current = swatches.firstOrNull { it.key == selected } ?: swatches.first()
  Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
    Text(title, style = MaterialTheme.typography.bodyLarge)
    Text(current.label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      swatches.forEach { sw ->
        val on = sw.key == current.key
        val shape = if (sw.square) RoundedCornerShape(12.dp) else CircleShape
        Box(
          Modifier.size(44.dp)
            .border(2.dp, if (on) MaterialTheme.colorScheme.onSurface else Color.Transparent, shape)
            .padding(4.dp).clip(shape)
            .background(Brush.linearGradient(sw.colors))
            .border(1.dp, MaterialTheme.colorScheme.outline, shape)
            .clickable(onClickLabel = sw.label) { onPick(sw.key) }
            .semantics { contentDescription = sw.label; this.selected = on },
          contentAlignment = Alignment.Center,
        ) {
          if (on) Icon(FluentIcons.CheckCircle, null, tint = if (sw.square) MaterialTheme.colorScheme.primary else Color.White, modifier = Modifier.size(18.dp))
        }
      }
    }
  }
}

@Composable
private fun accentLabel(key: String): String = stringResource(when (key) {
  "violet" -> R.string.accent_violet; "ocean" -> R.string.accent_ocean; "moss" -> R.string.accent_moss
  "amber" -> R.string.accent_amber; "rose" -> R.string.accent_rose; "indigo" -> R.string.accent_indigo
  "coral" -> R.string.accent_coral; "fuchsia" -> R.string.accent_fuchsia; "silver" -> R.string.accent_silver
  else -> R.string.accent_blue
})

@Composable
private fun paletteLabel(key: String): String = stringResource(when (key) {
  "oled" -> R.string.palette_oled; "deepsea" -> R.string.palette_deepsea
  "forest" -> R.string.palette_forest; "plum" -> R.string.palette_plum
  "light" -> R.string.palette_light; "mist" -> R.string.palette_mist; "sky" -> R.string.palette_sky
  "mint" -> R.string.palette_mint; "lilac" -> R.string.palette_lilac
  else -> R.string.palette_navy
})

@Composable
fun SettingItem(title: String, value: String, hint: String? = null, onClick: (() -> Unit)? = null) {
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
private fun progressLabel(style: String): String = stringResource(
  when (style) {
    "classic" -> R.string.progress_classic
    "bold" -> R.string.progress_bold
    "minimal" -> R.string.progress_minimal
    "wave" -> R.string.progress_wave
    "segments" -> R.string.progress_segments
    "dots" -> R.string.progress_dots
    "gradient" -> R.string.progress_gradient
    "needle" -> R.string.progress_needle
    "ribbon" -> R.string.progress_ribbon
    else -> R.string.progress_ring
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
