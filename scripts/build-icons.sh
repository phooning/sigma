#!/usr/bin/env bash
# build-icons.sh — Generate all Tauri icon assets from public/logo.svg
# Usage: ./build-icons.sh [project-root]
#   project-root defaults to the directory containing this script (or cwd)
#
# Dependencies (one rasterizer required):
#   • rsvg-convert  (librsvg)   — preferred, fastest
#   • inkscape                  — fallback
#   • cairosvg (python)         — last resort
#
# For .ico:  icotool (icoutils) OR python3 Pillow (auto-used if icotool absent)
# For .icns: iconutil (macOS)   OR png2icns (Linux)
set -euo pipefail

SVG="public/logo.svg"
ICONS_DIR="src-tauri/icons"

if [[ ! -f "$SVG" ]]; then
  echo "ERROR: SVG not found at $SVG" >&2
  exit 1
fi

mkdir -p "$ICONS_DIR"

rasterize() {
  local size="$1" out="$2"
  if command -v rsvg-convert &>/dev/null; then
    rsvg-convert -w "$size" -h "$size" "$SVG" -o "$out"
  elif command -v inkscape &>/dev/null; then
    inkscape "$SVG" --export-width="$size" --export-height="$size" \
      --export-filename="$out" 2>/dev/null
  elif command -v cairosvg &>/dev/null; then
    cairosvg "$SVG" -W "$size" -H "$size" -o "$out"
  else
    echo "ERROR: No SVG rasterizer found. Install librsvg2-tools, inkscape, or cairosvg." >&2
    exit 1
  fi
}

echo "→ Rasterizing PNGs..."

rasterize 32   "$ICONS_DIR/32x32.png"
rasterize 128  "$ICONS_DIR/128x128.png"
rasterize 256  "$ICONS_DIR/128x128@2x.png"   # 2× of 128
rasterize 512  "$ICONS_DIR/icon.png"          # master high-res

# Windows Square logos (WinUI / MSIX)
for size in 30 44 71 89 107 142 150 284 310; do
  rasterize "$size" "$ICONS_DIR/Square${size}x${size}Logo.png"
done

# StoreLogo (50×50 per MS Store spec)
rasterize 50 "$ICONS_DIR/StoreLogo.png"

echo "→ Building icon.ico..."

# .ico (multi-resolution)
TMP_ICO="$(mktemp -d)"
trap 'rm -rf "$TMP_ICO"' EXIT

for size in 16 24 32 48 64 128 256; do
  rasterize "$size" "$TMP_ICO/${size}.png"
done

if command -v icotool &>/dev/null; then
  icotool -c \
    "$TMP_ICO/16.png" "$TMP_ICO/24.png" "$TMP_ICO/32.png" \
    "$TMP_ICO/48.png" "$TMP_ICO/64.png" "$TMP_ICO/128.png" "$TMP_ICO/256.png" \
    -o "$ICONS_DIR/icon.ico"
else
  # Fallback: use Python Pillow
  python3 - "$TMP_ICO" "$ICONS_DIR/icon.ico" <<'PYEOF'
import sys, os
from PIL import Image

tmp, out = sys.argv[1], sys.argv[2]
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [Image.open(os.path.join(tmp, f"{s}.png")).convert("RGBA") for s in sizes]
images[0].save(out, format="ICO", sizes=[(s, s) for s in sizes],
               append_images=images[1:])
print(f"  ico written via Pillow → {out}")
PYEOF
fi

echo "→ Building icon.icns..."

# .icns
if [[ "$(uname)" == "Darwin" ]] && command -v iconutil &>/dev/null; then
  # macOS native path
  ICONSET="$TMP_ICO/icon.iconset"
  mkdir -p "$ICONSET"
  declare -A ICNS_SIZES=(
    [icon_16x16.png]=16
    [icon_16x16@2x.png]=32
    [icon_32x32.png]=32
    [icon_32x32@2x.png]=64
    [icon_128x128.png]=128
    [icon_128x128@2x.png]=256
    [icon_256x256.png]=256
    [icon_256x256@2x.png]=512
    [icon_512x512.png]=512
    [icon_512x512@2x.png]=1024
  )
  for name in "${!ICNS_SIZES[@]}"; do
    rasterize "${ICNS_SIZES[$name]}" "$ICONSET/$name"
  done
  iconutil -c icns "$ICONSET" -o "$ICONS_DIR/icon.icns"

elif command -v png2icns &>/dev/null; then
  for size in 16 32 64 128 256 512; do
    rasterize "$size" "$TMP_ICO/icns_${size}.png"
  done
  png2icns "$ICONS_DIR/icon.icns" \
    "$TMP_ICO/icns_16.png"  "$TMP_ICO/icns_32.png"  \
    "$TMP_ICO/icns_64.png"  "$TMP_ICO/icns_128.png" \
    "$TMP_ICO/icns_256.png" "$TMP_ICO/icns_512.png"

else
  # Pure-Python fallback via Pillow (basic ICNS, no compression)
  python3 - "$TMP_ICO" "$ICONS_DIR/icon.icns" <<'PYEOF'
import sys, os, struct
from PIL import Image

tmp, out = sys.argv[1], sys.argv[2]

ICNS_TYPES = [
  (16,  b'icp4'), (32,  b'icp5'), (64,  b'icp6'),
  (128, b'ic07'), (256, b'ic08'), (512, b'ic09'), (1024, b'ic10'),
]

chunks = []
for size, tag in ICNS_TYPES:
  path = os.path.join(tmp, f"{size}.png")
  if not os.path.exists(path):
    img = Image.open(os.path.join(tmp, "256.png")).resize((size, size), Image.LANCZOS)
    img.save(path)
  with open(path, "rb") as f:
    data = f.read()
  chunks.append(tag + struct.pack(">I", len(data) + 8) + data)

body = b"".join(chunks)
with open(out, "wb") as f:
  f.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
print(f"  icns written via Python → {out}")
PYEOF
fi

echo ""
echo "✓ Done. Icons written to: $ICONS_DIR"
echo ""
ls -lh "$ICONS_DIR"
