#!/usr/bin/env bash
# build.sh — packages X-Purge for Chrome Web Store submission
# Usage: bash build.sh
# Output: x-purge-<version>.zip in the current directory

set -e

VERSION=$(node -e "console.log(require('./manifest.json').version)" 2>/dev/null \
          || grep '"version"' manifest.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')

OUT="x-purge-${VERSION}.zip"
DIST=".dist-tmp"

echo "Building X-Purge v${VERSION}..."

# Clean up any previous build artifacts
rm -rf "$DIST" "$OUT"
mkdir -p "$DIST/icons"

# Copy extension source files (exclude dev/repo artifacts)
cp manifest.json \
   content-script.js \
   page-bridge.js \
   overlay.css \
   service-worker.js \
   popup.html \
   popup.js \
   LICENSE \
   README.md \
   "$DIST/"

cp icons/icon16.png icons/icon48.png icons/icon128.png "$DIST/icons/"

# Create the zip from inside the dist directory so there's no top-level folder
(cd "$DIST" && zip -r "../$OUT" . -x "*.DS_Store" -x "Thumbs.db")

# Clean up temp directory
rm -rf "$DIST"

SIZE=$(du -sh "$OUT" | cut -f1)
echo "✓  Created $OUT ($SIZE)"
echo ""
echo "Next steps:"
echo "  1. Go to https://chrome.google.com/webstore/devconsole"
echo "  2. Click 'New item' and upload $OUT"
echo "  3. Fill in the store listing (see README.md § Chrome Web Store)"
