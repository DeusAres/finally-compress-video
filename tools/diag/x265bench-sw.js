// Service worker SOLO per tools/diag/x265bench.html (scope './x265bench.html'): GitHub Pages non manda COOP/COEP,
// qui li aggiungiamo alla navigazione della pagina così diventa crossOriginIsolated (SharedArrayBuffer → x265 multi-thread).
// Non tocca l'app (sw.js), le altre pagine diag né le richieste diverse dalla navigazione. Per rimuoverlo: pulsante nella pagina.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.mode !== 'navigate') return;
  e.respondWith(fetch(r, { cache: 'no-store' }).then((res) => {
    if (!res || res.status === 0 || res.type === 'opaqueredirect') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
