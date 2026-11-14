package com.gharmonize.player.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import kotlinx.coroutines.launch

@Composable
fun SavePlaylistDialog(state: AppState, trackIds: List<Long>, suggestedName: String = "", onDismiss: () -> Unit, onSaved: (Long) -> Unit = {}) {
  val choices = rememberLoad("playlist-choices") { state.api.playlists().filter { it.editable } }
  var name by rememberSaveable { mutableStateOf(suggestedName) }
  var selected by rememberSaveable { mutableStateOf<Long?>(null) }
  var busy by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  AlertDialog(
    onDismissRequest = { if (!busy) onDismiss() },
    title = { Text(stringResource(if (trackIds.isEmpty()) R.string.create_playlist else R.string.save_to_playlist)) },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(name, { name = it; selected = null }, enabled = !busy, label = { Text(stringResource(R.string.playlist_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        if (trackIds.isNotEmpty()) {
          Text(stringResource(R.string.playlist_existing), style = MaterialTheme.typography.labelMedium)
          LazyColumn(Modifier.heightIn(max = 220.dp)) {
            items(choices.value.orEmpty(), key = { it.id }) { pl ->
              Row(Modifier.fillMaxWidth().clickable(enabled = !busy) { selected = pl.id }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected == pl.id, onClick = { selected = pl.id }, enabled = !busy)
                Text(pl.name, style = MaterialTheme.typography.bodyMedium)
              }
            }
          }
          choices.error?.let { Text(state.errorText(it), color = MaterialTheme.colorScheme.error) }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
      }
    },
    confirmButton = {
      TextButton(enabled = !busy && (selected != null || name.isNotBlank()), onClick = {
        busy = true
        state.scope.launch {
          try {
            val ids = trackIds.filter { it > 0 }.distinct()
            val id = selected ?: state.api.createPlaylist(name.trim(), ids).id
            if (selected != null) state.api.addToPlaylist(id, ids)
            state.messageRes(R.string.playlist_saved)
            onSaved(id); onDismiss()
          } catch (e: Exception) { error = state.errorText(e) }
          busy = false
        }
      }) { Text(stringResource(R.string.save_playlist)) }
    },
    dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
  )
}

@Composable
fun SavePlaylistButton(state: AppState, trackIds: List<Long>, name: String = "") {
  var show by remember { mutableStateOf(false) }
  OutlinedButton(onClick = { show = true }, enabled = trackIds.isNotEmpty()) {
    Icon(FluentIcons.QueueMusic, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(stringResource(R.string.save_to_playlist))
  }
  if (show) SavePlaylistDialog(state, trackIds, name, onDismiss = { show = false })
}

@Composable
fun PlaylistsScreen(state: AppState) {
  Column(Modifier.fillMaxSize()) {
    Text(stringResource(R.string.playlists), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(16.dp))
    PlaylistsTab(state)
  }
}
