/* Sync: one set of ratings for the TV, the Mac and the iPhone, in the To Do app's Supabase (public.tv_rating, the table
   Free My TV's own Watched prompt writes to). One global: window.Sync.

   Who it is, one of two ways:
   - On the TV (inside Free My TV) the TV sends its key with postMessage ({type: 'fmtv-ratings', supabaseUrl,
     supabaseKey, tvKey, tmdbKey}); the key stays in memory.
   - On the Mac and iPhone it uses the To Do app's sign-in: same site (jamieh06.github.io), same saved session
     ('todo.session'), as the To Do app's tv.html does. Sign in there once (Edit Lists → Sync).

   How: a three-way merge per rating, against what both sides agreed on at the last sync ('tvr.sync.base'):
   changed here only → sent up; changed there only → taken; changed on both, or never synced → the newer rated_at wins.
   That way deletes travel too, and an Undo here (an older score with its older time) still wins over the server.
   Runs on open, when the page comes back, every 2 minutes while it's showing, and a second after any rating here.
   Server functions: tv_app_ratings(p_key) and tv_app_write(p_set, p_unset, p_key) (TV Ratings/bridge/*.sql). */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://ajgymyqgthxaiqoniwbe.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_5JI6nVkFUSISlmX1dntU8Q_QTJUGxR5';   // public by design; row level security guards the data
  const SESSION_KEY = 'todo.session', BASE_KEY = 'tvr.sync.base';
  const R = window.Ratings;

  let tv = null;              // {url, apikey, key} once Free My TV has sent it
  let state = 'off';          // 'off' (not signed in) | 'busy' | 'ok' | 'offline' | 'error'
  let lastOk = 0, timer = null, running = null, again = false;
  const listeners = [];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function setState(s) { state = s; listeners.forEach(fn => { try { fn(status()); } catch (e) {} }); }
  function status() { return { state, lastOk, tv: !!tv }; }

  /* ---------- who ---------- */
  class SignedOut extends Error {}
  function session() { try { return JSON.parse(lsGet(SESSION_KEY)); } catch (e) { return null; } }
  let refreshing = null;
  async function token() {
    const s = session();
    if (!s || !s.refresh_token) throw new SignedOut();
    if (s.expires_at - Date.now() > 60e3) return s.access_token;
    if (!refreshing) refreshing = (async () => {
      const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', { method: 'POST',
        headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        if (r.status === 400 || r.status === 401) { lsDel(SESSION_KEY); throw new SignedOut(); }
        throw new Error('net');
      }
      const next = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000,
                     email: d.user.email, id: d.user.id };
      lsSet(SESSION_KEY, JSON.stringify(next));   // shared with the To Do app, as tv.html does
      return next.access_token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  // whose ratings these are, so a different sign-in never merges against the wrong base
  function who() { if (tv) return 'tv'; const s = session(); return s && s.id ? s.id : null; }

  async function rpc(name, body) {
    let url = SUPABASE_URL, headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
    if (tv) { url = tv.url; headers.apikey = tv.apikey; body = Object.assign({ p_key: tv.key }, body); }
    else headers.Authorization = 'Bearer ' + await token();
    const r = await fetch(url + '/rest/v1/rpc/' + name, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => null);
    if (r.status === 401 && !tv) throw new SignedOut();
    if (!r.ok) { const e = new Error((d && d.message) || 'HTTP ' + r.status); e.status = r.status; throw e; }
    return d;
  }

  /* ---------- merge ---------- */
  function sig(rec) { return rec ? rec.tenths + '@' + rec.rated_at : null; }
  function rowSig(row) { return row ? Math.round(row.score * 10) + '@' + new Date(row.rated_at).toISOString() : null; }
  function itemOf(r) { return { kind: r.kind, tmdb_id: r.tmdb_id, season: r.season, episode: r.episode }; }
  function toRow(rec) {
    return { kind: rec.kind, tmdb_id: rec.tmdb_id, show_name: rec.show_name || '', season: rec.season, episode: rec.episode,
             episode_name: rec.kind === 'episode' ? rec.episode_name || null : null, score: rec.tenths / 10, rated_at: rec.rated_at };
  }
  function loadBase(user) {
    try { const b = JSON.parse(lsGet(BASE_KEY)); if (b && b.user === user && b.keys) return b.keys; } catch (e) {}
    return {};
  }
  function saveBase(user, rows) {
    const keys = {};
    rows.forEach(r => { const k = R.keyOf(itemOf(r)); if (k) keys[k] = rowSig(r); });
    lsSet(BASE_KEY, JSON.stringify({ user, keys }));
  }

  async function reconcile() {
    const user = who();
    if (!user) { setState('off'); return; }
    setState('busy');
    const server = await rpc('tv_app_ratings');
    if (!Array.isArray(server)) throw new Error('bad answer');
    const base = loadBase(user);
    const local = new Map(), remote = new Map();
    R.all().forEach(rec => local.set(R.keyOf(rec), rec));
    server.forEach(row => { const k = R.keyOf(itemOf(row)); if (k) remote.set(k, row); });

    const take = [], drop = [], put = [], unput = [];
    new Set([...local.keys(), ...remote.keys()]).forEach(k => {
      const L = local.get(k) || null, S = remote.get(k) || null, l = sig(L), s = rowSig(S), b = base[k] || null;
      if (l === s) return;
      let mine;
      if (l === b) mine = false;                 // only the server changed
      else if (s === b) mine = true;             // only this device changed
      else if (L && S) mine = L.rated_at > new Date(S.rated_at).toISOString();   // both, or never synced: newer wins (a tie keeps the server's)
      else mine = !!L;                           // one side has it, no agreed base: keep the rating rather than lose it
      if (mine) { if (L) put.push(toRow(L)); else unput.push(itemOf(S)); }
      else { if (S) take.push(S); else drop.push(itemOf(L)); }
    });

    if (take.length || drop.length) R.applyRemote(take, drop);
    let after = server;
    if (put.length || unput.length) after = await rpc('tv_app_write', { p_set: put, p_unset: unput });
    if (!Array.isArray(after)) throw new Error('bad answer');
    saveBase(user, after);
    lastOk = Date.now();
    setState('ok');
  }

  function run() {
    if (running) { again = true; return running; }
    running = reconcile().catch(e => {
      if (e instanceof SignedOut) setState('off');
      else setState(navigator.onLine === false || e.message === 'Failed to fetch' || e.message === 'net' ? 'offline' : 'error');
      if (state === 'error') console.warn('TV Ratings sync:', e.message);
    }).finally(() => {
      running = null;
      if (again) { again = false; soon(); }
    });
    return running;
  }
  function soon(ms) { clearTimeout(timer); timer = setTimeout(run, ms == null ? 1000 : ms); }

  R.on('change', e => { if (e.type !== 'remote') soon(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(200); });
  window.addEventListener('online', () => soon(200));
  window.addEventListener('storage', e => { if (e.key === SESSION_KEY && e.newValue) soon(200); });   // signed in in the To Do app's tab
  setInterval(() => { if (!document.hidden) run(); }, 120e3);

  // Free My TV (the parent window) sends the TV's key; nothing else may. Only in TV mode (?tv=1), only when this copy runs
  // from files installed on the TV (file:, its parent's origin 'null' or 'file://') or is the Mac test copy, and
  // only for this project's Supabase (or, on the Mac test copy at 127.0.0.1, a local stand-in), so a page that frames the
  // published app can't point it at another server.
  const TV_MODE = new URLSearchParams(location.search).get('tv') === '1';
  const LOCAL_TEST = location.hostname === '127.0.0.1';
  function fromFreeMyTv(e) {
    if (!TV_MODE || window.parent === window || e.source !== window.parent) return false;
    if (location.protocol === 'file:') return e.origin === 'null' || e.origin === 'file://';   // installed on the TV
    return LOCAL_TEST && e.origin === location.origin;   // the Mac test copy; the published site never takes a key
  }
  function allowedServer(raw) {
    let u;
    try { u = new URL(String(raw)); } catch (x) { return null; }
    const url = u.origin;
    if (url === SUPABASE_URL) return url;
    if (LOCAL_TEST && u.protocol === 'http:' && u.hostname === '127.0.0.1') return url;
    return null;
  }
  window.addEventListener('message', e => {
    const d = e.data;
    if (!fromFreeMyTv(e) || !d || d.type !== 'fmtv-ratings') return;
    const url = allowedServer(d.supabaseUrl);
    if (url && d.supabaseKey && d.tvKey) tv = { url, apikey: String(d.supabaseKey), key: String(d.tvKey) };
    soon(0);
  });

  window.Sync = {
    status,
    now: () => run(),
    on(fn) { listeners.push(fn); },
    signInUrl: '../todo/',
    fromFreeMyTv,
  };
  soon(300);
})();
