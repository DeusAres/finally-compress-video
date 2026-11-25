#!/usr/bin/env node
// Sonda della CODA (v0.36) in Chromium/Playwright, con 3 copie H.264 del campione (+ il campione HEVC come voce che fallisce:
// il <video> di Chromium non lo decodifica). Strumentazione e mappatura hvc1 → avc1 solo in pagina di prova: probe_kit.mjs.
// navigator.share/canShare sono simulati (registrano i file condivisi; modalità 'fail' = condivisione multipla rifiutata).
//
// Scenari: 1) coda completa [A,B] + C aggiunto mentre lavora (va in fondo) → «Salva tutti» (3 file in un gesto)
//          2) [A, HEVC, B, C]: C rimosso prima di partire, A annullata a metà, HEVC in errore → la coda prosegue, B fatto;
//             «Riprova» su A; «Salva tutti» rifiutato → un tasto per file
//          3) ripresa: [A,B,C], ricarica durante la voce 2 → coda ripristinata, A salvabile, B/C da riselezionare →
//             «Riseleziona i video» → B riprende dai segmenti (RIPRESA nel log) → «Salva tutti»
//          4) «Ferma la coda» durante una voce → la voce resta in attesa e riprende dai segmenti
//          5) un solo file = esperienza singola; «Aggiungi altri video» → coda; trascinamento di più file (+ un non video)
//          6) (v0.36.2) risorse media costanti fra le voci: coda di 5 voci con qualità per scena e 2 player, PiP preparata
//             (Chromium: PiP simulata come disponibile); durante ogni voce (player aperti) conta i <video> con src anche FUORI
//             dal DOM, quelli in riproduzione, i <video> creati in tutto, encoder/decoder aperti: devono restare costanti
//             (nessun <video> nuovo dopo la voce 1, un solo <video> PiP per tutta la coda). Riga «risorse:» nel log per voce.
//          7) (v0.36.2) seek bloccato simulato (il setter di currentTime di un <video> fuori DOM smette di fare seek):
//             a) un player si blocca → si continua con l'altro, il bloccato è ricreato, voce fatta;
//             b) ogni player si blocca sempre → ricreati, voce riprovata UNA volta con player nuovi, poi errore (guasto reale non
//                mascherato) e la voce successiva (sblocco) è fatta con <video> nuovi.
// Misure (GC forzato) a ogni passaggio fra voci e a riposo: Blob URL, VideoFrame, encoder/decoder, Worker, <video>, OPFS.
// Screenshot (--shots <dir>): lista, lavoro e fine coda a 320/375/390 px, chiaro e scuro; controllo overflow orizzontale.
//
// Uso: node tools/lab/queue_probe.mjs [--sample samples/IMG_7440.mov] [--shots <dir>] [--only 1,2,3,4,5]
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { arg, makeSamples, startServer, openProbe, SNAP_COLS } from './probe_kit.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = resolve(REPO, arg('--sample', 'samples/IMG_7440.mov')), SHOTS = arg('--shots', ''), ONLY = arg('--only', '1,2,3,4,5,6,7').split(',');
const [A, B, C, D, E] = makeSamples(SRC, 5, 'coda');
const server = await startServer(REPO);
const PIP = () => { // Chromium headless: PiP «disponibile» (la richiesta vera non serve: conta il <video> preparato)
  try { Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { get: () => true, configurable: true }); } catch {}
  if (!HTMLVideoElement.prototype.requestPictureInPicture) HTMLVideoElement.prototype.requestPictureInPicture = async function () { return {}; };
};
const HANG = () => { // seek bloccato simulato: window.__hang.budget = quanti <video> (fuori DOM) bloccare, dal seek n. `after` in poi
  const H = window.__hang = { budget: 0, after: 3, els: new WeakSet(), seen: new WeakMap(), n: 0 };
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get() { return d.get.call(this); }, set(v) {
    if (H.els.has(this)) return;
    const k = (H.seen.get(this) || 0) + 1; H.seen.set(this, k);
    if (H.budget > 0 && !this.isConnected && k >= H.after) { H.budget--; H.n++; H.els.add(this); return; }
    d.set.call(this, v);
  } });
};
const SHARE = () => {
  window.__shared = []; window.__shareMode = 'ok';
  navigator.canShare = (d) => !!d?.files?.length;
  navigator.share = async (d) => { if (window.__shareMode === 'fail' && d.files.length > 1) throw new DOMException('troppi file (simulato)', 'NotAllowedError'); window.__shared.push(d.files.map((f) => `${f.name}:${f.size}`)); };
};
const { browser, page, errors, snap, logTail } = await openProbe(server.base, { extraInit: [PIP, HANG, SHARE], viewport: { width: 390, height: 844 } });
page.on('dialog', (d) => d.accept());

