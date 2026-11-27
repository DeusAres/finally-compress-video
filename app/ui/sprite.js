// Mini motore di sprite pixel art → SVG inline (nitido a qualunque scala, zero immagini).
// Ogni sprite è un array di righe; ogni carattere è un pixel. '.' o ' ' = trasparente.
// Colori: lettere mappate su var(--px-*) del tema, 'c' = currentColor.
export const PX_COLORS = {
  k: 'var(--px-ink)', p: 'var(--px-plum)', r: 'var(--px-red)', o: 'var(--px-orange)',
  y: 'var(--px-yellow)', l: 'var(--px-lime)', g: 'var(--px-green)', t: 'var(--px-teal)',
  n: 'var(--px-navy)', b: 'var(--px-blue)', s: 'var(--px-sky)', a: 'var(--px-cyan)',
  w: 'var(--px-white)', v: 'var(--px-silver)', e: 'var(--px-slate)', d: 'var(--px-steel)',
  c: 'currentColor',
};

/** Ritorna una stringa <svg> dallo sprite. opts: {scale (px per pixel), title, className, colors} */
export function sprite(rows, { scale = 4, title = '', className = '', colors = PX_COLORS } = {}) {
  const h = rows.length, w = Math.max(...rows.map((r) => r.length));
  let rects = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') { x++; continue; }
      let run = 1; while (row[x + run] === ch) run++;
      rects += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${colors[ch] || ch}"/>`;
      x += run;
    }
  });
  const a11y = title ? `role="img" aria-label="${title}"` : 'aria-hidden="true"';
  return `<svg class="px-sprite ${className}" ${a11y} viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges">${rects}</svg>`;
}

/** Sprite pronti all'uso (condivisi con fun.js). */
export const SPRITES = {
  // logo: fotogramma HDR (sole giallo) schiacciato da due frecce
  logo: [
    '...kkkkkkkkkk...',
    '...kwkbbbbkwk...',
    '...kkkbbbbkkk...',
    'y..kwkbyybkwk..y',
    'yy.kkkyyyykkk.yy',
    'yyykwkyyyykwkyyy',
    'yy.kkkbyybkkk.yy',
    'y..kwkbbbbkwk..y',
    '...kkkbbbbkkk...',
    '...kwkbbbbkwk...',
    '...kkkkkkkkkk...',
  ],
  film: [
    'c.cccc.c', 'cccccccc', 'c.c..c.c', 'ccc..ccc', 'c.c..c.c', 'ccc..ccc', 'cccccccc', 'c.cccc.c',
  ],
  trash: [
    '..cccc..', 'cccccccc', '........', '.c.cc.c.', '.c.cc.c.', '.c.cc.c.', '.c.cc.c.', '.cccccc.',
  ],
  analisi: [
    '.ccc....', 'c...c...', 'c...c...', 'c...c...', '.ccc....', '....cc..', '.....cc.', '......cc',
  ],
  video: [
    'c.cccc.c', 'cccccccc', 'c.c..c.c', 'ccc..ccc', 'c.c..c.c', 'ccc..ccc', 'cccccccc', 'c.cccc.c',
  ],
  audio: [
    '...ccccc', '...c...c', '...c...c', '...c...c', '.ccc.ccc', 'cccccccc', 'cccccccc', '.cc..cc.',
  ],
  scrittura: [
    'ccccccc.', 'c.cccc.c', 'c.cccc.c', 'c......c', 'c.cccc.c', 'c.c..c.c', 'c.cccc.c', 'cccccccc',
  ],
  fatto: [
    '...cc...', '...cc...', 'cccccccc', '.cccccc.', '..cccc..', '.cccccc.', '.cc..cc.', 'cc....cc',
  ],
  errore: [
    '.cccccc.', 'cccccccc', 'c..cc..c', 'c..cc..c', 'cccccccc', '.ccc.cc.', '.cccccc.', '.c.cc.c.',
  ],
  check: [
    '......c', '.....cc', 'c...cc.', 'cc.cc..', '.ccc...', '..c....',
  ],
  heart: [
    '.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...',
  ],
  heartEmpty: [
    '.ee.ee.', 'e..e..e', 'e.....e', '.e...e.', '..e.e..', '...e...',
  ],
  star: [
    '...y...', '...y...', 'yyyyyyy', '.yyyyy.', '..yyy..', '.yy.yy.', 'yy...yy',
  ],
  // v0.38: interruttore HDR/SDR (sole/luna), chiudi, bussola (Apri in Safari)
  sun: [
    '.....o.....', '.o...o...o.', '..o.....o..', '....yyy....', '...yyyyy...', 'oo.yyyyy.oo',
    '...yyyyy...', '....yyy....', '..o.....o..', '.o...o...o.', '.....o.....',
  ],
  moon: [
    '....wwww...', '..wwwww....', '.wwww......', '.www.......', 'wwww.......', 'wwww.......',
    'wwww.......', '.wwww....w.', '.wwwww..ww.', '..wwwwwwww.', '....wwww...',
  ],
  x: ['cc...cc', '.cc.cc.', '..ccc..', '...c...', '..ccc..', '.cc.cc.', 'cc...cc'],
  compass: [
    '..ccccc..', '.c.....c.', 'c....c..c', 'c...ccc.c', 'c..ccc..c', 'c.ccc...c', 'c..c....c', '.c.....c.', '..ccccc..',
  ],
  chevron: [
    'c...', 'cc..', '.cc.', '..cc', '.cc.', 'cc..', 'c...',
  ],
};
