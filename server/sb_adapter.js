'use strict';
/* Supabase (PostgREST) backend for the VIKING server — an
   RTDB-compatible adapter (owner migration order 2026-11-16).
   index.js talks to the database exclusively through rtdb().ref(...)
   plus the getVal/txUpdate helpers, so this module re-implements
   exactly that surface on top of Postgres:

     ref(path).once('value')  -> snapshot.val()
     ref.set / update / remove
     ref.transaction(fn)      -> optimistic loop over the doc_write
                                 RPC (version-checked); exhaustion
                                 throws Error('maxretry') so the
                                 existing txUpdate retry ladder applies
     ref.orderByChild(child).equalTo/startAt/limitToFirst/limitToLast
     ref().update({path: v})  -> one multi_write RPC (atomic)

   Storage model (see supabase/schema.sql): one row per RTDB
   document root — players/<id>, withdrawals/<id>, and named docs
   (settings/global, meta/counters, wallets/<raw>, sigs/<key>, ...)
   in the docs table keyed by their two-segment path. Subpaths are
   resolved inside the row's jsonb `data` by the doc_write RPC.

   Modes (env DB_BACKEND): 'supabase' = this adapter alone;
   'dual' = DualDb below (RTDB primary, this adapter as shadow). */

const MAP_ROOTS = new Set(['wallets', 'sigs', 'deviceIds', 'devices', 'verifyClaims', 'refRepairQueue', 'verifyUnresolved']);
const PLAYER_QUERY_COLS = { verifyPendingAt: 'verify_pending_at', walletVerified: 'wallet_verified', invitedBy: 'invited_by', userNo: 'user_no' };
const WD_QUERY_COLS = { userId: 'user_id' };

const splitPath = (p) => String(p == null ? '' : p).split('/').filter((s) => s.length > 0);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSub(data, subpath) {
  let cur = data;
  for (const s of subpath) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[s];
  }
  return cur === undefined ? null : cur;
}

/* firebase-admin's ServerValue.increment(n) serialises to
   {'.sv': {increment: n}}; translate those sentinels (anywhere in a
   written value) into the marker the SQL layer understands. */
function convSentinels(v, depth = 0) {
  if (v == null || typeof v !== 'object' || depth > 12) return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '.sv' && v['.sv'] && typeof v['.sv'].increment === 'number') {
    return { __increment: v['.sv'].increment };
  }
  if (Array.isArray(v)) return v.map((x) => convSentinels(x, depth + 1));
  const out = {};
  for (const k of keys) out[k] = convSentinels(v[k], depth + 1);
  return out;
}

/* RTDB child ordering: null < false < true < numbers < strings <
   objects; used by the in-memory query fallback. */
