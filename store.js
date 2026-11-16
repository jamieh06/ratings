/* Ratings store: window.Ratings. Plain ES2017+, no dependencies, no build step.

   Scores are INTEGER TENTHS (87 = 8.7), 0..100. null = unrated, never 0 (0 = 0.0 is a real rating).
   Item key: {kind: 'episode'|'season'|'show', tmdb_id, season, episode} (season/episode null where not used).

   API
     Ratings.get(item)                 -> tenths | null
     Ratings.set(item, tenths, meta)   -> undo token; meta = {show_name, episode_name}; set(item, null) clears
     Ratings.clear(item)               -> undo token, or null if the item was not rated
     Ratings.undo(token)               -> true | false (false if the item changed since the token was made)
     Ratings.forShow(tmdb_id)          -> [record]   record = {kind, tmdb_id, show_name, season, episode,
                                                      episode_name, tenths, rated_at, first_rated_at}
     Ratings.all()                     -> [record], sorted by tmdb_id, show/season/episode
     Ratings.diary({tmdb_id?, kind?, limit?, before?}) -> newest first; entry = {id, kind, tmdb_id, show_name,
                                          season, episode, episode_name, value, previous, rated_at, action}
                                          value/previous are tenths or null; before = ISO string | Date | ms | an entry
     Ratings.deleteDiaryEntry(id)      -> true | false; removes the entry ONLY, never the current rating
     Ratings.exportJSON()              -> string: array of {kind, tmdb_id, show_name, season, episode,
                                          episode_name, score (8.7), rated_at (ISO UTC)}
     Ratings.importJSON(str|array, {mode: 'merge'|'replace'}) -> {added, updated, skipped}
                                       Accepts the export format above (kind optional: default 'episode') and Free My TV's
                                       tv_ratings() rows [tmdb_id, show_name, season, episode, episode_name, score,
                                       rated (epoch SECONDS)], which become kind 'episode' rows; the two may be mixed.
                                       rated_at in an object row: a number below 1e11 is epoch seconds, otherwise
                                       milliseconds; an ISO string with no time zone is UTC; more than 1 day in the
                                       future = invalid (row skipped). A file of only tv_ratings rows holds episodes
                                       only, so 'replace' removes only episode ratings: season/show ratings stay.
     Ratings.applyRemote(rows, removedItems) -> bool; sets rows (export format) exactly and deletes removedItems, for
                                       sync.js; emits {type: 'remote'}. Ratings.keyOf(item) -> 'kind:id:season:episode'
     Ratings.on('change', fn) / Ratings.off('change', fn)   fn({type, item, value, previous, ...})
     Ratings.persistent                false when localStorage is unavailable (store still works in memory)
     Ratings.problems                  notes about bad stored data that was set aside (tvr.corrupt-<time>)
   Storage keys: tvr.v (=1), tvr.ratings, tvr.diary, tvr.seq, tvr.seeded.
   Test seed: window.TVR_TEST_SEED (export format) is imported once, only into an empty store. */
