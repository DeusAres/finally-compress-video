// Offline: l'app si apre senza rete. Stessa strategia dell'app sorella finally-cool-film.
// - install: tutta l'app è in cache (PRECACHE: la pagina, ogni modulo come lo richiedono le pagine (?v=<id>), CSS, icone;
//   PRECACHE_CDN: il bundle Mediabunny), scritta da tools/stamp-version.sh prima del commit; un rilascio nuovo è un worker e una cache nuovi;
// - la pagina: rete per prima (online è sempre l'ultima), cache se la rete fallisce o non risponde entro NAV_WAIT_MS
//   (un telefono con Wi-Fi senza internet non fallisce, resta appeso); una risposta tardiva aggiorna comunque la cache;
// - moduli, CSS, icone: URL esatto dalla cache, altrimenti rete (e tenuto); offline, qualunque versione in cache;
// - cross-origin: solo il bundle Mediabunny (jsdelivr) e Google Fonts (cache a runtime); il resto non si tocca;
// - version.txt (checkUpdate in index.html): mai in cache. I video scelti dall'utente sono File locali, non passano di qui.
const VERSION = '0.33-20261123T000313Z';
/*PRECACHE:BEGIN*/const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'app/lib/frames.js?v=0.33',
  'app/ui/estimate.js?v=0.33',
  'app/lib/encode.js?v=0.33',
  'app/lib/downscale.js?v=0.33',
  'app/lib/hevc-vui.js?v=0.33',
  'app/lib/brctl.js?v=0.33',
  'app/lib/dovi.js?v=0.33',
  'app/lib/mp4-post.js?v=0.33',
  'app/lib/passthrough.js?v=0.33',
  'app/lib/apac.js?v=0.33',
  'app/lib/echo.js?v=0.33',
  'app/lib/opfs.js?v=0.33',
  'app/lib/opfs-worker.js?v=0.33',
  'app/lib/jobstore.js?v=0.33',
  'app/lib/keepalive.js?v=0.33',
  'app/lib/chime.js?v=0.33',
  'app/lib/pip.js?v=0.33',
  'app/lib/scenesearch.js?v=0.33',
  'app/lib/ratecontrol.js?v=0.33',
  'app/lib/scenes.js?v=0.33',
  'app/lib/quality.js?v=0.33',
  'app/ui/ui.js?v=0.33',
  'app/ui/bus.js?v=0.33',
  'app/ui/sprite.js?v=0.33',
  'app/ui/logstore.js?v=0.33',
  'vendor/mediabunny-1.65.1.min.mjs',
  'app/ui/theme.css',
  'app/ui/ui.css',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/fonts/PixelifySans-400-1.woff2',
  'vendor/fonts/PixelifySans-400-2.woff2',
  'vendor/fonts/PixelifySans-400-3.woff2',
  'vendor/fonts/PixelifySans-600-4.woff2',
  'vendor/fonts/PixelifySans-600-5.woff2',
  'vendor/fonts/PixelifySans-600-6.woff2',
  'vendor/fonts/PixelifySans-700-7.woff2',
  'vendor/fonts/PixelifySans-700-8.woff2',
  'vendor/fonts/PixelifySans-700-9.woff2',
  'vendor/fonts/Silkscreen-400-10.woff2',
  'vendor/fonts/Silkscreen-400-11.woff2',
  'vendor/fonts/Silkscreen-700-12.woff2',
  'vendor/fonts/Silkscreen-700-13.woff2',
  'vendor/fonts/VT323-400-14.woff2',
  'vendor/fonts/VT323-400-15.woff2',
  'vendor/fonts/VT323-400-16.woff2',
  'vendor/fonts/fonts.css',
];/*PRECACHE:END*/
/*CDN:BEGIN*/const PRECACHE_CDN = [
];/*CDN:END*/
const CACHE = `fcv-${VERSION}`;
const NAV_WAIT_MS = 3000;   // scelta a sensazione (non misurata): una connessione mobile funzionante serve la pagina ben entro 3 s
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const CDN_HOST = 'cdn.jsdelivr.net';
const SKIP_PATHS = ['/samples/', '/docs/', '/tools/'];   // mai in cache (video di prova, documenti, strumenti)

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));   // oltre la cache HTTP di Pages (~10 min)
    for (const u of PRECACHE_CDN) { try { await c.add(u); } catch { /* CDN irraggiungibile ora: verrà tenuto al primo uso */ } }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fcv-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (req, res) => {
  if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  const same = url.origin === location.origin;
  if (!same && url.hostname !== CDN_HOST && !FONT_HOSTS.includes(url.hostname)) return;   // altre origini: rete normale
  if (same && (url.pathname.endsWith('/version.txt') || SKIP_PATHS.some((p) => url.pathname.includes(p)))) return;
  if (same && req.mode === 'navigate') {
    const net = fetch(req).then((res) => keep(req, res));
    e.waitUntil(net.catch(() => {}));   // una risposta tardiva finisce comunque in cache
    const cached = () => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'));
    const late = new Promise((ok) => setTimeout(ok, NAV_WAIT_MS)).then(cached);
    e.respondWith(Promise.race([net, late.then((hit) => hit || net)]).catch(() => cached().then((hit) => hit || Response.error())));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))
    .catch(() => caches.match(req, { ignoreSearch: true }).then((old) => old || Response.error()))));
});
