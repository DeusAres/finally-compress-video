# 13 - Export "in background" su Safari iOS: PiP, audio, altre strade

Legenda: ✅ fonte primaria (WebKit bugzilla/source, Apple) / 🟡 secondaria (blog, forum, StackOverflow) / ❓ da testare su device.
Nota: nessuna fonte trovata su iOS 27 specifico; i dati arrivano da iOS 17-26. Tutto ciò che segue va riverificato su iPhone 17 Pro Max.

## 1. PiP: la pagina resta viva?

- ✅ Apple (Frameworks Engineer, forum, mar 2025): su iOS la sospensione di JS in background è *intenzionale*, "non si può controllare"; consigliato salvare un timestamp di inizio e ricalcolare al ritorno. https://developer.apple.com/forums/thread/777860
- 🟡 Test dev: un `setInterval` gira ~7-8 s dopo il passaggio in background, poi si ferma (stessa thread). Firtman: Safari/PWA vengono *sospesi* (non killati), JS context in memoria ma timer/animazioni fermi; ~3 s di grazia. https://firt.dev/understanding-js-background/
- ✅ Meccanismo WebKit: il WebProcess viene sospeso dal `ProcessThrottler` salvo "foreground/background activity" (media playback = attività che tiene l'assertion). Timeout di sospensione ~20 s (non confermato per tutte le piattaforme). https://webkit.googlesource.com/WebKit/+/e7faecc4fcb24350646e1305ac734c97b2abfc44/Source/WebKit/UIProcess/ProcessThrottler.cpp ; commit bug 269938 (grace period 10 s per avviare audio in bg, regressione iOS 17.2) https://lists.webkit.org/pipermail/webkit-changes/2024-February/298318.html
- ✅ Il PiP in sé: nessun codice/documento trovato che dica "PiP tiene vivo JS". Un bug WebKit sui sottotitoli PiP dice che in background il *layer tree viene congelato* (https://bugs.webkit.org/show_bug.cgi?id=220660) -> indizio che il PiP mostra solo ciò che il media pipeline riproduce, non che la pagina giri. ❓ Se la riproduzione media (video file/stream) tenga viva la pagina in PiP: plausibile (come per l'audio), ma NON documentato.
- ✅ PWA standalone: `requestPictureInPicture()` NON funziona nelle Home Screen Web Apps (NotSupportedError o no-op; `document.pictureInPictureEnabled` mente `true`; `webkitSupportsPresentationMode('picture-in-picture')` = false). Bug aperto (rdar://121964774), ultimo aggiornamento ago 2026, riprodotto su iOS 26.6. https://bugs.webkit.org/show_bug.cgi?id=303885 (v. anche 252765).
  -> Con la PWA installata il PiP è di fatto escluso; solo tab Safari. ❓ iOS 27.
- 🟡 PiP automatico (autopip on background) su iOS: richiede video in riproduzione con audio; non c'è API web per forzarlo; ❓.

## 2. Trucco audio in background

- ✅ Eric Carlson (WebKit): "il web process, normalmente sospeso in background, resta vivo mentre riproduce audio". https://bugs.webkit.org/show_bug.cgi?id=173332
- ✅ Ma: `audio.play()` *avviato* in background/schermo bloccato non fa nulla; solo audio già in corso continua. `ended` può non scattare (task sospeso) -> loop deve essere `loop=true`, non catena di eventi. https://bugs.webkit.org/show_bug.cgi?id=173332
- ✅ AudioContext sospeso in background su iOS 17.0-17.3 (regressioni), fix in main mar 2024, stabile ~17.5; `navigator.audioSession.type='playback'` aiuta. Comportamento = quello di `<audio>`. https://bugs.webkit.org/show_bug.cgi?id=261554
- 🟡 Trucco "silent audio loop" (libreria unmute: traccia HTML audio silenziosa per portare Web Audio sul canale media) https://github.com/swevans/unmute ; 🟡 report che un secondo `<audio>` silenzioso non sempre funziona; 🟡 PWA standalone perde audio dove Safari lo mantiene, ancora segnalato su iOS 26 (risultati ricerca, thread vari).
- Media Session API (`navigator.mediaSession.metadata`, action handlers) fornisce controlli lock-screen e segnala "sessione attiva"; ❓ se prolunga la vita oltre l'audio stesso (probabilmente no: conta l'attività media reale).
- Rischi: audio silenzioso = uso abusivo; Apple può restringere (nessuna garanzia, ❓ iOS 27). Altri audio (chiamate, Siri, musica dell'utente) interrompono la sessione -> `pause` e processo sospeso entro ~secondi. Jetsam: processo in bg con memoria alta è il primo killato. Batteria: CPU+GPU per encode + audio.
- Schermo bloccato: l'audio continua (è il caso d'uso previsto), quindi il processo resta vivo; ❓ se timer/Worker/GPU non vengano throttled (vedi §5).

## 3. PiP con MediaStream da canvas

- ✅ Esiste e funziona in Safari iOS: `canvas.captureStream()` -> `video.srcObject` -> PiP; bug "ghost PiP" (secondo finestra) fissato in iOS 17.6.1. https://bugs.webkit.org/show_bug.cgi?id=277804
- ✅ Storia: canvas 2D captureStream su iOS non riproduceva (nero) fino a ~15.4; WebGL ok prima. https://bugs.webkit.org/show_bug.cgi?id=181663 ; 235215
- Vita della pagina: ❓. Uno stream da canvas non è audio; il frame viene prodotto *dal JS della pagina*, quindi se il processo è sospeso lo stream si congela (circolare). Serve una sorgente che mantenga attività (audio nel MediaStream: `AudioContext.createMediaStreamDestination()` + oscillatore a gain 0 aggiunto alla stream) ❓.
- Non in PWA standalone (§1).

## 4. Altre strade

- Background Fetch / Background Sync / Periodic Sync: ✅ non supportati in WebKit (nessun supporto Safari iOS). Inutili: l'export è CPU locale, non rete.
- Service Worker: ✅ vive solo ad eventi (push/fetch), terminato presto; niente WebCodecs? (WebCodecs nel SW non garantito) ❓; non adatto a export di minuti. Staff Apple cita SW solo per macOS (thread 777860).
- Web Locks: tiene un lock ma non impedisce la sospensione del processo. ❓ (nessuna fonte che lo preveda).
- Screen Wake Lock: ✅ solo schermo acceso; supportato nelle Home Screen Web Apps da iOS 18.4 (bug 254545). Utile come *mitigazione principale*: l'utente lascia l'app in primo piano, schermo non si spegne. Si rilascia al cambio app.
- Split View / Stage Manager: solo iPad (due app visibili = entrambe in foreground). Non iPhone.
- Guided Access: blocca l'iPhone su un'app (impedisce di cambiare app) -> non è "background", ma consente di tenere schermo acceso e usare solo l'app; con Wake Lock = export affidabile ma con telefono dedicato. 🟡 impostazione utente, non controllabile dalla PWA.
- Realistico su iPhone: (a) Wake Lock + istruzione "tieni aperta"; (b) esportazione resumable: salvare avanzamento in OPFS (chunk/GOP, keyframe) e riprendere al `visibilitychange`/`pageshow`; (c) audio+PiP come tentativo best-effort, solo in tab Safari, da validare. Notifica (Web Push richiede PWA standalone) per avvisare "torna all'app" 🟡 firt.dev.

## 5. Rischi per VideoEncoder/Decoder/WebGPU/seek in bg (pagina viva)

- ❓ Nessuna documentazione. Ipotesi: la GPU process ha propria assertion (bug 2020: "GPU process sempre in background, mai foreground" per media playback, https://www2.webkit.org/show_bug.cgi?id=208250). Con pagina in background: WebGPU/canvas rendering viene throttled/sospeso (layer tree frozen, rAF non gira in hidden); `requestVideoFrameCallback` dipende da compositing -> ❓ può non scattare in background.
- Hardware encode (VideoToolbox) è a livello di sistema e in genere utilizzabile da app in bg con limiti; su Safari ❓ decode/encode HW può essere negato o rallentato (GPU priority bassa). Seek su `<video>` + decode: MediaPlayer può essere pausato (document hidden). Soluzione: spostare decode su `VideoDecoder` (WebCodecs, in Worker) invece di `<video>`+rVFC.
- Timer: in hidden i `setTimeout` vengono throttled (≥1 s); usare `MessageChannel`/loop continuo nel Worker. Worker + OPFS sync access handle: ❓ sospeso con il processo.
- Memoria: ✅/🟡 jetsam su iOS killa prima i processi in bg con alto footprint; pagina in bg con frame decodificati/GPU texture grandi = rischio alto. Minimizzare buffer (backpressure su `encodeQueueSize`, `VideoFrame.close()`).
- Aggiuntivo: se il WebProcess viene killato, la PWA ricarica la pagina: avere checkpoint su OPFS.

## Conclusione

- PiP *non* è documentato come meccanismo che tenga vivo JS. Con PWA installata il PiP non funziona proprio (bug 303885, aperto). Su tab Safari: possibile solo se la riproduzione media tiene vivo il WebProcess, ❓.
- L'unico meccanismo supportato in WebKit per tenere vivo il processo è la *riproduzione audio effettiva* (Carlson, bug 173332); ma sfruttarlo con audio silenzioso è fragile, rischia rifiuto/regressioni, e anche con processo vivo GPU/WebGPU/rVFC/seek in background sono ❓ e probabilmente throttled.
- Strategia consigliata: Wake Lock + export resumable con checkpoint su OPFS + avviso all'utente a non cambiare app; PiP/audio come esperimento opzionale, solo tab Safari, dopo misure sul device.

## Piano di test su device (iPhone 17 Pro Max, iOS 27)

Pagina servita via HTTPS. Testare 4 matrici: {tab Safari, PWA} x {Home, altra app, blocco schermo} x {PiP canvas, audio silenzioso, nulla (baseline)}. Per ogni caso: 60 s in bg, poi tornare e leggere il log (timestamp, lacune).

Log comune (persistente, sopravvive alla sospensione):
```js
const log = [];
const t0 = performance.now();
function mark(src){ log.push([src, Date.now(), Math.round(performance.now()-t0), document.visibilityState]); }
// Main thread timer
setInterval(()=>mark('main-1s'), 1000);
// rAF
(function r(){ mark('raf'); requestAnimationFrame(r); })();
// Worker timer (testa anche il thread worker)
const w = new Worker(URL.createObjectURL(new Blob([`
  setInterval(()=>postMessage(Date.now()),1000);`],{type:'text/javascript'})));
w.onmessage = e => log.push(['worker', e.data, 0, document.visibilityState]);
document.addEventListener('visibilitychange', ()=>mark('vis'));
function report(){
  const by={}; log.forEach(([s,t])=>{(by[s]??=[]).push(t)});
  const out={};
  for(const [s,a] of Object.entries(by)){
    let maxGap=0; for(let i=1;i<a.length;i++) maxGap=Math.max(maxGap,a[i]-a[i-1]);
    out[s]={n:a.length,maxGapMs:maxGap};
  }
  document.body.insertAdjacentHTML('beforeend','<pre>'+JSON.stringify(out,null,1)+'</pre>');
}
```
Lettura: `maxGapMs` >> 1000 per main/worker = sospeso. Se `worker` gira ma `main` no (o viceversa) annotarlo. Confrontare con baseline.

Test A: PiP con canvas stream che mostra % + audio muto opzionale:
```js
const c = document.createElement('canvas'); c.width=320; c.height=180;
const g = c.getContext('2d'); let pct=0;
function draw(){ pct=(pct+0.1)%100; g.fillStyle='#000'; g.fillRect(0,0,320,180);
  g.fillStyle='#fff'; g.font='48px sans-serif'; g.fillText(pct.toFixed(1)+'%',40,100);
  g.font='16px sans-serif'; g.fillText(new Date().toISOString().slice(11,23),40,140);
  mark('draw'); }
setInterval(draw, 100);
const v = document.createElement('video');
v.muted = true; v.playsInline = true; v.srcObject = c.captureStream(10);
document.body.append(v);
btn.onclick = async () => {              // gesto utente
  await v.play();
  console.log('PiP supported', document.pictureInPictureEnabled, v.webkitSupportsPresentationMode?.('picture-in-picture'));
  try { await v.requestPictureInPicture(); } catch(e){ // fallback iOS
    v.webkitSetPresentationMode?.('picture-in-picture'); console.log(e); }
};
```
Poi Home -> attendere 60 s -> riaprire -> `report()`. Osservare anche se il numero nel PiP avanza (stream vivo) e il gap di 'draw'. Variante con audio: aggiungere al MediaStream una traccia da `AudioContext.createMediaStreamDestination()` + oscillatore con gain 0.

Test B: audio silenzioso in loop (tab e PWA):
```js
btnAudio.onclick = async () => {
  navigator.audioSession && (navigator.audioSession.type = 'playback');
  const ctx = new AudioContext();
  const osc = ctx.createOscillator(), gain = ctx.createGain(); gain.gain.value = 0.0001; // ~silenzio ma non zero
  osc.connect(gain).connect(ctx.destination); osc.start();
  // variante <audio>: src = WAV silenzioso di 1 s, loop=true
  const a = new Audio(URL.createObjectURL(silentWavBlob)); a.loop = true; await a.play();
  navigator.mediaSession.metadata = new MediaMetadata({title:'Esportazione in corso', artist:'Compress'});
  navigator.mediaSession.setActionHandler('pause', ()=>{});
};
// silentWavBlob: 1 s di PCM 16-bit mono 8 kHz a zero con header WAV
```
Poi Home / altra app / blocco schermo 60 s e 5 min; `report()`. Provare anche con `gain=0` esatto (può essere ottimizzato e non contare come riproduzione ❓).

Test C (rilevante per l'export): in condizioni B/A vive, eseguire dentro il Worker un loop `VideoEncoder` HEVC con frame sintetici (OffscreenCanvas / `VideoFrame` da ArrayBuffer) e loggare frame/s per finestra di 5 s; poi lo stesso con `VideoDecoder` di un file; poi `<video>` seek + `requestVideoFrameCallback` (conta callback/s); infine WebGPU `queue.onSubmittedWorkDone()` latenza. Confrontare fg vs bg: se encode gira ma rVFC/WebGPU no, riprogettare con decode via WebCodecs e senza canvas/WebGPU in bg.

Test D: Wake Lock baseline: `await navigator.wakeLock.request('screen')` in PWA e tab; verificare che lo schermo resti acceso 5 min e il log non abbia gap.

Test E: memoria: lanciare export reale con `performance.measureUserAgentSpecificMemory` non disponibile su iOS -> osservare se la pagina viene ricaricata (log azzerato) dopo 2-5 min in bg; registrare `pageshow` con `event.persisted` e un contatore in `sessionStorage`.

Criterio di successo: gap massimo di 'main', 'worker' e 'draw' < 2 s per 5 min con app in bg e schermo bloccato, e throughput encode in bg >= 80% del fg. Altrimenti: scartare PiP/audio e adottare solo Wake Lock + resume.

## Risultato su device (iOS 27, 2026-11-20)

Test su iPhone (Safari iOS 27) con il «test background con audio» (keep-alive `<audio>` + Web Audio + Media Session) durante l'export a segmenti.

- **JS vivo in background con l'audio**: il battito del log continua da `hidden` (heartbeat ogni ~2 s, throttled rispetto al secondo richiesto), nessuna sospensione del processo.
- **Decodifica/seek del `<video>` sospesa**: nello stesso intervallo il lavoro reale avanza di 2 fotogrammi in 12.4 s di background. Il `seeked` non arriva finché la pagina non torna `visible`; al ritorno il `<video>` non rispondeva più ai seek e l'app restava ferma ~8 s fino a «seek timeout», poi ripartiva (da capo se nessun segmento era completo).
- **Conclusione**: con l'architettura seek-`<video>` + VideoEncoder il background non è ottenibile: l'audio tiene vivo il JS, non la pipeline di decodifica media. Il test resta disponibile ma marcato sperimentale. La **ripresa è la mitigazione**: su `hidden` la run video viene interrotta subito (AbortController, nessuna attesa del timeout di seek, che resta a ~4 s solo per guasti reali), su `visible` si ricrea l'elemento `<video>` dal File e si riparte dall'ultimo segmento completato, senza consumare i 3 tentativi automatici (log «ripreso dopo X s in background dal segmento n»).

## Round 2: workaround (dopo la misura su iPhone 17 Pro Max, iOS 27)

Fatto misurato: con `<audio>` loop quasi muto + AudioContext il JS resta vivo (timer ~2 s) ma seek + rVFC + `new VideoFrame(video)` NON avanzano (2 frame/12 s) e al ritorno il `<video>` non risponde ai seek finche' non viene ricreato. Legenda: ✅ fonte primaria / 🟡 secondaria / ❓ da testare (pannello `tools/diag/bg-test.html`).

### R2.1 GPU process / VideoToolbox in background (domanda 1)
- ✅ Il GPU process ha asserzioni di processo proprie, separate dal WebContent: il bug 208250 (2020) dice che "il GPU process non va mai in foreground" ed e' richiesto per la riproduzione media su iOS; 259219 (2023) lo fa rilasciare l'asserzione media con timer per evitare che il GPU process si sospenda mentre chiude lo stack media; 239815: il GPU process non riceveva la notifica di sospensione imminente. https://bugs.webkit.org/show_bug.cgi?id=208250 , https://bugs.webkit.org/show_bug.cgi?id=259219 , https://bugs.webkit.org/show_bug.cgi?id=239815
  Lettura: l'asserzione del GPU process e' legata ad attivita' *media* (playback/capture), non a "WebContent e' vivo". Con un `<audio>` che suona il GPU process puo' restare attivo, ma cio' non implica che il compositing/rendering dei `<video>` sia attivo.
- ✅ Nessun documento Apple/WebKit afferma che VideoToolbox (encode/decode HW) sia vietato o consentito per le pagine web in bg. Il divieto "no GPU in background" di Apple riguarda i comandi Metal/OpenGL delle app (tipicamente `kIOGPUCommandBufferCallbackErrorBackgroundExecutionNotPermitted`); VT usa media engine dedicato e le app con audio in bg lo usano (registrazione/transcode). ❓ Se il processo GPU di WebKit rallenti/neghi VT: da misurare (test c/d).
- 🟡 Spec: w3c/webcodecs #889: l'unico modo per evitare che un VideoDecoder attivo in bg sia "reclaimed" e' avere un VideoEncoder/AudioEncoder attivo sullo stesso global. Indizio di design (non WebKit-specifico) che un encoder attivo tiene vivo il codec stack. https://github.com/w3c/webcodecs/issues/889
- 🟡 Feature request Apple forum (2025): "WebRTC e Web Audio vengono sospesi appena lo schermo si blocca o Safari va in bg", nessuna risposta Apple, nessun workaround documentato. https://developer.apple.com/forums/thread/774239 ; thread webkit-dev apr 2025 chiede se WebCodecs+canvas o VideoTrackGenerator+`createMediaStreamDestination` aggirino i limiti (domanda, nessuna risposta verificata) https://lists.webkit.org/pipermail/webkit-dev/2025-April/032748.html
- Ipotesi coerente con la misura: il JS vive per l'audio; encoder/decoder WebCodecs (pure GPU-process, senza DOM) plausibilmente girano ❓ (probabilita' stimata media-alta); cio' che muore e' la parte *legata al rendering* del `<video>` (media player "non visibile": seek/frame presentati richiedono il layer/compositing).

### R2.2 `<video>` in riproduzione / PiP e rVFC (domanda 2)
- ✅ rVFC e' implementato sopra `copyDisplayedPixelBuffer`: bug 282797 "rVFC non chiama mai la callback se la finestra e' nascosta" (causa: nessun pixel buffer quando il video non e' realmente renderizzato), FIXED in 286853@main (nov 2024). https://bugs.webkit.org/show_bug.cgi?id=282797 ; correlato: callback non chiamata con video in pausa/non visibile (bug 282782, dic 2024). Il fix riguarda il caso "nascosto" nei test; ❓ non conferma il comportamento in app-background iOS.
- ✅ PiP: il layer tree viene congelato in bg salvo video in PiP (fix 220660 / commit "Video freezes in PiP mode", nov 2023) -> in PiP il video continua a essere *presentato* dal sistema. https://bugs.webkit.org/show_bug.cgi?id=220660 , https://lists.webkit.org/pipermail/webkit-changes/2023-November/294040.html
- ❓ Che la pagina (JS + rVFC + `new VideoFrame(video)`) giri in PiP: nessuna evidenza; e' il test (e) con pulsante PiP. Se in PiP rVFC scatta, `new VideoFrame(video)` ha buone chance (pixel buffer realmente presentato). PWA standalone: niente PiP (bug 303885).
- Plausibilita': in PiP la riproduzione e' reale (decoder HW attivo, frame presentati) quindi rVFC e' la strada piu' promettente; il seek in bg no (misurato).
- Frame-exact in riproduzione (~89 % a 0.5x): idea a "passate multiple": 1) passata play a 0.5x con rVFC, registra `mediaTime` (metadata.mediaTime) e salva per ogni timestamp il frame (encode subito, ordine per mediaTime); 2) i timestamp mancanti rispetto al demuxer (Mediabunny) = lista M; 3) ripetere la riproduzione con `currentTime` posizionato ~0.5 s prima di ciascun cluster di mancanti (seek in fg/PiP o a inizio passata) e catturare solo quelli di M; 3-4 passate convergono (~10 % -> ~1 % -> ~0.1 %). Costo: tempo reale 2x-4x la durata del clip (a 0.5x); alternativa: encoder fuori ordine impossibile (VT vuole ordine) -> bufferizzare frame decodificati e' vietato (memoria): quindi 1a passata = solo *scansione* (raccogli mediaTime catturati), le passate successive = encode, oppure encodare frame-per-frame con "buchi riempiti" ripetendo il frame precedente (qualita' degradata, ma frame-count esatto, VFR). ❓ Test (e) misura il tasso rVFC; ❓ `mediaTime` iOS impreciso (bug 260798 https://bugs.webkit.org/show_bug.cgi?id=260798) -> serve confronto con PTS del demuxer a tolleranza.
- Realismo: reale in teoria, ma vincolato al tempo reale (clip 10 min = 20+ min a 0.5x) e a PiP attivo (UX fragile: l'utente deve avviare PiP; il sistema chiude PiP con chiamate ecc.).

### R2.3 Decodifica/codifica fuori da `<video>` (domanda 3)
- ✅ Safari WebCodecs `VideoDecoder` HEVC restituisce NV12 8-bit (doc 02 §3) -> perde 10-bit; usabile solo come fallback "8-bit in bg" (HDR degradato a 8-bit HLG con banding) 🟡.
- 🟡 Decoder HEVC WASM single-thread: ~61 fps 1080p su Apple Silicon Mac (Chrome), 4K ~21 fps (https://dev.to/privaloops/playing-hevc-in-a-browser-without-plugin-an-h265-decoder-in-webassembly-4ag0 , https://github.com/privaloops/hevc.js); libde265.js piu' lento/uguale. Su iPhone ❓ stima 20-40 fps 1080p, 5-10 fps 4K; ma output I420P10 non costruibile in VideoFrame (doc 02 §10 run 6) -> non alimenta l'encoder 10-bit: escluso per HDR. Per SDR 8-bit sarebbe fattibile ma gia' coperto da VideoDecoder.
- ❓ Worker in bg con audio: i Worker appartengono al WebContent process (stesso ProcessThrottler) -> vivi se il processo e' vivo; test (b),(c),(d) in Worker vs main.
- Encoder SW (x265 wasm / openh264): 🟡 CPU-bound su iPhone, 1080p ~1-5 fps x265 medium; openh264 ~15-30 fps; thermal throttling in bg; scarsa convenienza rispetto al VT. Non realistica per export lungo; ok solo emergenza/anteprima.

### R2.4 Altre idee (domanda 4)
- Web Locks ❓/🟡: non tiene vivo il processo (nessuna fonte che lo preveda). SharedWorker: stesso processo (iOS 16+) -> nessun beneficio. Service Worker: vita a eventi, no WebCodecs garantito (v. §4) -> ❌ probabile.
- WebRTC: ✅ la regola WebKit: capture attivo (getUserMedia mic) *tiene il processo vivo* in bg (bug 255869 e altri: "when capturing microphone the page will not be suspended"); ma richiede indicatore microfono arancione + permesso mic: invasivo, UX inaccettabile per un compressore video. Loopback RTCPeerConnection senza capture: 🟡 sospeso (thread Apple 774239). ❓ Non raccomandato.
- Media Session + `<video>` muto: ❓ la policy WebKit (MediaSessionManagerCocoa / `canPlayToWirelessPlaybackTarget`/ PlatformMediaSessionManager) riconosce "background playable" solo con audio realmente udibile/non muted; video muto -> viene fermato in bg (comportamento Safari noto) 🟡. Test (e) muto vs (g) audio.
- Tab vs PWA: PWA niente PiP (303885); audio in bg in PWA piu' fragile 🟡. Tab Safari = unica via.
- ✅ Esperienza prodotto reale: Wake Lock + resumable + avviso restano la base.

### R2.5 Valutazione onesta
| Strada | Probabilita' | Note |
|---|---|---|
| Wake Lock + resume OPFS (nessun bg) | ✅ alta | gia' misurato fattibile; e' il percorso principale |
| Audio keep-alive + encoder WebCodecs (decode altrove) | 🟡 media | JS vive (misurato); encoder ❓ test c/d |
| Riproduzione `<video>` in PiP + rVFC (+ passate di recupero) | 🟡 bassa-media | richiede PiP manuale, tempo reale; test (e) |
| Seek `<video>` in bg | ❌ misurato non funziona | |
| VideoDecoder 8-bit in bg | 🟡 media (se (d) ok) | perde 10-bit/HDR (NV12 8-bit) |
| WASM HEVC decoder | ❌ per HDR | niente I420P10 -> encoder |
| Encoder SW wasm | ❌ | troppo lento/termico |
| getUserMedia mic come keep-alive | 🟡 funziona forse, ❌ UX | permesso + indicatore |
| Web Locks / SharedWorker / SW / Background Fetch | ❌ | nessun meccanismo supportato |

Raccomandazione: eseguire il pannello `bg-test.html` (60 s, 10 s fg + 40 s bg) in 4 combinazioni: {nessun keep-alive, audio} x {Worker, main} e una con PiP attivato; poi decidere. Se (c)+(d) sono VIVI e (e) in PiP e' VIVO si puo' progettare un export "foreground-first con degradazione": fg = seek 10-bit, bg = switch automatico a playback PiP/VideoDecoder 8-bit (mixed quality da dichiarare) -- altrimenti restare su Wake Lock + resume.

## Risultato test bg-test.html su device (iOS 27.0.1, tab Safari, 2026-11-20) ✅
Config: codec avc1.42001f, sottotest a–f in Worker, **keep-alive audio NON attivo**; fg 16.1 s, bg 43.9 s.
| sottotest | fg/s | bg/s | bg/fg | esito |
|---|---|---|---|---|
| a setInterval main | 1.0 | 0.5 | 51 % | RIDOTTO (1 ogni 2 s) |
| b setInterval Worker | 0.9 | 1.0 | 108 % | **VIVO** |
| c VideoEncoder (H.264, frame da OffscreenCanvas, Worker) | 497 | 461 | 93 % | **VIVO** |
| d VideoDecoder | 1218 | 0 | 0 % | **FERMO** — "Decoder failure" esattamente al passaggio in hidden |
| e rVFC su <video> in riproduzione | 48.7 | 0 | 0 % | FERMO |
| f seek+VideoFrame | 0 in fg | — | — | test rotto (già misurato nell'app: fermo in bg) |
**Conclusione**: in background iOS 27 lascia vivi Worker e **encoder hardware**, ma **revoca la decodifica hardware** (VideoDecoder fallisce, <video> si ferma). Le uniche decodifiche possibili in bg sono software (WASM) → frame 8-bit, incompatibili con i segmenti Main10 HLG dello stesso file. ⇒ **Export HDR/Dolby Vision in background non ottenibile dal browser**. Mitigazione adottata: Wake Lock + ripresa immediata dall'ultimo segmento (v0.20). Variante scartata: modalità "background SDR 8-bit" con decoder WASM (perde HDR, lenta).

## SVOLTA: Picture-in-Picture tiene la pagina attiva (iOS 27.0.1, tab Safari, 2026-11-20) ✅
Test bg-test.html con PiP attivato su un <video> in riproduzione muta (sottotest e), utente uscito da Safari e rientrato più volte:
- `visibilityState` resta **"visible"** per tutta la durata (iOS non segnala mai il background) → nessun throttling.
- Tutto continua a piena velocità: Worker/setInterval 1/s, VideoEncoder ~470–500 chunk/s, **VideoDecoder ~860–1100 frame/s**, rVFC su video in riproduzione ~41–45/s e — con il test seek corretto (rVFC richiesto prima del seek) — **seek + new VideoFrame su un SECONDO <video> ~31–37 frame/s**, 1 solo timeout in 20 s.
- Senza PiP (test precedente): decodifica revocata in bg ("Decoder failure"), <video> fermo.
⇒ **Export HDR in background possibile tenendo attiva una PiP** (video separato in riproduzione muta, avviata con un tap). Limiti: solo tab Safari (PWA standalone: requestPictureInPicture non funziona, bug WebKit 303885); se l'utente chiude la PiP fuori da Safari la pagina va in bg → ripresa dall'ultimo segmento (v0.20).
- **Prova v0.22 su device (IMG_2176, 25.5 s, 2026-11-20)**: PiP aperta 21.8 s, pagina mai nascosta, ~59 fps costanti, nessuna interruzione → PiP confermata. Estrazione parallela: player 2 non ha confermato il frame 3 (rVFC assente dopo ~1 s) → fallback immediato a 1 player (file corretto, 1527/1527, 0 doppioni). Fix v0.22.1: fino a 3 tentativi sullo stesso frame prima del fallback.
- **v0.23 su device (IMG_2034, 14.4 s, utente FUORI da Safari)**: PiP + estrazione parallela a 2 player → **91 fps**, 433+433 frame, 0 doppioni/fuori posto/callback mancanti, pagina mai nascosta; bitrate reale 8.01 Mbps su target 8 grazie al controllo a circuito chiuso (encoder portato a 9.4 Mbps); PiP chiusa correttamente a fine job. ⇒ PiP e parallela convivono (il fallimento precedente era un intoppo all'attivazione PiP, gestito dai 3 tentativi). v0.24: parallela ON di default, jingle di fine, notifica (solo web app installata).
