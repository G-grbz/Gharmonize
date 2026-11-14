plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "com.gharmonize.player"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.gharmonize.player"
    minSdk = 26
    targetSdk = 35
    // Release builds (CI) pass the Gharmonize version: -PghVersionName=1.4.6
    // -PghVersionCode=1004006. Local builds keep these defaults.
    versionCode = (findProperty("ghVersionCode") as String?)?.toInt() ?: 11
    versionName = (findProperty("ghVersionName") as String?) ?: "0.4.6"
  }

  // A stable release key lets every new APK install over the previous one.
  // CI provides it through these environment variables (GitHub secrets);
  // without them the release build is signed with the local debug key.
  val releaseKeystore = System.getenv("GHP_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
  signingConfigs {
    if (releaseKeystore != null) {
      create("release") {
        storeFile = file(releaseKeystore)
        storePassword = System.getenv("GHP_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("GHP_KEY_ALIAS")
        keyPassword = System.getenv("GHP_KEY_PASSWORD")
      }
    }
  }

  androidResources {
    localeFilters += listOf("en", "tr")
  }

  buildTypes {
    getByName("release") {
      isMinifyEnabled = false
      signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures { compose = true; buildConfig = true }
  packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

dependencies {
  val media3 = "1.10.1"
  implementation(platform("androidx.compose:compose-bom:2025.04.01"))
  implementation("androidx.activity:activity-compose:1.10.1")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.foundation:foundation")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.material:material-icons-extended")
  implementation("androidx.core:core-ktx:1.16.0")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-guava:1.10.2")
  implementation("androidx.media3:media3-exoplayer:$media3")
  implementation("androidx.media3:media3-session:$media3")
  implementation("androidx.media3:media3-datasource:$media3")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