const fails = [], ok = (cond, what) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${what}`); if (!cond) fails.push(what); };
const rows = []; const rec = async (scen, extra = '') => { const s = await snap(); rows.push({ scen, ...s, extra }); return s; };
const sts = () => page.$$eval('.fcv-q-item', (els) => els.map((e) => e.dataset.st + (e.hasAttribute('data-nf') ? '*' : '')));
const stage = () => page.$eval('#app', (r) => `${r.dataset.stage}/${r.dataset.busy}`);
const logAll = () => page.evaluate(() => [...document.querySelectorAll('[data-ref="log"] div')].map((d) => d.textContent).join('\n'));
const waitIdle = async (ms = 240000) => page.waitForFunction(() => document.querySelector('#app').dataset.busy === 'false', null, { timeout: ms })
  .catch(async (e) => { console.log('TIMEOUT', await sts(), '\n' + (await logTail(25))); throw e; });
const waitSt = (i, st, ms = 120000) => page.waitForFunction(([i, st]) => document.querySelectorAll('.fcv-q-item')[i]?.dataset.st === st, [i, st], { timeout: ms })
  .catch(async (e) => { console.log('TIMEOUT stato', i, st, await sts(), '\n' + (await logTail(25))); throw e; });
const waitInfo = () => page.waitForFunction(() => [...document.querySelectorAll('.fcv-q-item')].every((li) => !/lettura…/.test(li.textContent)), null, { timeout: 60000 });
const sceneOff = () => page.evaluate(() => { const c = document.querySelector('input[name="fcv-sceneq"]'); if (c.checked) { c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); } });
const shared = () => page.evaluate(() => window.__shared);
const shots = async (tag) => {
  if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true });
  for (const w of [320, 375, 390]) for (const scheme of ['light', 'dark']) {
    await page.setViewportSize({ width: w, height: 844 }); await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(120);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(ov <= 0, `${tag} @${w}px ${scheme}: nessun overflow orizzontale (${ov})`);
    await page.screenshot({ path: join(SHOTS, `coda-${tag}-${w}-${scheme}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'light' });
};

const base = await rec('avvio');

if (ONLY.includes('1')) { // ---- 1) coda completa + aggiunta durante il lavoro + «Salva tutti» ----
  await page.setInputFiles('[data-ref="input"]', [A, B]);
  await page.waitForSelector('.fcv-q-item'); await waitInfo(); await sceneOff();
  ok((await page.$eval('#app', (r) => r.dataset.queue)) === 'true', '1: due file scelti insieme → modalità coda');
  ok(/Comprimi 2 video/.test(await page.textContent('[data-ref="go"]')), '1: «Comprimi 2 video»');
  await shots('lista');
  await page.click('[data-ref="go"]');
  await waitSt(0, 'corso');
  await page.setInputFiles('[data-ref="qAdd"]', C); // aggiunto mentre lavora: in fondo
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 3);
  await page.waitForFunction(() => /video/i.test(document.querySelector('[data-ref="phName"]').textContent) || true);
  await shots('lavoro');
  await waitSt(0, 'fatto'); await rec('1: voce 1 fatta (voce 2 al via)');
  await waitSt(1, 'fatto'); await rec('1: voce 2 fatta (voce 3 al via)');
  await waitIdle();
  const s1 = await sts(); ok(s1.join() === 'fatto,fatto,fatto', `1: tre voci fatte nell'ordine di aggiunta (${s1})`);
  const L = await logAll();
  ok(/\[1\/[23] coda1_avc\.mov\] /.test(L) && /\[3\/3 coda3_avc\.mov\] /.test(L), '1: righe del log prefissate [n/N nome]');
  ok(/CODA \| file/.test(L) && (L.match(/^CODA \| coda\d_avc/mg) || []).length === 3, '1: riassunto finale a tabella nel log');
  ok((await stage()) === 'done/false' && !(await page.$eval('[data-ref="qdone"]', (e) => e.hidden)), '1: schermata «Coda finita!»');
  ok((await page.$$eval('[data-ref="qdBody"] tr', (t) => t.length)) === 3, '1: tabella finale con 3 righe');
  const rs = await rec('1: fine coda (3 risultati in OPFS)');
  ok(rs.opfs === 3, `1: 3 risultati in OPFS prima del salvataggio (${rs.opfsList})`);
  await shots('fine');
  await page.click('[data-ref="qSaveAll"]'); await page.waitForTimeout(600);
  const sh = await shared(); ok(sh.length === 1 && sh[0].length === 3, `1: «Salva tutti» = una sola condivisione con 3 file (${JSON.stringify(sh)})`);
  const r1 = await rec('1: dopo «Salva tutti»');
  ok(r1.opfs === 0 && r1.blobUrls <= base.blobUrls + 3, `1: OPFS vuoto e Blob URL non cresciuti dopo il salvataggio (opfs ${r1.opfs}, url ${r1.blobUrls})`);
  ok(/Tutti salvati/.test(await page.textContent('[data-ref="qSaveAll"]')), '1: tasto «Tutti salvati ✓»');
  await page.click('[data-ref="qNew"]'); await page.waitForTimeout(300);
  ok((await stage()).startsWith('pick') && (await page.$eval('#app', (r) => r.dataset.queue)) === 'false', '1: «Nuova coda» → passo 1 vuoto');
  await rec('1: riposo dopo «Nuova coda»');
}

