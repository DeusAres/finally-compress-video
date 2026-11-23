# 15 - Clipchamp: encoding video nel browser (cosa ci serve davvero)

Data: 2026-11-23. Legenda: ✅ scritto nella fonte · 🟡 dedotto/terze parti · ❓ non verificato (non trovato nelle fonti).

## Fonti (lette)
1. web.dev case study (PWA, SIMD): https://web.dev/case-studies/clipchamp , versione testo https://web.dev/case-studies/clipchamp.md.txt
2. W3C Media Production Workshop, talk di Sören Balko (Clipchamp), ott. 2021: https://www.w3.org/2021/03/media-production-workshop/talks/soeren-balko-clipchamp-webcodecs.html
3. Slide dello stesso talk (PDF, testo estratto): https://www.w3.org/2021/03/media-production-workshop/talks/slides/soeren-balko-clipchamp-webcodecs.pdf
4. Chromium blink-dev "Intent to Ship: WebCodecs" (dichiarazione Clipchamp): https://groups.google.com/a/chromium.org/g/blink-dev/c/7UlTzFMbTFs
5. Indice workshop (solo puntatori, nessun dato): https://www.w3.org/2021/03/media-production-workshop/

Giudizio generale: le fonti pubbliche sono **povere di dettagli**. Non esiste (trovato) un post tecnico Clipchamp su worker/COOP-COEP/SharedArrayBuffer/memoria. Il case study web.dev e' in gran parte marketing PWA. Il valore sta in 3 cose: architettura a worker, trappole dell'integrazione WebCodecs, wishlist spec (che coincide con i nostri problemi).

## 1. Cosa dicono le fonti (fatti)
- Pipeline export in-browser a 3 stadi: decoder -> compositor/effetti -> encoder -> MP4 ✅ (talk, slide). Decoder e Encoder in **worker separati**; l'app principale ospita il compositor ("Superfill"); stream grezzo passato via un filesystem virtuale ("streamfs"/"writefs"/"readfs"), output MP4 scritto con Filewriter API; service worker + cache asset in IndexedDB ✅ (slide, diagramma).
- Base: **FFmpeg compilato in WASM** per demux/mux, file I/O, fallback codec software, filtri; WebCodecs innestato via "codec stub" FFmpeg (VP8/VP9/H.264/AV1) che chiamano JS per configure/push frame/pull packet/close ✅.
- Trappola 1: **dry-run "preflight" del VideoEncoder** per ottenere extradata (SPS/PPS) richiesta da FFmpeg all'init del codec ✅ ("headache").
- Trappola 2: FFmpeg WASM e' sincrono, WebCodecs asincrono -> spezzato in chiamate async per frame ✅.
- Trappola 3: **backpressure dell'encoder solo "stampella"** ✅; chiedono evento attivo di backpressure ✅.
- Storia: encoding software "per molto tempo", poi HW encode/decode "fantastico per noi" ✅ (nessun numero). "Memory is scarce still" ✅.
- Roadmap (blink-dev): export H.264 via WebCodecs prima sul preset default/draft; timeline interattiva: sostituire `<video>` con decode WebCodecs+FFmpeg, perche' lo stack software era troppo lento e per robustezza su Chromebook ✅. Nessun numero ✅(assenza).
- SIMD WASM (Chrome origin trial): clip 1080p 8,33 s 30 fps: preset Default 25 s -> ~13 s; Compression ~83 -> ~33 s; Quality ~75 -> ~30 s; **2,3x** complessivo, meno di un mese di un ingegnere; nessun aumento di failure rate in produzione ✅. Si riferisce all'encoder **software** WASM, non a WebCodecs.
- Threads WASM, bulk memory: solo citati come feature Chrome ✅ (secondo traduzioni; testo EN li elenca). Nessun dettaglio su SharedArrayBuffer/COOP/COEP/memoria ❓ non trovato.
- Wishlist "WebCodecs 2.0": backpressure attiva; **manopola qualita' diversa dal bitrate** (0-1); HDR; decode HEVC; API sincrona nei worker ✅.
- PWA: +97%/mese installazioni, retention +9% vs desktop ✅ (irrilevante tecnicamente).

## 2. Applicabilita' a noi e priorita'

