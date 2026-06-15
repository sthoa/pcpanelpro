#!/bin/bash
# Builds the macOS app icon (build/icon.icns) from the vector source
# build/icon-source.svg. The SVG is rendered once at 1024x1024 via Quick Look,
# then downscaled into a full iconset so every resolution is crisp (no upscaling
# from a tiny bitmap).
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"
SVG="$SCRIPT_DIR/icon-source.svg"
MASTER="$BUILD_DIR/icon-1024.png"
ICONSET="$BUILD_DIR/icon.iconset"

if [ ! -f "$SVG" ]; then
  echo "error: $SVG not found" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

# Render the SVG to a 1024x1024 master PNG using Quick Look.
rm -f "$BUILD_DIR/icon-source.svg.png" "$MASTER"
qlmanage -t -s 1024 "$SVG" -o "$BUILD_DIR" >/dev/null 2>&1
mv "$BUILD_DIR/icon-source.svg.png" "$MASTER"

# Generate every size the iconset needs by downscaling the master.
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
gen() { sips -z "$1" "$1" "$MASTER" --out "$ICONSET/$2" >/dev/null 2>&1; }
gen 16   icon_16x16.png
gen 32   icon_16x16@2x.png
gen 32   icon_32x32.png
gen 64   icon_32x32@2x.png
gen 128  icon_128x128.png
gen 256  icon_128x128@2x.png
gen 256  icon_256x256.png
gen 512  icon_256x256@2x.png
gen 512  icon_512x512.png
cp "$MASTER" "$ICONSET/icon_512x512@2x.png"

iconutil -c icns "$ICONSET" -o "$BUILD_DIR/icon.icns"
rm -rf "$ICONSET"

echo "Created build/icon.icns from icon-source.svg"
