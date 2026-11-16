plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

// Gharmonize version from the repository's package.json.
val gharmonizeVersion: String = run {
  val pkg = rootProject.file("../package.json")
  val match = Regex("\"version\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"").find(pkg.readText())
    ?: error("No x.y.z version in ${pkg.path}")
  match.groupValues[1]
}

fun versionCodeOf(name: String): Int {
  val (major, minor, patch) = name.split('.').map { it.toInt() }
  require(minor < 1000 && patch < 1000) { "Version $name does not fit the version code scheme" }
  return major * 1_000_000 + minor * 1_000 + patch
}

android {
  namespace = "com.gharmonize.player"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.gharmonize.player"
    minSdk = 26
    targetSdk = 35
    // The app shares Gharmonize's version (package.json): v2.0.1 -> versionName
    // 2.0.1, versionCode 2000001 (major*1e6 + minor*1e3 + patch, so every
    // release installs over the previous one). ghVersionName/ghVersionCode can
    // still override them.
    versionName = (findProperty("ghVersionName") as String?) ?: gharmonizeVersion
    versionCode = (findProperty("ghVersionCode") as String?)?.toInt() ?: versionCodeOf(versionName!!)
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
  testOptions { unitTests.isReturnDefaultValues = true }
  packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

dependencies {
  testImplementation("junit:junit:4.13.2")
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