| # | Tecnica / lezione Clipchamp | Applicabile? (Safari iOS, GH Pages, HDR 10-bit) | Priorita' |
|---|---|---|---|
| 1 | **Worker separati decoder / encoder**, compositor a parte, stream di frame tra stadi | Si' come principio. Per noi: `<video>`+rVFC deve stare sul main thread (non esiste nei worker), encoder+muxer+OPFS in worker. Frame passano con `VideoFrame` transferable (zero-copy). Verificare memoria: frame 10-bit sono pesanti, limitare frame in volo | Alta |
| 2 | **Backpressure dell'encoder va costruita a mano** (loro: "crutch"; chiedono evento) | Si'. Gia' previsto nel nostro circuito chiuso: usare `encodeQueueSize` + evento `dequeue`, tetto di frame in volo piccolo (prior art 09: 4 per HEVC). Safari non ha evento dedicato oltre `dequeue` | Alta |
| 3 | **Manca una manopola qualita' oltre il bitrate** (wishlist loro) | Conferma il nostro vincolo (BIBBIA §2: solo ABR, `quantizer` = TypeError). Conferma la scelta di controllare il bitrate a circuito chiuso con `configure()` al volo | Alta (validazione scelta) |
| 4 | **Preflight dry-run per extradata** | Non serve: mediabunny prende `description`/`hvcC` dal `decoderConfig` del primo chunk. Da non copiare. Resta valido leggere sempre l'`hvcC` reale dell'output (BIBBIA §2) | Bassa |
| 5 | Sync vs async: spezzare in passi per frame | Siamo gia' nativamente async (no FFmpeg). Nessuna azione | - |
| 6 | **FFmpeg WASM come muxer/fallback** | No: scartato (mediabunny). WASM+MP4 in iOS costerebbe memoria e non da' HW encode | Scartata |
| 7 | **WASM SIMD (2,3x)** su encoder software | Safari iOS supporta WASM SIMD (🟡 dalla conoscenza generale, non dalle fonti), ma un encoder x265 WASM e' molto piu' lento dell'HW VideoToolbox (163 fps misurati) e non fa 10-bit HLG utile al caso. Utile solo per **calcoli in-app** (SSIM/VMAF stimato, stima rumore) se la versione GPU/WebGPU non basta. Priorita' dopo WebGPU | Bassa (solo metriche) |
| 8 | **Thread WASM / SharedArrayBuffer / COOP-COEP** | Le fonti non ne parlano ❓. Per noi: GitHub Pages **non** permette header COOP/COEP -> cross-origin isolation impossibile (workaround con service worker che inietta header: 🟡, fragile su iOS, non verificato qui). Strategia: **non dipendere da SAB**; usare worker + `postMessage` transferable + OPFS `createSyncAccessHandle` | Evitare (non necessario) |
| 9 | **Decode con WebCodecs al posto di `<video>`** per timeline (loro) | Noi scegliamo `<video>` seek+rVFC perche' frame HLG nativi 10-bit e colorspace corretto (BIBBIA §2). Loro motivo opposto: `<video>` lento su hardware debole. Trappola per noi: misurare throughput seek+rVFC; fallback `VideoDecoder`+demux mediabunny e' alternativa se rVFC e' troppo lento (decodifica HEVC 10-bit via WebCodecs: ❓ da misurare su device, bug 262950) | Media |
| 10 | **Filesystem virtuale / streaming su disco** (streamfs/writefs, IndexedDB per asset) | Equivalente nostro: OPFS a segmenti (gia' deciso). Loro lo fanno per file da GB: conferma che non si tiene mai tutto in RAM | Alta (conferma) |
| 11 | Hardware encode "fantastico" dopo anni di SW; memoria scarsa | Conferma strada HW. Nessun numero Clipchamp utilizzabile come benchmark | Info |
| 12 | Rilascio graduale: prima preset draft su WebCodecs, poi resto; misure in produzione (failure rate) | Pratica utile: telemetria locale di errori/fallback per file (senza rete) e preset "bozza" veloce prima del preset qualita' | Media |
| 13 | HDR e decode HEVC come mancanze WebCodecs (2021) | Oggi (Safari 27) HEVC decode c'e'; HDR 10-bit encode da JS non costruibile (BIBBIA §2). Stessa lacuna, nessuna soluzione da Clipchamp | Info |
| 14 | PWA: install prompt, social login, quick export | Marginale. Solo manifest + icone; su iOS niente prompt automatico (installazione manuale da Share) 🟡 | Bassa |

## 3. Cosa NON c'e' nelle fonti (non verificato)
- Dimensione/gestione memoria WASM, limiti heap, numero di thread, pool di worker ❓
- Uso di SharedArrayBuffer, COOP/COEP, cross-origin isolation, workaround senza header ❓
- Numeri di throughput di WebCodecs HW (fps, bitrate error, qualita' vs software) ❓
- Rate control, qualita' per scena, metriche (SSIM/VMAF) ❓
- Comportamento su Safari/iOS (le fonti riguardano Chrome/ChromeOS; Safari mai citato) ❓
- Gestione HDR/10-bit/color management ❓
- Il PDF delle slide contiene solo ~12 pagine; testo estratto interamente e riportato sopra.

## 4. Conclusione operativa
Clipchamp non ci da' tecniche da importare di peso: ci da' **conferme** (HW encode, worker per stadio, backpressure manuale, assenza di knob qualita', streaming su filesystem) e **due trappole** da evitare (preflight/extradata: non serve con mediabunny; sincrono vs asincrono: non ci riguarda). Per SIMD/thread/COOP-COEP le fonti non offrono nulla di applicabile e su GitHub Pages l'isolamento cross-origin non e' disponibile: progettare senza SharedArrayBuffer.
