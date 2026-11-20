#!/usr/bin/env bash
# Builds the demo site into $OUT from a checkout of the app at $APP.
#   APP=/path/to/tab OUT=/path/to/site ./build.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${APP:?path to the tab checkout}" "${OUT:?where to write the site}"
rm -rf "$OUT" && mkdir -p "$OUT"
# 1. The app itself, unchanged, with relative asset paths and the simulated relay's address.
(cd "$APP" && VITE_RELAY='wss://relay.simulated.invalid/' pnpm exec vite build --base=./ --outDir "$OUT/app" --emptyOutDir >/dev/null)
# 2. One added line: the socket shim, loaded before the app.
cp "$HERE/../app/sim-socket.js" "$OUT/app/sim-socket.js"
sed -i 's#<title>#<script src="./sim-socket.js"></script>\n    <title>#' "$OUT/app/index.html"
# 3. The demo page and its script (simulated relay, wallets, and the player).
(cd "$HERE" && node_modules/.bin/vite build --outDir "$OUT" >/dev/null)
cp "$HERE/../index.html" "$HERE/../demo.css" "$OUT/" 2>/dev/null || true
touch "$OUT/.nojekyll"