if (ONLY.includes('2')) { // ---- 2) rimozione, annullo, errore (la coda prosegue), riprova, condivisione multipla rifiutata ----
  await page.setInputFiles('[data-ref="input"]', [A, SRC, B, C]);
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 4); await waitInfo(); await sceneOff();
  await page.click('.fcv-q-item:nth-child(4) [data-act="rm"]'); await page.waitForTimeout(200);
  ok((await sts()).length === 3, '2: voce rimossa prima di partire');
  await page.click('[data-ref="go"]');
  await waitSt(0, 'corso');
  await page.waitForFunction(() => /^Video$/i.test(document.querySelector('[data-ref="phName"]').textContent.trim()), null, { timeout: 60000 });
  await page.waitForTimeout(300); await page.click('[data-ref="cancel"]');
  await waitIdle();
  const s2 = await sts(); ok(s2.join() === 'annullata,errore,fatto', `2: annullata → errore → fatto, la coda prosegue dopo annullo ed errore (${s2})`);
  const L = await logAll(); ok(/\[2\/3 IMG_7440\.mov\] ERRORE/.test(L), '2: errore della voce 2 nel log con prefisso');
  ok(/Errore/.test(await page.textContent('.fcv-q-item:nth-child(2)')), '2: messaggio d\'errore nella voce');
  await rec('2: fine coda (annullata, errore, fatto)');
  await page.click('.fcv-q-item:nth-child(1) [data-act="retry"]'); await page.waitForTimeout(200);
  ok((await sts())[0] === 'attesa', '2: «Riprova» rimette in attesa');
  await page.click('[data-ref="go"]'); await waitIdle();
  ok((await sts()).join() === 'fatto,errore,fatto', `2: voce riprovata fatta (${await sts()})`);
  await page.evaluate(() => { window.__shareMode = 'fail'; window.__shared = []; });
  await page.click('[data-ref="qSaveAll"]'); await page.waitForTimeout(400);
  const btns = await page.$$('[data-ref="qdFiles"] button');
  ok(btns.length === 2 && !(await page.$eval('[data-ref="qdFiles"]', (e) => e.hidden)), `2: condivisione multipla rifiutata → un tasto per file (${btns.length})`);
  await shots('salva-uno');
  for (let i = 0; i < 2; i++) { await page.click('[data-ref="qdFiles"] button'); await page.waitForTimeout(400); }
  const sh = await shared(); ok(sh.length === 2 && sh.every((x) => x.length === 1), `2: salvati uno per uno (${JSON.stringify(sh)})`);
  const r2 = await rec('2: dopo i salvataggi singoli');
  ok(r2.opfs === 0, `2: OPFS vuoto (${r2.opfsList})`);
  await page.evaluate(() => { window.__shareMode = 'ok'; });
  await page.click('[data-ref="qNew"]'); await page.waitForTimeout(300);
}

