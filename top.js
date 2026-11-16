/* Top Rated: your best episodes, seasons and shows, ranked by YOUR scores only. Built by the Top Rated leaf.
   It takes over the sheet's main pane (the sidebar stays) and registers with window.App.sections.stats, which the Dock calls.
   Reads only the store (window.Ratings.all(), live through Ratings.on('change')) and, for pictures, window.TMDB (lazily, only for
   rows that scroll into view). Back to the show page: the back button, Esc, Dock Shows, a library row, any row, opening the Diary
   or Search. Nothing here writes ratings.
   Rules (the same as the Control Center's stats): season 0 (Specials) is left out everywhere; a show's score is your own show
   score if you set one, otherwise the mean of its rated episodes (said on the row); equal scores share a rank (1, 2, 2, 4),
   ordered by the most recent rated_at. */
(function () {
  'use strict';
  const App = window.App, R = window.Ratings, T = window.TMDB;
  const sheet = document.querySelector('.sheet'), pane = document.querySelector('.pane');
  if (!App || !App.sections || !R || !sheet || !pane) return;

  const esc = App.esc, fmt = App.fmt;
  const $ = (s, r = document) => r.querySelector(s);
  const KINDS = [['episode', 'Episodes'], ['season', 'Seasons'], ['show', 'Shows']];
  const COUNTS = [[10, 'Top 10'], [25, 'Top 25'], [50, 'Top 50'], [0, 'All']];
  const NOUN = { episode: ['episode', 'episodes'], season: ['season', 'seasons'], show: ['show', 'shows'] };
  const KEY = 'tvr.top', FAIL_MS = 60000;
  const desk = matchMedia('(min-width: 1024px) and (min-height: 620px)');   // the sheet's own scroll; below it the page scrolls
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const plural = (n, k) => NOUN[k][n === 1 ? 0 : 1];

  /* ---------- remembered choices ---------- */
  const pref = { kind: 'episode', n: 10, show: 0 };
  try {
    const o = JSON.parse(localStorage.getItem(KEY));
    if (o && KINDS.some(k => k[0] === o.kind)) pref.kind = o.kind;
    if (o && COUNTS.some(c => c[0] === o.n)) pref.n = o.n;
    if (o && Number.isInteger(o.show) && o.show > 0) pref.show = o.show;
  } catch (e) { /* no storage, or junk in it: the defaults stand */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch (e) { /* not remembered, still works */ } };

  const st = { open: false, data: null, list: [], shown: [], byKey: new Map(), sig: '', selSig: null };
  let root, scroller, listEl, subEl, selEl, pickEl, kindEl, countEl, emptyEl;
  let thumbIO = null, liveT = 0, scrollT = 0;

  /* ---------- the numbers ---------- */
  const when = ms => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '');
  const cmp = (a, b) => b.v - a.v || b.at - a.at || a.id - b.id || (a.s || 0) - (b.s || 0) || (a.e || 0) - (b.e || 0);
  function compute() {
    const rows = R.all(), shows = new Map(), episode = [], season = [];
    for (const r of rows) {
      if (r.kind !== 'show' && !(r.season >= 1)) continue;   // season 0 (Specials) and anything without a real season
      if (!Number.isFinite(r.tenths)) continue;
      const at = Date.parse(r.rated_at) || 0;
      let sh = shows.get(r.tmdb_id);
      if (!sh) shows.set(r.tmdb_id, sh = { id: r.tmdb_id, name: '', own: null, sum: 0, n: 0, at: 0 });
      if (!sh.name && r.show_name) sh.name = r.show_name;
      if (at > sh.at) sh.at = at;
      if (r.kind === 'show') sh.own = r.tenths;
      else if (r.kind === 'season') season.push({ k: 's:' + r.tmdb_id + ':' + r.season, kind: 'season', id: r.tmdb_id, s: r.season, e: null, v: r.tenths, at });
      else if (r.kind === 'episode') {
        sh.sum += r.tenths; sh.n++;
        episode.push({ k: 'e:' + r.tmdb_id + ':' + r.season + ':' + r.episode, kind: 'episode', id: r.tmdb_id, s: r.season, e: r.episode, title: r.episode_name || '', v: r.tenths, at });
      }
    }
    const show = [];
    for (const sh of shows.values()) {
      if (!sh.name) sh.name = 'Show ' + sh.id;
      const own = sh.own != null, v = own ? sh.own : sh.n ? Math.round(sh.sum / sh.n) : null;
      if (v == null) continue;   // only a season score: no show-level number
      show.push({ k: 'p:' + sh.id, kind: 'show', id: sh.id, s: null, e: null, v, at: sh.at, own, n: sh.n });
    }
    for (const x of [...episode, ...season, ...show]) x.name = shows.get(x.id).name;
    episode.sort(cmp); season.sort(cmp); show.sort(cmp);
    const list = [...shows.values()].map(x => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
    return { episode, season, show, shows: list, ids: new Set(list.map(x => x.id)) };
  }

  /* ---------- pictures: lazy, a few at a time, remembered; a failed lookup waits a minute before it is asked again ---------- */
  const thumbs = new Map();            // key -> {path}; 'none' when TMDB has no picture
  const showP = new Map(), seasonP = new Map(), failed = new Map();
  let active = 0; const waiters = [];
  const slot = () => new Promise(r => (active < 3 ? (active++, r()) : waiters.push(r)));
  const free = () => { const n = waiters.shift(); if (n) n(); else active--; };
  const limited = async fn => { await slot(); try { return await fn(); } finally { free(); } };
  function memo(map, key, fn) {
    if (map.has(key)) return map.get(key);
    const f = failed.get(key);
    if (f && Date.now() - f < FAIL_MS) return Promise.resolve(undefined);   // it failed a moment ago: no new request on this redraw
    const p = limited(fn).then(v => { failed.delete(key); return v; }, () => { map.delete(key); failed.set(key, Date.now()); return undefined; });
    map.set(key, p);
    return p;
  }
  const getShow = id => memo(showP, id, () => T.show(id));
  const getSeason = (id, n) => memo(seasonP, id + ':' + n, () => T.season(id, n));
  const initials = name => String(name || '').replace(/^The /, '').split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase() || null;
  const thumbInner = (x, got) => App.img(got && got !== 'none' ? got.path : null, x.kind === 'episode' ? 'still' : 'poster', x.kind === 'episode' ? 'page' : 'small', initials(x.name));
  async function resolveThumb(x) {
    if (!T || thumbs.has(x.k)) return;
    let path = null, ok = true;
    if (x.kind === 'episode') {
      const s = await getSeason(x.id, x.s);
      if (s === undefined) ok = false; else path = ((s.episodes || []).find(y => y.e === x.e) || {}).still_path || null;
    } else {
      const sh = await getShow(x.id);
      if (sh === undefined) ok = false;
      else if (x.kind === 'season') path = ((sh.seasons || []).find(y => y.n === x.s) || {}).poster_path || sh.poster_path || null;
      else path = sh.poster_path || null;
    }
    if (!ok) return;
    thumbs.set(x.k, path ? { path } : 'none');
    if (!st.open || !path) return;
    listEl.querySelectorAll('.tp-thumb').forEach(el => {
      if (el.dataset.k !== x.k) return;
      el.removeAttribute('data-need');
      el.innerHTML = thumbInner(x, thumbs.get(x.k));
    });
  }
  const rootEl = () => (desk.matches ? scroller : null);
  function watchThumbs() {
    thumbIO?.disconnect();
    thumbIO = new IntersectionObserver(es => es.forEach(en => {
      if (!en.isIntersecting) return;
      thumbIO.unobserve(en.target);
      const x = st.byKey.get(en.target.dataset.k);
      if (x) resolveThumb(x);
    }), { root: rootEl(), rootMargin: '240px 0px' });
    listEl.querySelectorAll('.tp-thumb[data-need]').forEach(el => thumbIO.observe(el));
  }

  /* ---------- markup ---------- */
  function rowHtml(x, rank, tied) {
    const poster = x.kind !== 'episode';
    const label = x.kind === 'episode' ? 'S' + x.s + 'E' + x.e + (x.title ? ' · ' + x.title : '') : x.kind === 'season' ? 'Season ' + x.s : '';
    const basis = x.kind === 'show' ? (x.own ? 'Your score' : 'Episodes avg · ' + x.n + ' ' + plural(x.n, 'episode')) : x.kind === 'season' ? 'Your season score' : 'Your score';
    const date = x.kind === 'show' ? '' : when(x.at);
    const b = App.band(x.v), got = thumbs.get(x.k);
    const spoken = rank + '. ' + (tied ? 'Tied. ' : '') + x.name + (label ? ', ' + label : '') + ', ' + fmt(x.v) + '. ' + basis + '. Opens the show.';
    return `<li class="tp-item"><button class="tp-row" type="button" data-tmdb="${x.id}" aria-label="${esc(spoken)}">`
      + `<span class="tp-rank${rank <= 3 ? ' is-top' : ''}" aria-hidden="true"><span class="tp-n">${rank}</span>${tied ? '<span class="tp-tied">tied</span>' : ''}</span>`
      + `<span class="tp-tslot"><span class="tp-media tp-media--${poster ? 'poster' : 'still'}"><span class="tp-thumb ph" data-k="${esc(x.k)}"${got ? '' : ' data-need="1"'} aria-hidden="true">${thumbInner(x, got)}</span>`
      + `<span class="score tp-chip${x.kind === 'episode' ? '' : ' score--own'}" style="--b:var(--band-${b.key});--bf:${b.ink}" aria-hidden="true">${fmt(x.v)}</span></span></span>`
      + `<span class="tp-text"><span class="tp-title" aria-hidden="true"><b>${esc(x.name)}</b>${label ? '<span class="tp-dot"> · </span>' + esc(label) : ''}</span>`
      + `<span class="tp-meta" aria-hidden="true">${esc(basis)}${date ? ' · ' + esc(date) : ''}</span></span></button></li>`;
  }
  function emptyHtml(filtered) {
    const name = (st.data.shows.find(s => s.id === pref.show) || {}).name || '';
    if (filtered) {
      return `<svg class="ic tp-empty__ic" aria-hidden="true"><use href="#i-search"></use></svg><h3 class="tp-empty__h">No rated ${NOUN[pref.kind][1]} for ${esc(name)}</h3>`
        + `<p class="tp-empty__p">You have not scored any ${NOUN[pref.kind][1]} of this show yet. Pick another show, or look across all of them.</p>`
        + `<button class="pillbtn" type="button" data-tp="reset">Show all shows</button>`;
    }
    const m = {
      episode: ['Rate some episodes to see your top ones', 'Open a show and pick any cell in its grid to give that episode a score from 0.0 to 10.0. Your best ones will line up here.', 'Find a show to rate', 'find'],
      season: ['Rate a season to see your top ones', 'Open a show and pick a cell in its Season row to give the whole season a score. Season scores are yours only.', 'Open your shows', 'shows'],
      show: ['Rate a show to see your top ones', 'Give a whole show a score, or rate some of its episodes: with no show score of its own, a show ranks by the average of the episodes you rated.', 'Open your shows', 'shows'],
    }[pref.kind];
    return `<svg class="ic tp-empty__ic" aria-hidden="true"><use href="#i-star"></use></svg><h3 class="tp-empty__h">${m[0]}</h3><p class="tp-empty__p">${m[1]}</p><button class="pillbtn" type="button" data-tp="${m[3]}">${m[2]}</button>`;
  }

  /* ---------- drawing (open, a choice changes, the ratings change) ---------- */
  const viewer = () => (desk.matches ? scroller : document.scrollingElement || document.documentElement);
  function drawControls() {
    kindEl.querySelectorAll('.seg__btn').forEach(b => { const on = b.dataset.kind === pref.kind; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; });
    countEl.querySelectorAll('.seg__btn').forEach(b => { const on = +b.dataset.n === pref.n; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; });
    const sig = st.data.shows.map(s => s.id + ':' + s.name).join('|');
    if (sig !== st.selSig) {
      st.selSig = sig;
      selEl.innerHTML = `<option value="0">All shows</option>` + st.data.shows.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    }
    selEl.value = String(pref.show);
    selEl.classList.toggle('is-on', !!pref.show);
    pickEl.hidden = pref.kind === 'show' || !st.data.shows.length;   // a show's own rank needs no show filter
  }
  function draw(keep) {
    const D = st.data = compute();
    if (pref.show && !D.ids.has(pref.show)) { pref.show = 0; save(); }
    const all = D[pref.kind];
    const list = pref.kind === 'show' || !pref.show ? all : all.filter(x => x.id === pref.show);
    const shown = pref.n ? list.slice(0, pref.n) : list;
    // ranks over the whole filtered list, ties share the better rank: 1, 2, 2, 4
    const ranks = [];
    list.forEach((x, i) => ranks.push(i && x.v === list[i - 1].v ? ranks[i - 1] : i + 1));
    st.list = list; st.shown = shown; st.byKey = new Map(shown.map(x => [x.k, x]));

    const total = list.length, noun = plural(total, pref.kind), where = pref.kind !== 'show' && pref.show ? ' in ' + ((D.shows.find(s => s.id === pref.show) || {}).name || '') : '';
    const sub = !total ? (pref.show && pref.kind !== 'show' ? 'Nothing rated here yet' : 'Nothing rated yet')
      : pref.n && total > pref.n ? 'Top ' + pref.n + ' of ' + total.toLocaleString('en-GB') + ' ' + noun + where
      : (total === 1 ? '1 ' + noun : 'All ' + total.toLocaleString('en-GB') + ' ' + noun) + where;
    const tiedTop = ranks.filter(r => r === 1).length;   // a big tie at the top reads as a wall of 1s: say how big it is
    const subFull = tiedTop > 1 ? sub + ' · ' + tiedTop + ' tied at ' + App.fmt(list[0].v) : sub;
    const sig = [pref.kind, pref.n, pref.show, sub, shown.map((x, i) => x.k + '|' + x.v + '|' + x.name + '|' + (x.title || '') + '|' + (x.own ? 1 : 0) + x.n + '|' + ranks[i] + '|' + x.at).join(';'), D.shows.length].join('~');
    drawControls();
    subEl.textContent = subFull;
    if (keep && sig === st.sig) return;   // a change that does not touch what is on screen: leave it be (no flicker, no jump)
    st.sig = sig;

    // keep what you were looking at where it is: the first row in view goes back to the same height
    const vw = viewer();
    let anchor = null, focusK = null;
    if (keep) {
      const a = document.activeElement;
      if (a && a.closest && a.closest('.tp-row') && listEl.contains(a)) focusK = a.closest('.tp-row').dataset.k;
      if (listEl.firstChild && vw.scrollTop > 0) {
        const top = desk.matches ? scroller.getBoundingClientRect().top : 0;
        const row = [...listEl.querySelectorAll('.tp-row')].find(r => r.getBoundingClientRect().bottom > top + 40);
        if (row) anchor = { k: row.dataset.k, y: row.getBoundingClientRect().top };
      }
    }
    root.classList.toggle('is-empty', !shown.length);
    emptyEl.innerHTML = shown.length ? '' : emptyHtml(!!(pref.show && pref.kind !== 'show' && D[pref.kind].length));
    const maxRank = ranks.length ? Math.max(...ranks.slice(0, shown.length)) : 1;
    listEl.style.setProperty('--rk', Math.max(2, String(maxRank).length));
    listEl.setAttribute('aria-label', (pref.n && total > pref.n ? 'Top ' + pref.n : 'All') + ' ' + NOUN[pref.kind][1] + ', ranked by your score');
    listEl.innerHTML = shown.map((x, i) => rowHtml(x, ranks[i], i > 0 && ranks[i] === ranks[i - 1] || (ranks[i + 1] === ranks[i]))).join('');
    listEl.querySelectorAll('.tp-row').forEach((r, i) => { r.dataset.k = shown[i].k; });
    watchThumbs();
    if (anchor) {
      const row = [...listEl.querySelectorAll('.tp-row')].find(r => r.dataset.k === anchor.k);
      if (row) { const dy = row.getBoundingClientRect().top - anchor.y; if (dy) vw.scrollTop += dy; }
    } else if (!keep) vw.scrollTop = 0;
    if (focusK) [...listEl.querySelectorAll('.tp-row')].find(r => r.dataset.k === focusK)?.focus({ preventScroll: true });
  }

  /* ---------- the shell, built once ---------- */
  function build() {
    if (root) return;
    root = document.createElement('section');
    root.className = 'toprated'; root.hidden = true; root.setAttribute('aria-labelledby', 'tp-title');
    root.innerHTML = `<header class="tp-top"><button class="tp-back" type="button" data-tp="back" aria-label="Back to the show"><svg class="ic" aria-hidden="true"><use href="#i-chev-l"></use></svg><span>Shows</span></button>`
      + `<div class="tp-titles"><h2 class="tp-h" id="tp-title" tabindex="-1">Top Rated</h2><p class="tp-sub" role="status"></p></div></header>`
      + `<div class="tp-filters" role="group" aria-label="Choose what to rank">`
      + `<div class="seg tp-seg tp-seg--kind" role="radiogroup" aria-label="Rank">` + KINDS.map(([k, l]) => `<button class="seg__btn" type="button" role="radio" aria-checked="false" tabindex="-1" data-kind="${k}">${l}</button>`).join('') + `</div>`
      + `<div class="seg tp-seg tp-seg--count" role="radiogroup" aria-label="How many">` + COUNTS.map(([n, l]) => `<button class="seg__btn" type="button" role="radio" aria-checked="false" tabindex="-1" data-n="${n}">${l}</button>`).join('') + `</div>`
      + `<label class="tp-pick"><span class="visually-hidden">Show</span><select class="tp-select" data-tp="show"></select></label></div>`
      + `<div class="tp-scroll"><ol class="tp-list" role="list"></ol><div class="tp-empty" aria-live="polite"></div></div>`;
    pane.append(root);
    scroller = $('.tp-scroll', root); listEl = $('.tp-list', root); emptyEl = $('.tp-empty', root);
    subEl = $('.tp-sub', root); selEl = $('.tp-select', root); pickEl = $('.tp-pick', root);
    kindEl = $('.tp-seg--kind', root); countEl = $('.tp-seg--count', root);

    root.addEventListener('click', ev => {
      const row = ev.target.closest('.tp-row');
      if (row) return openShow(+row.dataset.tmdb);
      const kb = ev.target.closest('[data-kind]');
      if (kb) { if (pref.kind !== kb.dataset.kind) { pref.kind = kb.dataset.kind; save(); draw(false); } return; }
      const nb = ev.target.closest('[data-n]');
      if (nb) { if (pref.n !== +nb.dataset.n) { pref.n = +nb.dataset.n; save(); draw(false); } return; }
      const a = ev.target.closest('[data-tp]')?.dataset.tp;
      if (a === 'back' || a === 'shows') close({ focus: a === 'back' });
      else if (a === 'reset') { pref.show = 0; save(); draw(false); }
      else if (a === 'find') { close({ focus: false }); $('.dock [data-section="search"]')?.click(); }
    });
    selEl.addEventListener('change', () => { pref.show = +selEl.value || 0; save(); draw(false); });
    // a radio group: one stop in the tab order, arrows move the choice
    for (const g of [kindEl, countEl]) g.addEventListener('keydown', ev => {
      if (!/^(Arrow(Left|Right|Up|Down)|Home|End)$/.test(ev.key)) return;
      const all = [...g.querySelectorAll('.seg__btn')], i = all.indexOf(document.activeElement);
      if (i < 0) return;
      const j = ev.key === 'Home' ? 0 : ev.key === 'End' ? all.length - 1 : (i + (/Left|Up/.test(ev.key) ? -1 : 1) + all.length) % all.length;
      ev.preventDefault(); all[j].focus(); all[j].click();
    });
    // no row hover while the list is moving under a still pointer (the show page does the same)
    scroller.addEventListener('scroll', () => { scroller.classList.add('is-scrolling'); clearTimeout(scrollT); scrollT = setTimeout(() => scroller.classList.remove('is-scrolling'), 140); }, { passive: true });
  }

  /* ---------- open and close ---------- */
  const statsBtn = () => $('.dock [data-section="stats"]'), showsBtn = () => $('.dock [data-section="shows"]');
  function dockMark(on) {
    const d = statsBtn(), s = showsBtn();
    if (!d || !s) return;
    const sDot = s.parentElement.querySelector('.dock__dot');
    if (on) {
      d.setAttribute('aria-current', 'page'); s.removeAttribute('aria-current');
      if (sDot) sDot.style.display = 'none';
      if (!d.parentElement.querySelector('.dock__dot')) { const dot = document.createElement('span'); dot.className = 'dock__dot tp-dock-dot'; dot.setAttribute('aria-hidden', 'true'); d.parentElement.append(dot); }
    } else {
      d.removeAttribute('aria-current');
      if (!document.querySelector('.dock [aria-current="page"]')) s.setAttribute('aria-current', 'page');
      if (sDot) sDot.style.display = '';
      d.parentElement.querySelector('.tp-dock-dot')?.remove();
    }
  }
  function open() {
    build();
    if (st.open) { $('#tp-title', root).focus({ preventScroll: true }); return; }
    if (App.diary && App.diary.isOpen && App.diary.isOpen()) App.diary.close({ focus: false });
    st.open = true; st.sig = ''; st.selSig = null;
    // the remembered tab has nothing in it (say Seasons, with only episodes rated): open on the first one that has some
    const now = compute();
    if (!now[pref.kind].length) { const k = KINDS.find(x => now[x[0]].length); if (k) pref.kind = k[0]; }
    root.hidden = false;
    sheet.classList.add('has-top');
    dockMark(true);
    draw(false);
    if (!still.matches) { root.classList.remove('is-in'); void root.offsetWidth; }
    root.classList.add('is-in');
    if (!desk.matches) root.scrollIntoView({ block: 'start' });
    $('#tp-title', root).focus({ preventScroll: true });
  }
  function close(o) {
    if (!st.open) return;
    st.open = false;
    clearTimeout(liveT);
    thumbIO?.disconnect();
    root.hidden = true; root.classList.remove('is-in');
    sheet.classList.remove('has-top');
    dockMark(false);
    if (o && o.focus) statsBtn()?.focus({ preventScroll: true });
  }
  function openShow(id) {
    st.open && close({ focus: false });
    const p = origOpenShow(id);
    Promise.resolve(p).then(ok => { if (ok) { const t = $('#show-title'); if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true }); } } });
    return p;
  }

  /* ---------- live updates and ways back ---------- */
  // a change, an undo or an import: redraw from the store (events can carry no item, so nothing here reads one)
  R.on('change', () => {
    if (!st.open) return;
    clearTimeout(liveT);
    liveT = setTimeout(() => { if (st.open) draw(true); }, 30);
  });
  document.addEventListener('keydown', e => {
    if (!st.open || e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    if (document.querySelector('dialog[open]') || e.target.closest?.('input, textarea')) return;
    e.preventDefault(); close({ focus: true });
  });
  // the search panel's own shortcuts (Cmd/Ctrl+K, and / outside a field) open it over the sheet: Top Rated steps aside first
  document.addEventListener('keydown', e => {
    if (!st.open || e.isComposing || e.defaultPrevented || e.altKey) return;
    const k = (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'k';
    const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.target.closest?.('input, textarea, select, [contenteditable]') && !document.querySelector('dialog[open]');
    if (k || slash) close({ focus: false });
  }, true);
  document.addEventListener('click', e => {
    if (!st.open) return;
    // Dock Shows, Diary or Search; a show in the library; a Control Center show tile: Top Rated steps aside. Capture phase, so it
    // goes before the page's own handler redraws the library and detaches what was clicked.
    const dockBtn = e.target.closest?.('.dock [data-section]');
    if ((dockBtn && dockBtn.dataset.section !== 'stats') || e.target.closest?.('.side [data-show], .cc [data-show]')) close({ focus: false });
  }, true);
  addEventListener('hashchange', () => { if (st.open) close({ focus: false }); });
  desk.addEventListener('change', () => { if (st.open) watchThumbs(); });

  // any other way of opening a show or the diary (the search panel) also leaves Top Rated
  const origOpenShow = App.openShow;
  App.openShow = function (id, opts) { if (st.open) close({ focus: false }); return origOpenShow.call(App, id, opts); };
  for (const name of ['diary', 'search']) {
    const prev = App.sections[name];
    if (typeof prev === 'function') App.sections[name] = function () { if (st.open) close({ focus: false }); return prev.apply(this, arguments); };
  }
  App.sections.stats = () => open();
  App.top = { open, close, isOpen: () => st.open };
})();
