# 12 — Ricerca a circuito chiuso del bitrate per scena

Data: 2026-11-19. Moduli: `app/lib/quality.js`, `app/lib/scenes.js`, `app/lib/ratecontrol.js`; test `app/lib/ratecontrol.test.mjs` (`node --test`, 19 test, solo stub); taratura `tools/lab/calibrate_quality.mjs`.
Legenda: ✅ misurato da noi · 🟡 stima/ragionamento · ❓ da verificare su device.

## 1. Problema

L'encoder di Safari 27 (VideoToolbox realtime via WebCodecs) ha una sola leva di qualità: il `bitrate` medio. Non c'è un quantizzatore e non esiste CRF (BIBBIA §8, research/02 §10). Lo stesso bitrate dà qualità molto diverse da scena a scena. Su IMG_7440, a 8 Mbps fissi, la media del clip è VMAF 88.8, ma i singoli secondi vanno da 81.7 a 95.7 ✅ (tabella §4). L'obiettivo è dare a ogni segmento il bitrate minimo che porta il VMAF stimato a ≥ 88, cioè la soglia decisa dall'utente (BIBBIA §12). La qualità si misura nel browser con una metrica leggera tarata su VMAF.

Schema:
```
demux (metadataOnly: size/key/dur) ─► scenes.segmentScenes ─► ratecontrol.planSegments (finestre di prova, budget)
        ─► per segmento: searchBitrate
              encodeTrial(finestra 1 s, [b/1.3, b×1.3])   ← VideoEncoder separati, stessi frame nativi (seek)
              measure: VideoDecoder(prova) + VideoDecoder(sorgente) ─► luma Y 8-bit ─► SSIM 540×960 ─► ssimDb
              ssimDb ─► VMAF stimato (taratura) ─► interpolazione log-rate ─► bitrate minimo (+margine, guardia p5)
        ─► encode finale: encodeSchedule(i) → setBitrate()+keyFrame all'inizio di ogni segmento
```

## 2. Metrica scelta: SSIM della luma a 540×960, in dB

**Scelta**: SSIM in stile x264 (somme su blocchi 4×4, finestre 8×8 su una griglia di 4 px), calcolata sulla sola luma. La luma è sottocampionata 2× con un filtro box (1080×1920 → 540×960). Il valore usato è `ssimDb = −10·log10(1−SSIM)`. Per segmento si prende la media dei dB per-frame e il 5° percentile come guardia. La funzione `frameScore` è pura e gira identica in Node e nel browser.

**Pipeline dei pixel (decisione HLG 10-bit → 8-bit)**. Le due luma vengono confrontate nel dominio dei code value HLG, in range limitato, senza tone mapping e senza conversione di colore.
- Nel browser entrambe le immagini passano da `VideoDecoder` → NV12 8-bit (comportamento misurato in research/02 §10, run 4), poi `copyTo` del solo piano Y. Le immagini sono:
  - la prova ricodificata;
  - la sorgente, decodificata dai pacchetti originali a partire dal keyframe che precede la finestra.

  Non c'è alcuna conversione YCbCr→RGB, quindi matrice e range sono identici per costruzione.
- In Node (taratura) ffmpeg decodifica a `gray10le` (piano Y 10-bit, già ruotato). `lumaFromPlane(…, {bitDepth:10})` converte con `(Y10+2)>>2`, cioè l'arrotondamento che ci si aspetta da un decoder 10→8. In seguito applica lo stesso box 2×.
- Fallback per i frame nativi (`format:null`, niente `copyTo`): `lumaViaCanvas` (canvas 2D → `getImageData` → Y BT.2020). Si può usare solo se **anche** l'altro lato passa dalla stessa funzione: il browser può applicare matrici o tone mapping propri ❓.

**Varianti confrontate** (IMG_7440, 522 frame × 5 bitrate). La colonna "errore bitrate" (LOSO) è l'errore sul bitrate necessario per raggiungere VMAF 88, stimato lasciando fuori un segmento alla volta (leave-one-segment-out) e con segmenti da 1 s. È la grandezza che conta davvero per la ricerca.

| variante | costo Node ms/frame* | PLCC/SROCC per-frame | PLCC/SROCC segmento 1 s | errore bitrate (rmse log2) |
|---|---|---|---|---|
| **SSIM 540×960 (scelta)** | **≈ 4** (1.6 downsample + 2.5 SSIM) | 0.911 / 0.929 | **0.958 / 0.946** | 0.236 (±18 %) |
| SSIM 1080×1920 | 9.5 | 0.904 / 0.928 | 0.970 / 0.969 | 0.197 |
| SSIM 270×480 | 0.6 | 0.891 / 0.905 | 0.929 / 0.917 | — |
| MS-SSIM 3 scale, 1080p | 16.8 | 0.912 / 0.930 | 0.957 / 0.947 | 0.239 |
| MS-SSIM 3 scale, 540×960 | 4.4 | 0.899 / 0.914 | 0.938 / 0.923 | — |
| PSNR 540×960 | 0.6 | 0.893 / 0.937 | 0.967 / 0.978 | 0.173 |
| SSIM su gradienti 540×960 | 3.9 | 0.909 / 0.933 | 0.967 / 0.965 | 0.203 |
| SSIM + log(moto sorgente) | ≈ 4.5 | — | — | 0.153 (2 s: 0.158) |

