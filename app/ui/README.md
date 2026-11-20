# app/ui — interfaccia pixel art

Tema "Pressa a 16 colori": palette Sweetie 16, bordi pixel con angoli smussati e ombre a gradini (solo `box-shadow`, nessuna immagine), sprite SVG generati da stringhe, tre famiglie pixel da Google Fonts (con fallback): Silkscreen solo per brand, titoli e cifre grandi; Pixelify Sans (400/600/700) per testo, etichette, bottoni, chip, note; VT323 (monospazio pixel) per numeri di tabelle e previsioni, contatori, nome file e log tecnico.

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
  onStart(settings) {},       // {bitrateMbps, keyframeS, audioMode, bgAudio, par2} (+ resume:true dal pulsante «Riprendi»); chiamato SINCRONO nel tap
  onCancel() {},              // l'app interrompe e chiama ui.setBusy(false)
  onPip(wasActive) {},        // (v0.21) tap su «Continua in Picture-in-Picture»; SINCRONO nel tap (requestPictureInPicture richiede il gesto)
  onSave() {},                // chiamato SINCRONO nel tap → navigator.share() funziona
  onCopyLog() {},             // facoltativo: se assente la UI copia da sola il log mostrato
}, { version: 'v0.15' });    // opts facoltativo (estensione)
ui.setDefaults({ bitrateMbps: 8, keyframeS: 4, audioMode: 'copy' });
ui.setBusy(true); /* … export … */ ui.setBusy(false);
```

`index.html` può linkare `theme.css` e `ui.css` nel `<head>` per evitare il flash; altrimenti `mountUI` li aggiunge.

Valori: `bitrateMbps` ∈ 4,6,8,10,12,14 (8 consigliato) · `keyframeS` ∈ 1,4,10 · `audioMode` ∈ `copy`,`v4`,`v3`,`v2`,`v1`,`reenc` · `bgAudio` (bool, opzioni avanzate → Sperimentale, default false: test background con audio keep-alive) · `par2` (bool, Sperimentale, default false: estrazione frame parallela con 2 player).

### Ritorno di `mountUI`
- `setBusy(bool)` — contratto. `true` mostra il pannello di avanzamento e blocca i controlli; `false` senza `result`/`error` ⇒ torna al passo 2 ("annullato").
- `setDefaults(settings)` — contratto (accetta anche un oggetto parziale).
- Estensioni: `getSettings()`, `setSaveMessage(text)` (sotto "Salva nelle Foto"), `setCopyMessage(text)`, `getLog()`, `reset()`, `destroy()`.
- `setResume({name, done, total, settings} | null)` (v0.18): nel passo 3 mostra «Riprendi export di <nome> (segmenti x/y)»; il tap applica `settings` e chiama `onStart({...settings, resume: true})`. Nascosto durante l'export e quando si sceglie un altro file.
- `setPip(active)` (v0.21): etichetta del pulsante PiP («Continua» / «Chiudi Picture-in-Picture»). Il pulsante (`pipBox`) compare nel pannello di avanzamento dalla fase `video` in poi solo se `document.pictureInPictureEnabled`; in display-mode standalone mostra solo la nota «apri il sito in Safari» (bug WebKit 303885). Logica PiP in `app/lib/pip.js` (`createPip(file, {log, onChange})`: `<video>` muto separato dal video dei seek, `leavepictureinpicture` → chiusura gestita, la ripresa v0.20 resta invariata).
- `setProgNote(text, kind)` (v0.18): riquadro nel pannello di avanzamento; testo vuoto = «Tieni l'app aperta e lo schermo acceso finché finisce.»; `kind` `warn`/`bad`. Usato per «pausa di N s / ripreso / interrotto, riprendo dal segmento x».

## Eventi del bus (`bus.js`)

`export const bus = new EventTarget()`, `emit(type, detail)`; estensioni: `on(type, fn(detail)) → off`, `EVENTS`, `PHASES`. Ogni evento è un `CustomEvent` con i dati in `e.detail`.

| tipo | detail | effetto nella UI |
|---|---|---|
| `file` | `{name, sizeMB, durationS, width, height, hdr, dolbyVision}` (+ `fps` facoltativo) | scheda file, badge HDR/Dolby Vision, peso stimato |
| `phase` | `{phase: 'analisi'\|'video'\|'assemblaggio'\|'audio'\|'scrittura'\|'fatto'\|'errore'}` | fase corrente, catena delle fasi |
| `progress` | `{phase, done, total, fps, etaS, elapsedS}` (campi mancanti tollerati) | %, barra, restante, trascorso, fps, fotogrammi. Coalescente con rAF: si può emettere spesso |
| `frame` | `{index}` | ignorato dalla UI (per fun.js) |
| `result` | `{inMB, outMB, savedPct, fileName}` | schermata "Fatto!" con −%, MB prima→dopo, coriandoli una volta |
| `log` | `{line}` | aggiunge una riga al log tecnico |
| `error` | `{message}` | pannello errore + log aperto + Riprova |

Percentuale complessiva = pesi per fase (analisi 4 %, video 82 %, assemblaggio 4 % — etichetta «Unione» —, audio 7 %, scrittura 3 % — etichetta «File»), mai decrescente. Se `etaS` manca è stimata da `elapsedS`.

## Intrattenimento

Rimosso dall'app dalla v0.17 (`fun.js` resta nel repo ma non è caricato; nessun `#fun-slot`). Il root ha `data-busy` e `data-stage` ∈ `pick|ready|busy|done|error`.

