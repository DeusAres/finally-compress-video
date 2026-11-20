# Finally Compress

Comprime i video HEVC HDR / Dolby Vision dell'iPhone **direttamente in Safari**, senza server: il video non lascia mai il telefono.

**App:** https://deusares.github.io/finally-compress-video/

## Cosa fa

- Ricodifica in **HEVC 10-bit HLG**, mantenendo **Dolby Vision** (metadati per frame trapiantati dall'originale), data/ora con fuso, dati della fotocamera.
- Default **8 Mbps**: qualità "quasi identica" (VMAF ≈ 89). Risparmio tipico: −60 % sui 1080p dell'iPhone, ~−90 % sugli originali 4K, meno sui video già leggeri.
- Audio originale copiato senza perdite; opzione per **ridurre l'eco** dei video passati dal comando rapido "Codifica contenuto multimediale".
- Export a segmenti salvati su disco: se l'app viene interrotta **riprende da dove era rimasta**.
- **Continua in Picture-in-Picture**: aperta in Safari, la compressione prosegue anche usando altre app finché la finestrella resta aperta.
- Installabile sulla schermata Home, funziona offline, si aggiorna da sola.

## Come si usa

1. Apri il link in **Safari** (per la PiP serve la scheda di Safari, non l'app installata).
2. Scegli o trascina un video → lascia 8 Mbps → **Comprimi**.
3. Tieni l'app aperta (o attiva la PiP), poi **Salva nelle Foto** → «Salva video».

## Requisiti

iPhone con Safari / iOS 27 (testato su iPhone 17 Pro Max). Velocità ≈ tempo reale per i video a 60 fps (opzione sperimentale "estrazione parallela": ~1,5× in laboratorio).

## Sviluppo

- `index.html` (app), `app/lib/` (pipeline), `app/ui/` (interfaccia pixel art), `sw.js` (offline), `tools/` (laboratorio, diagnostica, script).
- Rilascio: `tools/stamp-version.sh <versione>` → commit → push su `main` (GitHub Pages dalla radice).
- Documentazione di progetto e decisioni: [`docs/BIBBIA.md`](docs/BIBBIA.md); ricerche e misure: [`docs/research/`](docs/research/).