\* Xeon 2.3 GHz, un thread. Su iPhone 17 Pro Max (JSC) ci si aspetta lo stesso ordine di grandezza ❓.

Perché SSIM a 540×960:
1. Le varianti stanno tutte in un intervallo stretto di correlazione per segmento (0.93–0.97). Con segmenti da 2 s l'ordine delle varianti cambia: SSIM 540×960 ha rmse 0.178 contro 0.195 di quella a 1080p. Su un solo clip quindi nessuna variante vince in modo robusto.
2. Il costo è circa 1/2–1/4 della versione full-res. Inoltre la cache della luma sorgente per una finestra di 1 s pesa ~31 MB come Uint8, contro 124 MB a 1080p: un dato rilevante dato il budget memoria di research/03.
3. Misurare un frame su due (stride 2) non cambia la correlazione (PLCC 0.958 → 0.956; stride 4 → 0.945) ✅ e dimezza la CPU.

Le varianti con il moto sorgente (VMAF ha una feature di "motion masking") sono le migliori, ma hanno 3 parametri tarati su 9 segmenti di un solo clip. Sono documentate qui e non attivate. Vanno riprese quando ci saranno più clip.

## 3. Taratura metrica → VMAF ✅

Dati: originale IMG_7440 e output reali dell'app v0.13 a 4/6/8/10/12 Mbps (frame verificati, GOP 4 s). VMAF `vmaf_v0.6.1` per-frame, calcolato come in `tools/lab/vmaf_score.sh`: medie 76.6 / 84.1 / 88.8 / 92.0 / 94.4, che coincidono con research/05. I campioni sono 9 segmenti da 1 s (60 frame) × 5 bitrate = 45 punti.

- **Media**: `VMAF ≈ 32.71 + 4.085 · ssimDb`, residuo s.d. 2.48, PLCC 0.958 / SROCC 0.946.
- **Guardia p5**: `VMAF_p5 ≈ 10.96 + 5.85 · ssimDb_p5`, s.d. 3.93, PLCC 0.936.
- **Soglia equivalente a VMAF 88**: ssimDb 13.53 (SSIM 0.9557). **Con margine +1 s.d. (VMAF stimato 90.5): ssimDb 14.14 (SSIM 0.9615)**. È il bersaglio usato da `searchBitrate`.
- Guardia: p5 stimato ≥ 72 + 3.93. Il file a 8 Mbps giudicato "quasi perfetto" ha p5 73.0.
- Il margine di 2.48 VMAF corrisponde a circa +19 % di bitrate (pendenza misurata ~10 VMAF per raddoppio: 9.6–11.3 tra 6 e 12 Mbps).

Valori in `quality.DEFAULT_CALIBRATION`. Per rifare la taratura con altri clip: `node tools/lab/calibrate_quality.mjs`, poi si incolla l'oggetto stampato.

Limiti: la taratura viene da **un solo clip** (diurno, poco rumore). VMAF SDR applicato a HLG è indicativo (research/05). Le prove partono con un IDR, mentre gli output usati per la taratura sono codificati senza interruzioni: la prova è leggermente pessimista, quindi l'errore va nel verso conservativo.

## 4. Segmentazione (scenes.js) e cosa predice il bitrate sorgente

`segmentScenes(packets)`:
- unità atomica = GOP sorgente, perché iPhone mette un keyframe ogni ~28 frame. La dimensione del singolo pacchetto oscilla ×10 tra I, P e B, quella del GOP no;
- tagli di scena = pacchetto non-key più grande di 3× il 90° percentile locale dei non-key (≈ un P tipico), oppure picchi opzionali di differenza di luma. Due tagli devono distare almeno 1 s;
- programmazione dinamica che minimizza la varianza del log-bitrate dentro ogni segmento più una penalità per segmento, con durata `minSec..maxSec` (in `ratecontrol` default 2–4 s) e confini forzati ai tagli;
- output `[{startIdx, endIdx (escluso), complexity = bitrate segmento / bitrate clip, srcBitrate, duration, cutAtStart}]`.

**Risultato importante ✅**: dentro un clip il bitrate sorgente **non** predice il bitrate necessario. Su IMG_7440, con segmenti da 1 s, la sorgente va da 17.9 a 23.3 Mbps e il bitrate necessario per VMAF 88 va da 4.8 a 11.0 Mbps (×2.3), con correlazione −0.03. Nel rapporto `necessario/sorgente`, la media 0.40 vale come prior **a livello di clip** (`priorModel: k=0.4`, ≈ 8 Mbps per una sorgente da 20 Mbps), ma solo la prova misura le differenze tra segmenti. Da qui seguono tre scelte:
- finestra di prova **centrata** nel segmento (`trialPick:'center'`). Prendere la finestra a bitrate sorgente massimo (`'max'`) spende di più senza alcun guadagno: 9.80 contro 8.80 Mbps nella simulazione;
- segmenti brevi (2–4 s), in modo che ogni segmento possa essere provato;
- per un segmento non provato si usa `prior × correzione del clip (media geometrica + 1 s.d.) × 1.2`.

