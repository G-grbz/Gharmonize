#!/usr/bin/env bash
# Builds the Gharmonize Player Android APK without any setup by hand:
# finds a suitable JDK and the Android SDK, signs with the release key when
# one is available, and prints where the APK is.
#
#   android/scripts/build-apk.sh            # release APK
#   android/scripts/build-apk.sh --debug    # debug APK
#   android/scripts/build-apk.sh -- --info  # extra arguments go to Gradle
#
# Override what it finds with JAVA_HOME / ANDROID_HOME (or ANDROID_SDK_ROOT,
# or sdk.dir in android/local.properties). Release signing uses, in order:
#   - GHP_KEYSTORE_FILE, GHP_KEYSTORE_PASSWORD, GHP_KEY_ALIAS, GHP_KEY_PASSWORD
#   - ~/.gharmonize/gharmonize-player-release.jks (+ .pass), as created by
#     android/scripts/set-signing-secrets.sh
#   - otherwise the local debug key (an APK signed with another key does not
#     install over the existing app: uninstall it first).
set -euo pipefail

ANDROID_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK=":app:assembleRelease"
VARIANT=release
GRADLE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) TASK=":app:assembleDebug"; VARIANT=debug ;;
    --) shift; GRADLE_ARGS+=("$@"); break ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# ---- JDK: Gradle 8.11 + Kotlin 2.1 run on Java 17 to 23 -----------------------------
MIN_JAVA=17
MAX_JAVA=23
java_major() {
  local out
  out="$("$1/bin/java" -version 2>&1 | head -1)" || return 1
  out="$(sed -E 's/.*version "([0-9]+)(\.([0-9]+))?.*/\1 \3/' <<<"$out")"
  local major="${out%% *}" minor="${out##* }"
  [[ "$major" == 1 ]] && major="$minor"   # "1.8.0" → 8
  [[ "$major" =~ ^[0-9]+$ ]] && echo "$major"
}
usable_jdk() {
  local home="$1" major
  [[ -x "$home/bin/java" && -x "$home/bin/javac" ]] || return 1
  major="$(java_major "$home")" || return 1
  (( major >= MIN_JAVA && major <= MAX_JAVA ))
}
find_jdk() {
  local candidates=()
  [[ -n "${JAVA_HOME:-}" ]] && candidates+=("$JAVA_HOME")
  if [[ -x /usr/libexec/java_home ]]; then # macOS
    for v in 17 21 23; do candidates+=("$(/usr/libexec/java_home -v "$v" 2>/dev/null || true)"); done
  fi
  # Prefer 17, then 21: the versions the project and CI use.
  for v in 17 21 23 22 20 19 18; do
    candidates+=(/usr/lib/jvm/java-"$v"-* /usr/lib/jvm/jdk-"$v"* /usr/lib/jvm/temurin-"$v"* "$HOME"/.jdks/*-"$v"* "$HOME"/.jdks/*"$v".*)
  done
  candidates+=(
    /opt/android-studio/jbr "$HOME/android-studio/jbr" "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    /usr/lib/jvm/* "$HOME"/.jdks/*
  )
  if command -v java >/dev/null 2>&1; then
    candidates+=("$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")")
  fi
  for home in "${candidates[@]}"; do
    [[ -n "$home" && -d "$home" ]] || continue
    if usable_jdk "$home"; then echo "$home"; return 0; fi
  done
  return 1
}
if ! JDK="$(find_jdk)"; then
  echo "No JDK $MIN_JAVA–$MAX_JAVA found. Install JDK 17 (e.g. 'sudo pacman -S jdk17-openjdk'," >&2
  echo "'sudo apt install openjdk-17-jdk', 'brew install openjdk@17') or set JAVA_HOME." >&2
  exit 1
fi
export JAVA_HOME="$JDK"

# ---- Android SDK -------------------------------------------------------------------------
COMPILE_SDK="$(sed -nE 's/^[[:space:]]*compileSdk[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$ANDROID_DIR/app/build.gradle.kts" | head -1)"
local_sdk() { [[ -f "$ANDROID_DIR/local.properties" ]] && sed -nE 's/^sdk\.dir=(.*)$/\1/p' "$ANDROID_DIR/local.properties" | head -1 || true; }
SDK_CANDIDATES=("${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$(local_sdk)" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" /opt/android-sdk /usr/lib/android-sdk)
SDK=""
for dir in "${SDK_CANDIDATES[@]}"; do   # one that already has the platform
  [[ -n "$dir" && -d "$dir/platforms/android-$COMPILE_SDK" ]] && { SDK="$dir"; break; }
done
if [[ -z "$SDK" ]]; then
  for dir in "${SDK_CANDIDATES[@]}"; do  # else any SDK (Gradle may install the rest)
    [[ -n "$dir" && -d "$dir/platforms" ]] && { SDK="$dir"; break; }
  done
fi
if [[ -z "$SDK" ]]; then
  echo "No Android SDK found. Install it (Android Studio, or the command line tools) and set ANDROID_HOME." >&2
  exit 1
fi
[[ -d "$SDK/platforms/android-$COMPILE_SDK" ]] || echo "Note: $SDK has no android-$COMPILE_SDK platform yet; Gradle installs it when the SDK licenses are accepted (sdkmanager --licenses)." >&2
export ANDROID_HOME="$SDK"
unset ANDROID_SDK_ROOT

# ---- Release signing -----------------------------------------------------------------
SIGNED_WITH="debug key"
if [[ "$VARIANT" == release ]]; then
  if [[ -n "${GHP_KEYSTORE_FILE:-}" ]]; then
    SIGNED_WITH="release key ($GHP_KEYSTORE_FILE)"
  elif [[ -f "$HOME/.gharmonize/gharmonize-player-release.jks" && -f "$HOME/.gharmonize/gharmonize-player-release.pass" ]]; then
    export GHP_KEYSTORE_FILE="$HOME/.gharmonize/gharmonize-player-release.jks"
    GHP_KEYSTORE_PASSWORD="$(cat "$HOME/.gharmonize/gharmonize-player-release.pass")"
    export GHP_KEYSTORE_PASSWORD GHP_KEY_PASSWORD="${GHP_KEY_PASSWORD:-$GHP_KEYSTORE_PASSWORD}" GHP_KEY_ALIAS="${GHP_KEY_ALIAS:-gharmonize-player}"
    SIGNED_WITH="release key ($GHP_KEYSTORE_FILE)"
  fi
fi

echo "JDK:      $JAVA_HOME (Java $(java_major "$JAVA_HOME"))"
echo "SDK:      $ANDROID_HOME"
echo "Signing:  $SIGNED_WITH"
cd "$ANDROID_DIR"
./gradlew "$TASK" ${GRADLE_ARGS[@]+"${GRADLE_ARGS[@]}"}

APK="$ANDROID_DIR/app/build/outputs/apk/$VARIANT/app-$VARIANT.apk"
[[ -f "$APK" ]] || { echo "Build finished but $APK is missing." >&2; exit 1; }
echo
echo "APK: $APK"
[[ "$SIGNED_WITH" == "debug key" && "$VARIANT" == release ]] && echo "Signed with the local debug key: it installs over an APK built on this machine, not over a release APK (uninstall that first)."
exit 0
