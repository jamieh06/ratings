/* TV Ratings service worker: keeps the app shell so the app opens offline after the first visit.
   The shell (SHELL below) is one generation: every online page load fetches index.html and every other shell file
   (CODE: index.html, JS, CSS) together, and only when all of them arrived does it replace the cached copies (index.html last) and answer the page.
   So the page always gets an index.html and JS/CSS that belong together, on the very first load after a deploy.
   - Slow or offline (nothing back within NETWORK_WAIT): the cached generation is shown whole; that fetch is thrown away and
     the next online load tries again.
   - Shell files requested by the page: cache first (they are the generation above; nothing is fetched behind its back).
   - TMDB API calls: never touched here (tmdb.js keeps its own answers in localStorage).
   - TMDB images: cached as they are seen, newest IMG_MAX kept.
   ON A DEPLOY: just publish. A changed JS, CSS or index.html file arrives on the first online load, no bump needed.
   Changed icons or manifest: bump VERSION (they are fetched only at install).
   Edit this file, and bump VERSION, only when you add or remove a file in SHELL (a new JS or CSS file must be listed here or it is
   not available offline), or to force-clear the cache. The browser re-reads sw.js itself on every load. */
const VERSION = 'v2';   // v2: top.js and top.css added to SHELL
const SHELL_CACHE = 'tvr-shell-' + VERSION;
const IMG_CACHE = 'tvr-img-v1';             // kept across versions, trimmed by count
const IMG_PREFIX = 'https://image.tmdb.org/t/p/';
const IMG_MAX = 150;
const SHELL = ['index.html', 'sample.js', 'store.js', 'tmdb.js', 'search.js', 'search.css', 'diary.js', 'diary.css', 'top.js', 'top.css',
  'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/favicon.svg', 'icons/favicon-32.png'];
const CODE = SHELL.slice(0, 10);          // what must match index.html: fetched together on each online load (icons and manifest only at install)
const BASE = self.registration.scope;
const url = p => new URL(p, BASE).href;
const INDEX = url('index.html');
const SHELL_URLS = new Set(SHELL.map(url));
const NETWORK_WAIT = 4000;                  // on a slow connection, show the cached copy after this long

self.addEventListener('install', event => {
  event.waitUntil(fetchGeneration(SHELL).then(commit).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('tvr-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const u = req.url;
  if (req.mode === 'navigate' && u.startsWith(BASE) && !u.startsWith(BASE + 'icons/')) {
    const path = new URL(u).pathname.slice(new URL(BASE).pathname.length);
    if (path === '' || path === 'index.html') return event.respondWith(indexNetworkFirst(event));
  }
  const noQuery = u.split('#')[0].split('?')[0];
  if (SHELL_URLS.has(noQuery)) return event.respondWith(shellCacheFirst(event, noQuery));
  if (u.startsWith(IMG_PREFIX)) return event.respondWith(image(event));
  // everything else (TMDB API, anything off-site) goes straight to the network
});

// every shell file, fetched fresh together and read in full; fails as a whole if any one fails (a half-new shell is worse than the old one)
async function fetchGeneration(list) {
  return Promise.all(list.map(async p => {
    const res = await fetch(url(p), { cache: 'no-cache' });
    if (!res.ok) throw new Error(p + ' ' + res.status);
    return { url: url(p), body: await res.arrayBuffer(), type: res.headers.get('Content-Type') || '' };
  }));
}

const asResponse = e => new Response(e.body.slice(0), { headers: { 'Content-Type': e.type } });

async function commit(entries) {
  const cache = await caches.open(SHELL_CACHE);
  for (const e of entries) if (e.url !== INDEX) await cache.put(e.url, asResponse(e));
  await cache.put(INDEX, asResponse(entries.find(e => e.url === INDEX)));   // index last
}

async function indexNetworkFirst(event) {
  const state = { late: false, committing: false };
  const fresh = fetchGeneration(CODE).then(async entries => {
    if (state.late) return null;            // the page was already answered from the cache: keep that generation whole
    state.committing = true;                // set in the same tick as the check above, so the timeout can't slip in between
    await commit(entries);
    return asResponse(entries.find(e => e.url === INDEX));
  });
  fresh.catch(() => {});
  event.waitUntil(fresh.catch(() => {}));
  try {
    const res = await Promise.race([fresh, new Promise((_, no) => setTimeout(no, NETWORK_WAIT))]);
    if (res) return res;
  } catch (e) {}
  if (state.committing) { try { const res = await fresh; if (res) return res; } catch (e) {} }   // a swap has begun: wait for it, never serve half of it
  state.late = true;
  return (await (await caches.open(SHELL_CACHE)).match(INDEX)) || fetch(INDEX);
}

async function shellCacheFirst(event, key) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(key);
  if (res.ok) event.waitUntil(cache.put(key, res.clone()));
  return res;
}

let trimming = Promise.resolve();            // one trim at a time, so a burst of images can't over- or under-trim

async function image(event) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(event.request.url);
  if (hit) return hit;
  try {
    // a CORS request gives a readable response that costs its real size in storage (an opaque one is counted far larger)
    const res = await fetch(event.request.url, { mode: 'cors' });
    if (res.ok) event.waitUntil(cache.put(event.request.url, res.clone()).then(() => (trimming = trimming.then(() => trim(cache)))));
    return res;
  } catch (e) {
    return fetch(event.request);            // no CORS headers or offline: pass it through, don't keep it
  }
}

async function trim(cache) {
  const keys = await cache.keys();          // oldest first
  for (let i = 0; i < keys.length - IMG_MAX; i++) await cache.delete(keys[i]);
}