| secondo | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| sorgente Mbps | 23.3 | 19.3 | 20.8 | 20.5 | 21.1 | 20.5 | 17.9 | 21.3 | 18.3 |
| VMAF a 8 Mbps | 84.8 | 94.9 | 94.8 | 93.2 | 95.7 | 84.4 | 81.7 | 83.4 | 85.4 |
| necessario per 88 (Mbps reali) | 11.0 | 4.9 | 5.2 | 6.0 | 4.8 | 9.6 | 10.9 | 10.2 | 10.1 |

## 5. Algoritmo di ricerca (ratecontrol.js)

Per ogni segmento con prova:
1. `prior` = 0.4 × bitrate sorgente della finestra, limitato a [2, 20] Mbps.
2. **Giro 1**: una sola chiamata `encodeTrial(finestra, [prior/1.3, prior×1.3])`. I due bitrate sono pensati in parallelo: gli stessi frame nativi, letti con un solo seek, alimentano due `VideoEncoder`.
3. `measure` → ssimDb per-frame → `pool` (media, p5) → VMAF stimato (media e p5).
4. Interpolazione in log2(bitrate) del punto in cui la media stimata raggiunge 88 + 2.48 e il p5 stimato raggiunge 72 + 3.93. Si prende il massimo dei due. Fuori dalla forchetta si estrapola con la pendenza misurata, limitata a [5, 20] VMAF per raddoppio.
5. **Giro 2**, solo se il risultato è oltre 1.15× fuori dalla forchetta e resta budget: una prova al valore estrapolato, poi si interpola di nuovo.
6. Il risultato viene limitato a [2, 20] Mbps e arrotondato a 10 kbps.

Encode finale: `encodeSchedule(segments, {gopFrames})(i)` restituisce `{keyFrame, bitrate}`. All'inizio di ogni segmento c'è sempre un keyframe, e `setBitrate` scatta solo se la variazione è ≥ 8 % (prior art, BIBBIA §8). Dentro un segmento restano i keyframe periodici, contati dall'inizio del segmento.

**Simulazione con i dati reali ✅** (`calibrate_quality.mjs`). Le prove sono rigiocate interpolando gli output reali; la colonna "VMAF vero" è il VMAF interpolato al bitrate scelto. Piano di default su IMG_7440: 3 segmenti, cioè [0–3.27 s], [3.27–5.64 s], [5.64–8.7 s].

| strategia | Mbps medi | VMAF clip | VMAF min segmento | frame di prova |
|---|---|---|---|---|
| fisso 8 Mbps (oggi) | 8.0 | 88.8 | 81.7 (segm. 1 s) | 0 |
| fisso con ogni segmento ≥ 88 | 10.9 | — | 88 | — |
| oracolo (VMAF vero = 88 per segmento, senza margine) | 7.79 | — | 88 | — |
| **ricerca, budget 0.4 (default)** | **8.80** | 90.2 | **88.7** | 180/522 (34 %) |
| ricerca, budget 0.2 (1 segmento provato) | 8.85 | 90.2 | 85.3 | 60/522 |
| ricerca, finestra 'max' | 9.80 | 91.6 | 88.9 | 180/522 |

Bitrate scelti con il default: 7.63 / 7.10 / 11.35 Mbps, con VMAF veri 90.5 / 91.9 / 88.7.

## 6. Tempi su iPhone (stima 🟡, da misurare ❓) e risparmio atteso

Costi unitari:
- seek + rVFC ≈ 60 fps, misurato (≈ tempo reale per un clip a 60 fps);
- `VideoDecoder` HW ❓ ≥ 240 fps a 1080p;
- metrica ≈ 4–5 ms per frame per bitrate (copyTo Y + downsample + SSIM). Con stride 2 si scende a ~2.5 ms.

Per una finestra di 1 s (60 frame) con 2 bitrate in parallelo:
- seek 1.0 s;
- decodifica di 2 prove + sorgente ≈ 0.75 s;
- metrica ≈ 60 × (2 × 2.5 + 1.5) ms ≈ 0.4 s.

In totale ≈ **2–2.2 s per segmento provato**. Con segmenti da ~3 s e budget 0.4 (tutti provati) l'overhead è ≈ 0.7× la durata del clip, quindi **tempo totale ≈ 1.7× quello attuale**. Esempi: IMG_7440 (8.7 s) ≈ 15 s contro 9 s; 1 minuto di video ≈ 1 min 45 s. Le prove possono girare in pipeline (metrica del segmento k mentre si fa il seek del k+1), con un obiettivo di ~1.5×. Con `budget` 0.2 si scende a ~1.3×, ma i segmenti non provati sono rischiosi (simulazione: 85.3).