if (ONLY.includes('3')) { // ---- 3) ripresa dopo ricarica ----
  await page.setInputFiles('[data-ref="input"]', [A, B, C]);
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 3); await waitInfo(); await sceneOff();
  await page.click('[data-ref="go"]');
  await waitSt(0, 'fatto');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ref="log"] div')].some((d) => /^\[2\/3 [^\]]+\] .*segmento 1\/\d+ salvato/.test(d.textContent)), null, { timeout: 60000 });
  await page.reload(); await page.waitForSelector('[data-ref="go"]');
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 3, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const sR = await sts(); ok(sR.join() === 'fatto,attesa*,attesa*', `3: coda ripristinata: A fatta, B e C da riselezionare (${sR})`);
  ok(!!(await page.$('.fcv-q-item:nth-child(1) [data-act="save"]')), '3: risultato di A salvabile dopo la ricarica');
  ok(/riprende/.test(await page.textContent('.fcv-q-item:nth-child(2)')), '3: B «riprende dai segmenti»');
  ok(!(await page.$eval('[data-ref="qRelinkBox"]', (e) => e.hidden)), '3: «Riseleziona i video» visibile');
  await shots('ripresa');
  await page.setInputFiles('[data-ref="qRelink"]', [A, B, C]); await page.waitForTimeout(400);
  ok((await sts()).join() === 'fatto,attesa,attesa' && (await sts()).length === 3, `3: B e C riabbinati, A non duplicata (${await sts()})`);
  await page.click('[data-ref="go"]'); await waitIdle();
  const L = await logAll();
  ok(/\[2\/3 coda2_avc\.mov\] RIPRESA: [1-9]/.test(L), '3: B riprende dai segmenti salvati (RIPRESA nel log)');
  ok((await sts()).join() === 'fatto,fatto,fatto', `3: coda completata dopo la ripresa (${await sts()})`);
  await page.click('[data-ref="qSaveAll"]'); await page.waitForTimeout(600);
  const sh = await shared(); ok(sh.at(-1)?.length === 3, `3: «Salva tutti» con 3 file (${JSON.stringify(sh.at(-1))})`);
  const r3 = await rec('3: dopo «Salva tutti»'); ok(r3.opfs === 0, `3: OPFS vuoto (${r3.opfsList})`);
  await page.click('[data-ref="qNew"]'); await page.waitForTimeout(300);
}

if (ONLY.includes('4')) { // ---- 4) «Ferma la coda» → riprende dai segmenti ----
  await page.setInputFiles('[data-ref="input"]', [A, B]);
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 2); await waitInfo(); await sceneOff();
  await page.click('[data-ref="go"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-ref="log"] div')].some((d) => /^\[1\/2 [^\]]+\] .*segmento 1\/\d+ salvato/.test(d.textContent)), null, { timeout: 60000 });
  await page.click('[data-ref="qStop"]'); await waitIdle();
  const s4 = await sts(); ok(s4.join() === 'attesa,attesa' && (await stage()).startsWith('ready'), `4: coda fermata, voci in attesa (${s4}, ${await stage()})`);
  ok(/riprende/.test(await page.textContent('.fcv-q-item:nth-child(1)')), '4: la voce fermata riprende dai segmenti');
  await page.click('[data-ref="go"]'); await waitIdle();
  ok(/\[1\/2 coda1_avc\.mov\] RIPRESA/.test(await logAll()) && (await sts()).join() === 'fatto,fatto', '4: ripresa dopo «Ferma la coda» e coda completata');
  await page.click('[data-ref="qNew"]'); await page.waitForTimeout(300); // due risultati non salvati: confermato dal dialogo
}

