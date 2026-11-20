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