Risparmio (IMG_7440, rispetto all'originale da 21.6 MB): la ricerca sta a 8.8 Mbps, cioè ≈ −56 %, con **ogni** segmento ≥ 88. A pari garanzia ("nessun segmento sotto 88") un bitrate fisso richiederebbe 10.9 Mbps: **−19 % di bit**. Rispetto agli 8 Mbps fissi di oggi il file cresce del +10 %, ma i 3–4 s difficili passano da VMAF ~82–85 a ≥ 88.7.

Il guadagno grosso è atteso **tra clip diversi**. Un clip facile (statico, poco dettaglio) scende verso i 3–5 Mbps invece di 8. Un clip difficile come IMG_2147 (VMAF 87.7 a 4.3 Mbps con il proxy x265) riceve ciò che serve invece di un valore fisso. Il risparmio medio su una libreria reale va misurato ❓: servono più clip e la taratura con più contenuti, anche low-light.

## 7. Integrazione in index.html, passo per passo

Le funzioni dipendenti dal browser vengono iniettate. Lo schizzo segue le variabili di `run()` (v0.14).

1. **Import**
   ```js
   import { planSegments, runSearch, encodeSchedule, expectedBitrate, DEFAULTS } from './app/lib/ratecontrol.js?v=0.15';
   import { lumaFromDecodedFrame, frameScore, rotateLuma, decodeChunks } from './app/lib/quality.js?v=0.15';
   ```
2. **Demux**: nel loop `metadataOnly` esistente, salvare anche `size: p.byteLength, key: p.type === 'key'` in `pk`. Dopo il filtro `ts ≥ 0`, `frames[i]` porta già `size`/`key`. Poi:
   ```js
   const plan = planSegments(frames, frames /* {size,key} */, { targetVmaf: 88 });
   ```
   UI: un selettore "Bitrate: automatico (per scena)" accanto ai valori fissi. In modalità fissa il flusso resta quello di oggi.
3. **encodeTrial(w, rates)**:
   - creare `rates.length` encoder con `createHevcEncoder({width:W, height:H, bitrate:r, onChunk})` (moduli esistenti);
   - per ogni frame di `seekFrames(video, frames.slice(w.startIdx, w.endIdx)…, vstats)`: `enc_k.encode(vf, j === 0)` su **tutti** gli encoder, poi `vf.close()`, poi `drain`;
   - raccogliere i chunk e `meta.decoderConfig`;
   - restituire `[{bitrate:r, bytes, encoded:{chunks, config}}]`.

   Va alimentato **a tempo reale come l'encode finale** (rVFC obbligatorio): il rate control VT dipende dal ritmo di alimentazione (BIBBIA §11, v0.7). Se il device non regge due sessioni VT in parallelo ❓, eseguirle in serie (stesso API, costo doppio di seek).
4. **Luma della sorgente per la finestra**, una volta per segmento, in cache come `Uint8Array` 540×960:
   ```js
   const vsink = new MB.EncodedPacketSink(vt); const cfg = await vt.getDecoderConfig();
   let p = await vsink.getKeyPacket(frames[w.startIdx].ts);   // keyframe ≤ inizio finestra
   ```
   - iterare `vsink.packets(p)` in ordine di decodifica fino a coprire `frames[w.endIdx-1].ts` (più 3–4 pacchetti di riordino B), convertendo con `p.toEncodedVideoChunk()`, e passarli a `decodeChunks(cfg, chunks, onFrame)`;
   - in `onFrame` tenere solo i frame con timestamp nella finestra (match con `frames[i].ts·1e6 ± 1 ms`) e calcolare `rotateLuma(await lumaFromDecodedFrame(f, {factor:2}), rotation)`, dove `rotation = await vt.getRotation()`. I frame del `VideoDecoder` **non** sono ruotati, quelli del `<video>` sì: verso da verificare con l'autotest al punto 8.
5. **measure(w, encoded)**: `decodeChunks(encoded.config, encoded.chunks, async (f, i) => { if (i % 2) return; dbs.push(frameScore(srcLuma[i], await lumaFromDecodedFrame(f, {factor:2})).db); })`. Stride 2: un frame su due.
6. **Ricerca**: `const res = await runSearch(plan, { encodeTrial, measure }, {}, (i, s, r) => log(...))`. Nel log: per segmento i punti `{bitrate, q, qLow}`, il bitrate scelto e la stima. `expectedBitrate(res.segments)` serve per la UI.
7. **Encode finale**:
   - `const ctl = encodeSchedule(res.segments, { gopFrames: keyEvery })`;
   - nel loop: `const c = ctl(i); if (c.bitrate) enc.setBitrate(c.bitrate); enc.encode(vf, c.keyFrame);`;
   - `setBitrate` deve precedere l'`encode` del keyframe;
   - aggiungere il bitrate medio reale per segmento al log (dai chunk);
   - nome file: `_autoQ88_`.
8. **Autotest di allineamento** (da fare una volta in diagnostica e poi in debug): una prova a 20 Mbps deve dare ssimDb medio ≥ ~20 (SSIM ≥ 0.99). Se si ottiene SSIM ~0.3, la rotazione o l'allineamento dei frame sono sbagliati: provare la rotazione opposta e controllare l'offset di indice (`vstats`).
9. **Memoria**: luma sorgente 0.5 MB/frame × 60 = 31 MB per finestra. Al massimo 2 encoder di prova più l'encoder finale vivi: chiudere sempre gli encoder di prova prima dell'encode finale (non devono mai essere aperti insieme a lui).

## 8. Test su device prima di fidarsi (❓)

1. Due `VideoEncoder` HEVC in parallelo dallo stesso `VideoFrame` nativo: entrambi Main10? fps complessivi? Il bitrate prodotto è ≈ target?
2. `VideoDecoder` su pacchetti sorgente (HEVC Main10 + NAL 62 DV): esce NV12 8-bit? fps? Il piano Y coincide con quello della ricodifica a 20 Mbps (autotest al punto 8)?
3. Le prove (IDR + 1 s) predicono la qualità del segmento nell'encode finale con `configure()` al volo? Confronto: VMAF in laboratorio del file finale per segmento contro la stima registrata nel log.
4. Tempo reale per segmento (seek, decode, metrica) e throttling su clip da 1–3 min.
5. Convergenza del rate control dopo `configure()` (BIBBIA §8: cambio efficace ma non istantaneo): byte reali per segmento nel log.

## 9. Alternativa da valutare: "ladder parallela + splice"

Codificare **l'intero clip** a 2–3 bitrate in parallelo, con un solo seek per frame e keyframe forzati agli stessi indici (inizi di segmento) su tutti gli encoder. Si misura ogni segmento sul bitstream vero (decode + metrica in pipeline) e per ogni segmento si tengono i chunk del bitrate più basso che passa la soglia. Pregi:
- nessun tempo di seek extra;
- misura esatta, non su una finestra.

Rischi ❓:
- i parameter set (SPS/PPS) devono essere identici tra gli encoder, perché l'app ne usa uno solo in `hvcC`;
- throughput VT con 3 sessioni;
- la decodifica e la metrica di K flussi completi devono reggere ≥ 60 fps (con stride 2–4).

L'API `searchBitrate` resta valida come fallback.

## 10. Riproduzione

```
node --test app/lib/ratecontrol.test.mjs
TMPDIR=/tmp/claude-0/lab/tmp node tools/lab/calibrate_quality.mjs     # salta se mancano i file privati
```
Variabili d'ambiente: `CALIB_REF`, `CALIB_DIST` (directory con `*-<base>_<N>M_k4s_aCopy_v0.13`), `VMAF`, `MODELS`, `CALIB_CACHE`. Il VMAF per-frame viene messo in cache. La prima esecuzione richiede ~10 min (VMAF ~1 min/file, metriche ~3 min).

## 11. Integrazione nell'app (v0.28, opzione sperimentale, default OFF)

Opzione «Qualità garantita per scena (sperimentale)» nelle avanzate (`sceneQ`). Codice: `app/lib/scenesearch.js` (piano, prove, misura, riepilogo), `brctl.createSegmentRate` (controllo per segmento), cablaggio in `index.html` `run()`; test `app/lib/scenesearch.test.mjs` (stub). Differenze rispetto allo schizzo del §7:
- **Segmenti = segmenti dell'export** (`jobstore.planSegments`, ~4–5 s), non `scenes.segmentScenes`: la ripresa resta valida. Finestra di prova di ~1 s al **centro** del segmento; tutti i segmenti sono provati. Le prove di tutti i segmenti ancora da fare girano **prima** dell'encoder finale (mai aperti insieme, §7.9), sugli stessi player (1 o 2, `parallelFrames` con il suo fallback) e con la stessa estrazione verificata (rVFC). Ogni risultato va in `manifest.scene[k]` (`{b, why, prior, pts, est, ms, real}`): una ripresa non rifà le prove.
- **Bitrate dell'utente = limite superiore** (`maxBitrate`); partenza = `min(0.4 × bitrate sorgente della finestra, limite)`. Il peso non supera mai la stima a bitrate fisso; la UI mostra «variabile, ≤ X MB» e tempo × 1.7. Se la soglia richiederebbe di più il log scrive «limite raggiunto».
- **Luma della sorgente dai frame nativi via canvas 2D** a ½ risoluzione (non `VideoDecoder` sui pacchetti sorgente): la prova decodificata passa dalla **stessa** funzione canvas (`makeCanvasLuma`), Y BT.709 → range limitato. Cache Uint8 dei soli frame pari (≈ 15 MB per finestra a 1080p), liberata a ogni segmento. La taratura (§3) è stata fatta su piani Y di decoder con filtro box: la via canvas differisce (interpolazione di `drawImage`, conversione colore del browser) ❓.
- **Punti al bitrate REALE della prova** (byte × 8 / durata), non al configurato: l'encode finale è corretto a circuito chiuso verso il bitrate reale del segmento (`createSegmentRate`: stato = rapporto configurato/target conservato tra segmenti e nel manifest, `configure` prima del keyframe di ogni segmento; finestre di misura che non scavalcano segmenti; finestre limitate dal contenuto, reale < 0.5 × target, non aggiornano il rapporto).
- **Robustezza**: errore di encoder/decoder nelle prove → log e bitrate dell'utente per quel segmento; dopo 2 segmenti di fila falliti le prove si spengono per il resto del job. Interruzioni da background/annullo non sono assorbite (ripresa normale).

Verifica in Chromium (Playwright, localhost, nessun HEVC: harness di test con encoder H.264 SOLO per il test, clip ffmpeg 12 s 1280×720 60 fps = testsrc2 + rumore + barre statiche): autotest a 20 Mbps ssimDb 30.8 (allineamento ok); scelti 2.0 / 12.0 (limite) / 2.0 Mbps, reali nell'encode finale 2.0 / 12.7 / 0.1 Mbps (statico: l'encoder non spende); ripresa senza nuove prove; ripiego su errore verificato. `index.html` in Chromium: UI e stime ok, prove HEVC fallite → ripiego all'utente come previsto, poi l'encoder finale HEVC non esiste (atteso).

