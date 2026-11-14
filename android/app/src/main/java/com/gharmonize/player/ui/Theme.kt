package com.gharmonize.player.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

// Same colours as the classic Gharmonize theme (and the web player):
// navy dark / white light, blue accent, slate-violet secondary.
private val Dark = darkColorScheme(
  primary = Color(0xFF60A5FA),
  onPrimary = Color(0xFF0B1220),
  primaryContainer = Color(0xFF1E3A8A),
  onPrimaryContainer = Color(0xFFDBEAFE),
  secondary = Color(0xFF8B7CF6),
  onSecondary = Color(0xFFFFFFFF),
  secondaryContainer = Color(0xFF1F2A44),
  onSecondaryContainer = Color(0xFFE0E7FF),
  tertiaryContainer = Color(0xFF2E2A5C),
  onTertiaryContainer = Color(0xFFDDD6FE),
  background = Color(0xFF0D1117),
  onBackground = Color(0xFFF4F6FB),
  surface = Color(0xFF111827),
  onSurface = Color(0xFFF4F6FB),
  surfaceVariant = Color(0xFF1F2937),
  onSurfaceVariant = Color(0xFFA6ADBB),
  surfaceContainerLowest = Color(0xFF0B0F15),
  surfaceContainerLow = Color(0xFF111827),
  surfaceContainer = Color(0xFF172133),
  surfaceContainerHigh = Color(0xFF1F2937),
  surfaceContainerHighest = Color(0xFF2B3647),
  outline = Color(0xFF2F3D54),
  outlineVariant = Color(0xFF1F2A3A),
  error = Color(0xFFF87171),
)

private val Light = lightColorScheme(
  primary = Color(0xFF2563EB),
  onPrimary = Color(0xFFFFFFFF),
  primaryContainer = Color(0xFFDBEAFE),
  onPrimaryContainer = Color(0xFF1E3A8A),
  secondary = Color(0xFF6A5ACD),
  onSecondary = Color(0xFFFFFFFF),
  secondaryContainer = Color(0xFFE6E9F5),
  onSecondaryContainer = Color(0xFF1E2A55),
  tertiaryContainer = Color(0xFFEDE9FE),
  onTertiaryContainer = Color(0xFF3B2F7A),
  background = Color(0xFFF7F7FB),
  onBackground = Color(0xFF111317),
  surface = Color(0xFFFFFFFF),
  onSurface = Color(0xFF111317),
  surfaceVariant = Color(0xFFE6E9F5),
  onSurfaceVariant = Color(0xFF5B6170),
  surfaceContainerLowest = Color(0xFFFFFFFF),
  surfaceContainerLow = Color(0xFFF7F7FB),
  surfaceContainer = Color(0xFFF1F2F6),
  surfaceContainerHigh = Color(0xFFE6E9F5),
  surfaceContainerHighest = Color(0xFFD8DCEC),
  outline = Color(0xFFD0D3E0),
  outlineVariant = Color(0xFFE6E7EE),
  error = Color(0xFFDC2626),
)

/** Accent gradient (blue → slate violet) used by the play buttons. */
val AccentGradient = listOf(Color(0xFF8E5AF7), Color(0xFFBB20D4))

@Composable
fun GharmonizeTheme(theme: String, content: @Composable () -> Unit) {
  val dark = when (theme) {
    "dark" -> true
    "light" -> false
    else -> isSystemInDarkTheme()
  }
  MaterialTheme(
    colorScheme = if (dark) Dark else Light,
    shapes = Shapes(small = RoundedCornerShape(6.dp), medium = RoundedCornerShape(10.dp), large = RoundedCornerShape(16.dp)),
    content = content,
  )
}
