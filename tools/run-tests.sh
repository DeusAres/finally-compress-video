#!/usr/bin/env bash
# Esegue tutti i test Node del progetto. I test che dipendono da file privati in /tmp saltano da soli (SKIP).
# Uso: tools/run-tests.sh   (exit 0 = tutti passati)
cd "$(dirname "$0")/.." || exit 1
fail=0
run() { echo "== $*"; if "$@" >/tmp/.fcv-test.$$ 2>&1; then tail -n 3 /tmp/.fcv-test.$$; else cat /tmp/.fcv-test.$$; echo "FALLITO: $*"; fail=1; fi; }
run node app/lib/hevc-vui.test.mjs
run node app/lib/dovi.test.mjs
run node app/lib/echo.test.mjs
run node --test app/lib/ratecontrol.test.mjs
run node tools/lab/brctl-test.mjs
rm -f /tmp/.fcv-test.$$
[ $fail = 0 ] && echo "TUTTI I TEST OK" || echo "ALCUNI TEST FALLITI"
exit $fail
