// Archivio del log tecnico: righe con categoria, limite in memoria e riassunto compatto per "Copia log".
// Nessuna dipendenza dal DOM (testabile in Node). Categorie: setup | segment | pip | heartbeat | warn | error | summary | info
export const CATS = ['setup', 'segment', 'pip', 'heartbeat', 'warn', 'error', 'summary', 'info'];
const STAMP = /^\[\d\d:\d\d:\d\d(?:\.\d+)?\]\s*/;
const RE_ERR = /^(ERRORE|Impossibile leggere)/;
const RE_WARN = /⚠️|non ottenuto|fallit[ao]|NON supportato|INCOMPLETO|^(visibilità|evento pagina|wake lock|background: interrompo|ripresa|RIPRESA|aggiornamento)|timer fermo/;
const RE_SUM = /^(COMPRESSIONE|QUALITÀ PER SCENA|bitrate video reale|fatto in|file:|PREVISIONE|PiP: aperta|background:|verifica|durate frame|codificati|assemblati|RPU trapiantati|metadati copiati|prove per scena|job completato|analisi eco|correzione|filtro|v4 elaborato|audio (corretto|SOLO)|hvcC)/;

/** Categoria dedotta dal prefisso (usata se il chiamante non la passa): robusta alle righe senza tag. */
export function classify(line, seenSegment = false) {
  const s = String(line).replace(STAMP, '');
  if (RE_ERR.test(s)) return 'error';
  if (s.startsWith('PiP ♥')) return 'pip';
  if (s.startsWith('♥')) return /timer fermo/.test(s) ? 'warn' : 'heartbeat';
  if (RE_WARN.test(s)) return 'warn';
  if (/^(segmento \d+|scena \d+)/.test(s)) return 'segment';
  if (RE_SUM.test(s)) return 'summary';
  return seenSegment ? 'info' : 'setup';
}

const num = (x) => (Number.isFinite(x) ? x : null);
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

/**
 * @param {{max?:number, head?:number, now?:()=>number}} o  max righe in memoria (poi: prime `head` + ultime), now() in ms
 */
