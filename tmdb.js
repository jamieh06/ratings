/* TMDB data for TV Ratings: search, show details, lazily loaded seasons, image URLs.
   One global: window.TMDB. Plain browser JS, no dependencies.
   - The TMDB key is pasted by Jamie once and kept only in this browser's localStorage ('tvr.tmdbKey'); it is never in code.
   - No key: every call answers from window.TV_DATA (sample.js) in the same shapes. Sample 'yours'/'mine' scores are never returned from here.
   - Key: answers from TMDB with a localStorage cache ('tvr.cache.*': 24 h show/season, 1 h search, 7 days configuration).
   - Offline or failing network: cache (even if stale), then sample data for sample shows, else a readable Error.
   Image sizes come from TMDB /configuration at runtime (defaults below if that fails). */
(function () {
  'use strict';

  const API = 'https://api.themoviedb.org/3';
  const IMG = 'https://image.tmdb.org/t/p/';

  const KEY_STORE = 'tvr.tmdbKey';
  const CACHE_PREFIX = 'tvr.cache.';
  const TTL = { show: 24 * 3600e3, season: 24 * 3600e3, search: 3600e3, config: 7 * 24 * 3600e3 };
  const MAX_CACHE_CHARS = 1500000;          // well under the browser's ~5M-character localStorage limit, which ratings share
  const MAX_AGE_KEEP = 14 * 24 * 3600e3;    // entries older than this are never useful, even as an offline fallback

  /* ---------- storage helpers (every access guarded) ---------- */
  function store() { try { return window.localStorage || null; } catch (e) { return null; } }
  function lsGet(k) { try { const s = store(); return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { const s = store(); if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { const s = store(); if (s) s.removeItem(k); } catch (e) {} }
  function lsKeys(prefix) {
    const out = [];
    try { const s = store(); if (s) for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.indexOf(prefix) === 0) out.push(k); } } catch (e) {}
    return out;
  }

  /* ---------- key ---------- */
  let memKey = '';   // used only if localStorage is unavailable, so the app still works for this visit
  function getKey() { return (lsGet(KEY_STORE) || memKey || '').trim(); }

  /* ---------- cache ---------- */
  function cacheGet(name) {
    try {
      const raw = lsGet(CACHE_PREFIX + name);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o.t !== 'number' || !('v' in o)) return null;
      return o;
    } catch (e) { return null; }
  }
  function isFresh(entry, ttl) { return !!entry && Date.now() - entry.t < ttl; }
  function evict(targetChars) {
    // drop expired entries first, then oldest first, until the cache is under targetChars
    const rows = lsKeys(CACHE_PREFIX).map(k => {
      const raw = lsGet(k) || ''; let t = 0;
      try { t = JSON.parse(raw).t || 0; } catch (e) {}
      return { k, t, n: raw.length };
    });
    const now = Date.now();
    let total = 0; rows.forEach(r => { total += r.n; });
    rows.sort((a, b) => a.t - b.t);
    for (const r of rows) {
      if (total <= targetChars && now - r.t < MAX_AGE_KEEP) break;
      lsDel(r.k); total -= r.n;
    }
  }
  function cachePut(name, value) {
    try {
      const raw = JSON.stringify({ t: Date.now(), v: value });
      if (raw.length > MAX_CACHE_CHARS / 2) return;   // never let one entry take the cache
      let total = raw.length;
      lsKeys(CACHE_PREFIX).forEach(k => { if (k !== CACHE_PREFIX + name) total += (lsGet(k) || '').length; });
      if (total > MAX_CACHE_CHARS) evict(MAX_CACHE_CHARS - raw.length);
      if (!lsSet(CACHE_PREFIX + name, raw)) {          // quota hit: make room once and retry
        evict(Math.floor(MAX_CACHE_CHARS / 2));
        lsSet(CACHE_PREFIX + name, raw);
      }
    } catch (e) {}
  }

  /* ---------- errors ---------- */
  function mkErr(message, code, status) { const e = new Error(message); e.code = code; if (status) e.status = status; return e; }
  /* TMDB sends vote_average 0 with vote_count 0 for unaired or unknown titles: that's no score, not 0.0. */
  function score(avg, count) { return num(count) ? num(avg) : null; }
  function isAbort(e) { return !!e && (e.name === 'AbortError'); }
  const MSG = {
    key: 'TMDB refused the key. Paste it again in Search, in the key row at the bottom (use the v3 API Key or the v4 Read Access Token from your TMDB account).',
    network: "Couldn't reach TMDB and nothing is saved for this yet. Check your connection and try again.",
    server: 'TMDB is having trouble right now and nothing is saved for this yet. Try again in a minute.',
    notfound: "TMDB doesn't have that.",
    nokey: "That show isn't in the sample shows. Add your TMDB key in Search (the key row at the bottom) to look up any show."
  };

  /* ---------- network ---------- */
  async function api(path, params, opts) {
    opts = opts || {};
    const key = opts.key != null ? opts.key : getKey();
    if (!key) throw mkErr(MSG.nokey, 'nokey');
    if (opts.signal && opts.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw mkErr(MSG.network, 'network');
    const q = new URLSearchParams();
    const bearer = /^eyJ/.test(key);          // v4 read access token (a JWT) goes in a header; v3 key goes in the query
    if (!bearer) q.set('api_key', key);
    q.set('language', 'en-US');
    Object.keys(params || {}).forEach(k => q.set(k, params[k]));
    const init = { headers: { Accept: 'application/json' } };
    if (bearer) init.headers.Authorization = 'Bearer ' + key;
    if (opts.signal) init.signal = opts.signal;
    let res;
    try { res = await fetch(API + path + '?' + q.toString(), init); }
    catch (e) { if (isAbort(e)) throw e; throw mkErr(MSG.network, 'network'); }
    if (res.status === 401) throw mkErr(MSG.key, 'key', 401);
    if (res.status === 404) throw mkErr(MSG.notfound, 'notfound', 404);
    if (res.status === 429 || res.status >= 500) throw mkErr(MSG.server, 'server', res.status);
    if (!res.ok) throw mkErr('TMDB said no (error ' + res.status + ').', 'http', res.status);
    try { return await res.json(); } catch (e) { if (isAbort(e) || (opts.signal && opts.signal.aborted)) throw e; throw mkErr('TMDB sent something unreadable. Try again.', 'http', res.status); }
  }

  const inflight = new Map();
  /* cache -> network -> (stale cache | sample) fallback */
  async function through(name, ttl, fetcher, sampleFn, signal) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const cached = cacheGet(name);
    if (isFresh(cached, ttl)) return cached.v;
    let p = signal ? null : inflight.get(name);
    if (!p) {
      p = fetcher();
      if (!signal) { inflight.set(name, p); const done = () => inflight.delete(name); p.then(done, done); }
    }
    try {
      const v = await p;
      cachePut(name, v);
      return v;
    } catch (e) {
      if (isAbort(e)) throw e;
      if (e.code === 'network' || e.code === 'server') {
        if (cached) return cached.v;
        const s = sampleFn && sampleFn();
        if (s) return s;
      }
      throw e;
    }
  }

  /* ---------- sample data (window.TV_DATA), same shapes as TMDB answers ---------- */
  function sampleShows() { const d = window.TV_DATA; return d && Array.isArray(d.shows) ? d.shows : []; }
  function tenths(v) { return typeof v === 'number' ? v / 10 : null; }
  function startYear(years) { const m = /\d{4}/.exec(years || ''); return m ? +m[0] : null; }
  function sampleShow(id) {
    const s = sampleShows().find(x => x.tmdb === +id);
    if (!s) return null;
    const seasons = (s.seasons || []).map(se => ({
      n: se.n, name: 'Season ' + se.n, episode_count: (se.eps || []).length, poster_path: null, air_date: null
    }));
    return {
      id: s.tmdb, name: s.name, years: s.years || '', poster_path: s.poster || null, backdrop_path: s.backdrop || null,
      vote_average: tenths(s.community), vote_count: s.votes == null ? null : s.votes,
      status: /–\s*$/.test(s.years || '') ? 'Returning Series' : 'Ended', seasons
    };
  }
  function sampleSeason(id, n) {
    const s = sampleShows().find(x => x.tmdb === +id);
    const se = s && (s.seasons || []).find(x => x.n === +n);
    if (!se) return null;
    return {
      n: se.n,
      episodes: (se.eps || []).map((r, i) => ({
        e: i + 1, name: r[2], still_path: r[3] || null, air_date: null, runtime: null,
        vote_average: tenths(r[0]), vote_count: r[4] == null ? null : r[4]
      }))
    };
  }
  function sampleSearch(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return sampleShows().filter(s => String(s.name).toLowerCase().indexOf(q) !== -1).map(s => ({
      id: s.tmdb, name: s.name, year: startYear(s.years), poster_path: s.poster || null,
      vote_average: tenths(s.community), vote_count: s.votes == null ? null : s.votes
    }));
  }

  /* ---------- mapping TMDB answers to our shapes ---------- */
  function yearOf(d) { const m = /^(\d{4})/.exec(d || ''); return m ? +m[1] : null; }
  function num(v) { return typeof v === 'number' ? v : null; }
  function mapSearchRow(r) {
    return {
      id: r.id, name: r.name || r.original_name || '', year: yearOf(r.first_air_date),
      poster_path: r.poster_path || null, vote_average: score(r.vote_average, r.vote_count), vote_count: num(r.vote_count)
    };
  }
  function yearsOf(d) {
    const a = yearOf(d.first_air_date); if (!a) return '';
    if (d.status === 'Ended' || d.status === 'Canceled') {
      const b = yearOf(d.last_air_date) || a;
      return b === a ? String(a) : a + '–' + b;
    }
    return a + '–';
  }
  function mapShow(d) {
    // all seasons are kept here (incl. Specials, n = 0); show() filters on the way out so one cache entry serves both
    return {
      id: d.id, name: d.name || '', years: yearsOf(d), poster_path: d.poster_path || null, backdrop_path: d.backdrop_path || null,
      vote_average: score(d.vote_average, d.vote_count), vote_count: num(d.vote_count), status: d.status || '',
      seasons: (d.seasons || []).map(se => ({
        n: se.season_number, name: se.name || ('Season ' + se.season_number), episode_count: se.episode_count == null ? 0 : se.episode_count,
        poster_path: se.poster_path || null, air_date: se.air_date || null
      }))
    };
  }
  function mapSeason(d, n) {
    return {
      n: d.season_number == null ? n : d.season_number,
      episodes: (d.episodes || []).map(ep => ({
        e: ep.episode_number, name: ep.name || '', still_path: ep.still_path || null, air_date: ep.air_date || null,
        runtime: num(ep.runtime), vote_average: score(ep.vote_average, ep.vote_count), vote_count: num(ep.vote_count)
      }))
    };
  }

  /* ---------- images ---------- */
  const DEFAULT_SIZES = {
    poster: ['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original'],
    still: ['w92', 'w185', 'w300', 'original'],
    backdrop: ['w300', 'w780', 'w1280', 'original']
  };
  // wanted width per kind and tier: posters w342 in grids, w500 on the show page; stills w300 in lists
  const WANT = {
    poster: { small: 92, grid: 342, page: 500 },
    still: { small: 92, grid: 185, page: 300 },
    backdrop: { small: 300, grid: 780, page: 1280 }
  };
  let sizes = null, cfgTried = false;
  function readConfigSizes(cfg) {
    const im = cfg && cfg.images; if (!im) return null;
    const pick = (a, d) => (Array.isArray(a) && a.length ? a : d);
    return {
      poster: pick(im.poster_sizes, DEFAULT_SIZES.poster),
      still: pick(im.still_sizes, DEFAULT_SIZES.still),
      backdrop: pick(im.backdrop_sizes, DEFAULT_SIZES.backdrop)
    };
  }
  function currentSizes() {
    if (sizes) return sizes;
    const c = cacheGet('config');
    if (isFresh(c, TTL.config)) { const s = readConfigSizes(c.v); if (s) { sizes = s; return s; } }
    if (getKey() && !cfgTried) { cfgTried = true; loadConfig().catch(() => {}); }   // refresh quietly for next time
    return DEFAULT_SIZES;
  }
  async function loadConfig(key) {
    const c = cacheGet('config');
    if (isFresh(c, TTL.config) && key == null) return c.v;
    const cfg = await api('/configuration', {}, key == null ? {} : { key });
    cachePut('config', { images: cfg.images || null });
    const s = readConfigSizes(cfg); if (s) sizes = s;
    return cfg;
  }
  function chooseSize(list, wantW) {
    const widths = list.map(s => /^w(\d+)$/.exec(s)).filter(Boolean).map(m => +m[1]).sort((a, b) => a - b);
    if (!widths.length) return list.indexOf('original') !== -1 ? 'original' : 'w500';
    if (widths.indexOf(wantW) !== -1) return 'w' + wantW;
    const up = widths.find(w => w > wantW);
    return 'w' + (up || widths[widths.length - 1]);
  }

  /* ---------- public API ---------- */
  const TMDB = {
    hasKey() { return !!getKey(); },

    clearKey() {
      memKey = ''; lsDel(KEY_STORE); sizes = null; cfgTried = false;
    },

    // Checks the key with one cheap call (/configuration, which we also want for image sizes), then stores it.
    async setKey(k) {
      const key = String(k == null ? '' : k).trim();
      if (!key) return { ok: false, message: 'Paste your TMDB key first.' };
      if (/\s/.test(key)) return { ok: false, message: "That doesn't look like a TMDB key (it has spaces in it)." };
      try {
        const cfg = await loadConfig(key);
        const stored = lsSet(KEY_STORE, key);
        if (!stored) memKey = key;
        sizes = readConfigSizes(cfg) || sizes;
        return { ok: true, message: stored ? 'Key accepted and saved in this browser.' : "Key accepted for this visit, but this browser wouldn't save it, so you'll need to paste it again next time." };
      } catch (e) {
        if (e.code === 'key') return { ok: false, message: 'TMDB refused that key. Check you copied all of it (the v3 API Key or the v4 Read Access Token) and try again.' };
        if (e.code === 'network') return { ok: false, message: "Couldn't reach TMDB to check the key, so it wasn't saved. Check your connection and try again." };
        return { ok: false, message: e.message || 'Something went wrong checking the key.' };
      }
    },

    async search(query, opts) {
      const q = String(query == null ? '' : query).trim();
      const signal = opts && opts.signal;
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!q) return [];
      if (!getKey()) return sampleSearch(q);
      return through('search.' + q.toLowerCase(), TTL.search, async () => {
        const d = await api('/search/tv', { query: q, include_adult: 'false', page: 1 }, { signal });
        return (d.results || []).map(mapSearchRow);
      }, () => { const s = sampleSearch(q); return s.length ? s : null; }, signal);
    },

    async show(id, opts) {
      const sid = +id;
      if (!sid) throw mkErr("That isn't a show id.", 'badid');
      const specials = !!(opts && opts.specials);
      let r;
      if (!getKey()) {
        r = sampleShow(sid);
        if (!r) throw mkErr(MSG.nokey, 'nokey');
      } else {
        r = await through('show.' + sid, TTL.show, async () => mapShow(await api('/tv/' + sid)), () => sampleShow(sid));
      }
      r = JSON.parse(JSON.stringify(r));
      if (!specials) r.seasons = r.seasons.filter(se => se.n !== 0);
      return r;
    },

    async season(id, n) {
      const sid = +id, sn = Number(n);
      if (!sid || !Number.isInteger(sn) || sn < 0) throw mkErr("That isn't a show and season.", 'badid');
      if (!getKey()) {
        const r = sampleSeason(sid, sn);
        if (!r) throw mkErr(MSG.nokey, 'nokey');
        return r;
      }
      const r = await through('season.' + sid + '.' + sn, TTL.season, async () => mapSeason(await api('/tv/' + sid + '/season/' + sn), sn), () => sampleSeason(sid, sn));
      return JSON.parse(JSON.stringify(r));
    },

    // Returns a URL, or null when there is no image (callers draw a placeholder tile).
    img(path, kind, size) {
      if (!path || typeof path !== 'string') return null;
      if (/^https?:\/\//.test(path)) return path;
      const k = WANT[kind] ? kind : 'poster';
      const tier = WANT[k][size] ? size : 'grid';
      const list = (TMDB.source === 'tmdb' ? currentSizes() : DEFAULT_SIZES)[k];
      return IMG + chooseSize(list, WANT[k][tier]) + (path.charAt(0) === '/' ? path : '/' + path);
    }
  };
  Object.defineProperty(TMDB, 'source', { enumerable: true, get() { return getKey() ? 'tmdb' : 'sample'; } });

  window.TMDB = TMDB;
})();
