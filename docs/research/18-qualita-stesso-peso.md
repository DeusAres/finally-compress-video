# 18 — Più qualità a parità di peso del file

Data: 2026-11-27. Solo studio, nessuna modifica al codice.
Legenda: ✅ misurato da noi o verificato nel sorgente WebKit · 🟡 stima/ragionamento sui nostri dati · ❓ da verificare su device.
Fonti interne: research/02 (opzioni encoder, §2 e §10), 05 (GOP, confronto x265), 12 (ricerca per scena, tabella §4); sorgente WebKit `main` riletto oggi: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/platform/video-codecs/cocoa/GPUVideoEncoderVTB.mm

## 0. Risposta breve: «quanto è impossibile?»

Non è impossibile, ma il margine è stretto e **quasi tutto sta nella distribuzione dei bit, non nell'encoder**. Stima onesta, a peso di file invariato, per un clip tipico a 8 Mbps (🟡):

| Risultato | Guadagno realistico |
|---|---|
| VMAF **medio** del file | **+0.5 … +1.5** (non +5). Zero se tutti i segmenti sono già difficili |
| VMAF del segmento **peggiore** / p5 | **+3 … +6** (è il vero beneficio visibile: sparisce il «secondo brutto») |
| Clip statici con frame rate dimezzato (opzionale) | **+3 … +5** sui segmenti statici, con costo di fluidità |
| Tutte le leve insieme, senza 30 fps | circa **+1.5 … +2.5** medio, +5 … +7 sul peggiore |

Non esiste nessuna leva da +5 sul medio. Il motivo di fondo: VT HEVC ha una sola manopola di qualità (`AverageBitRate`) e sta circa 8 VMAF sotto x265 a 4 Mbps (research/05, tabella GOP lungo 84.7 contro il nostro 76.6 ✅ per IMG_7440; ❓ verificare che sia lo stesso clip e la stessa scala). Quel divario (~×1.7 di bitrate) richiederebbe un altro encoder, ma non abbiamo i pixel a 10 bit per alimentarlo (VideoDecoder dà 8 bit, research/02 §10 run 4), quindi è fuori portata.

## 1. Fatto di partenza che ridimensiona la leva (a)

Pendenza misurata: ~10 VMAF per raddoppio di bitrate (9.6–11.3 tra 6 e 12 Mbps, research/12 §3 ✅), con curva concava verso l'alto.

Con pendenza uguale per tutti i segmenti l'allocazione ottima per il VMAF **medio** è **bitrate uguale ovunque** (derivata di `a_i + s·log2 r_i` uguale per ogni segmento → `r_i` uguale). Spostare bit da segmento facile a segmento difficile non alza la media: la alza solo nella misura in cui i segmenti facili sono saturati (pendenza minore sopra ~94). Quindi (a) è una leva sul **minimo/p5**, non sulla media.

Verifica sui nostri dati (IMG_7440, 9 secondi, tabella research/12 §4, 🟡 calcolo mio):
- fisso 8 Mbps: media 88.7, minimo 81.7;
- bitrate necessario per VMAF 88 per secondo: 11.0, 4.9, 5.2, 6.0, 4.8, 9.6, 10.9, 10.2, 10.1 → **media 8.08 Mbps**, cioè quasi lo stesso peso di 8 Mbps fissi;
- allocazione «VMAF uguale» a ~8.1 Mbps: **tutti i secondi a 88**, media 88.0 (−0.7 sulla media), minimo +6.3.