Da provare su iPhone ❓: drawImage di frame nativi HLG e di frame NV12 decodificati su canvas 2D → stessa conversione (tone mapping) sui due lati? (autotest 20 Mbps: ssimDb medio ≥ ~20); due sessioni VT di prova + `VideoDecoder` HEVC Main10 per segmento (memoria, jetsam); tempo reale delle prove (stima 1.7×); qualità finale per segmento contro la stima nel log (VMAF in laboratorio).

## 12. v0.35 — prove più veloci (stessa regola di decisione)

Data: 2026-11-23. Punto di partenza (iPhone, v0.34.1, IMG_3053 1080p60 8 s, 2 segmenti da 4 s, limite 8 Mbps): prove **8.8 s** (≈ 4.4 s per segmento) contro **4.2 s** di codifica finale a 120 fps; entrambi i segmenti «al limite»; le prove erano finite a 1 player («player 1: frame 2 non verificato dopo 3 tentativi (mediaTime assente)»). Unico criterio: tempo, con VMAF stimato ancora ≥ 88 e stima validata. Codice: `ratecontrol.searchBitrate` (politica `fast`, default), `scenesearch.js` (misura in diretta, partenza a caldo, tempi), `frames.js` (riscaldamento, rVFC tardiva), `index.html` §3b; test `scenesearch.test.mjs` (+10), laboratorio `tools/lab/scene_speed_lab.mjs`.

