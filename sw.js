const CACHE_NAME = "biblio-cache-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./style.css",
  "./db.js",
  "./parsers.js",
  "./app.js",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdn.jsdelivr.net/npm/epubjs/dist/epub.min.js"
];

// Stockage temporaire en mémoire des fichiers à servir via une URL normale du
// site (contourne un bug WebKit où les URL "blob:" ne fonctionnent pas de
// façon fiable dans une PWA installée en mode plein écran).
const blobStore = new Map();

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "store-blob") {
    blobStore.set(data.id, data.blob);
  } else if (data.type === "clear-blob") {
    blobStore.delete(data.id);
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch(() => {
            /* une ressource externe peut échouer au 1er lancement hors-ligne, ce n'est pas bloquant */
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.includes("/__blob__/")) {
    const id = url.pathname.split("/__blob__/")[1];
    const blob = blobStore.get(id);
    if (blob) {
      event.respondWith(new Response(blob, { headers: { "Content-Type": "application/pdf" } }));
    } else {
      event.respondWith(new Response("Fichier introuvable (session expirée)", { status: 404 }));
    }
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && event.request.method === "GET") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
