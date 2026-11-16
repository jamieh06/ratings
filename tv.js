/* TV mode: the app inside Free My TV on the LG (opened as index.html?tv=1, in a frame over the home screen).
   Off everywhere else. With it on:
   - the arrow keys move focus to the nearest thing in that direction (the episode grid, the 0-10 picks and the fine-tune
     slider keep their own arrows until they reach an edge; Up and Down always leave a slider or text field);
   - Back (the remote's, or Escape) closes the open sheet, panel or search first, then asks Free My TV to close the app;
   - Export and Import are hidden (no files on a TV); the TMDB key comes from Free My TV if this TV has none yet;
   - ?section=stats|diary|search opens that section, #show=<TMDB id> that show (index.html already reads it).
   Free My TV sends its Supabase key after 'fmtv-ratings-ready' (sync.js takes it). */
(function () {
  'use strict';
  const q = new URLSearchParams(location.search);
  const inFrame = window.parent !== window;
  if (q.get('tv') !== '1') return;
  document.documentElement.classList.add('is-tv');

  const BACK = new Set([461, 10009, 27, 8]);   // LG Back, Samsung Back, Escape, Backspace (outside a text field)
  const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const tell = msg => { if (inFrame) try { window.parent.postMessage(msg, '*'); } catch (e) {} };

  /* ---------- what can take focus ---------- */
  const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
  function scope() {
    const open = [...document.querySelectorAll('dialog[open]')];
    return open.length ? open[open.length - 1] : document;
  }
  function visible(el) {
    if (el.disabled || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0 || cs.pointerEvents === 'none') return false;
    // inside a scrolled pane it may be out of view, but not clipped away by a closed or zero-size box
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.display === 'none' || ps.visibility === 'hidden' || +ps.opacity === 0) return false;
    }
    return true;
  }
  // the library's filter box is left out: focusing it brings up the TV's on-screen keyboard (Search in the Dock finds shows)
  function candidates() { return [...scope().querySelectorAll(FOCUSABLE)].filter(el => !el.matches('.search__input') && visible(el)); }

  /* ---------- nearest in a direction ---------- */
  function nearest(from, d) {
    const a = from.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of candidates()) {
      if (el === from || el.contains(from) || from.contains(el)) continue;
      const b = el.getBoundingClientRect();
      // how far along the direction (edge to edge), and how far off to the side (0 when they overlap)
      let along, side;
      // only what lies beyond this one that way: its far edge past ours, and its middle past our middle
      if (d[0]) {
        along = d[0] > 0 ? b.left - a.right : a.left - b.right;
        if (d[0] > 0 ? (b.left + b.width / 2 <= ax || b.right <= a.right + 4) : (b.left + b.width / 2 >= ax || b.left >= a.left - 4)) continue;
        side = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
      } else {
        along = d[1] > 0 ? b.top - a.bottom : a.top - b.bottom;
        if (d[1] > 0 ? (b.top + b.height / 2 <= ay || b.bottom <= a.bottom + 4) : (b.top + b.height / 2 >= ay || b.top >= a.top - 4)) continue;
        side = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
      }
      const score = Math.max(along, -8) + side * 3;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }
  // where focus starts: the open section's first control, else the show's first episode, else the library
  function home() {
    const all = candidates(), side = document.querySelector('.side'), edge = side ? side.getBoundingClientRect().right : 0;
    return all.find(el => el.matches('.rg .cell')) && !document.querySelector('.has-top')
      ? all.find(el => el.matches('.rg .cell'))
      : all.find(el => el.getBoundingClientRect().left >= edge && !el.closest('.dock, .cc')) || all[0];
  }
  function go(el) {
    if (!el) return false;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  /* ---------- keys ---------- */
  let pendingHome = false;
  const OWN_ARROWS = '.rg .cell, .pick, [role="slider"], [role="radio"], [role="tab"], input, textarea, select';
  window.addEventListener('keydown', e => {
    if (!e.isTrusted) return;   // the Escape this sends to a sheet
    tell({ type: 'fmtv-ratings-activity' });
    const t = document.activeElement;
    const typing = t && (t.matches('textarea') || (t.matches('input') && !/^(range|checkbox|radio|button)$/.test(t.type)));

    if (BACK.has(e.keyCode) && !(typing && e.keyCode === 8)) {
      const open = [...document.querySelectorAll('dialog[open]')].pop();
      if (open) {   // its own Escape handling closes it (the rating sheet saves nothing; search closes)
        e.preventDefault(); e.stopPropagation();
        (t && open.contains(t) ? t : open).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
        setTimeout(() => { if (open.open && !open.classList.contains('is-out')) open.close(); }, 500);   // one that ignored it
        return;
      }
      e.preventDefault(); e.stopPropagation();
      tell({ type: 'fmtv-ratings-close' });
      return;
    }

    const d = DIRS[e.key];
    if (!d || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (pendingHome) {   // opened on a section and the app has since put focus back on the library: the first arrow starts there
      pendingHome = false;
      if (t && t.closest('.side') && document.querySelector('.has-top')) { e.preventDefault(); e.stopPropagation(); go(home()); return; }
    }
    if (!t || t === document.body || !scope().contains(t)) { e.preventDefault(); go(scope() === document ? home() : candidates()[0]); return; }
    const own = t.matches(OWN_ARROWS) || t.closest('[role="radiogroup"], [role="tablist"]');
    if (own && (typing || t.type === 'range' || t.getAttribute('role') === 'slider' || t.matches('.pick, [role="radio"], [role="tab"]')) && d[1]) {   // up/down leave a slider, the picks, a switch or a field
      e.preventDefault(); e.stopPropagation(); go(nearest(t, d)); return;
    }
    if (own && typing) {   // left/right move the caret, and leave the field from its ends
      const end = t.selectionStart === t.selectionEnd && (d[0] > 0 ? t.selectionEnd >= t.value.length : t.selectionStart <= 0);
      if (end) { const n = nearest(t, d); if (n) { e.preventDefault(); e.stopPropagation(); go(n); } }
      return;
    }
    if (!own) { e.preventDefault(); e.stopPropagation(); go(nearest(t, d)); return; }
    // the element's own arrows first; if focus didn't move (an edge), move to the nearest thing that way
    const before = t, value = t.value;
    setTimeout(() => {
      if (document.activeElement === before && before.value === value) go(nearest(before, d));
    }, 0);
  }, true);
  for (const ev of ['pointermove', 'wheel']) window.addEventListener(ev, () => tell({ type: 'fmtv-ratings-activity' }), { passive: true });

  // A sheet that opens with its text field focused would bring up the TV's on-screen keyboard: start on its 0-10 picks
  // (the one at the current score) instead. Typing digits on the remote still goes to the field.
  new MutationObserver(list => {
    for (const m of list) {
      const dlg = m.target;
      if (!dlg.open) continue;
      setTimeout(() => {
        const t = document.activeElement;
        if (!dlg.contains(t) || !t.matches('input[type="text"], input:not([type]), textarea')) return;
        const pick = dlg.querySelector('.pick[aria-checked="true"], .pick.is-on, .pick[aria-pressed="true"]') || dlg.querySelector('.pick');
        if (pick) pick.focus();
      }, 50);
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

  /* ---------- start ---------- */
  window.addEventListener('message', e => {
    const d = e.data;
    if (!window.Sync || !Sync.fromFreeMyTv(e) || !d || d.type !== 'fmtv-ratings') return;   // same checks as sync.js
    if (d.tmdbKey && window.TMDB && !TMDB.hasKey()) TMDB.setKey(d.tmdbKey).then(() => window.App && App.render && App.render()).catch(() => {});
  });
  function start() {
    tell({ type: 'fmtv-ratings-ready' });
    const s = q.get('section');
    const btn = s && document.querySelector(`.dock__btn[data-section="${CSS.escape(s)}"]`);
    if (btn) btn.click();
    // unless focus is already somewhere useful (the app puts it on the library row of the show it opened)
    const settle = () => { const a = document.activeElement; if (!a || a === document.body || (btn && a.closest('.side'))) go(home()); };
    setTimeout(settle, 600);
    setTimeout(settle, 1500);   // a section still opening at 600 ms
    pendingHome = !!btn;
  }
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
