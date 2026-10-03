// Offline support: app shell + libraries cached on first visit; map tiles cached as you view them.
const SHELL = "garden-shell-v2";
const RUNTIME = "garden-runtime-v1";
const TILES = "garden-tiles-v1";
const SHELL_FILES = ["./", "index.html", "styles.css", "app.js", "db.js", "ai.js", "manifest.webmanifest", "icon.svg",
  "tracker.js", "geo.js", "plan.js", "vendor/anthropic-sdk.mjs", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  const keep = [SHELL, RUNTIME, TILES];
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("anthropic.com")) return;

  const isTile = url.hostname.includes("arcgisonline.com") || url.hostname.includes("tile.openstreetmap.org");
  if (isTile) {
    e.respondWith(
      caches.open(TILES).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") { c.put(req, res.clone()); trim(TILES, 1500); }
        return res;
      })
    );
    return;
  }

  // Stale-while-revalidate for the app itself and CDN libraries/fonts.
  const cacheName = url.origin === self.location.origin ? SHELL : RUNTIME;
  e.respondWith(
    caches.open(cacheName).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: url.origin === self.location.origin });
      const net = fetch(req)
        .then((res) => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; })
        .catch(() => hit);
      return hit || net;
    })
  );
});
