#!/usr/bin/env bash
# Cache-busting: stamps ?v=<VERSION> on every local module import (index.html + app/lib/*.js).
# GitHub Pages caches files ~10 min: without this Safari keeps old modules after a release.
# Usage: tools/stamp-version.sh 0.7.2
set -euo pipefail
V=$1; cd "$(dirname "$0")/.."
sed -i -E "s#(\./app/lib/[a-z0-9-]+\.js)(\?v=[^']*)?'#\1?v=$V'#g" index.html
sed -i -E "s#(from '\./[a-z0-9-]+\.js)(\?v=[^']*)?'#\1?v=$V'#g" app/lib/*.js
sed -i -E "s#Compressore HDR v[0-9.]+#Compressore HDR v$V#g" index.html
grep -c "?v=$V" index.html
