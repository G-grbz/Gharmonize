#!/usr/bin/env bash
set -euo pipefail

SOURCE_APPIMAGE="${1:?usage: package-appimage-release.sh <source.AppImage> <output.AppImage>}"
OUTPUT_APPIMAGE="${2:?usage: package-appimage-release.sh <source.AppImage> <output.AppImage>}"

APPIMAGETOOL_VERSION="1.9.1"
APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
APPIMAGE_RUNTIME_TAG="20251108"
APPIMAGE_RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"
UPDATE_INFORMATION="${APPIMAGE_UPDATE_INFORMATION:-gh-releases-zsync|G-grbz|Gharmonize|latest|Gharmonize-x86_64.v*.AppImage.zsync}"

for command in curl sha256sum zsyncmake readelf; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

SOURCE_APPIMAGE="$(realpath "$SOURCE_APPIMAGE")"
OUTPUT_APPIMAGE="$(realpath -m "$OUTPUT_APPIMAGE")"
mkdir -p "$(dirname "$OUTPUT_APPIMAGE")"
chmod +x "$SOURCE_APPIMAGE"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

APPIMAGETOOL="$WORK_DIR/appimagetool-x86_64.AppImage"
RUNTIME_FILE="$WORK_DIR/runtime-x86_64"

curl --fail --location --retry 3 --silent --show-error \
  "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-x86_64.AppImage" \
  --output "$APPIMAGETOOL"
printf '%s  %s\n' "$APPIMAGETOOL_SHA256" "$APPIMAGETOOL" | sha256sum --check --strict
chmod +x "$APPIMAGETOOL"

curl --fail --location --retry 3 --silent --show-error \
  "https://github.com/AppImage/type2-runtime/releases/download/${APPIMAGE_RUNTIME_TAG}/runtime-x86_64" \
  --output "$RUNTIME_FILE"
printf '%s  %s\n' "$APPIMAGE_RUNTIME_SHA256" "$RUNTIME_FILE" | sha256sum --check --strict
chmod +x "$RUNTIME_FILE"

mkdir -p "$WORK_DIR/extract"
(
  cd "$WORK_DIR/extract"
  "$SOURCE_APPIMAGE" --appimage-extract >/dev/null
)

test -d "$WORK_DIR/extract/squashfs-root"
rm -f "$OUTPUT_APPIMAGE" "${OUTPUT_APPIMAGE}.zsync"

(
  # appimagetool writes the .zsync file to its working directory.
  cd "$(dirname "$OUTPUT_APPIMAGE")"
  ARCH=x86_64 \
  VERSION="${VERSION:-}" \
  APPIMAGE_EXTRACT_AND_RUN=1 \
    "$APPIMAGETOOL" \
    --updateinformation "$UPDATE_INFORMATION" \
    --runtime-file "$RUNTIME_FILE" \
    "$WORK_DIR/extract/squashfs-root" \
    "$(basename "$OUTPUT_APPIMAGE")"
)

chmod +x "$OUTPUT_APPIMAGE"
test -s "${OUTPUT_APPIMAGE}.zsync"

readelf --string-dump=.upd_info "$OUTPUT_APPIMAGE" | grep -F -- "$UPDATE_INFORMATION" >/dev/null
grep -F -- "Filename: $(basename "$OUTPUT_APPIMAGE")" "${OUTPUT_APPIMAGE}.zsync" >/dev/null

echo "Created updateable AppImage: $OUTPUT_APPIMAGE"
echo "Created zsync metadata: ${OUTPUT_APPIMAGE}.zsync"
