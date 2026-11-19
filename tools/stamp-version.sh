#!/usr/bin/env bash
# Rilascio senza CI: GitHub Pages serve i file COMMITTATI ("Deploy from branch main / (root)"), quindi si timbra in locale
# prima del commit. IDEMPOTENTE: ogni esecuzione sostituisce i valori precedenti (non solo i segnaposto) e genera un BUILD_ID nuovo.
#  - ?v=<VER> su import di index.html, app/lib, app/ui (+ anteprime), opfs-worker; titolo "Compressore HDR v<VER>"
#  - BUILD_ID (= <VER>-<UTC aaaammggThhmmssZ>) in index.html e sw.js, version.txt (letto da checkUpdate, mai in cache)
#  - etichetta "v<VER> · gg/mm HH:MM" (ora di Roma) in index.html
#  - sw.js: VERSION + PRECACHE (pagina, moduli raggiungibili da index.html con ?v=, worker, CSS, icone, manifest) + bundle CDN
# Uso: tools/stamp-version.sh 0.19
set -euo pipefail
V=${1:?uso: tools/stamp-version.sh <VER>}; cd "$(dirname "$0")/.."
[[ "$V" =~ ^[0-9][0-9A-Za-z.]*$ ]] || { echo "stamp-version: VER non valida: $V" >&2; exit 1; }
fail() { echo "stamp-version: $*" >&2; exit 1; }
# Un id sempre nuovo: se la stessa secondo ripete l'id precedente, attende.
old=$(cat version.txt 2>/dev/null || true)
while :; do BUILD_ID="$V-$(date -u +%Y%m%dT%H%M%SZ)"; [ "$BUILD_ID" != "$old" ] && break; sleep 1; done
when=$(TZ=Europe/Rome date '+%d/%m %H:%M')
LABEL="v$V · $when"

# 1) ?v=<VER> (sostituisce un ?v= precedente)
sed -i -E "s#(\./app/(lib|ui)/[a-z0-9-]+\.js)(\?v=[^']*)?'#\1?v=$V'#g" index.html
sed -i -E "s#(from '\./[a-z0-9-]+\.js)(\?v=[^']*)?'#\1?v=$V'#g" app/lib/*.js app/ui/*.js app/ui/preview.html app/ui/fun-preview.html
sed -i -E "s#(opfs-worker\.js)(\?v=[^']*)?'#\1?v=$V'#g" app/lib/opfs.js
sed -i -E "s#Compressore HDR v[0-9][0-9A-Za-z.]*#Compressore HDR v$V#g" index.html
# 2) BUILD_ID / etichetta in index.html (le costanti vengono riscritte, qualunque valore avessero)
sed -i -E "s#^(const BUILD_ID = )'[^']*';#\1'$BUILD_ID';#; s#^(const BUILD_LABEL = )'[^']*';#\1'$LABEL';#" index.html
printf '%s\n' "$BUILD_ID" > version.txt
# 3) sw.js: VERSION + liste di precache ricavate da index.html seguendo gli import (come li richiedono le pagine)
BUILD_ID="$BUILD_ID" V="$V" python3 -I - <<'PY'
import os, re, sys
build, v = os.environ['BUILD_ID'], os.environ['V']
def rd(p): return open(p, encoding='utf-8').read()
html = rd('index.html')
seen, order = set(), []
def visit(path, ref):                       # path: file su disco; ref: URL come richiesto (relativo alla radice, con ?v=)
    if path in seen: return
    seen.add(path); order.append(ref)
    if not path.endswith('.js'): return
    src = rd(path); base = os.path.dirname(path)
    for m in re.finditer(r"""(?:from\s+|import\(\s*|new URL\(\s*)'(\./[^'?]+\.js)(?:\?v=[^']*)?'""", src):
        t = os.path.normpath(os.path.join(base, m.group(1)))
        visit(t, t + '?v=' + v)
for m in re.finditer(r"from '\./(app/[^'?]+\.js)\?v=[^']*'", html): visit(m.group(1), m.group(1) + '?v=' + v)
if not seen: sys.exit('stamp-version: nessun modulo in index.html')
css = re.findall(r'<link rel="stylesheet" href="(app/[^"?]+\.css)"', html)
icons = sorted('icons/' + f for f in os.listdir('icons') if f.endswith('.png'))
local = ['./', 'index.html', 'manifest.webmanifest'] + order + css + icons
missing = [p for p in local if p not in ('./',) and not os.path.exists(p.split('?')[0])]
if missing: sys.exit('stamp-version: file di precache mancanti: %s' % missing)
cdn = sorted(set(re.findall(r"from '(https://cdn\.jsdelivr\.net/[^']+)'", html)))
if not cdn: sys.exit('stamp-version: bundle CDN (Mediabunny) non trovato in index.html')
sw = rd('sw.js')
q = lambda l: '[\n' + ''.join("  '%s',\n" % x for x in l) + ']'
sw, n1 = re.subn(r"^const VERSION = '[^']*';", "const VERSION = '%s';" % build, sw, flags=re.M)
sw, n2 = re.subn(r"/\*PRECACHE:BEGIN\*/.*?/\*PRECACHE:END\*/", lambda m: "/*PRECACHE:BEGIN*/const PRECACHE = %s;/*PRECACHE:END*/" % q(local), sw, flags=re.S)
sw, n3 = re.subn(r"/\*CDN:BEGIN\*/.*?/\*CDN:END\*/", lambda m: "/*CDN:BEGIN*/const PRECACHE_CDN = %s;/*CDN:END*/" % q(cdn), sw, flags=re.S)
if (n1, n2, n3) != (1, 1, 1): sys.exit('stamp-version: sw.js: marcatori non trovati %s' % ((n1, n2, n3),))
open('sw.js', 'w', encoding='utf-8').write(sw)
print('precache: %d locali + %d CDN' % (len(local), len(cdn)))
PY
# 4) controlli: fallisce se un pattern non ha trovato nulla
for f in index.html app/ui/preview.html; do grep -q "?v=$V'" "$f" || fail "nessun ?v=$V in $f"; done
grep -q "?v=$V'" app/lib/opfs.js || fail "worker OPFS non timbrato"
grep -q "?v=$V'" app/lib/jobstore.js || fail "import di jobstore.js non timbrati"
grep -q "?v=$V'" app/ui/ui.js || fail "import di ui.js non timbrati"
grep -q "^const BUILD_ID = '$BUILD_ID';" index.html || fail "BUILD_ID non timbrato in index.html"
grep -q "^const BUILD_LABEL = '$LABEL';" index.html || fail "etichetta non timbrata in index.html"
grep -q "<title>Compressore HDR v$V</title>" index.html || fail "titolo non timbrato"
grep -q "^const VERSION = '$BUILD_ID';" sw.js || fail "VERSION non timbrata in sw.js"
[ "$(cat version.txt)" = "$BUILD_ID" ] || fail "version.txt"
grep -q "__BUILD" index.html sw.js && fail "segnaposto rimasti" || true
grep -rhoE "\?v=[^'\"]*['\"]" index.html app --include=*.js --include=*.html | grep -vxF "?v=$V'" | grep -q . && fail "?v= con valore diverso da $V" || true
echo "stamped $BUILD_ID ($LABEL)"
