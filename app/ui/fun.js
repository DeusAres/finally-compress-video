// fun.js — intrattenimento pixel-art mostrato DURANTE l'export.
// "Pressa dei Byte": una pressa comprime blocchi HDR grandi in blocchi piccoli.
//  - Passivo di base (la pressa va da sola, la velocità del nastro segue gli fps reali,
//    la mascotte "Bit" avanza lungo il percorso con il progresso reale).
//  - Tap ovunque = stomp anticipato: se il blocco è sotto la pressa → "perfetto" (stella).
// Un solo <canvas> 160x144, max 30 fps, pausa a pagina nascosta, nessuna libreria.
// Uso: const fun = mountFun(slotEl, bus); fun.start(); fun.stop(); fun.destroy(); fun.stats()

const W = 160, H = 144, FRAME_MS = 1000 / 30 - 1.5;
const BELT_Y = 88, PRESS_X = 80, TRACK_Y = 125, TRACK_X0 = 12, TRACK_X1 = 146;

const FACTS = [
  'L’HDR dell’iPhone usa 10 bit: 1024 sfumature per canale invece di 256.',
  'Il video non lascia mai il telefono: tutto avviene qui, in Safari.',
  'HEVC ottiene a parità di qualità file molto più piccoli di H.264.',
  'A 60 fps ogni secondo sono 60 immagini da ricomprimere una per una.',
  'I frame B guardano sia avanti che indietro per risparmiare byte.',
  'HLG e PQ sono due modi diversi di codificare la luminosità HDR.',
  'Dolby Vision aggiunge metadati per adattare ogni scena al tuo schermo.',
  'Tieni lo schermo acceso: Safari rallenta le pagine in background.',
];
const PHASE_TXT = {
  analisi: 'Analizzo il video…', video: 'Comprimo i fotogrammi…',
  audio: 'Passo all’audio…', scrittura: 'Scrivo il file…',
};

// ---- sprite (pixel map) --------------------------------------------------
const BIT = [
  ['..AAAA..', '.AAAAAA.', '.AWKAWKA', '.AAAAAA.', '..AAAA..', '.AAAAAA.', '..L..L..', '.LL..LL.'],
  ['..AAAA..', '.AAAAAA.', '.AWKAWKA', '.AAAAAA.', '..AAAA..', '.AAAAAA.', '..L..L..', '.L....L.'],
];
const STAR = ['..X..', '.XXX.', 'XXXXX', '.XXX.', '.X.X.'];
const GLYPH = { '-': '......XXX......' };
GLYPH['%'] = 'X.X' + '..X' + '.X.' + 'X..' + 'X.X';
GLYPH[1] = '.X.' + 'XX.' + '.X.' + '.X.' + 'XXX';
GLYPH[0] = 'XXX' + 'X.X' + 'X.X' + 'X.X' + 'XXX';
GLYPH[2] = 'XXX' + '..X' + 'XXX' + 'X..' + 'XXX';
GLYPH[3] = 'XXX' + '..X' + 'XXX' + '..X' + 'XXX';
GLYPH[4] = 'X.X' + 'X.X' + 'XXX' + '..X' + '..X';
GLYPH[5] = 'XXX' + 'X..' + 'XXX' + '..X' + 'XXX';
GLYPH[6] = 'XXX' + 'X..' + 'XXX' + 'X.X' + 'XXX';
GLYPH[7] = 'XXX' + '..X' + '..X' + '..X' + '..X';
GLYPH[8] = 'XXX' + 'X.X' + 'XXX' + 'X.X' + 'XXX';
GLYPH[9] = 'XXX' + 'X.X' + 'XXX' + '..X' + 'XXX';

