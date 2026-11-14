package com.gharmonize.player

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.LocaleList
import java.util.Locale

/**
 * In-app language. "system" follows the phone; otherwise the chosen language
 * is used for the app texts (Turkish / English) and for the content language
 * the server is asked for (home shelves, recommendations, moods).
 */
object AppLocale {
  const val SYSTEM = "system"
  val CHOICES = listOf(SYSTEM, "tr", "en", "de", "es", "fr")

  private fun prefs(context: Context) = context.getSharedPreferences("gharmonize_player", Context.MODE_PRIVATE)

  fun saved(context: Context): String = prefs(context).getString("language", SYSTEM)?.takeIf { it in CHOICES } ?: SYSTEM

  fun save(context: Context, code: String) {
    prefs(context).edit().putString("language", code.takeIf { it in CHOICES } ?: SYSTEM).apply()
  }

  fun localeFor(code: String): Locale =
    if (code == SYSTEM) Resources.getSystem().configuration.locales[0] else Locale.forLanguageTag(code)

  /** Context with the saved language, for Application/Activity.attachBaseContext. */
  fun wrap(base: Context): Context {
    val locale = localeFor(saved(base))
    Locale.setDefault(locale)
    val config = Configuration(base.resources.configuration)
    config.setLocales(LocaleList(locale))
    return base.createConfigurationContext(config)
  }

  /** Applies a new choice to the running app (the activity is recreated by the caller). */
  @Suppress("DEPRECATION")
  fun apply(app: Context, code: String) {
    save(app, code)
    val locale = localeFor(code)
    Locale.setDefault(locale)
    val res = app.resources
    val config = Configuration(res.configuration)
    config.setLocales(LocaleList(locale))
    res.updateConfiguration(config, res.displayMetrics)
  }

  /** "Türkçe", "English", "Deutsch"… in their own language. */
  fun nativeName(code: String): String {
    val locale = Locale.forLanguageTag(code)
    return locale.getDisplayLanguage(locale).replaceFirstChar { it.titlecase(locale) }
  }
}