if (ONLY.includes('5')) { // ---- 5) dal singolo alla coda («Aggiungi altri video») e trascinamento di più file ----
  await page.setInputFiles('[data-ref="input"]', A);
  await page.waitForFunction(() => { const t = document.querySelector('[data-ref="fDur"]')?.textContent; return t && t !== '—'; }, null, { timeout: 30000 });
  ok((await page.$eval('#app', (r) => r.dataset.queue)) === 'false' && !(await page.$eval('[data-ref="fileBox"]', (e) => e.hidden)), '5: un solo file → esperienza singola di prima');
  await page.setInputFiles('[data-ref="qAddSingle"]', [B]); await page.waitForSelector('.fcv-q-item'); await waitInfo();
  const names = await page.$$eval('.fcv-q-name', (e) => e.map((x) => x.textContent));
  ok(names.join() === 'coda1_avc.mov,coda2_avc.mov', `5: «Aggiungi altri video» → coda con il video già scelto per primo (${names})`);
  await page.evaluate(() => { // trascinamento: 2 video (uno in due rappresentazioni) + un file non video
    const dt = new DataTransfer(), mk = (n, size, type) => new File([new Uint8Array(size)], n, { type, lastModified: 5 });
    for (const f of [mk('X.MOV', 10, 'video/quicktime'), mk('X.mp4', 20, 'video/mp4'), mk('Y.MOV', 30, 'video/quicktime'), mk('nota.txt', 5, 'text/plain')]) dt.items.add(f);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 4);
  const n2 = await page.$$eval('.fcv-q-name', (e) => e.map((x) => x.textContent));
  ok(n2.slice(2).join() === 'X.mp4,Y.MOV', `5: trascinati più video → in fondo alla coda, per nome base il più grande (${n2})`);
  await page.click('[data-ref="qClear"]'); await page.waitForTimeout(300);
  ok((await page.$eval('#app', (r) => r.dataset.queue)) === 'false', '5: «Svuota coda» → passo 1');
}

if (ONLY.includes('6')) { // ---- 6) risorse media costanti fra le voci (5 voci, qualità per scena, 2 player, PiP preparata) ----
  await page.setInputFiles('[data-ref="input"]', [A, B, C, D, E]);
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 5); await waitInfo();
  await page.evaluate(() => { for (const n of ['fcv-sceneq', 'fcv-par2']) { const c = document.querySelector(`input[name="${n}"]`); if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } } });
  await page.click('[data-ref="go"]');
  const per = [];
  for (let k = 1; k <= 5; k++) { // player aperti (riga «frame nativi») → misura durante la voce
    await page.waitForFunction((k) => [...document.querySelectorAll('[data-ref="log"] div')].some((d) => new RegExp(`^\\[${k}/5 [^\\]]+\\] frame nativi`).test(d.textContent)), k, { timeout: 120000 })
      .catch(async (e) => { console.log('TIMEOUT voce', k, await sts(), '\n' + (await logTail(25))); throw e; });
    const s = await rec(`6: durante voce ${k}`); per.push(s);
    console.log(`     voce ${k}: <video> con src ${s.vidSrc} (fuori DOM ${s.vidSrcOut}), in riproduzione ${s.vidPlay}, nel DOM ${s.videoDom}, creati in tutto ${s.vidMade}, codec aperti ${s.codecs}`);
  }
  await waitIdle(400000);
  const s6 = await sts(); ok(s6.join() === 'fatto,fatto,fatto,fatto,fatto', `6: cinque voci fatte (${s6})`);
  const p1 = per[0];
  ok(per.every((s) => s.vidSrc === p1.vidSrc && s.vidPlay === p1.vidPlay && s.videoDom === p1.videoDom), `6: <video> con src/in riproduzione/nel DOM costanti fra le voci (${per.map((s) => `${s.vidSrc}/${s.vidPlay}/${s.videoDom}`).join(' ')})`);
  ok(per.every((s) => s.vidSrcOut <= 2), `6: fuori dal DOM con src al massimo i 2 player di seek (${per.map((s) => s.vidSrcOut).join(' ')})`);
  ok(per.every((s) => s.vidPlay <= 1), `6: al massimo un <video> in riproduzione (l'anteprima PiP) (${per.map((s) => s.vidPlay).join(' ')})`);
  ok(per.at(-1).vidMade === p1.vidMade, `6: nessun <video> nuovo dopo la voce 1 (creati: ${per.map((s) => s.vidMade).join(' ')})`);
  ok(p1.videoDom === 1, `6: un solo <video> PiP nel DOM per tutta la coda (${per.map((s) => s.videoDom).join(' ')})`);
  const L = await logAll(), rl = L.split('\n').filter((l) => /\] risorse:/.test(l));
  ok(rl.length >= 5, `6: riga «risorse:» nel log per ogni voce (${rl.length})`);
  const fine = rl.filter((l) => /risorse: fine voce/.test(l));
  ok(fine.length === 5 && fine.every((l) => /<video> con src 1 \(nel DOM 1, fuori 0\), in riproduzione 1/.test(l)), `6: a fine voce i player di seek sono senza sorgente (resta solo l'anteprima PiP) (${fine.map((l) => l.match(/con src \d+ \([^)]*\)/)?.[0]).join(' | ')})`);
  ok(rl.some((l) => /anteprima PiP: clip leggera/.test(l)), '6: anteprima PiP sulla clip leggera (non sul video della voce 1)'); if (rl.length) console.log('     ' + rl.slice(0, 2).join('\n     ') + (rl.length > 2 ? '\n     … ' + rl.at(-1) : ''));
  await page.evaluate(() => { window.__shareMode = 'ok'; });
  await page.click('[data-ref="qSaveAll"]'); await page.waitForTimeout(600);
  const r6 = await rec('6: dopo «Salva tutti»'); ok(r6.vidSrc === 0 && r6.mediaPlay === 0, `6: a fine coda nessun <video> con src né media in riproduzione (${r6.vidSrc}, ${r6.mediaPlay})`);
  await page.click('[data-ref="qNew"]'); await page.waitForTimeout(300);
}

