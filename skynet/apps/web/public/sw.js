// ─── Skynet service worker ──────────────────────────────────────────────────
// Gives the SPA an offline app shell and a push → Inbox entry-point. Kept
// build-tool-agnostic: we precache the few static entrypoints and runtime-cache
// the hashed Vite assets as they're first requested, so a later offline visit
// reloads from cache. Registered only in production (see src/pwa/pwa.ts), so the
// Vite dev server / HMR is never intercepted.

const VERSION = "skynet-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

// Static entrypoints known at author-time. Hashed JS/CSS are cached at runtime.
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/icon-maskable.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // App navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/index.html").then((r) => r || caches.match("/")),
      ),
    );
    return;
  }

  // Same-origin static assets (hashed Vite bundles): stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
    return;
  }

  // Cross-origin (e.g. Google Fonts): cache-first, opaque-tolerant.
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const res = await fetch(request).catch(() => undefined);
        if (res) cache.put(request, res.clone());
        return res || Response.error();
      }),
    );
  }
});

// ─── Push → Inbox ───────────────────────────────────────────────────────────
// A push from the server (or a local demo notification) lands the operator in
// the Inbox. The payload may carry a target view/agent; we default to the queue.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data && event.data.text ? event.data.text() : "" };
  }
  const title = data.title || "Skynet — needs you";
  const view = data.view || "queue";
  const options = {
    body: data.body || "An agent is blocked and waiting on a decision.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.tag || "skynet-inbox",
    renotify: true,
    data: { url: `/?view=${view}&source=push`, view, agentId: data.agentId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || "/?view=queue&source=push";
  const view = data.view || "queue";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing tab and tell it to navigate to the Inbox in-place.
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "skynet:navigate", view, agentId: data.agentId || null });
          return client.focus();
        }
      }
      // Otherwise open a fresh window deep-linked to the Inbox.
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    }),
  );
});