let styleInjected = false;
function injectStyle() {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const s = document.createElement('style');
  s.textContent = `
.fun{display:flex;flex-direction:column;align-items:center;gap:calc(var(--px-unit,4px)*2);
  font-family:var(--font-body,system-ui,sans-serif);color:var(--text,#1a1c2c);text-align:center;touch-action:manipulation}
.fun[hidden]{display:none}
.fun canvas{width:320px;max-width:100%;aspect-ratio:160/144;image-rendering:pixelated;image-rendering:crisp-edges;
  image-rendering:pixelated;background:var(--px-ink,#1a1c2c);border:var(--px-border,4px) solid var(--line,#1a1c2c);
  box-sizing:border-box;display:block;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
.fun.fun-off canvas{opacity:.45}
.fun-stat{font-size:12px;line-height:1.3;min-height:1.3em;color:var(--text,#1a1c2c)}
.fun-cap{font-size:11px;line-height:1.4;min-height:2.8em;max-width:320px;color:var(--muted,#566c86)}
.fun-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
  document.head.appendChild(s);
}

export function mountFun(slotEl, bus) {
  injectStyle();
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- DOM
  const root = document.createElement('div');
  root.className = 'fun'; root.hidden = true;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Animazione: una pressa comprime i blocchi del video. Tocca per premere.');
  const stat = document.createElement('div'); stat.className = 'fun-stat';
  const cap = document.createElement('div'); cap.className = 'fun-cap';
  const sr = document.createElement('div'); sr.className = 'fun-sr'; sr.setAttribute('aria-live', 'polite');
  root.append(canvas, stat, cap, sr);
  slotEl.appendChild(root);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;

  // ---- palette (token del tema se presenti)
  const cs = getComputedStyle(root);
  const tok = (n, d) => (cs.getPropertyValue(n).trim() || d);
  const C = {
    bg: tok('--px-ink', '#1a1c2c'), bg2: tok('--px-navy', '#29366f'), fg: tok('--px-white', '#f4f4f4'),
    dim: tok('--px-steel', '#333c57'), acc: tok('--px-yellow', '#ffcd75'), ok: tok('--px-lime', '#a7f070'),
    steel: tok('--px-silver', '#94b0c2'), steel2: tok('--px-slate', '#566c86'), dark: tok('--px-ink', '#1a1c2c'),
    blocks: [tok('--px-red', '#b13e53'), tok('--px-orange', '#ef7d57'), tok('--px-yellow', '#ffcd75'),
      tok('--px-green', '#38b764'), tok('--px-sky', '#41a6f6'), tok('--px-plum', '#5d275d')],
  };

  // ---- stato
  const S = {
    running: false, raf: 0, last: 0, now: 0, phase: 'analisi', targetP: 0, p: 0, fps: 0,
    blocks: [], parts: [], spawnX: 0, nextColor: 0, stomp: null, stompCd: 0,
    score: 0, combo: 0, celebrate: 0, saved: null, t: 0, factI: 0, factT: 0, hidden: false, frozen: false,
    lastStat: 0,
  };
  const stats = { n: 0, sum: 0, max: 0 };
  const fmt = (x, d = 1) => x.toFixed(d).replace('.', ',');

  function reset() {
    Object.assign(S, { blocks: [], parts: [], spawnX: -14, stomp: null, stompCd: 0, score: 0, combo: 0,
      celebrate: 0, saved: null, t: 0, p: 0, targetP: 0, fps: 0, factI: 0, factT: 0, frozen: false });
    root.classList.remove('fun-off');
    setCaption(PHASE_TXT[S.phase] || PHASE_TXT.analisi);
  }
  function setCaption(t) { cap.textContent = t; }

  // ---- disegno
  const R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x | 0, y | 0, w, h); };
  function sprite(map, x, y, pal) {
    for (let j = 0; j < map.length; j++) for (let i = 0; i < map[j].length; i++) {
      const c = pal[map[j][i]]; if (c) R(x + i, y + j, 1, 1, c);
    }
  }
  function text(str, x, y, sc, col) {
    for (const ch of str) {
      const g = GLYPH[ch]; if (!g) continue;
      for (let k = 0; k < 15; k++) if (g[k] === 'X') R(x + (k % 3) * sc, y + ((k / 3) | 0) * sc, sc, sc, col);
      x += 4 * sc;
    }
  }
  function drawBlock(b) {
    const col = C.blocks[b.c];
    if (!b.small) {
      R(b.x - 7, BELT_Y - 14, 14, 14, C.dark);
      // bande "HDR" a gradiente: chiaro -> scuro
      R(b.x - 6, BELT_Y - 13, 12, 3, C.fg); R(b.x - 6, BELT_Y - 10, 12, 4, col);
      R(b.x - 6, BELT_Y - 6, 12, 3, col); R(b.x - 6, BELT_Y - 3, 12, 2, C.steel2);
    } else {
      const sc = b.sq > 0 ? 1 : 0;
      R(b.x - 4, BELT_Y - 8 + sc, 8, 8 - sc, C.dark);
      R(b.x - 3, BELT_Y - 7 + sc, 6, 3, C.fg); R(b.x - 3, BELT_Y - 4 + sc, 6, 4 - sc, col);
    }
  }
  function draw() {
    const t = S.t;
    R(0, 0, W, H, C.bg);
    // stelline di sfondo a dither (statiche, 1 sola lampeggia)
    for (let i = 0; i < 22; i++) {
      const x = (i * 53 + 17) % W, y = (i * 29 + 5) % 60;
      R(x, y, 1, 1, ((i + (reduced ? 0 : (t / 600) | 0)) % 5 === 0) ? C.fg : C.dim);
    }
    // titolo/contatore
    if (S.score > 0) { sprite(STAR, 4, 4, { X: C.acc }); text(String(S.score), 12, 4, 1, C.fg); }
    // struttura pressa
    R(PRESS_X - 22, 14, 44, 5, C.steel2); R(PRESS_X - 22, 14, 44, 1, C.steel);
    R(PRESS_X - 22, 14, 3, BELT_Y - 14, C.steel2); R(PRESS_X + 19, 14, 3, BELT_Y - 14, C.steel2);
    // pistone
    const hy = S.stomp ? S.stomp.y : 36;
    R(PRESS_X - 2, 19, 4, hy - 19, C.steel);
    R(PRESS_X - 10, hy, 20, 6, C.steel); R(PRESS_X - 10, hy, 20, 1, '#cfd3ee'); R(PRESS_X - 10, hy + 5, 20, 1, C.steel2);
    // nastro
    R(0, BELT_Y, W, 6, C.steel2); R(0, BELT_Y, W, 1, C.steel);
    const off = reduced ? 0 : ((S.beltX | 0) % 8 + 8) % 8;
    for (let x = -8 + off; x < W; x += 8) R(x, BELT_Y + 3, 4, 1, C.dark);
    R(0, BELT_Y + 6, W, 2, C.dark);
    // blocchi
    for (const b of S.blocks) drawBlock(b);
    // scintille/coriandoli
    for (const p of S.parts) R(p.x, p.y, p.s || 1, p.s || 1, p.col);
    // "indicatore" di compressione sopra l'uscita
    R(PRESS_X + 22, BELT_Y - 16, 1, 1, C.dim);
    // percorso progresso
    for (let x = TRACK_X0; x <= TRACK_X1; x += 3) R(x, TRACK_Y, 2, 1, C.dim);
    R(TRACK_X0, TRACK_Y, Math.round((TRACK_X1 - TRACK_X0) * S.p), 1, C.ok);
    R(TRACK_X1 + 2, TRACK_Y - 10, 1, 11, C.fg); R(TRACK_X1 + 3, TRACK_Y - 10, 5, 4, C.acc);
    const mx = TRACK_X0 + (TRACK_X1 - TRACK_X0) * S.p - 4;
    const jump = S.celebrate ? Math.abs(Math.sin(t / 130)) * 8 : (S.p >= 1 && S.running ? Math.abs(Math.sin(t / 220)) * 3 : 0);
    const frame = reduced ? 0 : ((t / 160) | 0) % 2;
    sprite(BIT[frame], mx, TRACK_Y - 8 - jump, { A: C.acc, W: '#fff', K: C.dark, L: C.fg });
    // celebrazione
    if (S.celebrate && S.saved != null) {
      const s = '-' + Math.round(S.saved) + '%';
      const w = s.length * 12 - 4;
      R(((W - w) >> 1) - 5, 40, w + 10, 26, C.dark);
      R(((W - w) >> 1) - 4, 41, w + 8, 24, C.bg2);
      text(s, (W - w) >> 1, 46, 4, C.acc);
    }
  }

  // ---- logica
  function burst(x, y, n, cols, up) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, v = 20 + Math.random() * 50;
      S.parts.push({ x, y, vx: Math.cos(a) * v, vy: (up ? -Math.abs(Math.sin(a)) : Math.sin(a)) * v - (up ? 20 : 0),
        life: 0.4 + Math.random() * 0.4, col: cols[(Math.random() * cols.length) | 0], s: 1 + (Math.random() < .2) });
    }
  }
  function startStomp(byUser) {
    if (S.stomp || S.stompCd > 0) return false;
    S.stomp = { t: 0, byUser, hit: false, y: 36 };
    return true;
  }
  function onImpact(st) {
    st.hit = true;
    let hit = null;
    for (const b of S.blocks) if (!b.small && Math.abs(b.x - PRESS_X) <= 8) { hit = b; break; }
    if (hit) {
      hit.small = true; hit.sq = 6;
      const perfect = st.byUser && Math.abs(hit.x - PRESS_X) <= 5;
      burst(hit.x, BELT_Y - 8, 8, [C.blocks[hit.c], '#fff'], true);
      if (perfect) { S.score++; S.combo++; burst(hit.x, BELT_Y - 16, 6, [C.acc], true); }
      else if (st.byUser) S.combo = 0;
    } else if (st.byUser) S.combo = 0;
  }
  function update(dt) {
    S.t += dt * 1000;
    S.p += (S.targetP - S.p) * Math.min(1, dt * 4);
    // velocita' nastro legata agli fps reali
    const fps = S.celebrate ? 0 : S.fps;
    const speed = S.celebrate ? 0 : (S.phase === 'analisi' ? 14 : 12 + 30 * Math.min(fps / 60, 1.5));
    S.beltX = (S.beltX || 0) + speed * dt;
    if (!S.celebrate) {
      S.spawnX += speed * dt;
      if (S.spawnX >= 34) { S.spawnX -= 34; S.blocks.push({ x: -8, c: S.nextColor++ % C.blocks.length, small: false, sq: 0 }); }
    }
    for (const b of S.blocks) { b.x += speed * dt; if (b.sq > 0) b.sq--; }
    while (S.blocks.length && S.blocks[0].x > W + 10) S.blocks.shift();
    // auto-stomp
    if (!S.stomp && !S.celebrate) for (const b of S.blocks) if (!b.small && b.x >= PRESS_X - 4 && b.x < PRESS_X + 8) { startStomp(false); break; }
    S.stompCd = Math.max(0, S.stompCd - dt);
    if (S.stomp) {
      const st = S.stomp; st.t += dt * 1000;
      // giu' 120ms, fermo 60ms, su 180ms
      if (st.t < 120) st.y = 36 + (st.t / 120) * 38;
      else if (st.t < 180) { st.y = 74; if (!st.hit) onImpact(st); }
      else if (st.t < 360) st.y = 74 - ((st.t - 180) / 180) * 38;
      else { S.stomp = null; S.stompCd = 0.05; }
    }
    for (const p of S.parts) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 90 * dt; }
    S.parts = S.parts.filter(p => p.life > 0 && p.y < H);
    if (S.celebrate) {
      if (Math.random() < 0.5) S.parts.push({ x: Math.random() * W, y: -2, vx: (Math.random() - .5) * 20, vy: 20 + Math.random() * 30,
        life: 3, col: C.blocks[(Math.random() * 6) | 0], s: 2 });
      if (S.t - S.celebrate > 4500) finishCelebration();
    }
    // didascalia: curiosita' ogni ~7s durante video
    if (!S.celebrate && S.phase === 'video') {
      S.factT += dt;
      if (S.factT > 7) { S.factT = 0; setCaption(FACTS[S.factI++ % FACTS.length]); }
    }
  }
  function statText(p) {
    if (S.celebrate) return '';
    if (S.phase === 'video') {
      let t = Math.round(S.targetP * 100) + '%';
      if (p && p.fps) t += ' · ' + Math.round(p.fps) + ' fps';
      if (p && p.etaS > 0) t += ' · ~' + Math.floor(p.etaS / 60) + ':' + String(Math.round(p.etaS % 60)).padStart(2, '0');
      return t;
    }
    return PHASE_TXT[S.phase] || '';
  }

  // ---- loop
  function frame(now) {
    S.raf = requestAnimationFrame(frame);
    if (now - S.last < FRAME_MS) return;
    const dt = Math.min(0.1, (now - (S.last || now - 33)) / 1000);
    S.last = now;
    const t0 = performance.now();
    update(dt); draw();
    const c = performance.now() - t0;
    stats.n++; stats.sum += c; if (c > stats.max) stats.max = c;
  }
  function loopOn() {
    if (reduced || S.raf || S.hidden || !S.running) return;
    S.last = 0; S.raf = requestAnimationFrame(frame);
  }
  function loopOff() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  function still() { // frame statico (reduced motion, pausa, fine)
    const t0 = performance.now(); draw();
    if (reduced) { const c = performance.now() - t0; stats.n++; stats.sum += c; if (c > stats.max) stats.max = c; }
  }
  function finishCelebration() {
    S.parts = []; S.frozen = true; loopOff(); draw();
  }

  // ---- API
  function start() {
    if (S.running) return;
    S.running = true; reset(); root.hidden = false; stat.textContent = statText();
    // pre-popola alcuni blocchi per evitare nastro vuoto
    if (!reduced) { for (let x = 10; x < 60; x += 34) S.blocks.push({ x, c: S.nextColor++ % 6, small: false, sq: 0 }); S.spawnX = 20; }
    still(); loopOn();
  }
  function stop() { S.running = false; loopOff(); root.classList.add('fun-off'); stat.textContent = ''; }
  function destroy() {
    stop(); off(); document.removeEventListener('visibilitychange', onVis);
    canvas.removeEventListener('pointerdown', onTap); root.remove();
  }
  function onTap(e) {
    e.preventDefault();
    if (!S.running || S.celebrate || reduced) return;
    startStomp(true);
  }
  function onVis() {
    S.hidden = document.hidden;
    if (S.hidden) loopOff(); else loopOn();
  }

  // ---- bus
  const h = {
    phase(e) {
      const ph = e.detail && e.detail.phase; if (!ph) return;
      if (ph === 'errore') { stop(); return; }
      if (ph === 'fatto') return;
      S.phase = ph;
      if ((ph === 'video' || ph === 'analisi') && !S.running) start();
      if (!S.running) return;
      setCaption(PHASE_TXT[ph] || ''); S.factT = 0;
      if (ph === 'audio' || ph === 'scrittura') S.targetP = 1;
      stat.textContent = statText();
      sr.textContent = PHASE_TXT[ph] || '';
      if (reduced) still();
    },
    progress(e) {
      const d = e.detail || {};
      if (d.phase && d.phase !== 'video') return;
      if (d.total > 0) S.targetP = Math.max(0, Math.min(1, d.done / d.total));
      if (d.fps > 0) S.fps = d.fps;
      const now = performance.now();
      if (now - S.lastStat > 500) { S.lastStat = now; stat.textContent = statText(d); if (reduced) { S.p = S.targetP; still(); } }
    },
    result(e) {
      const d = e.detail || {};
      if (!S.running) { start(); }
      S.celebrate = S.t + 1; S.targetP = 1; S.p = 1; S.phase = 'fatto';
      S.saved = d.savedPct != null ? d.savedPct : (d.inMB > 0 ? (1 - d.outMB / d.inMB) * 100 : 0);
      const mb = d.inMB != null && d.outMB != null ? d.inMB - d.outMB : null;
      const msg = 'Fatto! ' + (mb != null ? 'Risparmiati ' + fmt(mb) + ' MB' : 'File compresso') + ' (−' + Math.round(S.saved) + '%)';
      setCaption(msg); sr.textContent = msg; stat.textContent = d.fileName || '';
      if (reduced) { S.parts = []; still(); S.running = false; return; }
      for (let i = 0; i < 30; i++) S.parts.push({ x: Math.random() * W, y: Math.random() * 30, vx: (Math.random() - .5) * 40, vy: 10 + Math.random() * 40, life: 3, col: C.blocks[i % 6], s: 2 });
      S.celebrate = S.t + 1; loopOn();
    },
    error() { stop(); },
  };
  const names = ['phase', 'progress', 'result', 'error'];
  const handlers = names.map(n => [n, h[n]]);
  handlers.forEach(([n, f]) => bus.addEventListener(n, f));
  function off() { handlers.forEach(([n, f]) => bus.removeEventListener(n, f)); }
  document.addEventListener('visibilitychange', onVis);
  canvas.addEventListener('pointerdown', onTap);

  return {
    start, stop, destroy,
    stats: () => ({ frames: stats.n, avgMs: stats.n ? stats.sum / stats.n : 0, maxMs: stats.max }),
  };
}
