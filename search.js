/* search: the Spotlight panel (Dock Search button, Cmd/Ctrl+K, "/" when not typing).
   Registers window.App.sections.search. Type to search TMDB (300 ms debounce, stale requests aborted); choose a result
   (click, or arrows + Return) and window.App.openShow(id) opens it. Rating anything adds the show to the library, so
   there is no separate add step. No TMDB key: it searches the sample shows and offers a paste field for a key.
   Hooks used: window.App {openShow, render, band, fmt, esc, img}, window.TMDB, window.Ratings. Styles: search.css. */
(function () {
  'use strict';
  const App = window.App = window.App || {};
  App.sections = App.sections || {};
  const T = window.TMDB, R = window.Ratings;
  const esc = s => (App.esc ? App.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const DEBOUNCE = 300, MAX_RESULTS = 20, MAX_RECENT = 6;
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  let dlg = null, els = null;
  let opener = null, closeTimer = 0, debTimer = 0, ctrl = null, seq = 0, sugSeq = 0;
  // items: what the listbox shows now. sel: index of the highlighted one (-1 none).
  const st = { q: '', items: [], sel: -1, mode: 'recent', keyOpen: false, msg: null, busy: false, openFirst: false };

  /* ---------- small helpers ---------- */
  const isOpen = () => !!dlg && dlg.open && !dlg.classList.contains('is-out');
  const hasKey = () => !!(T && T.hasKey && T.hasKey());
  const startYear = y => { const m = /\d{4}/.exec(y == null ? '' : String(y)); return m ? +m[0] : null; };
  const tenths = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) : null);
  const initials = n => String(n || '').replace(/^The /, '').split(/\s+/).map(w => w[0] || '').join('').slice(0, 3).toUpperCase();
  function chipStyle(t) {
    const b = t == null || !App.band ? null : App.band(t);
    if (!b) return '';
    return b.key ? `--b:var(--band-${b.key});--bf:${b.ink}` : `--b:${b.hex};--bf:${b.ink || '#141414'}`;
  }
  const fmt = t => (App.fmt ? App.fmt(t) : t == null ? '?' : (t / 10).toFixed(1));
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // What the library already holds for a show: the note on a row.
  function libNote(id) {
    let recs = [];
    try { recs = (R && R.forShow(id)) || []; } catch (e) {}
    const eps = recs.filter(r => r.kind === 'episode');
    if (!recs.length) return '';   // a sample show you haven't rated isn't in your library
    const show = recs.find(r => r.kind === 'show');
    let score = show ? show.tenths : null, label = 'your score';
    if (score == null && eps.length) { score = Math.round(eps.reduce((a, r) => a + r.tenths, 0) / eps.length); label = 'your average'; }
    const head = eps.length ? 'Rated ' + plural(eps.length, 'episode') : 'In your library';
    return head + (score != null ? ` · ${label} ${fmt(score)}` : '');
  }
  function inSample(id) {
    const d = window.TV_DATA;
    return !!(d && Array.isArray(d.shows) && d.shows.some(s => s.tmdb === +id));
  }

  /* ---------- the panel ---------- */
  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'srch';
    dlg.setAttribute('aria-label', 'Search shows');
    dlg.innerHTML =
      '<div class="srch__glass rim">'
      + '<div class="srch__bar">'
      + '<svg class="ic srch__icon" aria-hidden="true"><use href="#i-search"></use></svg>'
      + '<input class="srch__input" type="text" role="combobox" aria-label="Search TV shows" aria-autocomplete="list" aria-expanded="true" aria-controls="srch-list" '
      + 'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="Search TV shows">'
      + '<button class="srch__clear" type="button" aria-label="Clear search" hidden><span class="srch__clearx" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"></path></svg></span></button>'
      + '</div>'
      + '<div class="srch__body">'
      + '<div class="srch__head" id="srch-head"></div>'
      + '<div class="srch__list" id="srch-list" role="listbox" aria-labelledby="srch-head"></div>'
      + '<div class="srch__note" role="status" aria-live="polite"></div>'
      + '</div>'
      + '<div class="srch__foot"></div>'
      + '</div>';
    document.body.appendChild(dlg);
    els = {
      glass: dlg.querySelector('.srch__glass'), input: dlg.querySelector('.srch__input'), clear: dlg.querySelector('.srch__clear'),
      head: dlg.querySelector('.srch__head'), list: dlg.querySelector('.srch__list'), note: dlg.querySelector('.srch__note'),
      foot: dlg.querySelector('.srch__foot'),
    };
    wire();
    watchViewport();
  }

  function wire() {
    els.input.addEventListener('input', onInput);
    els.clear.addEventListener('click', () => { els.input.value = ''; onInput(); els.input.focus(); });
    // keep focus in the field when a row is pressed
    els.list.addEventListener('mousedown', e => { if (e.target.closest('.srch__row')) e.preventDefault(); });
    // and when anything else in the panel is pressed that isn't a control (dimmed rows during a search, the header, gaps)
    els.glass.addEventListener('mousedown', e => { if (!e.target.closest('input, textarea, select, button, a, [contenteditable], [tabindex]')) e.preventDefault(); });
    els.list.addEventListener('click', e => {
      if (els.list.classList.contains('is-stale')) return;   // rows from an earlier query are inert
      const row = e.target.closest('.srch__row');
      if (row) choose(+row.dataset.id);
      else if (e.target.closest('[data-retry]')) { els.input.focus(); run(st.q); }   // the button is about to be redrawn: focus goes back to the field
    });
    els.list.addEventListener('pointermove', e => {
      const row = e.target.closest('.srch__row');
      if (!row || els.list.classList.contains('is-stale')) return;
      const i = +row.dataset.i;
      if (i !== st.sel) select(i, false);
    });
    els.foot.addEventListener('click', onFootClick);
    els.foot.addEventListener('submit', e => { e.preventDefault(); saveKey(); });
    // click on the dim area outside the glass closes
    dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dlg.addEventListener('keydown', onKey);
  }

  function onKey(e) {
    const inKey = e.target.closest && e.target.closest('.srch__keyfield');
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { trap(e); return; }
    if (inKey) return;   // arrows and Return belong to the paste field while it has focus
    if (e.target !== els.input) return;
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = st.items.length;
      if (!n) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      select(st.sel < 0 ? (d > 0 ? 0 : n - 1) : (st.sel + d + n) % n, true);
    } else if (e.key === 'Enter') {
      if (st.sel >= 0 && st.items[st.sel]) { e.preventDefault(); choose(st.items[st.sel].id); }
      else if (st.q && st.busy) { e.preventDefault(); st.openFirst = true; }   // open the first answer to THIS query when it arrives
    } else if ((e.key === 'Home' || e.key === 'End') && st.items.length && e.altKey) {
      e.preventDefault(); select(e.key === 'Home' ? 0 : st.items.length - 1, true);
    }
  }

  function trap(e) {
    const f = [...dlg.querySelectorAll('input, button')].filter(x => !x.disabled && !x.hidden && x.tabIndex >= 0 && x.getClientRects().length);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1], a = document.activeElement;
    if (e.shiftKey && (a === first || !dlg.contains(a))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (a === last || !dlg.contains(a))) { e.preventDefault(); first.focus(); }
  }

  // phones: the on-screen keyboard shrinks the visual viewport, not dvh; the panel's height follows it
  function watchViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => dlg.style.setProperty('--srch-vh', Math.round(vv.height) + 'px');
    vv.addEventListener('resize', set); vv.addEventListener('scroll', set); set();
  }

  /* ---------- open and close ---------- */
  function open(from) {
    if (!dlg) build();
    // any other sheet open (the rating sheet): leave it alone
    if (document.querySelector('dialog[open]:not(.srch)')) return;
    clearTimeout(closeTimer);
    if (!opener || !isOpen()) opener = from && from.isConnected ? from : (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
    if (dlg.open && !dlg.classList.contains('is-out')) { els.input.focus(); els.input.select(); return; }
    dlg.classList.remove('is-out');
    if (!dlg.open) dlg.showModal();
    st.q = ''; els.input.value = ''; st.keyOpen = false; st.msg = null; els.note.textContent = '';
    renderFoot();
    showRecent();
    els.input.focus();
    requestAnimationFrame(() => requestAnimationFrame(() => dlg.classList.add('is-in')));
  }

  function close(opts) {
    if (!dlg || !dlg.open || dlg.classList.contains('is-out')) return;
    clearTimeout(debTimer); if (ctrl) { ctrl.abort(); ctrl = null; } seq++; sugSeq++; st.openFirst = false;
    dlg.classList.remove('is-in'); dlg.classList.add('is-out');
    const done = () => {
      clearTimeout(closeTimer);
      if (dlg.classList.contains('is-out')) { dlg.close(); dlg.classList.remove('is-out'); }
      if (!(opts && opts.keepFocus)) restoreFocus();
    };
    closeTimer = setTimeout(done, reduceMotion() ? 0 : 200);
  }
  function restoreFocus() {
    let t = opener;
    if (!t || !t.isConnected) t = document.querySelector('[data-section="search"]');
    opener = null;
    if (t && t.focus) { try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); } }
  }

  function choose(id) {
    if (!Number.isInteger(+id) || +id <= 0) return;
    close();
    if (App.openShow) App.openShow(+id);
  }

  /* ---------- searching ---------- */
  function onInput() {
    const q = els.input.value.trim();
    els.clear.hidden = !els.input.value;
    clearTimeout(debTimer);
    if (ctrl) { ctrl.abort(); ctrl = null; }   // the answer to the previous keystroke is no longer wanted
    seq++;
    st.q = q; st.openFirst = false;
    if (!q) { showRecent(); return; }
    // whatever is on screen belongs to an earlier query: dim it and take it out of play (no selection, no Return, no click)
    st.items = []; st.sel = -1;
    els.list.classList.add('is-stale');
    els.list.querySelectorAll('.is-sel').forEach(r => r.classList.remove('is-sel'));
    els.list.querySelectorAll('[aria-selected="true"]').forEach(r => r.setAttribute('aria-selected', 'false'));
    els.input.removeAttribute('aria-activedescendant');
    st.busy = true;
    els.list.setAttribute('aria-busy', 'true');
    setHead('Searching…');
    debTimer = setTimeout(() => run(q), DEBOUNCE);
  }

  async function run(q) {
    if (!T || !q) return;
    const mine = ++seq;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const signal = ctrl.signal;
    st.busy = true; els.list.setAttribute('aria-busy', 'true');
    try {
      const rows = await T.search(q, { signal });
      if (mine !== seq || !isOpen()) return;
      const list = (rows || []).slice(0, MAX_RESULTS);
      st.mode = 'results'; st.busy = false; els.list.removeAttribute('aria-busy');
      setItems(list.map(r => ({
        id: r.id, name: r.name, year: r.year, poster: r.poster_path, comm: tenths(r.vote_average), votes: r.vote_count,
      })), 0);
      els.note.textContent = list.length ? plural(list.length, 'result') : 'No results';
      const open1 = st.openFirst; st.openFirst = false;
      if (list.length) {
        setHead(hasKey() ? 'Results' : 'Sample shows', list.length === 1 ? '1 result' : list.length + ' results');
        if (open1) choose(list[0].id);   // Return was pressed while this query was still pending
      } else renderMessage('No shows found for “' + q + '”.', hasKey() ? 'Check the spelling, or try fewer words.' : 'Add your TMDB key below to search every show, not just the samples.');
    } catch (err) {
      if (mine !== seq) return;
      if (err && (err.name === 'AbortError' || signal.aborted)) return;
      st.busy = false; els.list.removeAttribute('aria-busy'); st.openFirst = false;   // a later Try again must not open anything unasked
      st.mode = 'error'; els.note.textContent = 'Search failed';
      setItems([], -1);
      renderMessage('Couldn’t search just now.', (err && err.message) || 'Something went wrong. Try again.', true);
    }
  }

  /* ---------- the list ---------- */
  function setHead(text, count) {
    els.head.innerHTML = esc(text) + (count ? `<span class="srch__count">${esc(count)}</span>` : '');
    els.head.hidden = !text;
  }

  function rowHtml(it, i) {
    const note = libNote(it.id);
    const meta = [it.year ? String(it.year) : '', note].filter(Boolean).join(' · ');
    const score = it.comm != null && it.votes !== 0;
    const label = [it.name, it.year ? 'first aired ' + it.year : '', it.comm != null ? 'community score ' + fmt(it.comm) : 'no community score', note].filter(Boolean).join(', ');
    const poster = App.img ? App.img(it.poster, 'poster', 'small', null) : '';
    return `<div class="srch__row" role="option" id="srch-o-${it.id}" data-id="${it.id}" data-i="${i}" aria-selected="${i === st.sel}" aria-label="${esc(label)}">`
      + `<span class="srch__poster ph" aria-hidden="true">${poster}</span>`
      + `<span class="srch__txt"><span class="srch__name">${esc(it.name || 'Show ' + it.id)}</span>`
      + `<span class="srch__meta"><span>${esc(meta) || '&nbsp;'}</span></span></span>`
      + `<span class="score srch__score" style="${score ? chipStyle(it.comm) : ''}" aria-hidden="true">${score ? fmt(it.comm) : '?'}</span>`
      + '</div>';
  }

  function setItems(items, sel) {
    st.items = items;
    st.sel = items.length ? Math.max(0, Math.min(sel < 0 ? 0 : sel, items.length - 1)) : -1;
    els.list.classList.remove('is-stale');
    els.list.innerHTML = items.map(rowHtml).join('');
    els.list.scrollTop = 0;
    syncActive();
  }
  function renderMessage(title, sub, retry) {
    els.head.hidden = true;
    els.list.classList.remove('is-stale');
    els.list.innerHTML = `<div class="srch__empty" role="presentation"><div class="srch__etitle">${esc(title)}</div>`
      + (sub ? `<div class="srch__esub">${esc(sub)}</div>` : '')
      + (retry ? '<button class="srch__btn" type="button" data-retry>Try again</button>' : '') + '</div>';
    syncActive();
  }
  function select(i, scroll) {
    st.sel = i;
    syncActive();
    if (scroll) { const r = els.list.children[i]; if (r && r.scrollIntoView) r.scrollIntoView({ block: 'nearest' }); }
  }
  function syncActive() {
    const rows = els.list.querySelectorAll('.srch__row');
    rows.forEach((r, i) => { const on = i === st.sel; r.classList.toggle('is-sel', on); r.setAttribute('aria-selected', on ? 'true' : 'false'); });
    const cur = rows[st.sel];
    if (cur) els.input.setAttribute('aria-activedescendant', cur.id); else els.input.removeAttribute('aria-activedescendant');
  }

  // empty query: the shows he rated most recently (or the sample shows before he has rated anything)
  function showRecent() {
    st.mode = 'recent'; st.busy = false; els.list.removeAttribute('aria-busy');
    const my = ++sugSeq;
    let list = [], head = 'Recent';
    try {
      const seen = new Set();
      for (const d of (R && R.diary ? R.diary({ limit: 80 }) : [])) {
        if (seen.has(d.tmdb_id)) continue;
        seen.add(d.tmdb_id); list.push({ id: d.tmdb_id, name: d.show_name || '' });
        if (list.length >= MAX_RECENT) break;
      }
    } catch (e) {}
    if (!list.length) {
      head = 'Your shows';
      const d = window.TV_DATA;
      if (d && Array.isArray(d.shows)) list = d.shows.slice(0, MAX_RECENT).map(s => ({ id: s.tmdb, name: s.name, year: startYear(s.years), poster: s.poster || null, comm: tenths(s.community), votes: s.votes }));
    }
    if (!list.length) { setItems([], -1); setHead(''); renderMessage('Search for a show', 'Rate any episode of it and it joins your library.'); return; }
    setItems(list, -1); st.sel = -1; syncActive();
    setHead(head);
    // fill in posters and scores from TMDB (cached by the library already); a failure leaves the name-only row
    list.forEach((it, idx) => {
      if (it.poster !== undefined) return;
      if (!T || !T.show) return;
      T.show(it.id).then(r => {
        if (my !== sugSeq || st.mode !== 'recent' || !isOpen()) return;
        it.name = it.name || r.name; it.year = startYear(r.years); it.poster = r.poster_path || null; it.comm = tenths(r.vote_average); it.votes = r.vote_count;
        const row = els.list.children[idx];
        if (row && row.dataset.id == it.id) { const tmp = document.createElement('div'); tmp.innerHTML = rowHtml(it, idx); row.replaceWith(tmp.firstChild); syncActive(); }
      }).catch(() => {});
    });
  }

  /* ---------- footer: key row, key field, attribution ---------- */
  function renderFoot() {
    const keyed = hasKey();
    let h = '';
    if (st.msg) h += `<div class="srch__msg ${st.msg.ok ? 'is-ok' : 'is-bad'}" role="status">${esc(st.msg.text)}</div>`;
    if (!keyed) {
      h += `<button class="srch__keyrow" type="button" data-keytoggle aria-expanded="${st.keyOpen}" aria-controls="srch-keyfield">`
        + '<span class="srch__keyico" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><use href="#i-plus"></use></svg></span>'
        + '<span class="srch__keytxt"><span class="srch__name">Add your TMDB key for every show</span>'
        + '<span class="srch__meta"><span>Searching the sample shows only</span></span></span>'
        + `<span class="srch__chev ${st.keyOpen ? 'is-open' : ''}" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><use href="#i-chev-r"></use></svg></span></button>`;
      if (st.keyOpen) {
        h += '<form class="srch__keyfield" id="srch-keyfield" novalidate>'
          + '<div class="srch__keybox"><input class="srch__keyin" type="password" name="tmdb-key-field" aria-label="TMDB API key" placeholder="Paste your TMDB API key" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-form-type="other">'
          + '<button class="srch__save" type="submit">Save key</button></div>'
          + '<p class="srch__fine">Kept in this browser only. It is sent to TMDB and nowhere else. You can get a free key from your TMDB account settings (API section).</p>'
          + '</form>';
      }
    } else {
      h += '<div class="srch__src"><span>Showing every show from TMDB</span>'
        + '<button class="srch__link" type="button" data-removekey>Remove key</button></div>';
    }
    els.foot.innerHTML = h;
    els.foot.hidden = !h;
  }

  function onFootClick(e) {
    if (e.target.closest('[data-keytoggle]')) {
      st.keyOpen = !st.keyOpen; st.msg = null; renderFoot();
      if (st.keyOpen) { const k = els.foot.querySelector('.srch__keyin'); if (k) { k.focus(); k.scrollIntoView({ block: 'nearest' }); } }
      else { const b = els.foot.querySelector('[data-keytoggle]'); if (b) b.focus(); }
    } else if (e.target.closest('[data-removekey]')) {
      T.clearKey();
      st.msg = { ok: true, text: 'Key removed from this browser. Searching the sample shows only.' };
      st.keyOpen = false;
      afterKeyChange();
    }
  }

  async function saveKey() {
    const inp = els.foot.querySelector('.srch__keyin'), btn = els.foot.querySelector('.srch__save');
    if (!inp || !T) return;
    const val = inp.value;
    btn.disabled = true; btn.textContent = 'Checking…'; inp.disabled = true;
    let res;
    try { res = await T.setKey(val); } catch (e) { res = { ok: false, message: 'Something went wrong checking the key. Try again.' }; }
    if (!isOpen()) return;
    if (res.ok) {
      st.msg = { ok: true, text: res.message }; st.keyOpen = false;
      afterKeyChange(true);
    } else {
      st.msg = { ok: false, text: res.message };
      renderFoot();
      const k = els.foot.querySelector('.srch__keyin');
      if (k) { k.value = val; k.focus(); k.select(); }
    }
  }

  // the key changed: redo the footer and whatever the list was showing, then put focus back in the field
  function afterKeyChange(focusInput) {
    renderFoot();
    if (App.render) { try { App.render(); } catch (e) {} }
    if (st.q) run(st.q); else showRecent();
    els.input.focus();
  }

  /* ---------- hooks ---------- */
  App.sections.search = btn => open(btn);
  const mark = () => { const b = document.querySelector('[data-section="search"]'); if (b) b.setAttribute('aria-haspopup', 'dialog'); };
  mark();

  const typing = t => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (isOpen()) close(); else open(null);
    } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target) && !isOpen()) {
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault(); open(null);
    }
  });
})();
