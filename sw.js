/**
 * Service worker mínimo: cachea el "cascarón" estático de la página
 * (HTML/CSS/JS propios) SOLO como respaldo para cuando no hay internet.
 * Mientras haya conexión, siempre se pide la versión más nueva a la red
 * primero — así cada actualización que se publique se ve de inmediato,
 * sin quedar atascado en una copia vieja cacheada.
 *
 * NUNCA intercepta peticiones a otros orígenes (api.binance.com,
 * TradingView) — esas siempre van directo a la red, porque los datos
 * deben ser reales y en vivo, nunca servidos desde caché.
 */
const CACHE_NAME = 'xauusd-shell-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './chart.js',
  './analysis.js',
  './indicators.js',
  './backtest.js',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // Binance / TradingView: siempre red directa
  if (event.request.method !== 'GET') return;

  // Network-first: intenta traer siempre la versión más nueva. Solo si no
  // hay conexión (fetch falla) se usa la copia guardada como respaldo.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
