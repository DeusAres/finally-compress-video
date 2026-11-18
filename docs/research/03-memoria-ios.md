# 03 — Memoria, storage e ciclo di vita su iOS (Safari/PWA)

Legenda: ✅ fonte primaria (WebKit bugzilla/blog/Apple/spec) · 🟡 secondaria (forum, blog terzi, ricerca indiretta) · ❓ da testare su device.
Data ricerca: 2026-11-18. Nota: le pagine WebKit sono state lette via fetch; i numeri iOS 27 / iPhone 17 Pro Max NON sono documentati da nessuna fonte trovata.

## 1. Limiti di memoria del processo WebContent

- ✅ Soft limit WebContent su iPhone ~1.5 GB, "soft" perché superabile se la pressione di sistema è bassa; jetsam può uccidere se si supera. Smfr (WebKit): progettare per restare sotto 1.5 GB, limite più basso su device con meno RAM. https://bugs.webkit.org/show_bug.cgi?id=277848
- 🟡 Nello stesso bug il reporter osserva ~1.5 GB su iPhone 12 Pro (e ~3 GB dopo hard reset, tornato a 1.5 GB in 2-3 giorni) e ~3 GB costanti su iPhone 15 Pro/Pro Max: il limite effettivo dipende dalla pressione globale, non è un numero fisso. https://bugs.webkit.org/show_bug.cgi?id=277848
- 🟡 Log iOS 26: "Memory Limits: active 2048 inactive 2048" e kill jetsam `per-process-limit` (code 7) dopo un evento di memory pressure (~1.38 GiB di relief). https://discourse.threejs.org/t/memory-limit-crash-on-ios-26/86978
- ✅ iPhone iOS 26.6.2: tab ricaricato 4/4 volte per superamento del limite per-process con WASM (Asyncify) compilato; picco 0.8-0.9 GiB senza kill, kill con picchi maggiori. Picco memoria di compilazione WASM (OMG/greedy regalloc) scala col numero di istanze di modulo. https://bugs.webkit.org/show_bug.cgi?id=304810 (NEW, aperto a set 2026)
- 🟡 Storicamente il soft limit era hardcoded a 840 MB (2017), poi calcolato via SPI jetsam in bmalloc `AvailableMemory.cpp`. https://bugs.webkit.org/show_bug.cgi?id=171944 , https://bugs.webkit.org/show_bug.cgi?id=188091
- ✅ MemoryPressureHandler usa il *footprint* (memoria fisica sporca del processo) confrontato con soglia kill; tenta shrink e poi muore; sottoscrive eventi dispatch memory-pressure (warn/critical, process-limit warn/critical). https://webkit.googlesource.com/WebKit/+/refs/heads/master/Source/WTF/wtf/cocoa/MemoryPressureHandlerCocoa.mm (letto solo via snippet di ricerca; fetch del .cpp dato 403)
- ❓ Il limite per iPhone 17 Pro Max 12 GB / iOS 27: nessuna fonte. Atteso tra 1.5 e ~3+ GB; da misurare.
- ❓ Se IOSurface/GPU (texture WebGPU, CVPixelBuffer di VideoFrame) siano contate nel footprint WebContent o nel GPU process separato: dal 277848 non risulta. In WebKit il rendering/decoding media vive nel GPU process (🟡 https://bugs.webkit.org/show_bug.cgi?id=232076, decode video spostato nel GPU process da iOS 15), quindi buffer IOSurface hanno limite/accounting diverso, ma un eventuale kill del GPU process o pressione globale può comunque ricaricare la pagina. Da testare.
- ❓ PWA standalone vs tab Safari: nessuna differenza documentata di limite; stessi processi WebContent. Misurare entrambi.
- 🟡 Il messaggio "reloaded because it was using significant memory" corrisponde a terminazione WebContent per jetsam (stessa causa delle voci sopra).

## 2. Cosa consuma memoria in una pipeline WebCodecs

- ✅ Spec: risorse codec (CPU e GPU) possono essere allocate dall'UA alla creazione di AudioData/VideoFrame, "possono esaurirsi rapidamente" e vanno rilasciate subito con `close()`. https://www.w3.org/TR/webcodecs/ (sezione "Resource reclamation"/VideoFrame)
- ✅ `decodeQueueSize`/`encodeQueueSize` crescono quando il codec è saturo (richieste bufferizzate nella control message queue) e calano; evento `dequeue` a ogni decremento. https://www.w3.org/TR/webcodecs/
- 🟡 Backpressure = attendere il `dequeue` / controllare `encodeQueueSize` prima di inviare altri frame; senza, i frame si accumulano. Nessuna fonte con soglie raccomandate. https://dev.to/feed/pey_builder
- ✅ Fonti di consumo da ricordare (dal modello spec/implementazioni): VideoFrame non chiusi (CVPixelBuffer/IOSurface pool: il decoder HW ha un pool finito, se non chiudi i frame il decoder si blocca), EncodedVideoChunk in coda, copie CPU via `copyTo`, ArrayBuffer/Blob, texture GPU (importExternalTexture non copia ma tiene il frame vivo). ❓ costi esatti per frame (1080p HDR 10-bit ≈ 3 MB YUV P010; RGBA16F ≈ 16 MB) da misurare.
- ✅ WASM: la linear memory cresce ma non si restituisce mai (`memory.grow` non shrinka); compilazione di moduli grandi ha picchi transitori alti su iOS. https://bugs.webkit.org/show_bug.cgi?id=304810 (picco), spec WebAssembly (no shrink).
- 🟡 Limiti ArrayBuffer/WASM su iOS storicamente bassi (centinaia di MB su Safari 15, ~384 MB riportati). https://github.com/gildas-lormeau/zip.js/discussions/392
- ❓ Decoder HEVC 10-bit HDR in WebCodecs su iOS: supporto e pool IOSurface da verificare (`VideoDecoder.isConfigSupported` con hvc1.2.4.L…).

## 3. Lettura di file grandi

- ✅ `Blob.slice()` è lazy (non carica in RAM); `file.stream()` o `slice().arrayBuffer()` per chunk. Spec File API https://www.w3.org/TR/FileAPI/
- 🟡 Il File da `<input type=file>` su iOS proviene da una copia temporanea (lastModified riflette il momento dell'aggiunta alla cache temporanea di upload) e dalla Libreria Foto può essere transcodificato/ricompresso (varia tra "Libreria foto" e "File"). https://truefilesize.pages.dev/blog/browser-file-api-gotchas/ , https://developer.apple.com/forums/thread/731042 . Conseguenza: possibile duplicazione su disco (non RAM) e perdita di HDR originale: ❓ verificare che sia mantenuto HEVC HDR e dimensione identica.
- 🟡 Bug iOS 26.5.x: un File come body di fetch può arrivare vuoto (Content-Length 0); `arrayBuffer()` funziona. https://bugs.webkit.org/show_bug.cgi?id=319985 — per noi rilevante solo se si usa fetch(file); leggere a chunk.
- 🟡 Lettura a chunk con FileReader: errore `WebkitBlobResource error 1` dopo ~60 s riportato (ipotesi revoca blob, non confermata). https://developer.apple.com/forums/thread/686192 . ❓ mitigazione: copiare subito il file in OPFS (stream in sync access handle) e leggere da lì.

## 4. Scrittura output: OPFS e quota

- ✅ OPFS in Safari da 15.2; `createSyncAccessHandle` solo in Worker. https://webkit.org/?p=12257 , https://bugs.webkit.org/show_bug.cgi?id=231185
- ✅ `createWritable()` / FileSystemWritableFileStream: release notes Safari 26 "Added support for the File System WritableStream API" (via commento in bug). Il bug è REOPENED e utenti riportano confusione. https://bugs.webkit.org/show_bug.cgi?id=231706 , https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes — ❓ non usare come unica via: preferire sync access handle in worker (più stabile, scrittura a offset, `flush()`).
- ✅ Quota (Safari 17+/iOS 17+): origin quota fino al 60% del disco per browser app, 15% per altre app; overall 80%/20%; nessun prompt; `QuotaExceededError` se si supera. Home Screen Web App: stesse quote del browser. https://webkit.org/?p=14403
- ✅ Eviction: oltre overall quota, pressione di storage, o origine non usata a lungo (LRU per origine, tutta l'origine insieme); esenti origini con pagina attiva o in modalità persistente. Default best-effort. https://webkit.org/?p=14403
- ✅ `navigator.storage.persist()` concesso con euristiche (es. aperto come Home Screen Web App), non garantito. `estimate()` restituisce usage e quota, quota variabile per anti-fingerprinting. https://webkit.org/?p=14403
- ✅ Cap 7 giorni su script-writable storage (ITP) vale per uso in Safari; le web app Home Screen hanno contatore di giorni d'uso proprio. 🟡 Fonte: https://www.itnews.com.au/news/apple-cops-flak-for-deleting-local-browser-storage-after-7-days-539833 (dichiarazione Wilander); ✅ la pagina storage policy non cita i 7 giorni. Per i nostri file temporanei è irrilevante se si pulisce a fine job; per checkpoint di lunga durata chiamare persist() e usare da PWA.
- ❓ Blob in memoria vs su disco: WebKit tiene grandi Blob (creati da dati in memoria) in memoria/ file temp a seconda; evitare di creare Blob grandi dall'output, scrivere direttamente in OPFS. Nessuna fonte primaria trovata.

## 5. Restituire il file all'utente

- 🟡 `navigator.share({files})` con file grandi su iOS: segnalati problemi di memoria; un progetto limita iOS a 200 MB. https://github.com/gildas-lormeau/zip.js/discussions/392
- 🟡 "Salva video"/Save to Photos nello share sheet: riportati problemi/assenza ("Save to photos" mancante in iOS 16). https://developer.apple.com/forums/thread/729782 . Per un MP4/MOV con MIME corretto lo share sheet dovrebbe offrire "Salva video": ❓ testare.
- ❓ `OPFS.getFile()` restituisce File supportato da disco (non copia in RAM) – nessuna fonte esplicita; verificare footprint durante `navigator.share`.
- ❓ `<a download>` con Blob URL da `URL.createObjectURL(file)` (file OPFS): su iOS apre il download manager/Files, non Foto; dimensioni massime ignote. Fallback consigliato dopo il share.
- ✅ Requisito: `navigator.share` richiede user activation (transient) e `canShare({files})`. Spec https://www.w3.org/TR/web-share/
- Offrire doppia via: "Condividi/Salva in Foto" + "Salva in File".

## 6. Ciclo di vita

- 🟡 iOS sospende l'esecuzione JS (e i worker della pagina) quando Safari/PWA va in background o lo schermo si blocca; non è possibile forzare il lavoro in background. https://firt.dev/understanding-js-background/ , https://developer.apple.com/forums/thread/777860
- 🟡 Il processo può essere ucciso mentre sospeso; al ritorno la pagina si ricarica. ❓ perdita di WebGPU device/context e di VideoEncoder/Decoder dopo background: da assumere sempre (gestire `device.lost`, ricreare codec).
- ✅ Screen Wake Lock: in Safari dal 16.4; non funzionava in Home Screen Web App fino a iOS 18.4 (corretto, annunciato da Jen Simmons). https://bugs.webkit.org/show_bug.cgi?id=254545
- 🟡 Il lock viene rilasciato su `visibilitychange` e va ri-richiesto; bug 255363 ("permission denied after visibilitychange"). https://bugs.webkit.org/show_bug.cgi?id=255363 ; spec Wake Lock (rilascio automatico a pagina nascosta).
- ❓ Wake lock non impedisce il blocco manuale dello schermo né evita la sospensione se l'utente cambia app: servirà messaggio UI "tieni aperta l'app".
- Resume: checkpoint su OPFS (stato JSON + ultimo GOP/timestamp scritto + output parziale con offset) fsync (`flush()`) ogni N secondi; al riavvio leggere stato e ricominciare dal keyframe precedente. ✅ pratica standard, nessuna fonte specifica.

## 7. Rilevare la pressione di memoria da JS

- ✅ `performance.memory` non esiste in Safari; `performance.measureUserAgentSpecificMemory()` richiede cross-origin isolation e non è in WebKit (❓ verificare). 
- ❓ Nessun evento `memorypressure` esposto al web. `navigator.deviceMemory` assente in Safari.
- Strategie empiriche: budget fisso di frame in volo; misura throughput; riduzione parallelismo dopo errori codec/`device.lost`/reload (flag persistito in OPFS/localStorage "ultimo crash → modalità conservativa"); contatore di reload della pagina (`performance.getEntriesByType('navigation')[0].type === 'reload'` + flag "job in corso" in localStorage) per rilevare un kill jetsam avvenuto e abbassare i budget al tentativo successivo.

## Regole di progettazione anti-crash

1. Budget complessivo target WebContent ≤ 700 MB di footprint (limite assunto prudenziale 1.0-1.5 GB; 1.5 GB è il solo numero ufficiale, bug 277848). Misurare e adattare.
2. Frame in volo massimi: ≤ 4 VideoFrame decodificati contemporaneamente, `decodeQueueSize` ≤ 8, `encodeQueueSize` ≤ 4; invio solo dopo evento `dequeue` o `await` su promessa di backpressure.
3. Chiudere ogni VideoFrame con `close()` appena consegnato all'encoder / alla texture (try/finally); mai tenere frame in array. Contare frame aperti e abortire se > soglia.
4. Mai caricare l'intero file: slice a chunk 4-16 MB, `stream()`; demux incrementale; copiare l'input in OPFS appena selezionato se i chunk da File risultano instabili.
5. Output: scrivere direttamente in OPFS con `createSyncAccessHandle` in un Worker, scrittura sequenziale a buffer da 1-4 MB, `flush()` ogni 5-10 s; mai accumulare chunk in array o Blob.
6. WASM: un solo modulo/istanza, memoria massima dichiarata (es. 256 MB), nessuna crescita dopo l'init; evitare Asyncify (bug 304810); instanziare una volta.
7. Texture WebGPU: riuso di un pool fisso (2-3 texture), `destroy()` esplicito; niente creazione per frame; HDR in rgba16float solo se necessario.
8. Worker unico per pipeline; evitare ArrayBuffer transferiti duplicati; transferable al posto di copie.
9. Checkpoint ogni ~10 s o ogni GOP: {offset input, timestamp ultimo keyframe, byte scritti, config codec}; ripartenza dal keyframe precedente; verifica integrità file parziale.
10. Rilevamento reload: flag `jobRunning` in localStorage, se pagina carica con flag attivo → proporre "Riprendi" e dimezzare i budget (frame in volo, risoluzione intermedia).
11. Wake Lock richiesto all'avvio e ri-richiesto su `visibilitychange`; se pagina nascosta → mettere in pausa e salvare checkpoint; UI "Tieni l'app aperta e lo schermo acceso". Richiede iOS ≥ 18.4 per PWA standalone.
12. Chiamare `navigator.storage.persist()` all'installazione; prima del job controllare `estimate()` e richiedere spazio ≥ 2.5× dimensione input (input copia + output + margine); gestire `QuotaExceededError`.
13. Consegna: `File` da OPFS `getFile()` con `navigator.share({files})` su tap utente, con `canShare` e fallback "Salva in File"; nessuna copia in ArrayBuffer/Blob in memoria; pulire OPFS dopo conferma.
14. Telemetria locale: registrare picchi (frame in volo, bytes scritti) in OPFS per diagnosi dopo un kill.

## Test da eseguire su device

1. Stress di memoria: allocare ArrayBuffer da 100 MB crescenti in tab Safari e in PWA standalone fino al reload; annotare il totale (confronto con 1.5 / 2 / 3 GB). Ripetere con WASM memory e con texture WebGPU/VideoFrame mantenuti aperti per vedere se IOSurface conta.
2. VideoFrame non chiusi: decodificare HEVC 1080p60 HDR tenendo N frame; osservare quando il decoder si blocca (pool) o la pagina si ricarica.
3. Soglie backpressure: misurare throughput e picco memoria con decodeQueue 2/4/8/16 ed encodeQueue 2/4/8.
4. `VideoDecoder.isConfigSupported` per hvc1 Main10 HLG/PQ, `VideoEncoder` HEVC/H.264 10-bit su iOS 27; verifica `colorSpace` mantenuto.
5. `<input type=file>` da Libreria Foto: confrontare `file.size` con originale (transcodifica?), tempo di copia, lettura slice() per 3+ GB e per oltre 60 s; confronto con selezione da File.
6. OPFS: scrittura 1/2/4/8 GB con createSyncAccessHandle e con createWritable (iOS 27); `estimate()` prima/dopo; `persist()` ritorno in PWA.
7. `navigator.share({files:[file OPFS]})` con file 300 MB / 1 GB / 3 GB: footprint durante lo share, comparsa di "Salva video", successo del salvataggio in Foto; fallback `<a download>`.
8. Background: bloccare lo schermo e cambiare app durante il job a 10 s/60 s/5 min; verificare ripresa, `device.lost`, stato dei codec, reset della pagina; con e senza Wake Lock, tab vs PWA.
9. Wake Lock in PWA standalone su iOS 27: acquisizione, rilascio a `visibilitychange`, ri-acquisizione.
10. Resume: uccidere la pagina (swipe) a metà job e verificare ripresa dal checkpoint con output valido.
11. Verifica che `performance.memory`/`measureUserAgentSpecificMemory` siano assenti e testare il metodo euristico "reload flag".
12. Log: collegare il device al Mac (Console.app / Web Inspector) per leggere eventi jetsam (`per-process-limit`) e messaggi MemoryPressure durante tutti i test.