function rtdbRank(v) {
  if (v === null || v === undefined) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  if (typeof v === 'number') return 3;
  if (typeof v === 'string') return 4;
  return 5;
}
function rtdbCmp(a, b) {
  const ra = rtdbRank(a), rb = rtdbRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

function resolveSegs(segs) {
  if (!segs.length) return { kind: 'root' };
  const a = segs[0], b = segs[1];
  if (a === 'players') {
    return segs.length === 1 ? { kind: 'collection', table: 'players' }
      : { kind: 'doc', table: 'players', key: b, subpath: segs.slice(2) };
  }
  if (a === 'withdrawals') {
    return segs.length === 1 ? { kind: 'collection', table: 'withdrawals' }
      : { kind: 'doc', table: 'withdrawals', key: b, subpath: segs.slice(2) };
  }
  if (a === 'premiumEmoji') return { kind: 'doc', table: 'docs', key: 'premiumEmoji', subpath: segs.slice(1) };
  if (MAP_ROOTS.has(a)) {
    return segs.length === 1 ? { kind: 'docCollection', table: 'docs', prefix: a + '/' }
      : { kind: 'doc', table: 'docs', key: a + '/' + b, subpath: segs.slice(2) };
  }
  if ((a === 'settings' || a === 'meta')) {
    return segs.length === 1 ? { kind: 'docCollection', table: 'docs', prefix: a + '/' }
      : { kind: 'doc', table: 'docs', key: a + '/' + b, subpath: segs.slice(2) };
  }
  if (segs.length === 1) return { kind: 'doc', table: 'docs', key: a, subpath: [] };
  return { kind: 'doc', table: 'docs', key: a + '/' + b, subpath: segs.slice(2) };
}

class SbSnapshot {
  constructor(key, val) { this.key = key; this._val = val; }
  val() { return this._val; }
  exists() { return this._val !== null && this._val !== undefined; }
}

class SbDb {
  constructor(restUrl, serviceKey) {
    if (!restUrl || !serviceKey) throw new Error('SUPABASE_REST_URL / SUPABASE_SERVICE_KEY not configured');
    this.base = String(restUrl).replace(/\/+$/, '');
    this.key = serviceKey;
  }

  ref(path) { return new SbRef(this, splitPath(path)); }

  async _req(method, path, body, extraHeaders) {
    const res = await fetch(this.base + path, {
      method,
      headers: { apikey: this.key, Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/json', ...(extraHeaders || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error('supabase ' + method + ' ' + path.split('?')[0] + ' -> ' + res.status + ' ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  }

  async _readRow(table, key) {
    const col = table === 'docs' ? 'path' : 'id';
    const rows = await this._req('GET', '/' + table + '?' + col + '=eq.' + encodeURIComponent(key) + '&select=data,v');
    return rows && rows.length ? rows[0] : null;
  }

  async _readAll(table, extra = '') {
    const out = [];
    const page = 1000;
    const keyCol = table === 'docs' ? 'path' : 'id';
    for (let off = 0; ; off += page) {
      const rows = await this._req('GET', '/' + table + '?select=' + keyCol + ',data&limit=' + page + '&offset=' + off + extra);
      out.push(...rows);
      if (rows.length < page) break;
    }
    return out;
  }

  async _read(segs) {
    const r = resolveSegs(segs);
    if (r.kind === 'doc') {
      const row = await this._readRow(r.table, r.key);
      return row ? getSub(row.data, r.subpath) : null;
    }
    if (r.kind === 'collection') {
      const rows = await this._readAll(r.table);
      const out = {};
      for (const row of rows) out[row.id] = row.data;
      return Object.keys(out).length ? out : null;
    }
    if (r.kind === 'docCollection') {
      const rows = await this._readAll('docs', '&path=like.' + encodeURIComponent(r.prefix) + '*');
      const out = {};
      for (const row of rows) {
        const rest = row.path.slice(r.prefix.length).split('/');
        let cur = out;
        for (let i = 0; i < rest.length - 1; i++) cur = cur[rest[i]] = cur[rest[i]] || {};
        cur[rest[rest.length - 1]] = row.data;
      }
      return Object.keys(out).length ? out : null;
    }
    // root: assemble the whole tree (never used by hot paths)
    const [players, wds, docs] = await Promise.all([this._read(['players']), this._read(['withdrawals']), this._readAll('docs')]);
    const out = {};
    if (players) out.players = players;
    if (wds) out.withdrawals = wds;
    for (const row of docs || []) {
      const parts = row.path.split('/');
      let cur = out;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] = cur[parts[i]] || {};
      cur[parts[parts.length - 1]] = row.data;
    }
    return Object.keys(out).length ? out : null;
  }

  async _docWrite(r, mode, value, expectV) {
    const nv = await this._req('POST', '/rpc/doc_write', {
      p_table: r.table, p_key: r.key, p_subpath: r.subpath,
      p_value: value === undefined ? null : convSentinels(value),
      p_mode: mode, p_expect_v: expectV == null ? null : expectV,
    });
    return nv;
  }

  async _write(segs, mode, value) {
    const r = resolveSegs(segs);
    if (r.kind !== 'doc') throw new Error('supabase adapter: write to non-document path ' + segs.join('/'));
    await this._docWrite(r, mode, value, null);
  }

  async _update(segs, obj) {
    const keys = Object.keys(obj || {});
    const hasSlash = keys.some((k) => k.includes('/'));
    if (!segs.length || hasSlash) {
      // multi-path update (RTDB root-update semantics: set per path)
      const ops = [];
      for (const k of keys) {
        const target = resolveSegs(segs.concat(splitPath(k)));
        if (target.kind !== 'doc') throw new Error('supabase adapter: multi-update to non-document path ' + k);
        const v = obj[k];
        ops.push({ table: target.table, key: target.key, subpath: target.subpath, mode: v === null ? 'remove' : 'set', value: v === null ? null : convSentinels(v) });
      }
      if (ops.length) await this._req('POST', '/rpc/multi_write', { p_ops: ops });
      return;
    }
    const r = resolveSegs(segs);
    if (r.kind !== 'doc') throw new Error('supabase adapter: update on non-document path ' + segs.join('/'));
    await this._docWrite(r, 'update', obj, null);
  }

  async _transaction(segs, fn) {
    const r = resolveSegs(segs);
    if (r.kind !== 'doc') throw new Error('supabase adapter: transaction on non-document path ' + segs.join('/'));
    for (let attempt = 0; attempt < 30; attempt++) {
      const row = await this._readRow(r.table, r.key);
      const curVal = row ? getSub(row.data, r.subpath) : null;
      const arg = clone(curVal);
      const next = fn(arg);
      if (next === undefined) return { committed: false };
      if (next === arg && JSON.stringify(next) === JSON.stringify(curVal)) return { committed: true };
      let nv;
      try {
        nv = await this._docWrite(r, 'set', next === undefined ? null : next, row ? row.v : 0);
      } catch (e) {
        // a concurrent creator won the insert race (PK conflict): re-read and re-run
        if (/409|duplicate key/i.test(String(e.message))) { await sleep(20 + Math.random() * 60); continue; }
        throw e;
      }
      if (nv === -1) { await sleep(15 + Math.random() * 55); continue; }
      return { committed: true };
    }
    throw new Error('maxretry');
  }
}

class SbRef {
  constructor(db, segs) { this._db = db; this._segs = segs; }
  get key() { return this._segs.length ? this._segs[this._segs.length - 1] : null; }
  get parent() { return this._segs.length ? new SbRef(this._db, this._segs.slice(0, -1)) : null; }
  get root() { return new SbRef(this._db, []); }
  child(p) { return new SbRef(this._db, this._segs.concat(splitPath(p))); }
  async once() { return new SbSnapshot(this.key, await this._db._read(this._segs)); }
  async set(value) { await this._db._write(this._segs, 'set', value); }
  async update(obj) { await this._db._update(this._segs, obj); }
  async remove() { await this._db._write(this._segs, 'remove', null); }
  async transaction(fn) { return this._db._transaction(this._segs, fn); }
  orderByChild(child) { return new SbQuery(this._db, this._segs, child); }
}

class SbQuery {
  constructor(db, segs, child) {
    this._db = db; this._segs = segs; this._child = child;
    this._filters = []; this._limitFirst = null; this._limitLast = null;
  }
  equalTo(v) { this._filters.push(['eq', v]); return this; }
  startAt(v) { this._filters.push(['gte', v]); return this; }
  endAt(v) { this._filters.push(['lte', v]); return this; }
  limitToFirst(n) { this._limitFirst = n; return this; }
  limitToLast(n) { this._limitLast = n; return this; }

  _matches(childVal) {
    for (const [mode, v] of this._filters) {
      if (mode === 'eq') { if (childVal !== v) return false; }
      else if (mode === 'gte') { if (childVal === null || childVal === undefined || rtdbCmp(childVal, v) < 0) return false; }
      else if (mode === 'lte') { if (childVal === null || childVal === undefined || rtdbCmp(childVal, v) > 0) return false; }
    }
    return true;
  }

  async once() {
    const r = resolveSegs(this._segs);
    if (r.kind !== 'collection') throw new Error('supabase adapter: query on non-collection ' + this._segs.join('/'));
    const colmap = r.table === 'players' ? PLAYER_QUERY_COLS : WD_QUERY_COLS;
    const col = colmap[this._child];
    let entries = null;
    if (col && this._filters.length === 1 && !this._limitLast) {
      const [mode, v] = this._filters[0];
      const op = mode === 'eq' ? 'eq' : mode === 'gte' ? 'gte' : 'lte';
      let q = '/' + r.table + '?' + col + '=' + op + '.' + encodeURIComponent(String(v)) + '&order=' + col + '.asc&select=id,data';
      if (this._limitFirst) q += '&limit=' + this._limitFirst;
      const rows = await this._db._req('GET', q);
      entries = rows.map((row) => ({ id: row.id, data: row.data }));
    } else {
      const rows = await this._db._readAll(r.table);
      entries = rows
        .map((row) => ({ id: row.id, data: row.data, cv: row.data && typeof row.data === 'object' ? row.data[this._child] : null }))
        .filter((e) => this._matches(e.cv === undefined ? null : e.cv))
        .sort((x, y) => rtdbCmp(x.cv, y.cv));
      if (this._limitFirst) entries = entries.slice(0, this._limitFirst);
      if (this._limitLast) entries = entries.slice(-this._limitLast);
    }
    const out = {};
    for (const e of entries) out[e.id] = e.data;
    return new SbSnapshot(null, Object.keys(out).length ? out : null);
  }
}

/* Dual mode: one database stays the primary (all reads + writes);
   every committed write is mirrored to the other (the shadow).
   'dual' = RTDB primary / Supabase shadow; 'dual_sb' = Supabase
   primary / RTDB shadow (the read-flip phase, so a rollback to
   Firebase loses nothing — RTDB never stopped receiving writes).
   Mirror writes are idempotent by construction (keyed set/update/
   remove, transactions mirror their final value), so retrying one
   can never duplicate an operation. A mirror that still fails after
   bounded retries is counted in shadowFails and logged; the periodic
   reconciler diffs full snapshots and repairs the shadow from the
   primary, so a dropped mirror write is never fatal. */
class DualRef {
  constructor(dual, segs) { this._dual = dual; this._segs = segs; }
  get key() { return this._segs.length ? this._segs[this._segs.length - 1] : null; }
  get parent() { return this._segs.length ? new DualRef(this._dual, this._segs.slice(0, -1)) : null; }
  get root() { return new DualRef(this._dual, []); }
  child(p) { return new DualRef(this._dual, this._segs.concat(splitPath(p))); }
  _real() { const p = this._segs.join('/'); return p ? this._dual.real.ref(p) : this._dual.real.ref(); }
  _shadow() { return this._dual.sb.ref(this._segs.join('/')); }
  async once(ev) { return this._real().once(ev); }
  orderByChild(child) { return this._real().orderByChild(child); }
  async _mirror(fn) {
    const delays = [0, 150, 500, 1500];
    let lastErr = null;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i] + Math.floor(Math.random() * 60)));
      try { await fn(this._shadow()); return; }
      catch (e) { lastErr = e; }
    }
    this._dual.shadowFails++;
    console.error('dual mirror failed on', this._segs.join('/') || '/', '-', lastErr && lastErr.message);
  }
  async set(value) { await this._real().set(value); await this._mirror((s) => s.set(value)); }
  async update(obj) { await this._real().update(obj); await this._mirror((s) => s.update(obj)); }
  async remove() { await this._real().remove(); await this._mirror((s) => s.remove()); }
  async transaction(fn) {
    let lastArg, lastNext, ran = false;
    const wrapped = (cur) => { ran = true; lastArg = cur; const next = fn(cur); lastNext = next; return next; };
    const res = await this._real().transaction(wrapped);
    if (res && res.committed && ran && lastNext !== undefined && lastNext !== lastArg) {
      const value = lastNext;
      await this._mirror((s) => s.set(value));
    }
    return res;
  }
}

class DualDb {
  /* (primary, shadow): reads + writes hit the primary; committed
     writes mirror to the shadow. Field names keep the original
     dual-mode labels: .real = primary, .sb = shadow. */
  constructor(real, sb) { this.real = real; this.sb = sb; this.shadowFails = 0; }
  ref(path) { return new DualRef(this, splitPath(path)); }
}

function createSbDb(restUrl, serviceKey) { return new SbDb(restUrl, serviceKey); }

module.exports = { createSbDb, DualDb, SbDb };