Conclusione: a peso uguale la media non migliora (anzi, −0.7), ma il minimo passa da 81.7 a 88. Se l'obiettivo è la media VMAF, l'allocazione migliore è una via di mezzo (water-filling con pendenza reale); se è «nessun segmento scadente» (la scelta dell'utente: soglia 88) conta il minimo.

## 2. Leve ordinate per guadagno atteso e fattibilità

| # | Leva | Guadagno VMAF (stesso peso) | Rischio | Fattibilità | Priorità |
|---|---|---|---|---|---|
| a | Budget di file invece del limite per segmento | medio 0…+1, **minimo/p5 +3…+6** | basso-medio | alta: logica in `ratecontrol.js`/`brctl.js`, nessuna API nuova | **1** |
| b | Keyframe a 8–10 s o solo ai cambi di scena | +0.2…+0.6 (1–4 % di bit) | basso | molto alta: `keyframeS` esiste già | **2** |
| f | Controllo del peso finale (chiudere lo scarto reale/target) | 0…+0.7 | basso | alta, si fonde con (a) | con (a) |
| g | Ritmo di alimentazione (feed rate) a bitrate reale uguale | 0…+3 ❓ ignoto | basso | media: da misurare | **3** (esperimento) |
| c | 30 fps sui segmenti statici | +3…+5 sui segmenti, ma fluidità ridotta | **medio** (percezione, VMAF a frame rate diverso) | media | 4 (opzione, mai predefinita) |
| e | Audio: meno bit se l'utente lo accetta | +0.1…+0.4 | basso | dipende dalla modalità audio | 5 |
| d | Opzioni `VideoEncoder` / chiavi VT | **0** (non arrivano) | — | — | scartata ✅ |
| h | AV1 | 0 (8 bit da canvas, niente HDR) | alto | — | scartata (un solo test, §2.8) |

### 2.1 (a) Budget di file (e (f) peso finale)

Idea: il bitrate dell'utente (e il tetto 0.85 × sorgente) diventa il **bitrate medio del file**, non il limite del singolo segmento. Un segmento difficile può salire fino a ~1.5× (12 Mbps a 8), uno facile scende; il piano usa le curve già misurate dalle prove da 1 s (bitrate → VMAF stimato) e minimizza la perdita sotto vincolo Σ(bitrate × durata) = budget. Obiettivo secondario: equalizzare il VMAF stimato sopra la soglia 88 e usare l'eventuale avanzo per alzare i segmenti sotto soglia.

- Guadagno: dipende dall'eterogeneità. Con l'esempio §1: minimo +6. Se tutti i segmenti sono al limite con VMAF stimato 80–85 (caso comune segnalato) e **nessun** segmento sta sotto il limite, non c'è nulla da redistribuire: **guadagno 0**, e il file sarebbe uguale. Il guadagno compare solo se alcuni segmenti raggiungono 88 con meno bit.
- (f): il controllo a circuito chiuso oggi insegue il target per segmento; scarto reale/target non misurato da noi ❓ (brctl.js ha una finestra di 120 frame, passo 0.7–1.5). Un errore del 5–8 % sul peso vale 0.7–1.1 VMAF (10 VMAF per ×2). Con budget di file si può compensare sugli ultimi segmenti: guadagno 0…+0.7 per la parte «peso sprecato».
- Rischi: segmenti a 1.5× rompono il vincolo `MaxBitrate` del limite utente (va dichiarato nell'UI: «media file», non «massimo»); l'ordine di calcolo richiede di conoscere tutte le curve prima del finale (già vero: la ricerca precede l'encode); picchi alti vicino ai limiti di decodifica (1080p60 a 12 Mbps non è un problema).
- Come misurare: A0 contro A1 (§3).

### 2.2 (b) Intervallo dei keyframe

Fatti ✅: VT è configurato con `MaxKeyFrameInterval=7200`, `MaxKeyFrameIntervalDuration=240 s` (sorgente `GPUVideoEncoderVTB.mm`, research/02 §1): i keyframe periodici sono **solo quelli che forziamo noi** con `keyFrame:true`. `configure()` solo-bitrate non forza il keyframe (§4 research/02, run 1 ✅), quindi il keyframe all'inizio di ogni segmento da 4 s non serve al rate control, solo al GOP.

Dati: x265, keyint 28 contro 600: **−5.5/−6 %** di bitrate a VMAF 93–95, −2.5 % a 97 (research/05 ✅, con B-frame e a bitrate più alto). Per GOP da 4 s contro 10 s (240 → 600 frame) il peso dell'I-frame scende, stima 🟡: un I-frame costa 5–10 P; su 240 frame pesa 2–4 %, su 600 pesa 0.8–1.6 % → **risparmio 1–3 %** dei bit → **+0.15…+0.45 VMAF**. A 8 Mbps su clip lunghi (>30 s) il guadagno può arrivare al 4 % (+0.6).

Rischi: scrubbing/seek più lenti nei player (iOS decodifica dal keyframe precedente: 10 s a 60 fps = fino a 600 frame di salto, accettabile ma percepibile in Foto); perdita di resilienza (un errore dura più a lungo, irrilevante per file locali); l'allineamento delle sample per `AllowFrameReordering=false` è già I/P. **Bitrate più instabile nei primi frame dopo un keyframe tolto**: nessuna differenza, il rate control VT non dipende dal GOP.
Variante «solo ai cambi di scena» (`scenes.segmentScenes` ha già i tagli): guadagno simile al GOP lungo, più 1–2 % su clip con tagli perché l'I-frame cade dove il P sarebbe quasi intra comunque. Non misurato ❓.

Come misurare: a bitrate configurato uguale, stessi segmenti, `keyframeS` 4 / 10 / 30 (e «solo scene»): confrontare byte reali e VMAF; poi normalizzare a peso uguale con VMAF_adj = VMAF + 10·log2(byte_rif / byte). Soglia di utilità: ≥ 1 % di byte oppure ≥ +0.15 VMAF_adj rispetto al rumore (§3).

### 2.3 (c) Frame rate dimezzato (60 → 30)

Si possono semplicemente non codificare i frame dispari (i timestamp restano originali, il MP4 diventa a frame rate variabile o 30 fps: durata e A/V sync invariati).

- Guadagno: l'encoder ha il doppio dei bit per frame. Su contenuto statico il bitrate necessario a pari qualità per frame scende a ~60–70 % (🟡), cioè +6…+8 VMAF nominali sui segmenti statici. Su contenuto con moto il predittore P perde efficienza e il guadagno scende a 10–20 % di bit (+1.5…+3).
- Compromessi: (1) fluidità visibile su panoramiche e soggetti veloci (60 fps è un valore percepibile su iPhone); (2) il VMAF rispetto all'originale a 60 fps richiede la ripetizione dei frame: il punteggio ufficiale cala nei segmenti con moto e **non** è confrontabile con le altre varianti senza scegliere una convenzione (consiglio: calcolarlo due volte, vs 60 fps con frame ripetuti e vs 30 fps sottocampionato); (3) la metrica interna (SSIM per segmento) andrebbe applicata sui frame codificati, quindi si perde la penalità di moto; (4) VT con il rate control legato al tempo reale vede un feed dimezzato → ritmo di alimentazione diverso, il controllo a circuito chiuso va ritarato; (5) Foto/iMessage/AirDrop gestiscono VFR in modo non uniforme ❓.
- Fattibilità: la decisione per segmento (statico = bassa differenza luma e bitrate sorgente basso) c'è già in `scenes.js` (moto + texture). Proposta: **solo opzione esplicita «risparmia sui segmenti statici»**, mai predefinita; per ora solo per esperimento.

### 2.4 (g) Ritmo di alimentazione a parità di bitrate reale

✅ Il rate control VT ragiona sul tempo reale: alimentando più veloce si producono meno bit (×0.89 a ~100 fps, ×0.66 a ~178 fps, brctl.js / research/02 §11). Il circuito chiuso compensa alzando il bitrate configurato. **Non sappiamo se, a byte reali uguali, la qualità cambia con il ritmo** (VT potrebbe dedicare più tempo di analisi a ritmo basso): è una leva potenzialmente gratuita, 0…+3 VMAF ❓, ma pagata in tempo di esportazione (1× realtime = lento). Misurare è economico: 4 ritmi, stessi segmenti.

### 2.5 (e) Audio

Il peso del file include l'audio (copia AAC/APAC). Se l'utente accetta una ricodifica a bitrate più basso, 64–128 kbps risparmiati a 8 Mbps equivalgono a +0.1…+0.3 VMAF. Trascurabile: citata per completezza; l'audio spaziale resta intoccato per scelta del progetto.

### 2.6 Allineare i keyframe ai cambi di scena

Parte della leva (b). Se l'I-frame cade sul taglio, un P lì sarebbe quasi intra comunque: risparmio 0.5–2 % sui clip con tagli, ~0 sui piani sequenza. Prerequisito: sapere se VT inserisce da solo un IDR al cambio scena (con `RealTime=false` ❓). Si legge dal flag key dei chunk di un clip con tagli netti: 1 minuto di diag.

### 2.7 (d) Parametri `VideoEncoder` e chiavi VT: verifica nel sorgente ✅

Letto `GPUVideoEncoderVTB.mm` su `main` il 2026-11-27 (rilascio 27.2: `RTCVideoEncoderH265.mm`, research/02 §1a):

| Opzione JS | Arriva a `VTCompressionSession`? |
|---|---|
| `bitrate` | sì → `AverageBitRate` (kbps interi) |
| `bitrateMode` (`constant`/`variable`) | **no, mai letta**; `quantizer` → TypeError |
| `latencyMode` | solo come `RealTime` (+ `RequiredLowLatency` per `realtime`); `quality` = `RealTime=false` |
| `contentHint` | **assente dall'IDL**, ignorata |
| `scalabilityMode` | HEVC solo `L1T1`; `BaseLayerFrameRateFraction` solo per L1T2 su H.264 |
| `hardwareAcceleration` | **non letta**; l'HW forzato solo su macOS (`EnableHardwareAcceleratedVideoEncoder`), su iOS decide VT |
| `framerate` | scartata (`UNUSED_PARAM`); FIXME: «set ExpectedFrameRate» |
| opzioni per frame | solo `keyFrame` (`ForceKeyFrame`); `hevc.quantizer` assente |

Chiavi VT mai impostate (quindi leve potenziali **non raggiungibili da JS**): `Quality`, `ExpectedFrameRate`, `DataRateLimits`, `PrioritizeEncodingSpeedOverQuality`, profilo/livello, `MaxFrameDelayCount`. Fissi: `AllowFrameReordering=false`, `MaxKeyFrameInterval=7200`, `MaxKeyFrameIntervalDuration=240`.
Conclusione: **nessuna opzione di configurazione migliora la qualità**. Test su device non necessario per `contentHint`/`bitrateMode` (ignorate per costruzione), ma `isConfigSupported` darà comunque `true`: non prova nulla (research/02 §10). Una nuova chiave in 27.3 o successiva non si può escludere: rileggere il sorgente al prossimo aggiornamento di Safari.

### 2.8 (h) AV1

✅ `isConfigSupported` AV1 = true; l'encode reale funziona **solo da canvas 8 bit** (30 frame 1080×1920 = 686 KB, ~11 Mbps contro 8 richiesti, 87 fps, ❓ SW/HW); dal frame nativo `<video>` esce output vuoto (research/02 §10 run 2–3). Ne risulta: AV1 = 8 bit, niente HLG/Dolby Vision, overshoot di bitrate: **incompatibile col vincolo 10 bit**. Unica verifica ancora aperta: le note 27.3 beta citano la correzione «AV1 encoders encoding uninitialized data for 10-bit frames (189532957)» (research/02 §1): potrebbe voler dire che il 10 bit nativo ora attraversa l'encoder AV1. Se sì, resterebbe la perdita del Dolby Vision (profilo HEVC) e un encoder AV1 realtime software, la cui efficienza non supera in modo ovvio quella di VT HW 🟡. Un solo test su device (§3, braccio E), poi chiuso.

## 3. Piano di prova sul device

**Materiale**: IMG_7440 (1080p60 HLG, curva VT nota) + 2 clip dell'utente: uno **statico/facile** e uno **difficile** (low-light o movimento). Tutti HLG. I file privati restano fuori dal repo.

**Regole comuni**
1. Ogni confronto a **peso uguale**: byte reali del video entro ±1 % (si aggiusta il target e si riesegue, oppure si normalizza: VMAF_adj = VMAF + 10·log2(byte_rif / byte)).
2. **Rumore**: codificare il braccio A0 **due volte**. Il rumore tra due esecuzioni (VT dipende dal tempo reale) fissa la soglia sotto la quale una differenza non conta. Aspettativa 🟡: ±0.3 VMAF.
3. Metriche per braccio: byte, VMAF medio, p5, **minimo su finestre da 1 s**, bitrate reale per secondo. Comando: `tools/lab/vmaf_score.sh <output> <originale>` (stampa media, p5, neg_mean, neg_p5; per il minimo per secondo serve il json per frame: lo script lo elimina, quindi per il minimo per secondo conviene una piccola variante che salvi `o.json`: ❓ non esiste, modifica da decidere dal coordinatore).
4. Valori VMAF solo relativi (modello SDR su HLG, research/05 ✅).

**Bracci**

| Braccio | Cosa cambia | Strumento | Cosa si guarda |
|---|---|---|---|
| A0 ×2 | stato attuale: limite per segmento 8 Mbps | app v corrente | riferimento + rumore; byte B0 |
| A1 | budget di file = B0 (stessi byte di A0), segmento fino a 1.5×, equalizzazione del VMAF stimato | richiede il codice (a) | minimo e p5 contro A0; media non peggiore di −1 |
| A2 | come A1 ma massimizzando il VMAF medio con la pendenza reale per segmento | idem | media contro A0 |
| B1/B2/B3 | `keyframeS` = 4 (rif.), 10, 30; B4 = solo ai cambi di scena | impostazione esistente (verificare che l'UI offra 10 e 30 ❓); B4 richiede codice | byte a bitrate configurato uguale, poi VMAF_adj |
| C1 | 30 fps (frame dispari saltati) su tutto il clip statico, stesso peso; poi con solo i segmenti statici | richiede codice minimo nel loop dei frame | VMAF vs 60 fps con frame ripetuti **e** vs 30 sottocampionato; guardare a occhio un clip con panoramica |
| D1…D4 | ritmo di alimentazione 0.5×, 1×, 2×, libero, con brctl attivo per pareggiare i byte | diag nuovo o app con parametro | VMAF_adj a byte uguali |
| E | probe: frame nativo 10 bit → `VideoEncoder` AV1 (codec `av01.0.08M.10`), controllare dimensione output, bit depth, fps | card nuova in `tools/diag/index.html` | output non vuoto? 10 bit? Se no, chiudere (h) |

**Ordine** (costo/valore): A0×2 → B1–B3 (nessun codice) → D (poco codice) → A1/A2 (richiede implementazione, ma è la leva con più valore) → C1 → E.
**Criterio di decisione**: adottare una leva se, contro il rumore di A0, dà ≥ +0.3 VMAF_adj medio **oppure** ≥ +2 sul minimo/p5, senza peggiorare l'altro di più di 0.7.

## 4. Verificato e non verificato

✅ Verificato: opzioni WebKit realmente lette (§2.7, sorgente `main` e branch 27.2); `configure()` solo-bitrate senza keyframe; keyframe solo se forzati; curva VMAF/bitrate di IMG_7440; −5.5/−6 % di bitrate per GOP lungo con x265 (non VT); AV1 solo 8 bit da canvas.
🟡 Stimato: guadagno (a), costo I-frame a 4 s contro 10 s, guadagno 30 fps, gap contro x265.
❓ Da misurare: rumore tra esecuzioni; effetto del ritmo di alimentazione sulla qualità; scarto reale/target del controllo attuale; comportamento VT ai cambi scena; AV1 10 bit nativo su 27.3; se VT con `RealTime=false` si comporti come «realtime» nel rate control (le misure dicono di sì per il tempo reale, non è chiaro il perché).

Il modello VMAF 0.6.1 è addestrato su SDR: su HLG serve solo per confronti relativi. Gli stessi calcoli di §1 usano una sola clip (9 secondi) e vanno ripetuti sui due clip nuovi prima di cambiare il codice.

## 5. Trucchi non convenzionali

Sintesi: due idee valgono un esperimento (3: pacing per frame, 2: keyframe solo ai tagli), una è tecnicamente possibile ma ha un beneficio stretto e un rischio alto (1: copia per segmento), il resto è da scartare.

| # | Trucco | Guadagno stesso peso | Fattibilità | Rischio | Verdetto |
|---|---|---|---|---|---|
| 1 | Copia dei pacchetti per segmento (2 sample description) | 0 sul caso tipico; alto solo se sorgente già leggera | bassa (muxer a mano) | **alto** | rimandare |
| 2 | Keyframe solo ai tagli di scena | +0.15…+0.6 | alta | basso | fare (con §2.2) |
| 3 | Pacing dell'alimentazione per frame | 0…+1 ❓ | media | medio | un esperimento |
| 4a | Best-of-2 per segmento | +0.2…+0.5, tempo ×1.5–2 | media | basso | opzione «massima qualità» |
| 4b | Drop di frame quasi identici (VFR) | ~0 su camera, alto su screen recording | alta | basso | solo se rilevato |

### 5.1 Copia per segmento

Idea: dove ricomprimere conviene poco, si copiano i pacchetti originali del segmento (zero perdita, zero tempo di encode) e si ricodificano gli altri.

**Quando conviene davvero (🟡).** La copia costa i bit della sorgente. Un iPhone dà 17–23 Mbps su IMG_7440 (research/12 §4 ✅), contro un target di ~8: copiare un segmento costa 2–3× e, sulla curva di §1, rende come qualunque altro rialzo (~10 VMAF per raddoppio, quindi nessun vantaggio speciale a pari bit). Conviene solo dove `bitrate sorgente ≤ bitrate di ricompressione` (sorgente già leggera, es. scene statiche a 4–6 Mbps, o file già esportati: `origin.js` li riconosce). In quel caso la copia dà VMAF 100 a ≤ bit e senza tempo. Su libreria reale iPhone i segmenti che qualificano sono pochi ❓. Il caso «VMAF stimato basso al limite» **non** è un buon candidato: lì la sorgente costa molto di più del limite.

**Fattibilità tecnica.**
- Mediabunny non può scrivere due entry nello `stsd`, né box extra nel sample entry (research/04 §1.2: `videoSampleDescription` a lista fissa ✅). Servirebbe scrivere a mano `stsd` (2 voci `hvc1`), `stsc` (campo `sample_description_index` per chunk), `stco`/`stsz`/`stts`/`ctts`/`stss`: il progetto ha già moov scritto a mano per `apac` e passthrough (`mp4-post.js`, `passthrough.js`, research/04 §5), quindi non parte da zero, ma è la parte più fragile del progetto (offset `stco` errati = file corrotto, research/04).
- Le due voci differiscono: SPS/PPS/VPS di VT contro quelli della sorgente. Noti ✅: VT non scrive VUI (nessuna colour description, run 5) e codifica 1088 con crop; la sorgente ha VUI/level propri. Con `hvc1` i parameter set stanno **solo** nella voce, quindi la seconda voce è obbligatoria (non si possono mescolare nel flusso; `hev1` è rifiutato da AVFoundation secondo una segnalazione secondaria, vedi fonti).
- Vincoli del taglio: ingresso/uscita della copia su **IDR** sorgente (iPhone: keyframe ~ogni 28 frame, quindi granularità ~0.5 s ✅ research/12 §4; ❓ verificare che siano IDR chiusi e non CRA/open-GOP); la sorgente ha B-frame con riordino: i pacchetti copiati portano `ctts`, mentre il nostro encode no → la tabella dei tempi va unita con cura (dts/pts continui al confine). Stesso profilo e bit depth (Main10) e stesso `dvvC` in entrambe le voci (Profile 8.4); gli RPU Dolby Vision sono nel bitstream sorgente (research/04 §117) ma non in quello VT → mescolando, l'RPU manca nei segmenti ricodificati, dipende da come `dovi.js` li gestisce oggi (non riletto qui ❓).

**Riproduzione con più sample description: non verificato.** Non ho trovato documentazione Apple né fonti affidabili sul comportamento di AVPlayer/AVFoundation/Foto con parameter set che cambiano a un keyframe (la ricerca ha dato solo: l'indicazione Apple HLS di tenere i parameter set nelle sample description con `hvc1`, [HLS authoring spec](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html); un thread libav vecchio secondo cui parameter set in conflitto vanno in sample entry aggiuntive, [libav-devel](https://libav-devel.libav.narkive.com/D2KoGVly/patch-1-6-movenc-use-hev1-tag-for-hevc-in-mode-mov); e una segnalazione secondaria su `hev1` rifiutato da AVFoundation, [fliks-app/engine PR 144](https://github.com/fliks-app/engine/pull/144)). Aspettative 🟡: il formato QuickTime lo prevede (più voci `stsd` per traccia) e i decoder VT reinizializzano al cambio di format description su un sync sample, con possibile micro-blocco; Foto è di solito il player più severo. È testabile in un'ora con file sintetici (§5.5), prima di scrivere codice di produzione.

**Verdetto.** Rimandare. Guadagno nullo sul caso tipico, rischio alto sul file prodotto. Alternativa a basso costo: la decisione **per intero clip** «sorgente già leggera → non ricodificare» (passthrough esiste, `passthrough.js`).

### 5.2 Keyframe solo ai cambi di scena

Estende §2.2 e §2.6. Nota sulla premessa: i tagli oggi li trova `scenes.segmentScenes` dalla **dimensione dei pacchetti sorgente** (non-key > 3× il p90 locale) più picchi di luma opzionali (research/12 §4 ✅). Lo SSIM che calcoliamo è **tra prova e sorgente** sulla finestra da 1 s, non tra frame vicini di tutto il clip; usarlo per i tagli richiederebbe luma di tutti i frame (costo ~2.5–4 ms/frame, +25 % di CPU, ❓): non serve, i tagli per pacchetto sono gratuiti.

Politica proposta: keyframe a ogni taglio rilevato, più un keyframe se passano > 10 s senza (tetto per seek/scrub); mai keyframe all'inizio di un segmento di ricerca che non sia un taglio (il cambio di bitrate non lo richiede, ✅ run 1). Guadagno +0.15…+0.6 (1–4 % di bit). Rischi: falsi positivi (flash, dissolvenze) = un I-frame inutile da ~5–10 P, costo trascurabile; falsi negativi = nessun danno (l'inter-prediction regge). Se VT inserisce da solo un IDR ai tagli resta da vedere (❓, 1 minuto di diag: leggere i flag `key` dei chunk).

### 5.3 Pacing dell'alimentazione per frame

Fatti ✅: a bitrate configurato fisso, 59 fps di alimentazione → 8.2 Mbps, 178 fps → 5.3 Mbps (research/02 §11); brctl misura ×0.89 a ~100 fps e ×0.66 a ~178 fps. Il PTS passato a VT è in ms dal timestamp del frame (§3 research/02), ma l'effetto del tempo reale è misurato. Dai numeri: alimentazione ×3 più veloce → bit ×0.65, cioè la dipendenza è sub-lineare (bit ∝ Δt^0.4 circa, 🟡 due punti soli).

Ipotesi (non verificata): VT accredita un «budget» di bit proporzionale al tempo reale trascorso; se così, **ritardare l'invio prima di un frame complesso (o di un I-frame) gli dà più bit** e anticiparne uno semplice ne dà meno, senza toccare `configure()`. Utilità: allocazione **dentro** il segmento (I-frame non affamato, momenti difficili) oltre a quella per segmento che già fa brctl. Rischi: VT probabilmente media su una finestra ~1 s (l'effetto per frame potrebbe sparire); costo in tempo (rallentare il 20 % dei frame del doppio = +20 % di export); i timer in background/PiP non sono precisi; effetto non deterministico.
Esperimento minimo (diag): stesso clip, bitrate fisso, pausa X ∈ {0, 50, 150, 400 ms} **prima di ogni keyframe** e, in un secondo braccio, prima di ogni frame con differenza luma alta; misurare dimensione del keyframe e dei 10 P seguenti, VMAF del primo secondo, byte totali. Se la dimensione del frame ritardato non cresce chiaramente → leva morta, chiudere.

### 5.4 Altre idee

**Realistiche**
- (4a) **Best-of-2 per segmento**: VT dipende dal tempo reale, quindi due encode dello stesso segmento danno risultati diversi (rumore stimato ±0.3 VMAF ❓). Scegliere il migliore (SSIM stimato) a pari byte vale +0.2…+0.5 al costo di ~2× tempo sui segmenti che hanno margine. Utile solo come opzione «massima qualità»; misura del rumore già prevista da A0 ×2.
- (4b) **Drop di frame quasi identici** (VFR automatico): su camera iPhone i duplicati sono ~3 su 90 (research/02 run 9 ✅), guadagno ~0; su screen recording o timelapse è grande. Solo se `scenes.js` rileva differenza ~0 per molti frame consecutivi.
- **`latencyMode` quality contro realtime a byte uguali**: sappiamo cosa fa a livello di `RealTime` VT (✅), non quanto vale in VMAF; un braccio in più nel diag (D0). Probabile conferma che `quality` è già la scelta giusta.

**Scartate (motivo)**
- Filtri/prefiltri a 10 bit (denoise, grana, sharpen): ogni passaggio da canvas o WebGPU riporta a 8 bit (research/02 §10 run 4); `VideoDecoder` dà 8 bit.
- Ridurre la risoluzione a 10 bit (encode a 720p per bitrate bassi, «convex hull» alla Netflix): impossibile mantenendo i 10 bit (research/14).
- Codec neurali/pre-processing neurale: nessun decoder sul percorso di riproduzione di Foto, nessun accesso ai pixel a 10 bit, e costi di calcolo irrealistici su iPhone in Safari.
- x265 in WASM (`tools/diag/x265bench`): chiuderebbe il divario con VT (~8 VMAF a 4 Mbps), ma riceve solo pixel a 8 bit e rinuncerebbe a HLG/Dolby Vision; inoltre è molto più lento di VT HW.
- Opzioni `contentHint`, `bitrateMode`, `hardwareAcceleration`, `scalabilityMode`: ignorate per costruzione (§2.7).
- ROI/qualità per regione, `DataRateLimits`, `Quality` VT, B-frame: non raggiungibili da JS (§2.7).
- AV1: vedi §2.8.

### 5.5 Test aggiuntivi per il piano (§3)

- **F — multi-stsd**: preparare offline (ffmpeg + scrittura manuale dell'`stsd`, nel laboratorio, senza dati privati) un MOV con due voci `hvc1` Main10 HLG che cambiano a un IDR, più una variante con `dvvC` in entrambe le voci. Aprirlo su iPhone in: Safari `<video>`, Foto (import da File/AirDrop), QuickTime/anteprima Files, Messaggi. Annotare: riproduce? fotogramma saltato al cambio? scrubbing corretto? salvataggio in Foto?
- **G — pacing** (§5.3) e **D0** (`latencyMode` quality contro realtime a byte uguali).
- **K — IDR ai tagli**: clip con tagli netti, letta l'uscita VT: dove compaiono i keyframe senza forzarli?
