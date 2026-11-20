package com.gharmonize.player.ui

import androidx.compose.foundation.clickable
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.data.ReleaseNotifier
import com.gharmonize.player.data.parseOnline

/** New releases of followed artists; opening the list marks them read. */
@Composable
fun NotificationsScreen(state: AppState) {
  val data = rememberLoad("notifications") { ReleaseNotifier.check(state.app).first }
  LaunchedEffect(data.value) {
    if (data.value?.any { !it.read } == true) {
      runCatching { state.api.markNotificationsRead() }
      state.unreadNotifications = 0
    }
  }
  LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
    item { Text(stringResource(R.string.notif_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(16.dp)) }
    data.error?.let { e -> item { ErrorBox(state.errorText(e)) { data.reload() } } }
    val list = data.value
    if (list == null) { if (data.loading) item { Loading() }; return@LazyColumn }
    if (list.isEmpty()) item { EmptyText(stringResource(R.string.notif_empty)) }
    items(list, key = { it.id }) { n ->
      Row(
        Modifier.fillMaxWidth().clickable { n.data?.let { state.navigate(Route.OnlineAlbum(parseOnline(it))) } }.padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Artwork(n.artworkUrl, Modifier.size(56.dp), size = 128, placeholder = FluentIcons.Album)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
          Text(n.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (n.read) FontWeight.Normal else FontWeight.Bold)
          Text("${n.body} · ${stringResource(if (n.single) R.string.notif_new_single else R.string.notif_new_album)}",
            maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
      }
    }
  }
}