## Drag & drop, zoom, previsione

- Rilascio file su tutta la pagina (window: dragenter/over/leave/drop) con overlay pixel art; solo il primo video, altri tipi → messaggio; ignorato durante l'export.
- Zoom disattivato: viewport `maximum-scale=1,user-scalable=no`, `touch-action: manipulation`, guard su `dblclick`/`gesturestart`/doppio `touchend`.
- Al via la UI memorizza il peso stimato; il risultato mostra «Previsto ≈ X MB · Reale Y MB · scarto ±Z %» (nota se >15 %) e lo scrive nel log.

## Token principali (`theme.css`)

Palette: `--px-ink plum red orange yellow lime green teal navy blue sky cyan white silver slate steel` + `--px-paper`.
Font: `--font-pixel` (Silkscreen), `--font-body` (Pixelify Sans), `--font-mono` (VT323, `tabular-nums`), `--font-digits` = alias di `--font-pixel`. Il caricamento è un solo `@import` in `theme.css`.
Scala: `--fs-xs` 14 (solo note molto secondarie) · `--fs-sm` 16 · `--fs-md` 18 · `--fs-lg` 20 · `--fs-body-xl` 24 (testo, line-height ≥ 1.35) · `--fs-mono` 22 · `--fs-mono-lg` 28 · `--fs-log` 20 (VT323) · `--fs-px` 16 · `--fs-xl` 24 · `--fs-2xl` 32 · `--fs-3xl` 48 · `--fs-4xl` 64 (font pixel, multipli di 8). Spaziature `--sp-1/2/3/4/6` (multipli di `--px-unit`).
Griglia: `--px-unit` (4px), `--px-border`, `--px-gap`, `--px-touch` (48px), `--px-step`.
Ruoli (ridefiniti in scuro con `prefers-color-scheme` e `[data-theme]`): `--bg --surface --surface-2 --text --muted --line --shadow --accent --accent-text --ok --ok-strong --warn --danger --highlight --log-bg --log-text`.
Classi: `.px-panel(--inset|--accent)`, `.px-btn(--primary|--ok|--danger|--ghost|--xl|--block)`, `.px-bar` (riempimento con `--p` 0…1 sull'elemento, figlio `<i>`), `.px-chip(--hdr|--dv|--ok|--num)`, `.px-seg`, `.px-title`, `.px-label`, `.px-digits`, `.px-blink`, `.px-bob`, `.px-sr`.