(function () {
  'use strict';

  var VERSION = 1;
  var P = 'tvr.';
  var KINDS = { show: 0, season: 1, episode: 2 };

  var ratings = new Map();   // key -> record
  var diary = [];            // append order (ids ascend)
  var seq = 0;
  var listeners = { change: [] };
  var lastStamp = 0;
  var touched = new Map();   // key -> diary id of the latest write to that item (in memory; guards Undo tokens)
  var loadedSig = null;      // raw stored text (ratings+diary+seq) this tab last read or wrote: detects another tab's newer write
  var foreignN = 0;
  var locked = false;        // true when stored data could not be read or set aside safely: never save over it

  /* ---------- storage (every read and write guarded) ---------- */
  function ls() { try { return window.localStorage || null; } catch (e) { return null; } }
  function lsGet(k) { try { var s = ls(); return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { var s = ls(); if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } }
  function readKey(k) { try { var s = ls(); return s ? { ok: true, v: s.getItem(k) } : { ok: false, v: null }; } catch (e) { return { ok: false, v: null }; } }
  function sigNow() {
    var r = readKey(P + 'ratings'), d = readKey(P + 'diary'), q = readKey(P + 'seq');
    return (r.ok && d.ok && q.ok) ? r.v + '\u0001' + d.v + '\u0001' + q.v : null;
  }
  function lsProbe() {
    try {
      var s = ls(); if (!s) return false;
      s.setItem(P + 'probe', '1'); s.removeItem(P + 'probe'); return true;
    } catch (e) { return false; }
  }

  /* ---------- helpers ---------- */
  function now() {  // ISO UTC, strictly increasing so "latest" and diary order are never ambiguous
    var t = Date.now();
    if (t <= lastStamp) t = lastStamp + 1;
    lastStamp = t;
    return new Date(t).toISOString();
  }
  function intIn(v, lo, hi) {
    if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) v = Number(v);
    return (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi) ? v : null;
  }
  function isTenths(v) { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100; }
  function str(v, max) { return (v == null) ? null : String(v).slice(0, max); }
  // rated_at as read from an export/import row -> ISO UTC string, or null. Number: < 1e11 is seconds, else ms.
  // ISO text without a zone is UTC (Date.parse would say local time). Anything else: as Date.parse reads it.
  function ratedAtOrNull(v) {
    var t;
    if (typeof v === 'number') t = isFinite(v) ? (Math.abs(v) < 1e11 ? v * 1000 : v) : NaN;
    else if (v instanceof Date) t = v.getTime();
    else if (typeof v === 'string') {
      var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:[.,](\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(v.trim());
      if (m) {
        var zone = m[4] ? (m[4].toUpperCase() === 'Z' ? 'Z' : (m[4].length === 3 ? m[4] + ':00' : (m[4].indexOf(':') < 0 ? m[4].slice(0, 3) + ':' + m[4].slice(3) : m[4]))) : 'Z';
        var clock = m[2].length === 5 ? m[2] + ':00' : m[2];
        t = Date.parse(m[1] + 'T' + clock + (m[3] ? '.' + (m[3] + '00').slice(0, 3) : '') + zone);
      } else t = Date.parse(v);
    } else return null;
    if (!isFinite(t) || t > Date.now() + 864e5) return null;   // unreadable, or more than a day ahead of now
    return new Date(t).toISOString();
  }
  function isoOrNull(v) {
    if (typeof v !== 'string' && !(v instanceof Date) && typeof v !== 'number') return null;
    var t = (v instanceof Date) ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v));
    return isFinite(t) ? new Date(t).toISOString() : null;
  }

  // Validate and normalise an item key; returns a clean {kind, tmdb_id, season, episode} or null.
  function normItem(item) {
    if (!item || typeof item !== 'object') return null;
    var kind = item.kind;
    if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return null;
    var id = intIn(item.tmdb_id, 1, 2147483647);
    if (id === null) return null;
    var season = null, episode = null;
    if (kind !== 'show') {
      season = intIn(item.season, 0, 200);
      if (season === null) return null;
    }
    if (kind === 'episode') {
      episode = intIn(item.episode, 1, 5000);
      if (episode === null) return null;
    }
    return { kind: kind, tmdb_id: id, season: season, episode: episode };
  }
  function keyOf(it) { return it.kind + ':' + it.tmdb_id + ':' + (it.season === null ? '' : it.season) + ':' + (it.episode === null ? '' : it.episode); }
  function copy(rec) { return rec ? Object.assign({}, rec) : null; }
  function itemOf(rec) { return { kind: rec.kind, tmdb_id: rec.tmdb_id, season: rec.season, episode: rec.episode }; }
  function cmpRec(a, b) {
    return (a.tmdb_id - b.tmdb_id) || (KINDS[a.kind] - KINDS[b.kind]) ||
      ((a.season === null ? -1 : a.season) - (b.season === null ? -1 : b.season)) ||
      ((a.episode === null ? -1 : a.episode) - (b.episode === null ? -1 : b.episode));
  }

  // A stored/imported record in internal form (score in tenths), or null if invalid.
  function normRecord(r) {
    if (!r || typeof r !== 'object') return null;
    var it = normItem(r);
    if (!it || !isTenths(r.tenths)) return null;
    var at = isoOrNull(r.rated_at);
    if (!at) return null;
    var first = isoOrNull(r.first_rated_at) || at;
    return {
      kind: it.kind, tmdb_id: it.tmdb_id, season: it.season, episode: it.episode,
      show_name: str(r.show_name, 200) || '',
      episode_name: it.kind === 'episode' ? str(r.episode_name, 300) : null,
      tenths: r.tenths, rated_at: at, first_rated_at: first
    };
  }
  function normDiaryEntry(d) {
    if (!d || typeof d !== 'object') return null;
    var it = normItem(d);
    var id = intIn(d.id, 0, Number.MAX_SAFE_INTEGER);
    var at = isoOrNull(d.rated_at);
    var v = d.value === null ? null : d.value, p = d.previous === null ? null : d.previous;
    if (!it || id === null || !at || (v !== null && !isTenths(v)) || (p !== null && !isTenths(p))) return null;
    return {
      id: id, kind: it.kind, tmdb_id: it.tmdb_id, show_name: str(d.show_name, 200) || '',
      season: it.season, episode: it.episode,
      episode_name: it.kind === 'episode' ? str(d.episode_name, 300) : null,
      value: v, previous: p, rated_at: at, action: str(d.action, 20) || 'set'
    };
  }

  /* ---------- persistence ---------- */
  var api = { persistent: true, problems: [] };

  function save() {
    // All of ratings, diary, seq and version are written together or not at all (rolled back on failure).
    if (locked) { api.persistent = false; return false; }
    var kv = [[P + 'ratings', JSON.stringify(Array.from(ratings.values()))], [P + 'diary', JSON.stringify(diary)],
              [P + 'seq', String(seq)], [P + 'v', String(VERSION)]];
    var prev = kv.map(function (p) { return readKey(p[0]); });
    if (prev.some(function (p) { return !p.ok; })) { api.persistent = false; return false; }
    var done = 0, ok = true;
    for (; done < kv.length; done++) { if (!lsSet(kv[done][0], kv[done][1])) { ok = false; break; } }
    if (!ok) {
      for (var i = 0; i < done; i++) {
        try { if (prev[i].v === null) ls().removeItem(kv[i][0]); else ls().setItem(kv[i][0], prev[i].v); } catch (e) { /* best effort */ }
      }
    }
    api.persistent = ok;
    if (ok) loadedSig = sigNow();
    return ok;
  }

  function loadPart(name, raw, normFn, out) {
    // Returns nothing; pushes good entries into out, reports the raw text if anything was unreadable.
    var bad = false, data;
    try { data = JSON.parse(raw); } catch (e) { bad = true; }
    if (!bad && !Array.isArray(data)) bad = true;
    if (!bad) {
      data.forEach(function (x) { var n = normFn(x); if (n) out.push(n); else bad = true; });
    }
    return bad;
  }

  function load(keepTouched) {
    var oldRatings = keepTouched ? new Map(ratings) : null;
    if (!keepTouched) touched.clear();
    loadCore();
    if (oldRatings) {   // items another tab changed can no longer be undone from an old token here
      var keys = new Set(Array.from(oldRatings.keys()).concat(Array.from(ratings.keys())));
      keys.forEach(function (k) {
        var a = oldRatings.get(k) || null, b = ratings.get(k) || null;
        if (!a !== !b || (a && (a.rated_at !== b.rated_at || a.tenths !== b.tenths))) touched.set(k, 'x' + (++foreignN));
      });
    }
  }

  // Before any write: if another tab wrote since we last looked, take its data first, then apply our change on top.
  function sync() {
    var now_ = sigNow();
    if (now_ !== null && now_ !== loadedSig) { load(true); scheduleExternal(); }
  }
  // The data is reloaded at once; only the event is coalesced (Chrome delivers the 3 key events one by one).
  var extTimer = null;
  function scheduleExternal() {
    if (extTimer !== null) return;
    extTimer = setTimeout(function () { extTimer = null; emit({ type: 'external' }); }, 60);
  }

  function loadCore() {
    api.persistent = lsProbe();   // a failed probe (storage full) must not stop us reading what is stored
    ratings.clear(); diary = []; seq = 0; api.problems = []; locked = false; loadedSig = null;
    var parts = {};
    var rV = readKey(P + 'v'), rR = readKey(P + 'ratings'), rD = readKey(P + 'diary'), rS = readKey(P + 'seq');
    if (!rV.ok || !rR.ok || !rD.ok || !rS.ok) { locked = true; api.persistent = false; return; }   // unreadable: never overwrite
    var rawV = rV.v, rawR = rR.v, rawD = rD.v;
    loadedSig = rawR + '\u0001' + rawD + '\u0001' + rS.v;
    if (rawV !== null && rawV !== String(VERSION)) {
      // Written by a newer/unknown version: do not guess, set it aside and leave it untouched.
      if (rawR !== null) parts.ratings = rawR;
      if (rawD !== null) parts.diary = rawD;
      parts.version = rawV;
    } else {
      var recs = [], ents = [];
      if (rawR !== null) {
        if (loadPart('ratings', rawR, normRecord, recs)) parts.ratings = rawR;
        recs.forEach(function (r) { ratings.set(keyOf(r), r); });
      }
      if (rawD !== null) {
        if (loadPart('diary', rawD, normDiaryEntry, ents)) parts.diary = rawD;
        diary = ents.sort(function (a, b) { return a.id - b.id; });
      }
    }
    var s = parseInt(rS.v, 10);
    seq = Math.max(isFinite(s) ? s : 0, diary.length ? diary[diary.length - 1].id : 0);
    if (Object.keys(parts).length) {
      var key = P + 'corrupt-' + Date.now();
      if (!lsSet(key, JSON.stringify({ saved_at: new Date().toISOString(), parts: parts }))) {
        locked = true; api.persistent = false;   // could not keep a copy: leave the stored text alone
        api.problems.push({ key: null, parts: Object.keys(parts) });
        return;
      }
      api.problems.push({ key: key, parts: Object.keys(parts) });
      if (parts.version !== undefined) { locked = true; api.persistent = false; return; }   // newer data: read-only
      save();   // rewrite what we could read, so the bad text stops being re-read (the copy is kept)
    }
  }

  /* ---------- events ---------- */
  function emit(ev) {
    listeners.change.slice().forEach(function (fn) { try { fn(ev); } catch (e) { /* a bad listener must not break a write */ } });
  }

  /* ---------- core writes ---------- */
  function addDiary(rec, value, previous, at, action) {
    var e = {
      id: ++seq, kind: rec.kind, tmdb_id: rec.tmdb_id, show_name: rec.show_name || '',
      season: rec.season, episode: rec.episode, episode_name: rec.kind === 'episode' ? (rec.episode_name || null) : null,
      value: value, previous: previous, rated_at: at, action: action
    };
    diary.push(e);
    touched.set(keyOf(rec), e.id);
    return e;
  }

  function makeToken(key, before, after, id) { return { v: 1, key: key, before: copy(before), after: copy(after), seq: id }; }

  function set(item, tenths, meta) {
    if (tenths === null || tenths === undefined) return clear(item);
    var it = normItem(item);
    if (!it) throw new TypeError('Ratings.set: invalid item');
    sync();
    if (!isTenths(tenths)) throw new RangeError('Ratings.set: score must be whole tenths 0..100 (8.7 is 87)');
    meta = meta || {};
    var key = keyOf(it), old = ratings.get(key) || null, at = now();
    var rec = {
      kind: it.kind, tmdb_id: it.tmdb_id, season: it.season, episode: it.episode,
      show_name: meta.show_name != null ? str(meta.show_name, 200) : (old ? old.show_name : ''),
      episode_name: it.kind === 'episode' ? (meta.episode_name != null ? str(meta.episode_name, 300) : (old ? old.episode_name : null)) : null,
      tenths: tenths, rated_at: at, first_rated_at: old ? old.first_rated_at : at
    };
    ratings.set(key, rec);
    var de = addDiary(rec, tenths, old ? old.tenths : null, at, 'set');
    save();
    emit({ type: 'set', item: itemOf(rec), value: tenths, previous: old ? old.tenths : null });
    return makeToken(key, old, rec, de.id);
  }

  function clear(item) {
    var it = normItem(item);
    if (!it) throw new TypeError('Ratings.clear: invalid item');
    sync();
    var key = keyOf(it), old = ratings.get(key);
    if (!old) return null;
    var at = now();
    ratings.delete(key);
    var de = addDiary(old, null, old.tenths, at, 'clear');
    save();
    emit({ type: 'clear', item: itemOf(old), value: null, previous: old.tenths });
    return makeToken(key, old, null, de.id);
  }

  function undo(token) {
    if (!token || token.v !== 1) return false;
    sync();
    if (token.type === 'import') return undoImport(token);
    if (typeof token.key !== 'string') return false;
    if (touched.get(token.key) !== token.seq) return false;   // anything written to this item since: never clobber it
    var cur = ratings.get(token.key) || null, before = token.before;
    var base = before || token.after;
    var at = now();
    if (before) ratings.set(token.key, copy(before)); else ratings.delete(token.key);
    addDiary(base, before ? before.tenths : null, cur ? cur.tenths : null, at, 'undo');
    save();
    emit({ type: 'undo', item: itemOf(base), value: before ? before.tenths : null, previous: cur ? cur.tenths : null });
    return true;
  }

  function undoImport(token) {
    var keys = Object.keys(token.seqs || {});
    for (var i = 0; i < keys.length; i++) if (touched.get(keys[i]) !== token.seqs[keys[i]]) return false;
    var at = now();
    keys.forEach(function (k) {
      var cur = ratings.get(k) || null, before = token.snap[k];
      var base = before || cur;
      if (!base) return;
      if (before) ratings.set(k, copy(before)); else ratings.delete(k);
      addDiary(base, before ? before.tenths : null, cur ? cur.tenths : null, at, 'undo');
    });
    save();
    emit({ type: 'undo', import: true });
    return true;
  }

  /* ---------- reads ---------- */
  function get(item) {
    var it = normItem(item);
    if (!it) return null;
    var r = ratings.get(keyOf(it));
    return r ? r.tenths : null;
  }
  function allRecords() { return Array.from(ratings.values()).sort(cmpRec); }
  function all() { return allRecords().map(copy); }
  function forShow(id) {
    var n = intIn(id, 1, 2147483647);
    return n === null ? [] : allRecords().filter(function (r) { return r.tmdb_id === n; }).map(copy);
  }

  function diaryList(opts) {
    opts = opts || {};
    var list = diary.slice();
    if (opts.tmdb_id != null) { var id = intIn(opts.tmdb_id, 1, 2147483647); list = list.filter(function (d) { return d.tmdb_id === id; }); }
    if (opts.kind) list = list.filter(function (d) { return d.kind === opts.kind; });
    list.sort(function (a, b) { return a.rated_at < b.rated_at ? 1 : a.rated_at > b.rated_at ? -1 : b.id - a.id; });
    var b = opts.before;
    if (b != null) {
      if (typeof b === 'object' && !(b instanceof Date) && b.rated_at) {
        list = list.filter(function (d) { return d.rated_at < b.rated_at || (d.rated_at === b.rated_at && d.id < b.id); });
      } else {
        var iso = isoOrNull(b);
        if (iso) list = list.filter(function (d) { return d.rated_at < iso; });
      }
    }
    if (opts.limit != null && opts.limit >= 0) list = list.slice(0, opts.limit);
    return list.map(copy);
  }

  function deleteDiaryEntry(id) {
    var i = diary.findIndex(function (d) { return d.id === id; });
    if (i < 0) return false;
    diary.splice(i, 1);   // the current rating is untouched on purpose
    save();
    return true;
  }

  /* ---------- export / import ---------- */
  function toRow(r) {
    return {
      kind: r.kind, tmdb_id: r.tmdb_id, show_name: r.show_name, season: r.season, episode: r.episode,
      episode_name: r.episode_name, score: r.tenths / 10, rated_at: r.rated_at
    };
  }
  function exportJSON() { return JSON.stringify(allRecords().map(toRow), null, 2); }

  // An export-format row -> internal record, or null (invalid / unknown kind / bad score).
  function rowToRecord(row) {
    if (!row || typeof row !== 'object') return null;
    var kind = row.kind === undefined ? 'episode' : row.kind;   // Free My TV's own rows have no kind: they are episodes
    var s = row.score;
    if (typeof s !== 'number' || !isFinite(s) || s < 0 || s > 10) return null;
    var t = Math.round(s * 10);
    if (Math.abs(s * 10 - t) > 1e-6) return null;   // more than one decimal
    return normRecord({
      kind: kind, tmdb_id: row.tmdb_id, season: row.season, episode: row.episode,
      show_name: row.show_name, episode_name: row.episode_name, tenths: t, rated_at: ratedAtOrNull(row.rated_at)
    });
  }

  // Free My TV's tv_ratings() row [tmdb_id, show, season, episode, name, score, rated (epoch seconds)] -> an export-format
  // row of kind 'episode'; anything not shaped like one -> null (counted as skipped).
  function fmtvRow(a) {
    if (a.length < 7 || typeof a[6] !== 'number' || !isFinite(a[6]) || !isFinite(a[6] * 1000)) return null;
    var d = new Date(a[6] * 1000);
    return {
      kind: 'episode', tmdb_id: a[0], show_name: a[1], season: a[2], episode: a[3], episode_name: a[4], score: a[5],
      rated_at: isFinite(d.getTime()) ? d.toISOString() : null
    };
  }

  function importJSON(input, opts) {
    var mode = (opts && opts.mode) === 'replace' ? 'replace' : 'merge';
    var rows = input;
    if (typeof input === 'string') rows = JSON.parse(input);   // throws before anything is touched
    if (!Array.isArray(rows)) throw new TypeError('Ratings.importJSON: expected an array of ratings');
    var result = { added: 0, updated: 0, skipped: 0 };
    var onlyFmtv = rows.length > 0 && rows.every(Array.isArray);   // a Free My TV file: episodes only, so replace leaves seasons/shows
    rows = rows.map(function (row) { return Array.isArray(row) ? fmtvRow(row) : row; });
    sync();
    var incoming = new Map(), mentioned = new Set();
    rows.forEach(function (row) {
      var it0 = row && typeof row === 'object' ? normItem({ kind: row.kind === undefined ? 'episode' : row.kind, tmdb_id: row.tmdb_id, season: row.season, episode: row.episode }) : null;
      if (it0) mentioned.add(keyOf(it0));   // a row that names an item protects it from replace-deletion, valid score or not
      var rec = rowToRecord(row);
      if (!rec) { result.skipped++; return; }
      var k = keyOf(rec), prev = incoming.get(k);
      if (prev) { result.skipped++; if (prev.rated_at >= rec.rated_at) return; }   // duplicate in the file: newer wins
      incoming.set(k, rec);
    });
    if (mode === 'replace' && !incoming.size) { result.noChange = 'replace: no valid rows, nothing changed'; return result; }   // never wipe on an empty/bad file

    var changed = false, snap = {};
    function remember(k, old) { if (!(k in snap)) snap[k] = copy(old); }
    incoming.forEach(function (rec, k) {
      var old = ratings.get(k) || null;
      if (old && (mode === 'merge' ? rec.rated_at <= old.rated_at : (rec.rated_at === old.rated_at && rec.tenths === old.tenths && rec.show_name === old.show_name && rec.episode_name === old.episode_name))) {
        result.skipped++; return;
      }
      rec.first_rated_at = old ? (old.first_rated_at < rec.rated_at ? old.first_rated_at : rec.rated_at) : rec.rated_at;
      if (old && !rec.show_name) rec.show_name = old.show_name;
      remember(k, old);
      ratings.set(k, rec);
      addDiary(rec, rec.tenths, old ? old.tenths : null, rec.rated_at, 'import');
      old ? result.updated++ : result.added++;
      changed = true;
    });
    if (mode === 'replace') {
      Array.from(ratings.keys()).forEach(function (k) {
        if (incoming.has(k) || mentioned.has(k)) return;
        var old = ratings.get(k);
        if (onlyFmtv && old.kind !== 'episode') return;
        remember(k, old);
        ratings.delete(k);
        addDiary(old, null, old.tenths, now(), 'import');
        result.updated++;
        changed = true;
      });
    }
    if (changed) {
      var seqs = {};
      Object.keys(snap).forEach(function (k) { seqs[k] = touched.get(k); });
      result.undo = { v: 1, type: 'import', snap: snap, seqs: seqs };
      save();
      emit({ type: 'import', mode: mode, added: result.added, updated: result.updated, skipped: result.skipped });
    }
    return result;
  }

  /* ---------- sync (sync.js) ---------- */
  // Take the server's ratings as they are: rows in the export format are set exactly (score and rated_at), removed items
  // are deleted. A diary entry ('sync') only where the score itself changed. Emits {type: 'remote'}, which sync.js
  // never pushes back.
  function applyRemote(rows, removed) {
    sync();
    var changed = false;
    (rows || []).forEach(function (row) {
      var rec = rowToRecord(row);
      if (!rec) return;
      var k = keyOf(rec), old = ratings.get(k) || null;
      if (old && !rec.show_name) rec.show_name = old.show_name;
      if (old && rec.kind === 'episode' && !rec.episode_name) rec.episode_name = old.episode_name;
      if (old && old.tenths === rec.tenths && old.rated_at === rec.rated_at && old.show_name === rec.show_name && old.episode_name === rec.episode_name) return;
      rec.first_rated_at = old ? (old.first_rated_at < rec.rated_at ? old.first_rated_at : rec.rated_at) : rec.rated_at;
      ratings.set(k, rec);
      if (!old || old.tenths !== rec.tenths) addDiary(rec, rec.tenths, old ? old.tenths : null, rec.rated_at, 'sync');
      changed = true;
    });
    (removed || []).forEach(function (item) {
      var it = normItem(item);
      if (!it) return;
      var k = keyOf(it), old = ratings.get(k);
      if (!old) return;
      ratings.delete(k);
      addDiary(old, null, old.tenths, now(), 'sync');
      changed = true;
    });
    if (changed) { save(); emit({ type: 'remote' }); }
    return changed;
  }

  /* ---------- events API ---------- */
  function on(name, fn) {
    if (name === 'change' && typeof fn === 'function') listeners.change.push(fn);
    return function () { off(name, fn); };
  }
  function off(name, fn) {
    if (name !== 'change') return;
    var i = listeners.change.indexOf(fn);
    if (i >= 0) listeners.change.splice(i, 1);
  }

  /* ---------- wire up ---------- */
  Object.assign(api, {
    get: get, set: set, clear: clear, undo: undo, forShow: forShow, all: all, diary: diaryList,
    deleteDiaryEntry: deleteDiaryEntry, exportJSON: exportJSON, importJSON: importJSON, on: on, off: off,
    applyRemote: applyRemote, keyOf: function (item) { var it = normItem(item); return it ? keyOf(it) : null; }
  });

  load();

  // Test seed: once, and only into an empty store.
  try {
    var seed = window.TVR_TEST_SEED;
    if (Array.isArray(seed) && !ratings.size && !diary.length && lsGet(P + 'seeded') === null) {
      importJSON(seed, { mode: 'merge' });
      lsSet(P + 'seeded', '1');
    }
  } catch (e) { /* a bad seed must not stop the app */ }

  // Another tab changed the data: pick it up at once (no timer: background tabs throttle timers to about 1 s).
  // The first of its three key events loads all three keys; the rest find nothing new, so one 'external' event.
  // Only the data keys count, never tvr.probe, tvr.cache.*, tvr.tmdbKey or tvr.corrupt-*.
  try {
    window.addEventListener('storage', function (e) {
      if (e.key !== null && e.key !== P + 'ratings' && e.key !== P + 'diary' && e.key !== P + 'seq') return;
      try { if (e.storageArea && e.storageArea !== ls()) return; } catch (x) { return; }
      sync();
    });
  } catch (e) { /* no window events: fine */ }

  window.Ratings = api;
})();
