#!/usr/bin/env bash
# Stores the Android signing key as GitHub Actions secrets, so the release
# workflow signs every Gharmonize Player APK with the same key (phones only
# accept an update signed like the installed app).
#
#   android/scripts/set-signing-secrets.sh            # dedicated release key
#   android/scripts/set-signing-secrets.sh --debug    # this machine's debug key
#   android/scripts/set-signing-secrets.sh --dry-run  # prepare, upload nothing
#
# Release key: created once in ~/.gharmonize/ (keep a backup — losing it means
# users must reinstall the app). Phones that run an APK built on this machine
# (debug key) need one reinstall when switching to it.
# Debug key: CI builds install over the APKs built here, no reinstall needed.
set -euo pipefail

MODE=release
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --debug) MODE=debug ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

KEYTOOL="${JAVA_HOME:+$JAVA_HOME/bin/}keytool"

if [[ "$MODE" == debug ]]; then
  KEYSTORE="$HOME/.android/debug.keystore"
  STORE_PASS=android
  KEY_PASS=android
  ALIAS=androiddebugkey
  [[ -f "$KEYSTORE" ]] || { echo "No debug keystore at $KEYSTORE (build the app once first)." >&2; exit 1; }
else
  DIR="$HOME/.gharmonize"
  KEYSTORE="$DIR/gharmonize-player-release.jks"
  PASS_FILE="$DIR/gharmonize-player-release.pass"
  ALIAS=gharmonize-player
  mkdir -p "$DIR"
  chmod 700 "$DIR"
  if [[ ! -f "$KEYSTORE" ]]; then
    umask 077
    head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > "$PASS_FILE"
    "$KEYTOOL" -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 \
      -storepass "$(cat "$PASS_FILE")" -keypass "$(cat "$PASS_FILE")" \
      -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
      -dname "CN=Gharmonize Player, O=Gharmonize" >/dev/null
    echo "Created $KEYSTORE (password in $PASS_FILE). Back both up somewhere safe."
  fi
  STORE_PASS="$(cat "$PASS_FILE")"
  KEY_PASS="$STORE_PASS"
fi

"$KEYTOOL" -list -keystore "$KEYSTORE" -storepass "$STORE_PASS" -alias "$ALIAS" -v | grep -E "SHA256:" | head -1

if [[ "$DRY_RUN" == 1 ]]; then
  echo "Dry run: would set ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD."
  exit 0
fi

command -v gh >/dev/null || { echo "GitHub CLI (gh) is required." >&2; exit 1; }
# Values go through stdin, never through the command line.
base64 -w0 "$KEYSTORE" | gh secret set ANDROID_KEYSTORE_BASE64
printf '%s' "$STORE_PASS" | gh secret set ANDROID_KEYSTORE_PASSWORD
printf '%s' "$ALIAS" | gh secret set ANDROID_KEY_ALIAS
printf '%s' "$KEY_PASS" | gh secret set ANDROID_KEY_PASSWORD
echo "Android signing secrets are set for $(gh repo view --json nameWithOwner -q .nameWithOwner)."
