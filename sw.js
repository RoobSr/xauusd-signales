/**
 * Service worker mínimo: solo cachea el "cascarón" estático de la página
 * (HTML/CSS/JS propios) para que abra rápido/offline en otro dispositivo
 * una vez visitada. NUNCA intercepta peticiones a otros orígenes
 * (api.binance.com, TradingView) — esas siempre van directo a la red,
 * porque los datos deben ser reales y en vivo, nunca servidos desde caché.
 */
const CACHE_NAME = 'xauusd-shell-v1';
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
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