if (ONLY.includes('7')) { // ---- 7) seek bloccato: recupero (player ricreato, voce riprovata) senza mascherare il guasto reale ----
  await page.setInputFiles('[data-ref="input"]', [A, B]);
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 2); await waitInfo(); await sceneOff();
  await page.evaluate(() => { const c = document.querySelector('input[name="fcv-par2"]'); if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } });
  await page.evaluate(() => { window.__hang.budget = 1; window.__hang.after = 8; });
  await page.click('[data-ref="go"]'); await waitIdle(400000);
  let L = await logAll();
  ok((await sts()).join() === 'fatto,fatto', `7a: un player bloccato → coda completata (${await sts()})`);
  ok(/⚠️ player \d: seek timeout @[\d.]+s → ricreo il <video>/.test(L), '7a: player bloccato ricreato (log)');
  ok(/FALLBACK a 1 player \(player (\d): seek timeout[^)]*; continua il player (?!\1)\d\)/.test(L), '7a: il fallback continua con il player SANO');
  ok(!/riprovo questo video una volta/.test(L), '7a: nessuna ripetizione della voce (bastava ricreare il player)');
  await page.click('[data-ref="qSaveAll"]'); await page.waitForTimeout(600); await page.click('[data-ref="qNew"]'); await page.waitForTimeout(300);

  await page.setInputFiles('[data-ref="input"]', [C, D]);
  await page.waitForFunction(() => document.querySelectorAll('.fcv-q-item').length === 2); await waitInfo(); await sceneOff();
  await page.evaluate(() => { window.__hang.budget = 1e9; window.__hang.after = 8; window.__hang.n = 0; });
  await page.click('[data-ref="go"]');
  await waitSt(0, 'errore', 400000); await page.evaluate(() => { window.__hang.budget = 0; });
  await waitIdle(400000);
  L = await logAll();
  ok((await sts()).join() === 'errore,fatto', `7b: blocco permanente → voce in errore, la successiva fatta (${await sts()})`);
  ok(/riprovo questo video una volta/.test(L), '7b: voce riprovata una volta con player nuovi prima dell\'errore');
  ok(/\[1\/2 [^\]]+\] ERRORE: SeekTimeout: seek timeout/.test(L), '7b: errore finale = SeekTimeout (guasto reale non mascherato)');
  const hung = await page.evaluate(() => window.__hang.n); console.log(`     7b: <video> bloccati in tutto: ${hung}`);
  await page.click('[data-ref="qNew"]'); await page.waitForTimeout(300);
}

const rest = await rec('riposo finale');
ok(rest.opfs === 0 && rest.codecs === 0 && rest.videoDom === 0 && rest.frames === 0 && rest.workers === 0, `riposo: nessun encoder/<video>/VideoFrame/Worker/OPFS rimasto (${SNAP_COLS.map((k) => `${k} ${rest[k]}`).join(', ')})`);
ok(rest.blobUrls <= base.blobUrls + 3, `riposo: Blob URL ${rest.blobUrls} (avvio ${base.blobUrls}; jingle/notifiche ≤ 3)`);
await browser.close(); server.close();
console.log(['scen', ...SNAP_COLS, 'extra'].join('\t'));
for (const r of rows) console.log([r.scen, ...SNAP_COLS.map((c) => r[c]), r.extra].join('\t'));
if (errors.length) { console.log('errori pagina:', errors.slice(0, 5)); fails.push('errori pagina'); }
console.log(fails.length ? `SONDA CODA: ${fails.length} controlli FALLITI` : 'SONDA CODA: tutti i controlli OK');
process.exit(fails.length ? 1 : 0);
