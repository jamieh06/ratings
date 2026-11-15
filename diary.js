/* Diary: every rating Jamie has made, newest first, grouped by day. Built by the diary leaf.
   It takes over the sheet's main pane (the sidebar stays) and registers with window.App.sections.diary, which the Dock calls.
   Reads only the store (window.Ratings.diary(), live through Ratings.on('change')) and, for thumbnails, window.TMDB (lazily,
   only for rows that scroll into view). Back to the show page: the back button, Esc, Dock Shows, a library row, or any row.
   Nothing here writes ratings, and there is no delete. */
(function () {
  'use strict';
  const App = window.App, R = window.Ratings, T = window.TMDB;
  const sheet = document.querySelector('.sheet'), pane = document.querySelector('.pane');
  if (!App || !App.sections || !R || !sheet || !pane) return;

  const PAGE = 50, DAY = 864e5;
  const esc = App.esc, fmt = App.fmt;
  const $ = (s, r = document) => r.querySelector(s);
  const LEVELS = [['all', 'All'], ['episode', 'Episodes'], ['season', 'Seasons'], ['show', 'Shows']];
  const KEYS = ['ac', 'aw', 'gr', 'go', 'av', 'bd', 'ga'];                  // band order, best first
  const desk = matchMedia('(min-width: 1024px) and (min-height: 620px)');   // the sheet's own scroll; below it the page scrolls
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  const st = { open: false, level: 'all', show: 0, shown: PAGE, base: [], list: [], totals: new Map(), byId: new Map(), drawn: 0, lastDay: null, lastUl: null, sig: '' };
  let root, scroller, listEl, footEl, subEl, selEl, segEl, weekEl, topDay = 0;
  let thumbIO = null, moreIO = null, tick = 0, liveT = 0, scrollT = 0;

  /* ---------- time ---------- */
  const dayStart = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const dayOf = e => dayStart(Date.parse(e.rated_at));
  const sameYear = ms => new Date(ms).getFullYear() === new Date().getFullYear();
  const shortDate = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: sameYear(ms) ? undefined : 'numeric' });
  function dayLabel(start) {
    const diff = Math.round((dayStart(Date.now()) - start) / DAY);
    if (diff === 0) return { name: 'Today', date: shortDate(start) };
    if (diff === 1) return { name: 'Yesterday', date: shortDate(start) };
    if (diff >= 2 && diff <= 6) return { name: new Date(start).toLocaleDateString('en-GB', { weekday: 'long' }), date: shortDate(start) };
    return { name: new Date(start).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: sameYear(start) ? undefined : 'numeric' }), date: '' };
  }
  function when(iso) {   // relative under 7 days, else the date
    const t = Date.parse(iso), diff = Date.now() - t;
    if (diff < 0 || diff >= 7 * DAY) return shortDate(t);
    if (diff < 6e4) return 'Just now';
    if (diff < 36e5) return Math.floor(diff / 6e4) + ' min ago';
    if (diff < DAY) return Math.floor(diff / 36e5) + ' h ago';
    const d = Math.floor(diff / DAY);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }
  const exact = iso => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  /* ---------- thumbnails: lazy, a few at a time, remembered ---------- */
  const thumbs = new Map();            // key -> {path, kind}; 'none' when TMDB has no picture
  const showP = new Map(), seasonP = new Map();
  let active = 0; const waiters = [];
  const slot = () => new Promise(r => (active < 3 ? (active++, r()) : waiters.push(r)));
  const free = () => { const n = waiters.shift(); if (n) n(); else active--; };
  const limited = async fn => { await slot(); try { return await fn(); } finally { free(); } };
  function memo(map, key, fn) {
    if (!map.has(key)) map.set(key, limited(fn).catch(() => { map.delete(key); return undefined; }));   // a failed call is tried again next time
    return map.get(key);
  }
  const getShow = id => memo(showP, id, () => T.show(id));
  const getSeason = (id, n) => memo(seasonP, id + ':' + n, () => T.season(id, n));
  const tkey = e => (e.kind === 'episode' ? 'e:' + e.tmdb_id + ':' + e.season + ':' + e.episode : e.kind === 'season' ? 's:' + e.tmdb_id + ':' + e.season : 'p:' + e.tmdb_id);
  const initials = name => String(name || '').replace(/^The /, '').split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase() || null;
  const thumbInner = (e, got) => App.img(got && got !== 'none' ? got.path : null, e.kind === 'episode' ? 'still' : 'poster', e.kind === 'episode' ? 'page' : 'small', initials(e.show_name));
  async function resolveThumb(e) {
    if (!T) return;
    const k = tkey(e);
    if (thumbs.has(k)) return;
    let path = null, ok = true;
    if (e.kind === 'episode') {
      const s = await getSeason(e.tmdb_id, e.season);
      if (s === undefined) ok = false; else path = ((s.episodes || []).find(x => x.e === e.episode) || {}).still_path || null;
    } else {
      const sh = await getShow(e.tmdb_id);
      if (sh === undefined) ok = false;
      else if (e.kind === 'season') path = ((sh.seasons || []).find(x => x.n === e.season) || {}).poster_path || sh.poster_path || null;
      else path = sh.poster_path || null;
    }
    if (!ok) return;
    thumbs.set(k, path ? { path } : 'none');
    if (!st.open || !path) return;
    listEl.querySelectorAll('.dy-thumb').forEach(el => {
      if (el.dataset.k !== k) return;
      el.removeAttribute('data-need');
      el.innerHTML = thumbInner(e, thumbs.get(k));
    });
  }
  function rootEl() { return desk.matches ? scroller : null; }
  function watchThumbs(from) {
    thumbIO?.disconnect();
    thumbIO = new IntersectionObserver(es => es.forEach(en => {
      if (!en.isIntersecting) return;
      thumbIO.unobserve(en.target);
      const e = st.byId.get(+en.target.closest('.dy-row')?.dataset.id);
      if (e) resolveThumb(e);
    }), { root: rootEl(), rootMargin: '240px 0px' });
    (from || listEl).querySelectorAll('.dy-thumb[data-need]').forEach(el => thumbIO.observe(el));
  }
  function observeNew(container) {
    if (!thumbIO) return watchThumbs();
    container.querySelectorAll('.dy-thumb[data-need]').forEach(el => thumbIO.observe(el));
  }

  /* ---------- building the markup ---------- */
  const LEVEL_NAME = { episode: 'Episode', season: 'Season', show: 'Whole show' };
  function rowHtml(e) {
    const name = e.show_name || ('Show ' + e.tmdb_id);
    const where = e.kind === 'episode' ? 'S' + e.season + 'E' + e.episode + (e.episode_name ? ' · ' + esc(e.episode_name) : '')
      : e.kind === 'season' ? 'Season ' + e.season : 'Whole show';
    const b = e.value == null ? null : App.band(e.value);
    // the score sits on the picture (ref 12): the chip is the biggest thing in the row
    const chip = e.value == null
      ? '<span class="score dy-chip dy-chip--off">removed</span>'
      : `<span class="score dy-chip${e.kind === 'episode' ? '' : ' score--own'}" style="--b:var(--band-${b.key});--bf:${b.ink}"><span class="visually-hidden">Rated </span>${fmt(e.value)}</span>`;
    const was = e.previous != null ? ` · <span class="dy-was">was ${fmt(e.previous)}</span>` : '';
    const k = tkey(e), got = thumbs.get(k);
    const poster = e.kind !== 'episode';
    const t = `data-at="${esc(e.rated_at)}" datetime="${esc(e.rated_at)}" title="${esc(exact(e.rated_at))}"`;
    const rel = esc(when(e.rated_at));
    return `<li class="dy-item"><button class="dy-row" type="button" data-id="${e.id}" data-tmdb="${e.tmdb_id}">`
      + `<span class="dy-tslot"><span class="dy-media dy-media--${poster ? 'poster' : 'still'}"><span class="dy-thumb ph" data-k="${esc(k)}"${got ? '' : ' data-need="1"'} aria-hidden="true">${thumbInner(e, got)}</span>${chip}</span></span>`
      + `<span class="dy-text"><span class="dy-title"><b>${esc(name)}</b><span class="dy-dot"> · </span>${where}</span>`
      + `<span class="dy-meta">${LEVEL_NAME[e.kind]}${was}${e.action === 'undo' ? ' · undone' : ''}<span class="dy-in"> · <time class="dy-time" ${t}>${rel}</time></span></span></span>`
      + `<time class="dy-time dy-when" ${t}>${rel}</time></button></li>`;
  }
  // the last 7 calendar days as a heat row: one square per rating in its band colour, best on top (the numbers are printed beside it)
  function weekHtml() {
    const today = dayStart(Date.now()), d0 = new Date(today);
    const days = [];
    for (let i = 6; i >= 0; i--) days.push({ start: new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - i).getTime(), v: [] });
    const first = days[0].start;
    let sum = 0, n = 0;
    for (const e of st.list) {
      if (e.value == null) continue;
      const ds = dayOf(e);
      if (ds < first) continue;
      const day = days.find(d => d.start === ds);
      if (!day) continue;
      day.v.push(e.value); sum += e.value; n++;
    }
    const maxN = Math.max(1, ...days.map(d => d.v.length));
    // the column box is a fixed 40px so the header never grows: up to 5 a day as squares, a busier week as one stacked bar per day, scaled to the busiest day
    const SQUARES = maxN <= 5, cell = 7, H = 40;
    const avg = n ? Math.round(sum / n) : null, ab = avg == null ? null : App.band(avg);
    const cols = days.map((d, i) => {
      const sorted = d.v.slice().sort((x, y) => y - x);
      let segs;
      if (SQUARES) segs = sorted.map(v => `<i style="--b:var(--band-${App.band(v).key})"></i>`).join('');
      else if (!sorted.length) segs = '';
      else {
        const runs = [];
        for (const v of sorted) { const k = App.band(v).key; if (runs.length && runs[runs.length - 1].k === k) runs[runs.length - 1].n++; else runs.push({ k, n: 1 }); }
        segs = `<span class="dy-wkstack" style="height:${Math.max(3, Math.round(H * sorted.length / maxN))}px">${runs.map(r => `<i style="--b:var(--band-${r.k});flex:${r.n} 1 0"></i>`).join('')}</span>`;
      }
      const lab = new Date(d.start).toLocaleDateString('en-GB', { weekday: 'narrow' });
      return `<span class="dy-wk${i === 6 ? ' is-today' : ''}" title="${esc(new Date(d.start).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }))}: ${d.v.length} rating${d.v.length === 1 ? '' : 's'}"><span class="dy-wkbars">${segs}</span><span class="dy-wkl">${lab}</span></span>`;
    }).join('');
    const stat = n
      ? `<span class="dy-wkn">${n}</span><span class="dy-wkt">rating${n === 1 ? '' : 's'}<br>last 7 days</span><span class="score dy-avg" style="--b:var(--band-${ab.key});--bf:${ab.ink}"><span class="dy-avgl">avg</span> ${fmt(avg)}</span>`
      : `<span class="dy-wkt dy-wkt--none">No ratings<br>in the last 7 days</span>`;
    return `<span class="dy-wkstat">${stat}</span><span class="dy-wkcols" style="--cell:${cell}px" aria-hidden="true">${cols}</span>`;
  }
  function sumHtml(day) {
    const t = st.totals.get(day);
    if (!t) return '';
    const bits = [];
    if (t.n) bits.push(t.n + (t.n === 1 ? ' rating' : ' ratings'));
    if (t.n > 1) bits.push('avg ' + fmt(Math.round(t.sum / t.n)));
    if (t.rm) bits.push(t.rm + ' removed');
    const strip = t.n ? '<span class="dy-strip" aria-hidden="true">' + KEYS.filter(k => t.bands[k]).map(k => `<i style="flex:${t.bands[k]};--b:var(--band-${k})"></i>`).join('') + '</span>' : '';
    return strip + `<span class="dy-sumtxt">${bits.join(' · ')}</span>`;
  }
  function sectionHtml(day, rows) {
    const l = dayLabel(day);
    return `<section class="dy-day" data-day="${day}" aria-labelledby="dyh-${day}"><h3 class="dy-dayhead" id="dyh-${day}"><span class="dy-dn">${esc(l.name)}</span>${l.date ? `<span class="dy-dd">${esc(l.date)}</span>` : ''}<span class="dy-sum">${sumHtml(day)}</span></h3><ul class="dy-items">${rows}</ul></section>`;
  }
  // draw list[from, to) onto the end of what is on screen; rows of the day already open join its list
  function drawRows(from, to) {
    const list = st.list;
    let i = from;
    while (i < to) {
      const d = dayOf(list[i]); let j = i;
      while (j < to && dayOf(list[j]) === d) j++;
      const rows = list.slice(i, j).map(rowHtml).join('');
      if (d === st.lastDay && st.lastUl) st.lastUl.insertAdjacentHTML('beforeend', rows);
      else { listEl.insertAdjacentHTML('beforeend', sectionHtml(d, rows)); st.lastUl = listEl.lastElementChild.querySelector('ul'); st.lastDay = d; }
      i = j;
    }
    st.drawn = to;
  }
  function drawFoot() {
    moreIO?.disconnect();
    const left = st.list.length - st.drawn;
    if (!st.list.length) { footEl.innerHTML = ''; return; }
    if (left > 0) {
      footEl.innerHTML = `<button class="dy-more" type="button" data-dy="more">Load ${Math.min(PAGE, left)} more<span class="dy-morecount"> · ${left} older</span></button>`;
      moreIO = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting)) loadMore(); }, { root: rootEl(), rootMargin: '0px 0px 480px 0px' });
      moreIO.observe(footEl.firstChild);
    } else {
      footEl.innerHTML = `<p class="dy-end">${st.level === 'all' && !st.show ? 'That is every rating in your diary.' : 'That is everything for this filter.'}</p>`;
    }
  }
  // the observer catches a normal scroll; this also catches a jump (End key, dragging the scrollbar) that skips past the button
  let endT = 0;
  function checkEnd() {
    endT = 0;
    const btn = st.open && footEl.querySelector('.dy-more');
    if (!btn) return;
    const lim = (desk.matches ? scroller.getBoundingClientRect().bottom : innerHeight) + 480;
    if (btn.getBoundingClientRect().top < lim) { loadMore(); queueEnd(); }
  }
  const queueEnd = () => { if (!endT) endT = setTimeout(checkEnd, 60); };
  function loadMore() {
    if (!st.open || st.drawn >= st.list.length) return;
    const from = st.drawn;
    st.shown = Math.min(st.list.length, st.drawn + PAGE);
    drawRows(from, st.shown);
    observeNew(listEl);
    drawFoot();
  }

  /* ---------- data: read the store, filter, summarise ---------- */
  function readStore() {
    st.base = R.diary();
    const names = new Map();
    st.base.forEach(e => { if (!names.has(e.tmdb_id) || (!names.get(e.tmdb_id).name && e.show_name)) names.set(e.tmdb_id, { name: e.show_name || '', n: 0 }); names.get(e.tmdb_id).n++; });
    names.forEach((v, id) => { if (!v.name) v.name = 'Show ' + id; });
    st.shows = [...names].map(([id, v]) => ({ id, name: v.name, n: v.n })).sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
    if (st.show && !names.has(st.show)) st.show = 0;
    st.list = st.base.filter(e => (st.level === 'all' || e.kind === st.level) && (!st.show || e.tmdb_id === st.show));
    st.byId = new Map(st.list.map(e => [e.id, e]));
    st.totals = new Map();
    for (const e of st.list) {
      const d = dayOf(e);
      let t = st.totals.get(d); if (!t) st.totals.set(d, t = { n: 0, rm: 0, sum: 0, bands: {} });
      if (e.value == null) t.rm++;
      else { t.n++; t.sum += e.value; const k = App.band(e.value).key; t.bands[k] = (t.bands[k] || 0) + 1; }
    }
  }
  function drawFilters() {
    const total = st.base.length;
    $('.dy-filters', root).hidden = !total;
    subEl.textContent = !total ? 'Nothing logged yet'
      : st.list.length === total ? total + (total === 1 ? ' entry' : ' entries')
      : st.list.length + ' of ' + total + ' entries';
    segEl.querySelectorAll('.seg__btn').forEach(b => b.setAttribute('aria-checked', b.dataset.lvl === st.level));
    const sig = st.shows.map(s => s.id + ':' + s.name + ':' + s.n).join('|');
    if (sig !== st.sig) {
      st.sig = sig;
      selEl.innerHTML = `<option value="0">All shows</option>` + st.shows.map(s => `<option value="${s.id}">${esc(s.name)} (${s.n})</option>`).join('');
    }
    weekEl.innerHTML = weekHtml();
    weekEl.hidden = !total;
    selEl.value = String(st.show);
    selEl.classList.toggle('is-on', !!st.show);
  }

  /* ---------- drawing everything (open, filter change, live update) ---------- */
  const viewer = () => (desk.matches ? scroller : document.scrollingElement || document.documentElement);
  function draw(keep) {
    readStore();
    // a live update keeps what you were looking at where it is: find the first row in view, put it back at the same height
    let anchor = null;
    const vw = viewer();
    if (keep && listEl.firstChild && vw.scrollTop > 0) {
      const top = desk.matches ? scroller.getBoundingClientRect().top : 0;
      const row = [...listEl.querySelectorAll('.dy-row')].find(r => r.getBoundingClientRect().bottom > top + 40);
      if (row) anchor = { id: row.dataset.id, y: row.getBoundingClientRect().top };
    }
    st.shown = Math.max(PAGE, Math.min(st.list.length, keep ? st.shown : PAGE));
    drawFilters();
    listEl.innerHTML = ''; st.lastDay = null; st.lastUl = null; st.drawn = 0;
    root.classList.toggle('is-empty', !st.list.length);
    $('.dy-empty', root).innerHTML = emptyHtml();
    drawRows(0, Math.min(st.shown, st.list.length));
    drawFoot();
    watchThumbs();
    if (anchor) {
      const row = listEl.querySelector(`.dy-row[data-id="${anchor.id}"]`);
      if (row) { const dy = row.getBoundingClientRect().top - anchor.y; if (dy) vw.scrollTop += dy; }
    } else if (!keep) vw.scrollTop = 0;
  }
  function emptyHtml() {
    if (st.list.length) return '';
    if (!st.base.length) {
      return `<svg class="ic dy-empty__ic" aria-hidden="true"><use href="#i-clock"></use></svg><h3 class="dy-empty__h">Nothing rated yet</h3>`
        + `<p class="dy-empty__p">Every score you give an episode, a season or a whole show lands here, newest first. Open a show and pick any cell to rate it, or search for a show to add.</p>`
        + `<button class="pillbtn" type="button" data-dy="find">Find a show to rate</button>`;
    }
    return `<svg class="ic dy-empty__ic" aria-hidden="true"><use href="#i-search"></use></svg><h3 class="dy-empty__h">No ratings match</h3>`
      + `<p class="dy-empty__p">Nothing in the diary fits this show and level together.</p><button class="pillbtn" type="button" data-dy="reset">Show everything</button>`;
  }

  /* ---------- the shell, built once ---------- */
  function build() {
    if (root) return;
    root = document.createElement('section');
    root.className = 'diary'; root.hidden = true; root.setAttribute('aria-labelledby', 'dy-title');
    root.innerHTML = `<header class="dy-top"><button class="dy-back" type="button" data-dy="back" aria-label="Back to the show"><svg class="ic" aria-hidden="true"><use href="#i-chev-l"></use></svg><span>Shows</span></button>`
      + `<div class="dy-titles"><h2 class="dy-h" id="dy-title" tabindex="-1">Diary</h2><p class="dy-sub" role="status"></p></div><div class="dy-week" role="group" aria-label="Your last 7 days"></div></header>`
      + `<div class="dy-filters" role="group" aria-label="Filter the diary"><div class="seg dy-seg" role="radiogroup" aria-label="Level">`
      + LEVELS.map(([k, label]) => `<button class="seg__btn" type="button" role="radio" aria-checked="${k === 'all'}" data-lvl="${k}">${label}</button>`).join('')
      + `</div><label class="dy-pick"><span class="visually-hidden">Show</span><select class="dy-select" data-dy="show"></select></label></div>`
      + `<div class="dy-scroll"><div class="dy-list"></div><div class="dy-empty" aria-live="polite"></div><div class="dy-foot"></div></div>`;
    pane.append(root);
    scroller = $('.dy-scroll', root); listEl = $('.dy-list', root); footEl = $('.dy-foot', root);
    subEl = $('.dy-sub', root); weekEl = $('.dy-week', root); selEl = $('.dy-select', root); segEl = $('.dy-seg', root);

    root.addEventListener('click', ev => {
      const row = ev.target.closest('.dy-row');
      if (row) return openShow(+row.dataset.tmdb);
      const lvl = ev.target.closest('[data-lvl]');
      if (lvl) { st.level = lvl.dataset.lvl; return draw(false); }
      const a = ev.target.closest('[data-dy]')?.dataset.dy;
      if (a === 'back') close({ focus: true });
      else if (a === 'more') loadMore();
      else if (a === 'reset') { st.level = 'all'; st.show = 0; draw(false); }
      else if (a === 'find') { close({ focus: false }); $('.dock [data-section="search"]')?.click(); }
    });
    selEl.addEventListener('change', () => { st.show = +selEl.value || 0; draw(false); });
    // arrows move between the levels, like the show page's Yours / Community control
    segEl.addEventListener('keydown', ev => {
      if (!/^Arrow(Left|Right|Up|Down)$/.test(ev.key)) return;
      const all = [...segEl.querySelectorAll('.seg__btn')], i = all.indexOf(document.activeElement);
      if (i < 0) return;
      const j = (i + (/Left|Up/.test(ev.key) ? -1 : 1) + all.length) % all.length;
      ev.preventDefault(); all[j].focus(); all[j].click();
    });
    // no row hover while the list is moving under a still pointer (the show page does the same)
    scroller.addEventListener('scroll', () => { scroller.classList.add('is-scrolling'); clearTimeout(scrollT); scrollT = setTimeout(() => scroller.classList.remove('is-scrolling'), 140); queueEnd(); }, { passive: true });
    addEventListener('scroll', queueEnd, { passive: true });   // the stacked layout scrolls the page instead
  }

  /* ---------- open and close ---------- */
  const diaryBtn = () => $('.dock [data-section="diary"]'), showsBtn = () => $('.dock [data-section="shows"]');
  function dockMark(on) {
    const d = diaryBtn(), s = showsBtn();
    if (!d || !s) return;
    const sDot = s.parentElement.querySelector('.dock__dot');
    if (on) {
      d.setAttribute('aria-current', 'page'); s.removeAttribute('aria-current');
      if (sDot) sDot.style.display = 'none';
      if (!d.parentElement.querySelector('.dock__dot')) { const dot = document.createElement('span'); dot.className = 'dock__dot dy-dock-dot'; dot.setAttribute('aria-hidden', 'true'); d.parentElement.append(dot); }
    } else {
      d.removeAttribute('aria-current'); s.setAttribute('aria-current', 'page');
      if (sDot) sDot.style.display = '';
      d.parentElement.querySelector('.dy-dock-dot')?.remove();
    }
  }
  function open() {
    build();
    if (st.open) { $('#dy-title', root).focus({ preventScroll: true }); return; }
    st.open = true; st.level = 'all'; st.show = 0; st.shown = PAGE; st.sig = '';
    root.hidden = false;
    sheet.classList.add('has-diary');
    dockMark(true);
    draw(false);
    topDay = dayStart(Date.now());
    if (!still.matches) { root.classList.remove('is-in'); void root.offsetWidth; }
    root.classList.add('is-in');
    if (!desk.matches) root.scrollIntoView({ block: 'start' });
    $('#dy-title', root).focus({ preventScroll: true });
    // relative times keep up while the diary is open (and the day labels roll over at midnight)
    tick = setInterval(() => {
      if (dayStart(Date.now()) !== topDay) { topDay = dayStart(Date.now()); return draw(true); }
      listEl.querySelectorAll('.dy-time').forEach(t => { const w = when(t.dataset.at); if (t.textContent !== w) t.textContent = w; });
    }, 30000);
  }
  function close(o) {
    if (!st.open) return;
    st.open = false;
    clearInterval(tick); clearTimeout(liveT);
    thumbIO?.disconnect(); moreIO?.disconnect();
    root.hidden = true; root.classList.remove('is-in');
    sheet.classList.remove('has-diary');
    dockMark(false);
    if (o && o.focus) diaryBtn()?.focus({ preventScroll: true });
  }
  function openShow(id) {
    st.open && close({ focus: false });
    const p = origOpenShow(id);
    Promise.resolve(p).then(ok => { if (ok) { const t = $('#show-title'); if (t) { t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true }); } } });
    return p;
  }

  /* ---------- live updates and ways back ---------- */
  // events can carry no item (an undone import), so nothing here reads one: any change redraws from the store
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
  document.addEventListener('click', e => {
    if (!st.open) return;
    // Dock Shows, or a show in the library: the diary steps aside. Capture phase: the page's own handler redraws the library
    // while it handles the click, which would detach the clicked row before a later listener could look at it.
    if (e.target.closest?.('.dock [data-section="shows"], .side [data-show]')) close({ focus: false });
  }, true);
  for (const m of [desk]) m.addEventListener('change', () => { if (st.open) { watchThumbs(); drawFoot(); } });

  // any other way of opening a show (the search panel) also leaves the diary
  const origOpenShow = App.openShow;
  App.openShow = function (id, opts) { if (st.open) close({ focus: false }); return origOpenShow.call(App, id, opts); };
  App.sections.diary = () => open();
  App.diary = { open, close, isOpen: () => st.open };
})();
