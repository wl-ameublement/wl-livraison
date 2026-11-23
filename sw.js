/* WL Livraison — Service worker
   Met l'enveloppe de l'app en cache pour un démarrage rapide et
   un fonctionnement de base hors ligne. Les appels externes
   (Photon, OSRM, Supabase) passent toujours par le réseau. */
const CACHE = "wl-livraison-v21";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./data.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Réseau direct pour tout ce qui n'est pas l'enveloppe locale
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const network = fetch(e.request).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