export function createLogStore({ max = 20000, head = 200, now = () => Date.now() } = {}) {
  let lines, omitted, total, t0, seenSeg, keep, segs, pipSeen, hbSeen;
  function clear() {
    lines = []; omitted = 0; total = 0; t0 = now(); seenSeg = false;
    keep = [];        // setup / warn / error / summary: mai potate (tetto 3000), alimentano il riassunto anche se il log completo è troncato
    segs = new Map(); // un record per segmento (compatto): alimenta le righe aggregate
    pipSeen = []; hbSeen = [];
  }
  clear();

  function add(line, cat, data) {
    line = String(line);
    if (!CATS.includes(cat)) cat = classify(line, seenSeg);
    const t = now();
    const e = { t, cat, line };
    lines.push(e); total++;
    if (lines.length > max) { const drop = lines.length - max + 500; lines.splice(head, drop); omitted += drop; }
    if (cat === 'segment') {
      seenSeg = true;
      if (data && Number.isFinite(data.seg)) {
        const r = segs.get(data.seg) || { seg: data.seg };
        if (num(data.frames) !== null) { r.frames = data.frames; r.bytes = data.bytes; r.t = t; }
        if (num(data.real) !== null) { r.real = data.real; r.target = data.target; r.chosen = data.chosen; r.scene = !!data.scene; }
        segs.set(data.seg, r);
      }
    } else if (cat === 'pip') pipSeen.push(e);
    else if (cat === 'heartbeat') hbSeen.push(e);
    else if (cat === 'setup' || cat === 'warn' || cat === 'error' || cat === 'summary') { if (keep.length < 3000) keep.push(e); }
    return e;
  }

  const omittedLine = () => `… ${omitted} righe omesse …`;
  /** Tutte le righe conservate (se troncato: prime `head`, riga "omesse", ultime). */
  function fullText() {
    const out = lines.map((e) => e.line);
    if (omitted) out.splice(Math.min(head, out.length), 0, omittedLine());
    return out.join('\n');
  }
  const tail = (n) => lines.slice(-n);

  // "una riga ogni minuto" (si dirada oltre `cap` righe: video lunghissimi)
  function perMinute(list, cap) {
    if (!list.length) return [];
    const spanMin = Math.ceil((list[list.length - 1].t - t0) / 60000) + 1;
    const step = Math.max(1, Math.ceil(spanMin / cap)), seen = new Set(), out = [];
    for (const e of list) { const b = Math.floor(((e.t - t0) / 60000) / step); if (!seen.has(b)) { seen.add(b); out.push(e); } }
    return out;
  }

  function segLines(blockSize, maxBlocks) {
    const all = [...segs.values()].sort((a, b) => a.seg - b.seg);
    if (!all.length) return [];
    const bs = Math.max(blockSize, Math.ceil(all.length / maxBlocks));
    const out = []; let prevT = null;
    for (let i = 0; i < all.length; i += bs) {
      const b = all.slice(i, i + bs), a0 = b[0].seg, a1 = b[b.length - 1].seg;
      const timed = b.filter((r) => r.t != null), reals = b.filter((r) => r.real > 0).map((r) => r.real / 1e6);
      let fps = '—';
      if (timed.length) {
        const tLast = timed[timed.length - 1].t; let fr = timed.reduce((s, r) => s + (r.frames || 0), 0), t1 = prevT;
        if (t1 == null) { t1 = timed[0].t; fr -= timed[0].frames || 0; } // primo blocco: il tempo parte dal primo segmento salvato
        if (tLast > t1 && fr > 0) fps = String(Math.round(fr / ((tLast - t1) / 1000)));
        prevT = tLast;
      }
      const anom = [];
      for (const r of b) {
        if (r.real > 0 && r.target > 0 && Math.abs(r.real / r.target - 1) > 0.3) anom.push(`seg ${r.seg} reale ${f1(r.real / 1e6)} vs target ${f1(r.target / 1e6)} Mbps`);
        if (r.t != null && r.real == null) anom.push(`seg ${r.seg} senza misura bitrate`);
      }
      const scene = b.filter((r) => r.scene && r.chosen > 0);
      let s = `segmenti ${a0}–${a1}: fps medio ${fps}`;
      if (reals.length) s += `, bitrate reale medio ${f1(reals.reduce((x, y) => x + y, 0) / reals.length)} Mbps (${f1(Math.min(...reals))}–${f1(Math.max(...reals))})`;
      else s += ', bitrate reale n/d';
      if (scene.length) s += `, scelto ${f1(scene.reduce((x, r) => x + r.chosen, 0) / scene.length / 1e6)} Mbps`;
      s += `, anomalie: ${anom.length ? anom.slice(0, 4).join('; ') + (anom.length > 4 ? ` (+${anom.length - 4})` : '') : 'nessuna'}`;
      out.push(s);
    }
    return out;
  }

  /** Riassunto compatto: intestazione, setup, warn/error, segmenti a blocchi, PiP/heartbeat per minuto, summary (in ordine di arrivo). */
  function summaryText(header = '') {
    const out = [];
    if (header) out.push(String(header).trimEnd(), '');
    out.push(`# riassunto del log: ${total} righe totali${omitted ? `, ${omitted} omesse dall'archivio` : ''} (log completo: «Salva log completo»)`);
    const segOut = segLines(10, 25), hasSeg = segOut.length;
    // le righe aggregate si inseriscono prima del primo summary/warn successivo al primo segmento
    const ev = [
      ...keep.map((e) => ({ t: e.t, line: e.line, k: e.cat })),
      ...perMinute(pipSeen, 25).map((e) => ({ t: e.t, line: e.line, k: 'pip' })),
      ...perMinute(hbSeen, 25).map((e) => ({ t: e.t, line: e.line, k: 'heartbeat' })),
    ].sort((a, b) => a.t - b.t);
    const firstSeg = hasSeg ? Math.min(...[...segs.values()].map((r) => r.t ?? Infinity)) : Infinity;
    let placed = !hasSeg;
    const place = () => { if (!placed) { out.push(...segOut); placed = true; } };
    for (const e of ev) { if (!placed && e.t >= firstSeg && e.k !== 'setup') place(); out.push(e.line); }
    place();
    return out.join('\n');
  }

  return {
    add, clear, fullText, tail, summaryText,
    get total() { return total; }, get omitted() { return omitted; }, get size() { return lines.length; },
  };
}
