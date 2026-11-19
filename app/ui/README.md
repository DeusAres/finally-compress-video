# app/ui — interfaccia pixel art

Tema "Pressa a 16 colori": palette Sweetie 16, bordi pixel con angoli smussati e ombre a gradini (solo `box-shadow`, nessuna immagine), sprite SVG generati da stringhe, cifre grandi in VT323, titoli in Silkscreen, testo lungo in Atkinson Hyperlegible.

| File | Ruolo |
|---|---|
| `theme.css` | design token (`--px-*`, ruoli semantici, chiaro/scuro) + classi base `.px-*` |
| `bus.js` | bus eventi app → UI / fun.js |
| `ui.js` | `mountUI(root, handlers, opts?)` |
| `ui.css` | layout dell'app (prefisso `.fcv-`), caricato da `ui.js` se manca |
| `sprite.js` | `sprite(rows, {scale, title, className})` → `<svg>` + `SPRITES` condivisi |
| `preview.html` | demo standalone che simula il bus (`?state=pick|ready|busy|done|error&theme=light|dark&shot=1`) |

## Uso nell'app

```js
import { mountUI } from './app/ui/ui.js';
import { emit } from './app/ui/bus.js';
const ui = mountUI(document.getElementById('app'), {
  onFile(file) {},            // File scelto (l'app poi emette 'file' con i metadati)
  onStart(settings) {},       // {bitrateMbps, keyframeS, audioMode}
  onCancel() {},              // l'app interrompe e chiama ui.setBusy(false)
  onSave() {},                // chiamato SINCRONO nel tap → navigator.share() funziona
  onCopyLog() {},             // facoltativo: se assente la UI copia da sola il log mostrato
}, { version: 'v0.15' });    // opts facoltativo (estensione)
ui.setDefaults({ bitrateMbps: 8, keyframeS: 4, audioMode: 'copy' });
ui.setBusy(true); /* … export … */ ui.setBusy(false);
```

`index.html` può linkare `theme.css` e `ui.css` nel `<head>` per evitare il flash; altrimenti `mountUI` li aggiunge.

Valori: `bitrateMbps` ∈ 4,6,8,10,12,14 (8 consigliato) · `keyframeS` ∈ 1,4,10 · `audioMode` ∈ `copy`,`v4`,`v3`,`v2`,`v1`,`reenc`.

### Ritorno di `mountUI`
- `setBusy(bool)` — contratto. `true` mostra il pannello di avanzamento e blocca i controlli; `false` senza `result`/`error` ⇒ torna al passo 2 ("annullato").
- `setDefaults(settings)` — contratto (accetta anche un oggetto parziale).
- Estensioni: `getSettings()`, `setSaveMessage(text)` (sotto "Salva nelle Foto"), `setCopyMessage(text)`, `getLog()`, `reset()`, `destroy()`.

## Eventi del bus (`bus.js`)

`export const bus = new EventTarget()`, `emit(type, detail)`; estensioni: `on(type, fn(detail)) → off`, `EVENTS`, `PHASES`. Ogni evento è un `CustomEvent` con i dati in `e.detail`.

| tipo | detail | effetto nella UI |
|---|---|---|
| `file` | `{name, sizeMB, durationS, width, height, hdr, dolbyVision}` (+ `fps` facoltativo) | scheda file, badge HDR/Dolby Vision, peso stimato |
| `phase` | `{phase: 'analisi'\|'video'\|'audio'\|'scrittura'\|'fatto'\|'errore'}` | fase corrente, catena delle fasi |
| `progress` | `{phase, done, total, fps, etaS, elapsedS}` (campi mancanti tollerati) | %, barra, restante, trascorso, fps, fotogrammi. Coalescente con rAF: si può emettere spesso |
| `frame` | `{index}` | ignorato dalla UI (per fun.js) |
| `result` | `{inMB, outMB, savedPct, fileName}` | schermata "Fatto!" con −%, MB prima→dopo, coriandoli una volta |
| `log` | `{line}` | aggiunge una riga al log tecnico |
| `error` | `{message}` | pannello errore + log aperto + Riprova |

Percentuale complessiva = pesi per fase (analisi 4 %, video 86 %, audio 7 %, scrittura 3 %), mai decrescente. Se `etaS` manca è stimata da `elapsedS`.

## Intrattenimento

Rimosso dall'app dalla v0.17 (`fun.js` resta nel repo ma non è caricato; nessun `#fun-slot`). Il root ha `data-busy` e `data-stage` ∈ `pick|ready|busy|done|error`.

## Drag & drop, zoom, previsione

- Rilascio file su tutta la pagina (window: dragenter/over/leave/drop) con overlay pixel art; solo il primo video, altri tipi → messaggio; ignorato durante l'export.
- Zoom disattivato: viewport `maximum-scale=1,user-scalable=no`, `touch-action: manipulation`, guard su `dblclick`/`gesturestart`/doppio `touchend`.
- Al via la UI memorizza il peso stimato; il risultato mostra «Previsto ≈ X MB · Reale Y MB · scarto ±Z %» (nota se >15 %) e lo scrive nel log.

## Token principali (`theme.css`)

Palette: `--px-ink plum red orange yellow lime green teal navy blue sky cyan white silver slate steel` + `--px-paper`.
Font: `--font-pixel` (Silkscreen), `--font-digits` (VT323), `--font-body` (Atkinson Hyperlegible), con fallback di sistema.
Griglia: `--px-unit` (4px), `--px-border`, `--px-gap`, `--px-touch` (48px), `--px-step`.
Ruoli (ridefiniti in scuro con `prefers-color-scheme` e `[data-theme]`): `--bg --surface --surface-2 --text --muted --line --shadow --accent --accent-text --ok --ok-strong --warn --danger --highlight --log-bg --log-text`.
Classi: `.px-panel(--inset|--accent)`, `.px-btn(--primary|--ok|--danger|--ghost|--xl|--block)`, `.px-bar` (riempimento con `--p` 0…1 sull'elemento, figlio `<i>`), `.px-chip(--hdr|--dv|--ok|--num)`, `.px-seg`, `.px-title`, `.px-label`, `.px-digits`, `.px-blink`, `.px-bob`, `.px-sr`.