### 12.1 Cosa cambia ✅ (test Node + Chromium)

1. **Misura in diretta** (`createTrialDeps`): per i bitrate da misurare subito un `VideoDecoder` di prova riceve i chunk mentre l'encoder di prova li produce; luma (stessa funzione canvas) + SSIM del frame decodificato *i* contro la luma sorgente *i* (catturata prima di `encode(i)`, quindi sempre pronta). Niente secondo passaggio decode + canvas dopo la prova: la lettura del canvas si sovrappone alle attese di seek/rVFC. Ripiego: errore del decoder in diretta → i chunk sono ancora lì e si misura dopo come in v0.34; decoder non creabile → diretta spenta per il job. Encoder **e decoder** di prova sono comunque chiusi prima dell'encoder finale (§7.9). Chromium (H.264 al posto di HEVC, solo test): ssimDb in diretta **identici** a quelli misurati dopo; coda dopo la prova 0.01–0.02 s.
2. **Limite per primo**: se `prior × 1.3 ≥ limite` (la forchetta toccherebbe comunque il limite) il giro 1 codifica `[limite, prior/1.3]` in parallelo ma misura **solo il limite** (in diretta). Se lì il VMAF stimato (media o guardia p5, con margine) non basta → `clamped-max` subito: la prova più bassa non viene mai decodificata. Se basta, si misura anche quella (nessuna estrazione in più) e la decisione è la stessa di v0.34.
3. **Contenuto facile**: se la risposta sta sotto il punto più basso provato (che quindi supera già la soglia) si scende da quel punto con pendenza `max(misurata, 10 VMAF/raddoppio)` — più lenta = prudente — e si accetta **senza 2° giro** se si resta entro un dimezzamento o si tocca il minimo; altrimenti 2° giro come prima. Corretto anche un caso limite di v0.34: una pendenza misurata troppo piatta poteva dare `clamped-min` estrapolando senza verifica.
4. **2° giro** solo quando serve davvero: risposta sopra la forchetta (estrapolare verso l'alto non è sicuro) e sotto il limite.
5. **Partenza a caldo**: prior del segmento k = media geometrica fra il bitrate scelto per k−1 e 0.4 × sorgente (se k−1 era al limite: il limite → «limite per primo»). È solo il centro della forchetta; decide la misura. Non si **riusa** il risultato senza prova: dentro un clip il bitrate sorgente non predice il necessario (§4, correlazione −0.03), quindi «segmenti simili» non è un criterio sicuro.
6. **Riscaldamento** prima delle prove: ogni player estrae con verifica rVFC un frame che NON è il primo che gli verrà chiesto (stesso istante = nessuna nuova presentazione = rVFC che non scatta); poi un primo `drawImage` del frame nativo HLG (shader/conversione) e il banco di misura (punto 8). Se il 2° player non si verifica, le prove passano a 1 player subito (senza perdere 4 tentativi a frame).
7. **rVFC tardiva** (`frames.js`, vale anche per la codifica finale): dopo i 250 ms si concedono altri 60 ms; un timer scaduto mentre il thread principale era occupato passava prima del passo di rendering in cui gira la rVFC → falso «mediaTime assente». Prima di ogni nuovo tentativo il player si sposta su un frame vicino (con attesa della sua presentazione): rifare il seek allo **stesso** istante non presenta nulla e la rVFC non scatta più — spiegazione probabile dei 3 tentativi persi nel log di IMG_3053. La verifica resta identica (mediaTime nel frame atteso).
8. **Log per misurare sul device**: per segmento `· (1 giro, 2 enc/1 misura, 1 in diretta, limite per primo, partenza dal segmento prima)`; a fine prove `prove: tempi … · estrazione · luma sorgente · attese encoder · avvio enc/dec · misura in diretta: luma + SSIM, coda · misura dopo: decode, luma, SSIM · altro`; al riscaldamento `prove: banco luma per frame ½ (in uso) · ½ canvas GPU · ¼ · SSIM` (solo misura, nessuna scelta automatica). A/B di debug: `localStorage['fcv.sceneLive']='0'` = misura dopo, come v0.34.

### 12.2 Metrica più economica: laboratorio ✅ — NON adottata

`TMPDIR=/tmp/claude-0/lab/tmp node tools/lab/scene_speed_lab.mjs`. VMAF vero `vmaf_v0.6.1` per frame. Dati: IMG_7440 con le uscite **reali VideoToolbox** dell'app (v0.13, 4–12 Mbps) e, come controllo, 4 clip (2 privati, solo letti) codificati con x265 «simil-VT» (veryfast, senza B-frame, 2/3.5/6/10 Mbps, timestamp passthrough). Taratura sulle finestre con VMAF 65–97. (A) stima della finestra vs VMAF della finestra; (B) stima dalla finestra centrata vs VMAF dell'intero segmento d'export da 4 s (ciò che conta); (C) errore sul bitrate necessario per 88 (rmse log2).

IMG_7440 VT (34 finestre in taratura):

| variante | (A) PLCC / RMSE | (B) PLCC / RMSE | (C) rmse log2 | taratura a + b·x |
|---|---|---|---|---|
| **1 s, stride 2, ½ (in uso)** | **0.957 / 2.38** | **0.893 / 4.22** | **0.304** | 29.3 + 4.43 x |
| 1 s, stride 3, ½ | 0.961 / 2.26 | 0.878 / 4.90 | 0.300 | |
| 1 s, stride 4, ½ | 0.948 / 2.60 | 0.891 / 4.47 | 0.299 | |
| 0.5 s, stride 2, ½ | 0.931 / 2.98 | 0.804 / 5.59 | 0.477 | |
| 0.5 s, stride 3, ½ | 0.923 / 3.15 | 0.781 / 6.10 | 0.503 | |
| 1 s, stride 2, ¼ box | 0.938 / 2.83 | 0.938 / 3.27 | 0.277 | 22.2 + 3.70 x |
| 1 s, stride 2, ¼ «bilineare» (2×2 centrali, = drawImage senza mipmap) | 0.957 / 2.37 | 0.900 / 4.14 | 0.295 | 24.6 + 4.29 x |
| 0.5 s, stride 3, ¼ bilineare | 0.925 / 3.11 | 0.792 / 6.01 | 0.493 | |
| 0.5 s, stride 4, ¼ bilineare | 0.935 / 2.90 | 0.816 / 5.32 | 0.486 | |

Clip x265, taratura per clip, PLCC / RMSE (A) per IMG_2147 · IMG_7440 · privato A (facile, VMAF ≥ 95 a 2 Mbps) · privato B: oggi 0.850/5.24 · 0.953/2.71 · 0.744/0.34 · 0.874/2.53; 0.5 s 0.854/4.84 · 0.938/3.08 · 0.732/0.39 · 0.827/2.56; ¼ bilineare 0.852/5.21 · 0.950/2.80 · 0.738/0.35 · 0.896/2.31.

Decisioni:
- **Finestra 0.5 s: no.** Sul segmento intero (B) l'errore sale da 4.2 a 5.6–6.1 VMAF e quello sul bitrate da ×1.23 a ×1.40 (C). In più su device una prova da 0.5 s darebbe il doppio di peso all'IDR iniziale e al tempo di assestamento del rate control VT (~1 s), che il laboratorio non vede.
- **Stride 3–4: no.** (A) pari o leggermente migliore, ma (B) peggiora (4.2 → 4.5–4.9) e risparmierebbe solo 1/3–1/2 delle luma.
- **¼ di risoluzione: equivalente in laboratorio, ma non adottabile senza il device.** Con campionamento «bilineare» la qualità della stima è identica alla ½, ma la taratura dipende dal filtro con cui Safari ridimensiona `drawImage` di un frame video a 4×: fra box e bilineare la soglia per VMAF 88 passa da 17.8 a 14.8 dB (≈ 13 punti VMAF di differenza): usare la taratura sbagliata sovrastimerebbe la qualità. A ½ box e bilineare coincidono (campioni al centro di ogni 2×2), per questo la ½ è robusta. Prossimo passo: il banco `prove: banco luma` dice quanto si guadagnerebbe; se conviene, autotest del filtro sul device (motivo a righe di 1 px disegnato come VideoFrame) e taratura per filtro.
- Avvertenza, non nuova: con una sola taratura per tutti i contenuti la relazione ssimDb → VMAF **non generalizza** fra clip diversi (tutti i clip insieme: PLCC 0.62). Oggi la taratura è quella di IMG_7440 (§3); i limiti di §3 restano.

### 12.3 Simulazione delle politiche (v0.34 vs v0.35) ✅

Uscite reali rigiocate per segmento d'export da 4 s, taratura per clip (uguale per le due politiche), VMAF vero interpolato sull'intero segmento; 7 segmenti (IMG_7440 VT ×2, IMG_2147, IMG_7440 x265 ×2, privati A e B):

| limite | politica | Mbps medi | VMAF vero min | encoder | misure | giri |
|---|---|---|---|---|---|---|
| 8 | v0.34 | 5.97 | 86.4 | 16 | 16 | 9 |
| 8 | **v0.35** | **5.98** | **86.4** | 15 | **14** | 8 |
| 12 | v0.34 | 6.49 | 86.2 | 17 | 17 | 10 |
| 12 | **v0.35** | **6.49** | **86.2** | 16 | **16** | 9 |

Stessi bitrate e stessa qualità vera: la nuova politica non cambia le decisioni, toglie lavoro. Il minimo 86.4 è lo stesso segmento di IMG_7440 in entrambe le versioni: la finestra di 1 s al centro non rappresenta del tutto i 4 s del segmento (B, RMSE 4.2) — limite noto, non introdotto qui. Nei dati di laboratorio pochi segmenti sono al limite; sul device (IMG_3053: tutti al limite, 1 misura invece di 2) il guadagno in misure è maggiore.

### 12.4 Tempi attesi (🟡, da misurare ❓)

Chromium headless (H.264 al posto di HEVC, 720p60, 2 segmenti al limite): v0.34.1 8.9 s → v0.35 7.6 s (misura dopo, stessa politica: 8.8 s). Qui domina l'estrazione headless (58 ms/frame), non rappresentativa. Sul device la v0.34.1 spendeva ~1 s di estrazione e ~3.4 s di misura per segmento: con 2 player riscaldati, misura in diretta e una sola misura per i segmenti al limite la stima è **1.0–2.0 s per segmento**:
- IMG_3053: prove 8.8 s → **≈ 2.5–4 s**; totale 13 s → **≈ 7–8 s** (fattore sulla sola codifica da ≈ 3.1 a ≈ 1.6–1.9).
- Video lungo (60 s, 15 segmenti misti, codifica 30 s): prove ≈ 66 s → **≈ 20–30 s**; totale ≈ 96 s → **≈ 50–60 s**.
`SCENE.timeFactor` = `SCENE_TIME_FACTOR` = **1.6** (UI e quota della barra). Da verificare sul device: righe `prove: banco luma`, `prove: player riscaldati`, `prove: tempi …`, e per segmento `(1 giro, … in diretta …)`; nessuna `estrazione parallela (prove)` di ripiego; memoria con 2 encoder + 1–2 decoder di prova vivi insieme (mai con l'encoder finale).

### 12.5 Idee valutate e non adottate (prossimi passi)

- **Verifica sull'uscita finale + ricodifica del solo segmento sotto soglia**: misura esatta (non una finestra, risolverebbe il limite di 12.3) e nessuna prova per i segmenti che passano; ma richiede decoder + luma durante la codifica finale (memoria con l'encoder finale vivo, §7.9; rallenta i 120 fps) e la riscrittura di un segmento nel jobstore con lo stesso hvcC. Da provare su device.
- **Bitrate da statistiche gratuite della sorgente** (dimensioni pacchetti/QP) con modello appreso, prove solo per i segmenti incerti: nei dati di §4 il bitrate sorgente non predice il necessario dentro un clip; servono più clip e feature (moto, rumore) prima di saltare prove.
- **Luma/SSIM in un Worker** (VideoFrame e OffscreenCanvas trasferibili): toglierebbe il lavoro dal thread dei seek; da fare solo se `prove: tempi` mostra che l'estrazione rallenta per colpa della misura in diretta.
- **¼ di risoluzione** con autotest del filtro di `drawImage` (12.2).

### 12.6 v0.35.1 — misura iPhone (IMG_1634, 1080×1920 54 s, 14 segmenti) e luma via GPU

- v0.35.0 sul device: prove 47.8 s (3.4 s/segmento) contro 27.2 s di codifica finale → totale 75.8 s (2.7× la sola codifica). Player riscaldati ok, nessun ripiego.
- Banco: luma ½ canvas CPU (`willReadFrequently`) **72 ms/frame**, ½ canvas GPU **8 ms**, ¼ CPU 71 ms (il costo è la conversione del frame HLG nel canvas CPU, non la dimensione), SSIM 3.7 ms. → il readback CPU era il collo di bottiglia (~60 luma per segmento ≈ 4 s).
- v0.35.1: `chooseLuma` (autotest sul primo frame nativo prima delle prove): se la luma GPU coincide con la CPU (differenza media ≤ 1 livello, max ≤ 24) ed è più veloce, tutte le prove usano la GPU. Log: «prove: luma via canvas GPU — …».
- Caso IMG_1634: tutti i 14 segmenti al limite di 8 Mbps con VMAF stimato 73.6–77.9 (contenuto che per la stima richiederebbe più di 8 Mbps; taratura poco affidabile fra clip diversi, §12).
