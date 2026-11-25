# Finally Compress

Comprime i video HEVC HDR / Dolby Vision dell'iPhone **direttamente in Safari**, senza server: il video non lascia mai il telefono.

**App:** https://deusares.github.io/finally-compress-video/

## Cosa fa

- Ricodifica in **HEVC 10-bit HLG**, mantenendo **Dolby Vision** (metadati per frame trapiantati dall'originale), data/ora con fuso, dati della fotocamera.
- Default **8 Mbps**: qualità "quasi identica" (VMAF ≈ 89). Risparmio tipico: −60 % sui 1080p dell'iPhone, ~−90 % sugli originali 4K, meno sui video già leggeri.
- **Controllo bitrate a circuito chiuso**: il bitrate reale resta entro ~±4 % del target.
- **Veloce**: estrazione parallela a 2 player (~90–100 fps su iPhone); tempo ≈ **0,6× la durata del video** a 60 fps (ripiego automatico a 1 player, ~tempo reale).
- **Previsione** di peso e tempo (appresa dalle esportazioni precedenti) e confronto Previsto/Reale a fine lavoro.
- Audio originale copiato senza perdite; opzione per **ridurre l'eco** dei video passati dal comando rapido "Codifica contenuto multimediale" (filtro v4).
- **Coda di video**: scegli o trascina più video insieme, vengono compressi **uno dopo l'altro** (nell'ordine in cui li aggiungi) con le stesse impostazioni; a fine coda **«Salva tutti nelle Foto»** in un solo gesto.
- Export a segmenti salvati su disco: se l'app viene interrotta **riprende da dove era rimasta** (anche la coda).
- **Continua in Picture-in-Picture**: la compressione prosegue anche usando altre app finché la finestrella resta aperta.
- Suono di fine lavoro; notifica quando l'app è installata.
- Installabile sulla schermata Home, funziona offline, si aggiorna da sola. Interfaccia pixel art, chiara/scura.

## Come si usa

1. Apri il link in **Safari** (per la PiP serve la scheda di Safari, non l'app installata).
2. Scegli o trascina un video → lascia 8 Mbps → **Comprimi**.
3. Per lavorare in altre app: tocca **Continua in Picture-in-Picture** e lascia aperta la finestrella (se la chiudi, l'export si ferma e riprende al rientro).
4. A fine lavoro: **Salva nelle Foto** → «Salva video».

### Più video (coda)

1. In «Scegli il video» seleziona **più video** (o trascinali insieme); con un video già scelto usa **«Aggiungi altri video»**. Prendili dall'app **File** («Scegli file»): da «Libreria foto» iOS consegna copie ricodificate (l'app lo segnala sulla voce).
2. Controlla la lista: per ogni video peso, durata, HDR/Dolby Vision e la previsione; in alto il totale. **Rimuovi** toglie un video; le impostazioni del passo 2 valgono per tutta la coda.
3. **Comprimi N video**: un video alla volta, nell'ordine. Puoi aggiungere altri video anche mentre lavora (vanno in fondo) e salvare quelli già pronti con **Salva nelle Foto** sulla voce. La Picture-in-Picture resta aperta per tutta la coda.
4. Un video che dà errore non ferma la coda (poi puoi toccare **Riprova**). **Annulla questo video** lo salta; **Ferma la coda** si ferma e il video in corso riprende da dove era al prossimo «Comprimi».
5. A fine coda (suono e notifica): **Salva tutti nelle Foto** apre una sola condivisione con tutti i video → «Salva N video». Se il telefono non accetta tutti i file insieme compare un tasto per ciascun video. I video compressi restano nell'app finché li salvi (occupano spazio: salvali man mano se il telefono è pieno, altrimenti la coda si ferma con un avviso).
6. Se Safari si chiude a metà: riapri l'app, la coda è ancora lì; tocca **Riseleziona i video** e scegli di nuovo gli stessi file (si riconoscono da nome, peso e data): il video interrotto riprende dai segmenti già pronti, quelli finiti sono già salvabili.

## Installazione

In Safari: Condividi → **Aggiungi a Home**. Da installata: offline, notifica di fine e aggiornamenti automatici; la Picture-in-Picture non è disponibile (bug WebKit), quindi tieni l'app in primo piano.

## Requisiti

iPhone con Safari / iOS 27 (testato su iPhone 17 Pro Max, Safari 27.0.1). Spazio libero sul telefono per i segmenti temporanei (OPFS).

## Sviluppo

- `index.html` (app), `app/lib/` (pipeline), `app/ui/` (interfaccia pixel art), `sw.js` (offline), `tools/` (laboratorio, diagnostica, script).
- Test Node: `tools/run-tests.sh` (i test con file privati in `/tmp` saltano da soli). Sonde Chromium/Playwright: `tools/lab/lifecycle_probe.mjs` (export singolo), `tools/lab/queue_probe.mjs` (coda).
- Rilascio: `tools/stamp-version.sh <versione>` (timbra `?v=`, `BUILD_ID`, `version.txt` e precache del service worker) → commit → push su `main` (GitHub Pages dalla radice).
- Documentazione di progetto e decisioni: [`docs/BIBBIA.md`](docs/BIBBIA.md); ricerche e misure: [`docs/research/`](docs/research/).
