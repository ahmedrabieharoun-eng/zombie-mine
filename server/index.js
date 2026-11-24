const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const crypto = require('crypto');

/* RTDB port of the Firestore original — same API, same logic, only the
   persistence layer changed (see PORT_NOTES.md for the mapping + caveats).
   The database is initialised lazily on first use so the module still boots
   (and answers auth errors) when the DB env is not configured yet. */
let _rtdb = null;
function initRtdb() {
  if (_rtdb) return _rtdb;
  const url = process.env.FIREBASE_DATABASE_URL || '';
  if (!url) throw new Fail(500, 'Server not configured');
  try {
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault(), databaseURL: url });
    _rtdb = admin.database();
  } catch (e) {
    console.error('db init', e.message);
    throw new Fail(500, 'Server not configured');
  }
  return _rtdb;
}

/* Database backend (Supabase migration, owner order 2026-11-16):
   DB_BACKEND=rtdb (default) uses Firebase RTDB exactly as before;
   'dual' keeps RTDB primary and mirrors every committed write to
   Supabase; 'dual_sb' flips reads to Supabase (primary) while RTDB
   stays on as the write shadow, so rolling back to 'dual'/'rtdb'
   loses nothing; 'supabase' serves everything from Supabase through
   the RTDB-compatible adapter in sb_adapter.js. */
let _backend = null;
function rtdb() {
  if (_backend) return _backend;
  const mode = String(process.env.DB_BACKEND || 'rtdb').toLowerCase();
  if (mode === 'supabase' || mode === 'dual' || mode === 'dual_sb') {
    const { createSbDb, DualDb } = require('./sb_adapter');
    const sb = createSbDb(process.env.SUPABASE_REST_URL || '', process.env.SUPABASE_SERVICE_KEY || '');
    if (mode === 'supabase') _backend = sb;
    else if (mode === 'dual') _backend = new DualDb(initRtdb(), sb);
    else _backend = new DualDb(sb, initRtdb());
    return _backend;
  }
  _backend = initRtdb();
  return _backend;
}

// Hosting env (Render > Environment / secret files):
//   BOT_TOKEN, OWNER_ID, ALLOWED_ORIGIN, TONAPI_KEY, SIG_SECRET (optional),
//   FIREBASE_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS (service-account file)
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const OWNER_ID = String(process.env.OWNER_ID || '');          // your Telegram numeric ID
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const TONAPI_KEY = process.env.TONAPI_KEY || '';               // optional
// Wallet verification (owner order 2026-11-14): payments are confirmed
// on-chain through the TON Center v3 API. The key comes ONLY from the
// TON_API_KEY env var (the owner sets the same key as AdVOLT on Render);
// it is never stored in settings, never sent in any response, and the
// feature works without it (public rate limits only). TON_API_BASE is
// an env override for local testing, mirroring TG_API_BASE below.
const TON_API_KEY = process.env.TON_API_KEY || '';
const TON_API_BASE = (process.env.TON_API_BASE || 'https://toncenter.com/api/v3').replace(/\/+$/, '');
/* Toncenter key pool (owner order 2026-11-15): the owner supplied
   several toncenter API keys so chain reads stop depending on one
   key's rate limit — with thousands of players, a single throttled
   key was slowing wallet binds, hold syncs and verification checks.
   TONCENTER_KEYS env = comma-separated list; the legacy TON_API_KEY
   joins the pool too. tonc() walks the pool round-robin, and a 429
   from one key moves straight to the next: one throttled key must
   never fail a read while other keys are fresh. Keys live ONLY in
   the server env — never in code, never in any response. */
const TONCENTER_KEYS = (() => {
  const list = String(process.env.TONCENTER_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (TON_API_KEY && !list.includes(TON_API_KEY)) list.push(TON_API_KEY);
  return list;
})();
let toncKeyIdx = 0;
function nextToncKey() {
  if (!TONCENTER_KEYS.length) return '';
  const k = TONCENTER_KEYS[toncKeyIdx % TONCENTER_KEYS.length];
  toncKeyIdx = (toncKeyIdx + 1) % TONCENTER_KEYS.length;
  return k;
}

const JETTON = 'EQCY8LnAfr0NMgw0SGBRkSykRuYy5fCkrvu4TUxt_O-FR8mg';
/* Automatic $ZOM payouts (owner order 2026-11-14): when the
   PAYOUT_MNEMONIC env var holds the payout wallet's 24 words, an
   owner-approved withdrawal is paid the net amount in the $ZOM
   jetton by attemptPayout (manual review first — owner order
   2026-11-14 ~07:29). The mnemonic lives ONLY in this env var — it
   is never stored in settings, never logged, never sent anywhere.
   PAYOUT_WALLET_VERSION selects the wallet contract the words open:
   'v5' (WalletContractV5R1, the default) or 'v4'. Unset/invalid
   mnemonic = the feature is off and withdrawals stay fully manual,
   byte-for-byte the old behaviour. */
const PAYOUT_MNEMONIC = String(process.env.PAYOUT_MNEMONIC || '').trim();
const PAYOUT_WALLET_VERSION = String(process.env.PAYOUT_WALLET_VERSION || 'v5').trim().toLowerCase();
const MAX_AUTH_AGE_SEC = 24 * 60 * 60;
const MIN_COLLECT_SEC = 10;
const DAILY = [5, 10, 15, 20, 25, 30, 75, 30, 35, 40, 45, 50, 50, 130, 50, 55, 60, 60, 65, 70, 160, 70, 75, 80, 80, 85, 90, 230, 90, 95, 100, 105, 110, 115, 120, 120, 125, 130, 135, 465];
const DEFAULTS = {
  brandTitle: '$ZOMBIE MINER', coinSym: '$ZOM', taskReward: 20,
  bioReward: 100, refAchReward1: 250, refAchReward10: 500, refAchReward25: 1250, refAchReward50: 2500, refAchReward100: 5000,
  refClaimPercent: 5, refMinHold: 400, minWithdraw: 10000, holdPercentReq: 25, withdrawFeePercent: 5,
  lvl1PerDay: 500, payoutWallet: '', payoutChannel: '@ZOMBI_PAYMENTS', adminChatId: '',
  // Withdrawal-cooldown exemption (owner order 2026-11-14): these
  // Telegram ids never wait the 24 h between withdrawals (the owner
  // + Elshenawy, his tester). settings/global can override the list.
  withdrawCooldownExempt: [6970148965, 1111087186],
  // Owner-only maintenance (owner order 2026-11-14): while
  // settings/global.ownerOnly is true, the API answers 403
  // {maintenance:true} and the bot answers an update notice to
  // everyone except OWNER_ID; the app shows «update in progress».
  // (403, not 503: the app treats 503 as a sleeping-server wake-up
  // and would sit retrying behind the loader instead of showing it.)
  ownerOnly: false,
  // Tester opening (owner order 2026-11-15): while ownerOnly is on,
  // these Telegram ids may ALSO use the app and the bot — the owner
  // is resetting these accounts to zero and re-testing as brand-new
  // users while everyone else keeps seeing «update in progress».
  // settings/global can override the list. Admin tools (/withdrawals,
  // /multi, …) stay strictly OWNER_ID — testers are players.
  testUsers: [],
  // Full admins (owner order 2026-11-15): these Telegram ids are
  // admins alongside the owner — bot admin tools (/withdrawals,
  // /multi, /emojihunt), the withdrawal decision buttons, the in-app
  // admin actions, and every admin notification (verification
  // deposits, payout failures). settings/global can override the list.
  adminUsers: [],
  buySwapUrl: 'https://app.ston.fi/swap?chartVisible=false&tt=EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c&ft=GRAM',
  channel1: 'https://t.me/ZOMBI_UPDATE', channel2: 'https://t.me/ZOMBI_PAYMENTS', channel3: 'https://t.me/ZOMBI_COMMUNITY', botUsername: 'ZOMBIE_MINER_bot', twitterUrl: 'https://x.com/ZOMBIE_MINER',
  // Wallet verification (owner order 2026-11-14): the fee is paid to
  // verifyDepositWallet with the comment ZM-<userNo>.
  // verifyMinAgeDays is LEGACY since 2026-11-17 (owner order):
  // verification is no longer age-gated — a wallet of ANY age can be
  // verified. The wallet-age rule moved to withdrawals, which require
  // the bound wallet to be at least withdrawMinAgeDays old.
  verifyDepositWallet: 'UQBCoy7KjhL9VnKA_YOp4_hxmYKAQ8P8mIfx5FdIdSA6qvxE', verifyFeeTon: 0.05, verifyMinAgeDays: 7, withdrawMinAgeDays: 7,
  // Hold tasks (owner order 2026-11-17): five tiers — hold at least
  // `hold` $ZOM in the bound wallet, claim `reward`. The hold is read
  // FRESH from the chain at claim time and judged as the player's
  // current hold (see holdTask). settings/global can override the defs.
  // Hold-task renewal (owner order 2026-11-19): ONE claim pays the
  // player's highest qualified tier only, and claims renew every
  // holdRenewDays days (shared across all tiers — see holdTask).
  holdRenewDays: 7,
  // Adsgram (owner order 2026-11-19): reward ads in the Tasks page
  // (adReward coins each, at most adDailyLimit per day) plus a forced
  // ad gate on the money buttons (collect / claims / withdraw). A
  // reward is paid ONLY against a server-issued single-use ticket
  // that has aged at least adMinWatchSec — see adTicket / adClaim.
  // adsEnabled = 0 disables the whole system (no tickets issued, no
  // gate required, section hidden) as an emergency valve.
  adsEnabled: 0, adsgramBlockId: '60547', adReward: 10, adDailyLimit: 10, adMinWatchSec: 15, adGateMinSec: 5,
  holdTaskDefs: [ { hold: 2500, reward: 600 }, { hold: 5000, reward: 1000 }, { hold: 10000, reward: 2000 }, { hold: 20000, reward: 3000 }, { hold: 40000, reward: 5000 } ],
  // Holders contest (owner order 2026-11-24): 3-day board of the top 50
  // verified holders; only the top 5 win, paid in USDT to the linked
  // wallet (never in ZOM). contestEndsAt is set when a contest starts.
  contestStartsAt: 0, contestEndsAt: 0, contestPrizes: [70, 50, 40, 15, 15, 15, 15, 10, 10, 10]
};
const NUM_KEYS = ['lvl1PerDay', 'taskReward', 'bioReward', 'refAchReward1', 'refAchReward10', 'refAchReward25', 'refAchReward50', 'refAchReward100', 'refClaimPercent', 'refMinHold', 'minWithdraw', 'holdPercentReq', 'withdrawFeePercent', 'verifyFeeTon', 'verifyMinAgeDays', 'withdrawMinAgeDays', 'holdRenewDays', 'adsEnabled', 'adReward', 'adDailyLimit', 'adMinWatchSec', 'adGateMinSec', ];
const STR_KEYS = ['brandTitle', 'coinSym', 'payoutWallet', 'payoutChannel', 'adminChatId', 'channel1', 'channel2', 'channel3', 'twitterUrl', 'botUsername', 'buySwapUrl', 'verifyDepositWallet', 'adsgramBlockId'];

/* ---------- helpers ---------- */
class Fail extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new Fail(status, msg); };
const dayOf = (ts) => Math.floor(ts / 86400000);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, n);
// Like clean() but preserves newlines — for free-text panel request/reply
// bodies, whose line breaks are part of the formatting (owner order
// 2026-11-18: replies must not collapse into one line).
const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f<>]/g, '').slice(0, n);
const P = (id) => rtdb().ref('players/' + String(id));
const isId = (v) => /^\d{5,15}$/.test(String(v));
const walletDoc = (raw) => rtdb().ref('wallets/' + String(raw).replace(':', '_'));
const sigDoc = (k) => rtdb().ref('sigs/' + String(k).replace(/\//g, '_'));
const getVal = async (ref) => (await ref.once('value')).val();

/* Indexed candidate reads for the background watchers (owner
   load-reduction order 2026-11-15): the verify watcher used to
   download the ENTIRE players node every 10 s and the hold watcher
   on every sweep, just to find a handful of candidates. With
   .indexOn on verifyPendingAt / walletVerified in the RTDB rules,
   these queries are answered server-side and return only the
   candidate records. If a query ever fails (e.g. the index is
   removed from the rules), this returns null and the caller falls
   back to the full read — the watchers keep working either way,
   just heavier. */
async function queryPlayersByChild(child, mode, value) {
  try {
    let q = rtdb().ref('players').orderByChild(child);
    q = mode === 'startAt' ? q.startAt(value) : q.equalTo(value);
    const v = (await q.once('value')).val();
    return v || {};
  } catch (e) { console.error('queryPlayersByChild', child, e.message); return null; }
}

/* RTDB transaction helper replacing db.runTransaction for a single node.
   fn(cur) returns one of:
     { value, out }  -> commit `value` as the node's new content; txUpdate returns `out`
     { skip, out }   -> abort without error (a no-op the caller treats as done); returns `out`
     { error }       -> abort and throw that Fail (same status/message as the Firestore code)
   fn may run several times under contention; only the last run's result counts.

   ROOT-CAUSE FIX (the live "User not found" bug): the JS RTDB client first
   runs the update function against this process's LOCAL view of the node,
   which is null for any node the process has not synced yet — including a
   player that exists on the server (even one created seconds earlier by
   this same process; reproduced against the RTDB emulator). Returning
   undefined on that first pass aborts the transaction locally, BEFORE the
   SDK ever asks the server for the real value, so every "abort" decision
   (the actions' 404 'User not found', adminWd's 404, the banned/skip
   guards) could fire spuriously for a real record. On an abort decision we
   therefore return `cur` itself (identity) instead of undefined: that
   forces the server round-trip — if the view was stale, fn re-runs with
   the real value and decides again; if the value really is what fn saw,
   the commit is a harmless no-op and the recorded decision is applied
   below (throw err / return skip-out), so observable behaviour is
   unchanged while the stale-view false decisions disappear. Value
   decisions were never affected: they always round-tripped and re-ran.

   SECOND HALF of the same bug (intermittent 'User not found' AND
   'Server error' in the wild, typically right after a process
   (re)start): the first local pass can hand fn `undefined` — not null
   — for a node this process has never synced. Every callback is
   written against null, so on undefined it either mis-decided (the
   create-if-absent guards read `cur !== null` as "exists, skip", so
   ensurePlayer created nothing) or crashed dereferencing it
   (`d.banned` on undefined -> a bare 500), and the identity return
   above handed `undefined` back to the SDK, which aborts the
   transaction locally without ever asking the server. txUpdate
   therefore NEVER lets fn see undefined: an undefined pass decides
   nothing and returns null (never undefined) as a probe — the
   compare-and-swap hash check guarantees the probe cannot overwrite
   a real server value; if the server holds one, fn re-runs against
   it inside the same transaction. If fn never ran against a
   server-confirmed value at all (the node was truly empty and the
   probe committed), the decision is taken afterwards on a direct
   read, and a value decision is committed by one recursive pass —
   the read has synced the node, so fn runs against the real value
   there. Net effect: 'record missing' is only ever decided on a
   value the server confirmed, so a legitimate ensured player can
   no longer surface a spurious 404/500 from a stale local view.

   THIRD hardening (live incident 2026-11-14, player 1915163030):
   the compat SDK's own transaction loop gives up under contention
   and throws `Error: maxretry` (stack: repoRerunTransactionQueue).
   Whole-player-record transactions starve whenever the same record
   absorbs frequent small writes (state's lastSeen refresh, hold
   syncs, multiLinks), so a verifyCheck claim/flip could lose the
   race repeatedly and surface as a bare 500 'Server error' — the
   player's real, correctly-commented payment sat unclaimed while
   every retry from the app hit the same wall. txUpdate (below) now
   retries the WHOLE attempt when — and only when — the failure is
   a maxretry abort: up to 5 attempts total with growing delays.
   A maxretry abort means the transaction never committed, so
   re-running fn from scratch is exactly as safe as the SDK's own
   internal re-runs; every other error keeps the behaviour it has
   always had (thrown on first sight). */
async function txUpdateOnce(ref, fn, _depth = 0) {
  let out, err = null, skip = false, decided = false;
  const res = await ref.transaction((cur) => {
    if (cur === undefined) return null; // unseen locally != missing: probe, decide nothing (see above)
    decided = true;
    const r = fn(cur) || {};
    if (r.error || r.skip) { err = r.error || null; skip = !!r.skip; out = r.out; return cur; }
    skip = false; err = null; out = r.out;
    return r.value;
  });
  if (!decided) {
    if (_depth >= 1) throw new Fail(500, 'Server error'); // still undecided after a confirmed read: a genuine fault, not a stale view
    const cur = await getVal(ref);
    const r = fn(cur) || {};
    if (r.error) throw r.error;
    if (r.skip) return r.out;
    return txUpdateOnce(ref, fn, _depth + 1);
  }
  if (err) throw err;
  if (skip) return out;
  if (!res.committed) throw new Fail(500, 'Server error');
  return out;
}

const TX_MAXRETRY_DELAYS = [150, 350, 700, 1200]; // ms before retries 1..4 (±25% jitter) — 5 attempts total
const isMaxRetryError = (e) => /maxretry/i.test(String((e && (e.message || e.code)) || ''));
const txSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function txUpdate(ref, fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await txUpdateOnce(ref, fn, 0); }
    catch (e) {
      if (!isMaxRetryError(e) || attempt >= TX_MAXRETRY_DELAYS.length) throw e;
      const delay = Math.round(TX_MAXRETRY_DELAYS[attempt] * (0.75 + Math.random() * 0.5));
      const tail = ((ref.parent && ref.parent.key) ? ref.parent.key + '/' : '') + (ref.key || '');
      console.error('txUpdate maxretry on ' + tail + ' — retry ' + (attempt + 1) + '/' + TX_MAXRETRY_DELAYS.length + ' in ' + delay + 'ms');
      await txSleep(delay);
    }
  }
}

/* Increment one key of meta/counters atomically and return its new
   value. Routed through txUpdate so the counters inherit the
   unseen-node hardening above — the raw ref.transaction calls this
   replaces computed from the (possibly unseen) local view and never
   checked that the result had actually committed. */
async function bumpCounter(key) {
  return txUpdate(rtdb().ref('meta/counters'), (cur) => {
    const base = (cur && typeof cur === 'object') ? cur : {};
    const v = { ...base, [key]: (Number(base[key]) || 0) + 1 };
    return { value: v, out: v[key] };
  });
}

/* ---------- multi-account signals: for owner review only, nothing is blocked ---------- */
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return String(xf.length ? xf[xf.length - 1] : req.ip || '').replace(/[^0-9a-fA-F:.]/g, '').slice(0, 45);
}
function clientKeys(fp) {
  if (!fp || typeof fp !== 'object') return [];
  const keys = [];
  const cid = String(fp.cid || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (cid.length >= 8) keys.push('cid:' + cid);
  if (typeof fp.dev === 'string' && fp.dev) keys.push('dev:' + crypto.createHash('sha256').update(fp.dev.slice(0, 400)).digest('hex').slice(0, 16));
  const m = /(Telegram[\w-]*)\/([\d.]+)/i.exec(String(fp.ua || ''));
  keys.push('cl:' + clean(fp.tgp, 20) + '/' + clean(fp.tgv, 10) + (m ? '+' + m[1].slice(0, 24) + '/' + m[2].slice(0, 12) : ''));
  return keys;
}
const hashIp = (ip) => crypto.createHmac('sha256', process.env.SIG_SECRET || BOT_TOKEN || 'x').update(String(ip)).digest('hex').slice(0, 16);
const seenSig = new Map();
async function noteSignals(uid, keys) {
  const seen = seenSig.get(uid) || new Set();
  seenSig.set(uid, seen);
  const fresh = keys.filter((k) => k && !seen.has(k));
  if (!fresh.length || seen.size >= 60) return;
  fresh.forEach((k) => seen.add(k));
  if (seenSig.size > 50000) seenSig.clear();
  try {
    // Firestore original: one write batch (player sigs arrayUnion + one sigs
    // doc arrayUnion per non-cl key). RTDB has no arrayUnion, so: read the
    // current arrays, merge in code, write everything in ONE atomic
    // multi-path update (see PORT_NOTES.md for the race caveat).
    const db = rtdb();
    const docKeys = fresh.filter((k) => !k.startsWith('cl:')).map((k) => k.replace(/\//g, '_'));
    const [mySigs, ...sigUsers] = await Promise.all([
      getVal(db.ref('players/' + uid + '/sigs')),
      ...docKeys.map((dk) => getVal(db.ref('sigs/' + dk + '/users')))
    ]);
    const updates = {};
    updates['players/' + uid + '/sigs'] = [...new Set([...(mySigs || []), ...fresh])];
    docKeys.forEach((dk, i) => {
      const users = sigUsers[i] || [];
      if (!users.includes(String(uid))) updates['sigs/' + dk + '/users'] = [...users, String(uid)];
    });
    await db.ref().update(updates);
  } catch (e) { console.error('signals', e.message); }
}
/* A referral counts as ACTIVE only while BOTH activation conditions
   hold (owner orders 2026-11-14 + 2026-11-15): the invitee's wallet is
   VERIFIED (the 0.05 TON verification) AND his synced hold meets
   refMinHold (200 $ZOM = Level 2). The state is LIVE, not a latch:
   syncReferralActive() re-evaluates it after every wallet sync,
   verification completion and unlink — buying + verifying flips the
   inviter's entry to 'Verified ✅' and starts the 5% commission, and
   selling below the minimum (or losing verification) flips it back to
   'Pending ⏳' and pauses the commission. '⚠️ Duplicate' entries never
   flip either way and never count. */
const ACTIVE_REF_STATUS = 'Verified ✅';
const countActiveRefs = (refs) => Object.values(refs || {}).filter((r) => r && String(r.status || '').trim() === ACTIVE_REF_STATUS).length;
const publicPlayer = (d) => {
  const o = { ...(d || {}) };
  delete o.sigs;
  delete o.multiLinks; // owner-only detection data (adminState + /multi) — never shown to the player
  // ads were removed from the app (owner order): the stored counters stay in
  // the DB as inert data but are no longer exposed to the client
  delete o.adsWatched;
  delete o.lastAdUtcDay;
  delete o.lastAdAt;
  o.referrals = (o.referrals || []).map((r) => { const x = { ...r }; delete x.deviceHash; x.verified = x.verified === true; x.avatar = (Number(x.avatar) >= 1 && Number(x.avatar) <= 8) ? Number(x.avatar) : 0; return x; });
  o.avatar = (Number(o.avatar) >= 1 && Number(o.avatar) <= 8) ? Number(o.avatar) : 0; // chosen painted avatar (owner order 2026-11-14); 0 = not chosen yet
  // additive fields for the bio task + referral achievements (tasks tab)
  o.bioTaskDone = o.bioTaskDone === true;
  o.refAchClaimed = (o.refAchClaimed && typeof o.refAchClaimed === 'object') ? o.refAchClaimed : {};
  o.activeRefs = countActiveRefs(o.referrals);
  // wallet verification (owner order 2026-11-14): userNo is the player's
  // permanent sequential number (0 until assigned — see assignUserNo);
  // referrals entries above carry the invitee's `verified` flag, kept in
  // sync by syncRefVerifiedFlag at verify/void time.
  o.userNo = Number(o.userNo) || 0;
  o.walletVerified = o.walletVerified === true;
  o.verifiedWallet = o.verifiedWallet || '';
  o.verifiedAt = Number(o.verifiedAt) || 0;
  return o;
};
const WHY = { cid: 'نفس نسخة التطبيق', dev: 'نفس الجهاز' }; // no 'ip' label: a shared IP never explains a link (owner order 2026-11-14, round 2)
const LIMIT = { cid: 50, dev: 6, ip: 5 }; // signals shared by more accounts than this are treated as common (CGNAT, same phone model)
async function riskOf(uid) {
  const me = (await getVal(P(uid))) || {};
  const mine = me.sigs || [];
  const keys = mine.filter((k) => !k.startsWith('cl:')).slice(0, 40);
  const docs = await Promise.all(keys.map((k) => getVal(sigDoc(k))));
  const linked = {}, any = {};
  docs.forEach((data, i) => {
    if (!data) return;
    const kind = keys[i].split(':')[0];
    const users = (data.users || []).filter((x) => x !== String(uid));
    users.forEach((u) => { (any[u] = any[u] || new Set()).add(kind); }); // also counts common signals, used only for referral relations
    // A shared IP is NEVER a link (owner order 2026-11-14, round 2):
    // carrier NAT / shared Wi-Fi put strangers behind one address.
    // ip: keys are still recorded and still feed the player's OWN
    // «used N different IPs» reason further down — they just never
    // put another account into `linked`, at any level (and so never
    // into strong/rank/level, which all derive from `linked`).
    if (kind === 'ip') return;
    if (!users.length || users.length > (LIMIT[kind] || 0)) return;
    users.forEach((u) => { (linked[u] = linked[u] || new Set()).add(kind); });
  });
  const ids = Object.keys(linked);
  const rank = (u) => (linked[u].has('cid') ? 3 : linked[u].has('dev') ? 2 : 1);
  const strong = ids.filter((u) => linked[u].has('cid') || linked[u].size >= 2).length;
  const devLinks = ids.filter((u) => linked[u].has('dev')).length;
  const inviterLink = me.invitedBy && linked[String(me.invitedBy)];
  const invLinks = (me.referrals || []).filter((r) => linked[String(r.id)]).length;
  const times = (me.referrals || []).map((r) => r.at).filter(Boolean).sort((a, b) => a - b);
  let burst = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[i] - times[j] > 600000) j++; burst = Math.max(burst, i - j + 1); }
  const clients = mine.filter((k) => k.startsWith('cl:')).length;
  const ips = mine.filter((k) => k.startsWith('ip:')).length;
  const reasons = [];
  if (ids.length) reasons.push('مرتبط بـ ' + ids.length + ' حساب تاني');
  if (inviterLink) reasons.push('مرتبط بالحساب اللي دعاه (' + [...inviterLink].map((k) => WHY[k]).join('، ') + ')');
  if (invLinks) reasons.push(invLinks + ' من اللي دعاهم مرتبطين بيه');
  if (burst >= 4) reasons.push(burst + ' إحالات دخلت خلال 10 دقايق');
  if (clients >= 3) reasons.push('دخل من ' + clients + ' نسخ/أنظمة تيلجرام مختلفة');
  if (ips >= 5) reasons.push('استخدم ' + ips + ' عناوين IP مختلفة (احتمال VPN)');
  const hasDev = (u) => !!(linked[String(u)] && linked[String(u)].has('dev'));
  const hasDevAny = (u) => !!(any[String(u)] && any[String(u)].has('dev'));
  const relDev = hasDev(me.invitedBy) || (me.referrals || []).some((r) => hasDev(r.id));
  const relCommon = hasDevAny(me.invitedBy) || (me.referrals || []).some((r) => hasDevAny(r.id));
  if (relDev) reasons.push('نفس الجهاز مع حساب مرتبط بيه بالإحالة (دعاه أو دعاه هو)');
  else if (relCommon) reasons.push('نفس نوع الجهاز مع حساب مرتبط بيه بالإحالة (ممكن يكون صدفة لو الجهاز منتشر)');
  const level = strong > 0 || devLinks >= 3 || relDev ? 'high' : devLinks > 0 || relCommon || ids.length >= 3 || inviterLink || invLinks || burst >= 4 ? 'medium' : 'low';
  const top = ids.sort((a, b) => rank(b) - rank(a)).slice(0, 8);
  const rows = await Promise.all(top.map(async (id) => {
    const d = (await getVal(P(id))) || {};
    return { id, name: d.name || '', mined: d.mined || 0, banned: d.banned === true, verified: d.walletVerified === true, via: [...linked[id]].map((k) => WHY[k]) };
  }));
  return { level, reasons, linked: rows };
}

/* ---------- multi-account links: REPORT-ONLY (owner order) ----------
   Detection and storage ONLY — NO notifications: the proactive
   new-link alert DMs were removed entirely by owner order 2026-11-14;
   the links accumulate silently in player.multiLinks and the owner
   inspects them on demand with the /multi bot command (see multiTree
   below). Nothing here bans, blocks or delays any action: state()
   calls updateMultiLinks() inside a try/catch after its main work,
   and the stored `banned` flag is never touched by this code.

   The detection itself is a faithful port of the AdVOLT anti-fraud
   system (lux_v5/send_worker_v802.js, checkAntiFraud + helpers) — the
   owner ordered THE SAME system here, with exactly one difference:
   where the old build blocks the later account (blockNow), ZOMBIE RECORDS a
   link to the device owner in player.multiLinks.

   How it works (identical to VOLT):
   - The client sends a persistent random deviceId (stored on the device
     itself: localStorage + cookie + IndexedDB), a combined device
     fingerprint, and five individually hashed hardware signals
     (canvas/webgl/hardware/fonts/audio) — see AntiFraud in the frontend.
   - Layer 1 (primary): the deviceId registry deviceIds/{deviceId}. The
     first account to present a deviceId owns its record (with its
     signals stored); a DIFFERENT account presenting the same deviceId
     is linked to that owner.
   - Layer 2: the fingerprint registry devices/{fp}. A different account
     with the same combined fingerprint links ONLY if it is a legacy
     client with no deviceId (VOLT's original strict rule), or — the
     v800 rule — ALL FIVE of its signal hashes exactly match the signals
     stored under the fingerprint owner's deviceId record (same hardware
     behind a regenerated deviceId). A fingerprint match without the
     full signal match is noted as sharedSeen on the record, nothing
     more: identical phone models share fingerprints innocently.
   - IP addresses, the legacy sigs keys (cid:/dev:/ip:) and deviceHash
     play NO role in linking (VOLT never uses IPs for the decision; the
     old loose rule that linked on any shared sig key produced a
     live false positive between two strangers sharing carrier-NAT IPs
     and was removed entirely — see MULTI_FIX_REPORT.md).
   - Registry read failures fail OPEN (no link), exactly like VOLT: a
     database hiccup must never flag an innocent account. */
const AF_SIGNAL_KEYS = ['canvasHash', 'webglHash', 'hardwareHash', 'fontsHash', 'audioHash'];
function afSanitiseKey(str, maxLen = 64) {
  if (typeof str !== 'string') return null;
  const clean = str.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, maxLen);
  return clean.length >= 8 ? clean : null;
}
function afSanitiseSignals(sig) {
  if (!sig || typeof sig !== 'object') return null;
  const out = {};
  for (const k of AF_SIGNAL_KEYS) out[k] = afSanitiseKey(sig[k], 80);
  return out;
}
function afSanitiseFlags(f) {
  if (!f || typeof f !== 'object') return null;
  return { headless: !!f.headless, emulator: !!f.emulator, devtools: !!f.devtools };
}
function afSignalsFullMatch(a, b) {
  if (!a || !b) return false;
  for (const k of AF_SIGNAL_KEYS) {
    if (!a[k] || !b[k] || a[k] !== b[k]) return false;
  }
  return true;
}
function afOwnerOf(record) {
  if (!record) return null;
  const o = record.owner ?? record.firstTelegramId;
  return o ? String(o) : null;
}
const MULTI_IDS_CAP = 50;
/* Returns the device-owner account ids this account is linked to under
   the VOLT rules above (usually 0 or 1). Registration side effects are
   VOLT's: first presenter of a deviceId / fingerprint writes its record. */
async function detectDeviceLinks(uid, body) {
  const tid = String(uid);
  const fp = afSanitiseKey(body && body._deviceFingerprint, 64);
  const did = afSanitiseKey(body && body._deviceId, 64);
  const linked = new Set();
  if (!fp && !did) return [];
  const db = rtdb();

  // Layer 1 — deviceId registry (primary identity, as in VOLT)
  if (did) {
    let didRecord = null, readOk = true;
    try { didRecord = await getVal(db.ref('deviceIds/' + did)); } catch (e) { readOk = false; }
    if (readOk) {
      const didOwner = afOwnerOf(didRecord);
      if (!didOwner) {
        try {
          await db.ref('deviceIds/' + did).set({
            owner: tid, ts: Date.now(), fingerprint: fp || null,
            signals: afSanitiseSignals(body && body._afSignals),
            flags: afSanitiseFlags(body && body._afFlags),
          });
        } catch (e) { /* registration is best-effort, as in VOLT */ }
      } else if (didOwner !== tid) {
        linked.add(didOwner); // old build: blockNow(didOwner, 'deviceId') → ZOMBIE: record the link
      }
    }
  }

  // Layer 2 — combined fingerprint registry (VOLT's original system + v800 rule)
  if (fp) {
    let record = null, readOk = true;
    const fpRef = db.ref('devices/' + fp);
    try { record = await getVal(fpRef); } catch (e) { readOk = false; }
    if (readOk) {
      const owner = afOwnerOf(record);
      if (!owner) {
        try { await fpRef.set({ owner: tid, ts: Date.now(), deviceId: did || null }); } catch (e) { /* best-effort */ }
      } else if (owner !== tid) {
        if (!did) {
          linked.add(owner); // legacy client, no deviceId: VOLT blocks via 'fingerprint' → record the link
        } else {
          const mySignals = afSanitiseSignals(body && body._afSignals);
          const ownerDid = afSanitiseKey(record.deviceId, 64);
          let matched = false;
          if (mySignals && ownerDid) {
            try {
              const ownerDidRec = await getVal(db.ref('deviceIds/' + ownerDid));
              if (ownerDidRec && afSignalsFullMatch(mySignals, ownerDidRec.signals)) matched = true;
            } catch (e) { /* a failed read never flags anyone (VOLT) */ }
          }
          if (matched) {
            linked.add(owner); // VOLT v800: blockNow(owner, 'fingerprint_signals') → record the link
          } else if (record.sharedSeen !== tid) {
            // Fingerprint collision without a full signal match: VOLT only
            // notes it on the record for review — no block, no link.
            try { await fpRef.update({ sharedSeen: tid, sharedSeenAt: Date.now() }); } catch (e) { /* best-effort */ }
          }
        }
      }
    }
  }
  return [...linked];
}
async function updateMultiLinks(uid, body) {
  const ref = P(uid);
  const me = await getVal(ref);
  if (!me) return;
  const ids = (await detectDeviceLinks(uid, body)).sort().slice(0, MULTI_IDS_CAP);
  /* Contention diet (round 3, incident 2026-11-14): when the stored
     v2 set already equals the merged set (same ids, same count),
     skip the write ENTIRELY — do not even start the transaction.
     The in-transaction skip further down still ran ref.transaction
     on the whole player node, and under a burst of small writes to
     that record the compat SDK aborted it with 'maxretry' (16 log
     lines in the incident window) over a write that would have
     changed nothing. This pre-check uses the record read above and
     mirrors the union rule exactly; the in-transaction check stays
     as the race-safe authority whenever this read was stale in a
     way that matters (anything not already in the stored set still
     goes through the transaction). */
  const storedML = (me.multiLinks && Array.isArray(me.multiLinks.ids)) ? [...new Set(me.multiLinks.ids.map(String))].sort() : null;
  if (storedML && me.multiLinks.v === 2) {
    const mergedPre = [...new Set([...storedML, ...ids])].sort();
    if (mergedPre.length === storedML.length && mergedPre.every((x, i) => x === storedML[i])) return; // unchanged: no write at all
  }
  /* Persist + decide what is "fresh" INSIDE one transaction on the player
     node, against the freshest stored list:
     - concurrent state calls for the same user merge against the
       committed list, so no detected link is ever lost to a race — the
       loser's transaction re-runs against the winner's stored list;
     - a pair can only ever re-enter as "fresh" after it fully cleared
       from the stored list in between (a genuine unlink under this
       system, e.g. the device record changed hands) — never from a
       toggling computation.
     (The pre-port rule flapped exactly here: its link set was computed
     from the read-merge-write sigs arrays, and a concurrently dropped
     array entry toggled the set at 03:08 and 03:11 after the first
     sightings at 03:05/03:06. The registry records used now are
     single-owner writes that are never merged, so the computed set is
     stable as well.) */
  await txUpdate(ref, (cur) => {
    if (cur === null) return { skip: true, out: { fresh: [] } };
    const stored = (cur.multiLinks && Array.isArray(cur.multiLinks.ids)) ? cur.multiLinks.ids.map(String) : null;
    const storedV2 = !!(cur.multiLinks && cur.multiLinks.v === 2);
    /* Accumulate, never oscillate. Records written by THIS system carry
       v:2 and only ever GROW (union of stored + freshly detected): the
       detection answers "which device owners has this account ever been
       seen sharing a device with", and the answer for a given call
       depends on which deviceId the user happened to present THIS time
       — a user alternating between two shared devices would otherwise
       toggle the stored set on every call and re-alert on every toggle
       (the same flap shape as the old rule, different mechanism). VOLT
       has no such flap because its registries and block records are
       append-only; the stored list here is append-only too.
       Records WITHOUT v:2 were written by the removed loose rule and are
       REPLACED by the fresh computation exactly once — that is the heal
       that wipes the old false links (e.g. the two live accounts flagged
       over shared carrier IPs) on their first state call under this
       system; from then on their records are v:2 like everyone else's. */
    const merged = (storedV2 && stored) ? [...new Set([...stored, ...ids])].sort() : ids;
    const changed = stored === null || stored.length !== merged.length || stored.some((x, i) => x !== merged[i]);
    if (!changed && storedV2) return { skip: true, out: { fresh: [] } }; // nothing new: no write churn
    const fresh = merged.filter((id) => !(stored || []).includes(id));
    return { value: { ...cur, multiLinks: { count: merged.length, ids: merged, updatedAt: Date.now(), v: 2 } }, out: { fresh } };
  });
  /* Owner order 2026-11-14: NO message is sent when new links form.
     The proactive «تعدد حسابات — روابط جديدة» DM that used to be
     dispatched here is removed entirely — the stored links above are
     the whole feature now, and the owner reads them on demand with
     the /multi command (see multiTree). */
}

/* ---------- owner-only /multi <telegramId>: the link tree, on demand ----
   (Owner order 2026-11-14; replaces the proactive new-link alerts.)
   Dispatched from handleOwnerTools under the same admin gate
   (isAdminUid: owner + settings/global.adminUsers) as /emojihunt; anyone else's /multi falls through untouched
   and is silently ignored by the normal message handling.

   The stored multiLinks lists are ASYMMETRIC: a later account lists
   the device owner it linked to, while that owner's own list can be
   empty (live example: two players sharing one device each list
   Elshenawy, whose own list is empty). A player's links are therefore
   its multiLinks.ids PLUS every player whose ids contain it, and the
   tree is the whole connected cluster collected by BFS over both
   directions. Each non-queried account is shown with the reason for
   its link to the account it was reached through (the queried
   account for direct links), read off the two stored records:
   same deviceHash > shared dev: signal > shared cid: signal >
   a recorded link the stored signals no longer explain. A shared
   ip: signal NEVER explains a link (owner order 2026-11-14,
   round 2) — it falls through to «رابط مسجل» like any other
   unexplained stored link. Nothing here writes anything — it is
   a pure read. */
const MULTI_LIST_CAP = 40;
const sigSetOf = (p, prefix) => new Set((Array.isArray(p && p.sigs) ? p.sigs : []).filter((s) => typeof s === 'string' && s.startsWith(prefix)));
function linkReason(a, b) {
  const dhA = String((a && a.deviceHash) || ''), dhB = String((b && b.deviceHash) || '');
  if (dhA && dhB && dhA === dhB) return 'نفس الجهاز';
  for (const [prefix, label] of [['dev:', 'نفس بصمة الجهاز'], ['cid:', 'نفس تثبيت تيليجرام']]) {
    const mine = sigSetOf(a, prefix);
    if (!mine.size) continue;
    for (const s of sigSetOf(b, prefix)) if (mine.has(s)) return label;
  }
  return 'رابط مسجل';
}
async function multiTree(chatId, arg) {
  try {
    if (!/^\d+$/.test(String(arg || ''))) {
      await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: 'ℹ️ الاستخدام: /multi <رقم حساب التيليجرام> — مثال: <code>/multi 1915163030</code>' });
      return;
    }
    const target = String(arg);
    const players = (await getVal(rtdb().ref('players'))) || {};
    if (!players[target]) {
      await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `ℹ️ الحساب <code>${esc(target)}</code> مش موجود في اللعبة.` });
      return;
    }
    const idsOf = (p) => (p && p.multiLinks && Array.isArray(p.multiLinks.ids)) ? p.multiLinks.ids.map(String) : [];
    const listedBy = new Map(); // id -> uids whose stored list contains that id
    for (const [uid, p] of Object.entries(players)) {
      for (const id of idsOf(p)) {
        if (!listedBy.has(id)) listedBy.set(id, []);
        listedBy.get(id).push(uid);
      }
    }
    const neighborsOf = (uid) => [...new Set([...idsOf(players[uid]), ...(listedBy.get(uid) || [])])]
      .filter((id) => id !== uid && players[id]).sort();
    // BFS: the queried account first, then its direct links, then the
    // rest of the cluster. parent = the account each node was first
    // reached through.
    const parent = new Map([[target, null]]);
    const order = [target];
    for (let i = 0; i < order.length; i++) {
      for (const nb of neighborsOf(order[i])) {
        if (!parent.has(nb)) { parent.set(nb, order[i]); order.push(nb); }
      }
    }
    const fmtPlayer = (uid) => {
      const p = players[uid] || {};
      return `<b>${esc(p.name || '—')}</b>${p.username ? ' (@' + esc(p.username) + ')' : ''} — <code>${esc(uid)}</code>`;
    };
    const verOf = (p) => (p && p.walletVerified === true) ? 'موثّق ✅' : 'غير موثّق';
    const shown = order.slice(0, MULTI_LIST_CAP);
    const lines = shown.map((uid) => {
      if (uid === target) return `• ${fmtPlayer(uid)} ⬅️ <b>الحساب المطلوب</b> — ${verOf(players[uid])}`;
      const par = parent.get(uid);
      const via = par && par !== target ? ` (عن طريق <code>${esc(par)}</code>)` : '';
      return `• ${fmtPlayer(uid)} — ${verOf(players[uid])} — الربط: ${linkReason(players[uid], players[par])}${via}`;
    });
    let text = order.length > 1
      ? `⚠️ <b>الحساب ده عامل تعدد — مرتبط بـ ${order.length - 1} حساب</b>\n\n🌳 <b>شجرة الحسابات المرتبطة:</b>\n${lines.join('\n')}`
      : `✅ <b>الحساب ده مش مرتبط بأي حساب تاني</b>\n\n${lines.join('\n')}`;
    if (order.length > shown.length) text += `\n… ولسه فيه ${order.length - shown.length} حساب تاني في الشجرة`;
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text });
  } catch (e) {
    // The command must never throw the webhook: log + a short reply.
    console.error('multi', e.message);
    try { await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: '❌ حصلت مشكلة وأنا بجيب شجرة الحسابات، جرّب تاني.' }); } catch (e2) { /* a failed error reply must not throw either */ }
  }
}

let cfgCache = null;
// Who may pass the ownerOnly maintenance gate: the owner, plus any
// Telegram id on the settings/global.testUsers list.
function isTesterUid(uid, cfg) {
  if (OWNER_ID && String(uid) === OWNER_ID) return true;
  const list = (cfg && Array.isArray(cfg.testUsers)) ? cfg.testUsers : [];
  if (list.map(String).includes(String(uid))) return true;
  return isAdminUid(uid); // admins always pass the maintenance gate too
}

// Full admins (owner order 2026-11-15): the owner plus any Telegram id
// on settings/global.adminUsers. Reads the cached config — async
// callers refresh it first via getConfig().
function isAdminUid(uid) {
  if (OWNER_ID && String(uid) === OWNER_ID) return true;
  const list = (cfgCache && cfgCache.v && Array.isArray(cfgCache.v.adminUsers)) ? cfgCache.v.adminUsers : [];
  return list.map(String).includes(String(uid));
}

// Everyone who receives admin notifications, owner first, deduped.
function adminChatIds() {
  const ids = [];
  if (OWNER_ID) ids.push(String(OWNER_ID));
  const list = (cfgCache && cfgCache.v && Array.isArray(cfgCache.v.adminUsers)) ? cfgCache.v.adminUsers : [];
  for (const x of list) { const s = String(x); if (!ids.includes(s)) ids.push(s); }
  return ids;
}

const CONFIG_CACHE_MS = (() => { const v = Number(process.env.CONFIG_CACHE_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 60000; })(); // config cache TTL (owner load-reduction order 2026-11-15): settings change rarely; a Firebase-side edit applies within this window. Money values are NEVER cached — this covers config only.
async function getConfig() {
  if (cfgCache && Date.now() - cfgCache.t < CONFIG_CACHE_MS) return cfgCache.v;
  const s = await getVal(rtdb().ref('settings/global'));
  const v = { ...DEFAULTS, ...(s || {}) };
  delete v.botToken;
  cfgCache = { t: Date.now(), v };
  await loadHarvestedEmoji(); // the harvested premium-emoji map rides the same refresh cycle
  return v;
}
const PUBLIC_KEYS = ['brandTitle', 'coinSym', 'taskReward', 'bioReward', 'refAchReward1', 'refAchReward10', 'refAchReward25', 'refAchReward50', 'refAchReward100', 'refClaimPercent', 'refMinHold', 'minWithdraw', 'holdPercentReq', 'withdrawFeePercent', 'withdrawMinAgeDays', 'lvl1PerDay', 'buySwapUrl', 'channel1', 'channel2', 'channel3', 'twitterUrl', 'botUsername', 'holdTaskDefs', 'holdRenewDays', 'adsEnabled', 'adsgramBlockId', 'adReward', 'adDailyLimit', 'contestStartsAt', 'contestEndsAt', 'contestPrizes'];
const publicConfig = (c) => Object.fromEntries(PUBLIC_KEYS.map((k) => [k, c[k]]));

// simple in-memory rate limiter (per server instance)
const hits = new Map();
function hit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 20000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 120000) hits.delete(k);
  return true;
}
// verifyInfo/verifyCheck get 20/min (not the usual single digits): both
// are read-only or claim-guarded, and the Profile card BY DESIGN polls
// verifyCheck 6x at 5s intervals after a TonConnect payment — one poll
// burst plus a manual re-check must fit with room to spare, or the user
// hits this limiter for doing exactly what the UI told them to do. The
// global per-user (240/min) and per-IP caps still bound abuse.
const ACTION_LIMIT = { state: 60, collect: 6, daily: 6, task: 8, taskX: 8, taskXVisit: 8, holdTask: 8, bioTask: 8, refAch: 8, wallet: 8, unlink: 6, refCollect: 6, withdraw: 4, verifyInfo: 20, verifyCheck: 20, setAvatar: 8, adTicket: 6, adClaim: 6, adNoFill: 6, contest: 12, contestMe: 6 }; // per user per minute

function verifyInitData(initData) {
  if (!BOT_TOKEN) return { error: 'config' };
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 4096) return { error: 'invalid' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { error: 'invalid' };
  params.delete('hash');
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), expected)) return { error: 'invalid' };
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SEC) return { error: 'expired' };
  try {
    const user = JSON.parse(params.get('user'));
    if (!user || !user.id) return { error: 'invalid' };
    return { user, startParam: params.get('start_param') || '', authDate };
  } catch (e) { return { error: 'invalid' }; }
}

/* ---------- Telegram Premium (custom) emoji — ported from the AdVOLT
   messages bot (volt_messages_bot.js): the owner's own icon packs
   (TONEmoji + NewsEmoji) and substitution table, copied verbatim.
   Applied centrally in tg() for sendMessage text and sendPhoto
   captions below; on a Telegram emoji/icon rejection the send
   retries once fully stripped. */
// ─── Telegram Premium (custom) emoji ─────────────────────────────
// Owner-chosen packs (2026-11-21): ZombieHandEmoji + Emoji_fan37
// (t.me/addemoji/ZombieHandEmoji, t.me/addemoji/Emoji_fan37_by_TgEmodziBot).
// pz() wraps every matched emoji char in a
// <tg-emoji> tag inside HTML messages; if Telegram rejects a send
// (e.g. the bot owner's account has no Premium), callers fall back to
// the plain text via pzStrip() — no message is ever lost.
const PREMIUM_EMOJI = {
  '🧟\u200d♀️': '5391345899752398927',
  '🧟\u200d♂️': '5391345899752398927',
  '🧟': '5391345899752398927',
  '👍': '5393544437676646719',
  '👇': '5256221151968895599',
  '👆': '5256032594314667578',
  '👉': '5256260442329719686',
  '💵': '5390873668098204548',
  '💸': '5390873668098204548',
  '❤️': '5391252286645215101',
  '❤': '5391252286645215101',
  '👏': '5393172897235739796',
  '👁️': '5390996521342737835',
  '👁': '5390996521342737835',
  '💀': '4958593954309211065',
  '⚰️': '4958724224962265918',
  '⚰': '4958724224962265918',
  '🪦': '4956214142995268150',
  '🦴': '4956357289960276851',
  '👑': '4956420911310832630',
  '💰': '4958926882994127612',
  '🪙': '4958926882994127612',
  '✅': '4956721670690702265',
  '✔️': '4956721670690702265',
  '✔': '4956721670690702265',
  '❌': '4958526153955476488',
  '🛡️': '4958900559139570572',
  '🛡': '4958900559139570572',
  '🌙': '4958941455818163141',
  '🔥': '4956499161319998529',
  '👻': '4956285860359177035',
  '💎': '4956739572114392015',
  '⚡️': '4958479549265347295',
  '⚡': '4958479549265347295',
  '☠️': '4956461073550017373',
  '☠': '4956461073550017373',
  '🎁': '4958699241137505132',
  '⭐️': '4958714479681471536',
  '⭐': '4958714479681471536',
  '🧠': '4958937938239947673',
  '🎉': '4956308456182121758',
  '⚠️': '4956611513369494230',
  '⚠': '4956611513369494230',
  '🚫': '4956337889593000947',
  '🔄': '4956371914323920049',
  '🔴': '4956395910306202687',
  '🟢': '4958920483492857102',
};
const PREMIUM_KEYS = Object.keys(PREMIUM_EMOJI).sort((a, b) => b.length - a.length);
// Near-match substitutions (owner order 2026-11-11): bot emojis with no exact sticker in the
// NewsEmoji/TONEmoji packs are rendered with the closest-looking pack sticker instead.
// orig char -> [display char, custom_emoji_id]
const PREMIUM_SUBS = {}; // ZOMBIE: no near-match subs — PREMIUM_EMOJI maps every used char directly.
const PREMIUM_SUB_KEYS = Object.keys(PREMIUM_SUBS).sort((a, b) => b.length - a.length);
function pz(text) {
  let out = text;
  for (const ch of PREMIUM_KEYS) {
    if (out.indexOf(ch) === -1) continue;
    out = out.split(ch).join('<tg-emoji emoji-id="' + PREMIUM_EMOJI[ch] + '">' + ch + '</tg-emoji>');
  }
  for (const orig of PREMIUM_SUB_KEYS) {
    if (out.indexOf(orig) === -1) continue;
    const sub = PREMIUM_SUBS[orig];
    out = out.split(orig).join('<tg-emoji emoji-id="' + sub[1] + '">' + sub[0] + '</tg-emoji>');
  }
  return pzHarvested(out);
}
function pzStrip(text) {
  return String(text || '').replace(/<tg-emoji emoji-id="[^"]+">/g, '').replace(/<\/tg-emoji>/g, '');
}

// ─── Harvested premium emoji (RTDB node `premiumEmoji`) ─────────────
// Real per-glyph IDs harvested by the owner's bot tools (/emojihunt,
// /emojipack, the entity extractor — see handleOwnerTools below) and
// persisted at the TOP-LEVEL RTDB node `premiumEmoji` (deliberately NOT
// inside settings/global). pz() consults this map LAST — after
// PREMIUM_EMOJI and PREMIUM_SUBS — and so does premiumIconFor(). The
// map rides the config cache's refresh cycle (getConfig reloads it on
// every cache miss) and is updated in-process the moment a tool saves,
// so a fresh harvest takes effect without a restart. A missing node is
// simply an empty map, never an error.
let harvestedEmoji = {};
let harvestedKeys = [];
function refreshHarvestedKeys() {
  harvestedKeys = Object.keys(harvestedEmoji).sort((a, b) => b.length - a.length);
}
async function loadHarvestedEmoji() {
  try {
    const v = await getVal(rtdb().ref('premiumEmoji'));
    harvestedEmoji = (v && typeof v === 'object') ? v : {};
  } catch (e) { /* keep whatever is cached — harvesting is best-effort */ }
  refreshHarvestedKeys();
}
// found: { bareChar -> custom_emoji_id }. Each char is stored under BOTH
// its bare form and its U+FE0F form (same id); ref.update() merges into
// the node, so entries already stored are never deleted.
async function saveHarvestedEmoji(found) {
  const updates = {};
  for (const [ch, id] of Object.entries(found || {})) {
    if (!ch || !id) continue;
    updates[ch] = String(id);
    updates[ch + '\uFE0F'] = String(id); // second key form: char + U+FE0F
  }
  if (!Object.keys(updates).length) return;
  Object.assign(harvestedEmoji, updates);
  refreshHarvestedKeys();
  try { await rtdb().ref('premiumEmoji').update(updates); }
  catch (e) { console.error('premiumEmoji save', e.message); }
}
function pzHarvested(text) {
  if (!harvestedKeys.length || typeof text !== 'string') return text;
  // Only the segments OUTSIDE existing <tg-emoji> tags are processed, so
  // a harvested char that already appears as a wrapped display char
  // (e.g. 🎯 inside the 🔘 substitution tag) is never re-wrapped. The
  // single regex pass (keys are length-sorted, longest first) also stops
  // a shorter key from matching inside a tag this pass just inserted
  // (e.g. bare ⚔ inside a freshly wrapped ⚔️).
  const re = new RegExp(harvestedKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const parts = text.split(/(<tg-emoji[^>]*>[\s\S]*?<\/tg-emoji>)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(re, (ch) => '<tg-emoji emoji-id="' + harvestedEmoji[ch] + '">' + ch + '</tg-emoji>');
  }
  return parts.join('');
}

// ─── Premium button icons ─────────────────────────────────────────────
// Button TEXT always renders as plain text in Telegram, but an inline
// button may carry a custom-emoji icon via icon_custom_emoji_id (verified
// accepted for this bot, 2026-11-11). premiumizeKeyboard() adds the icon
// matching the first mapped emoji in each button label. The ZOMBIE server
// applies it centrally in tg() to every sendMessage and sendPhoto, so all
// keyboards are covered at once;
// if Telegram ever rejects an icon, the send retries once with the icons
// stripped — a message can never be lost over a button icon.
function premiumIconFor(text) {
  if (!text || typeof text !== 'string') return null;
  for (const ch of PREMIUM_KEYS) if (text.indexOf(ch) !== -1) return { icon: PREMIUM_EMOJI[ch], ch };
  for (const orig of PREMIUM_SUB_KEYS) if (text.indexOf(orig) !== -1) return { icon: PREMIUM_SUBS[orig][1], ch: orig };
  for (const ch of harvestedKeys) if (text.indexOf(ch) !== -1) return { icon: harvestedEmoji[ch], ch };
  return null;
}
function premiumizeKeyboard(rm) {
  if (!rm || !Array.isArray(rm.inline_keyboard)) return rm;
  for (const row of rm.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const b of row) {
      if (!b || typeof b.text !== 'string' || b.icon_custom_emoji_id) continue;
      const hit = premiumIconFor(b.text);
      if (!hit) continue;
      // Owner order 2026-11-11: once the premium icon is set, the plain emoji
      // must come OUT of the label — one icon per button, not two.
      const stripped = b.text.replace(hit.ch, '').replace(/\s+/g, ' ').trim();
      if (!stripped) continue; // emoji-only label: leave the button untouched
      b.icon_custom_emoji_id = hit.icon;
      b.text = stripped;
    }
  }
  return rm;
}
function stripPremiumIcons(rm) {
  if (!rm || !Array.isArray(rm.inline_keyboard)) return rm;
  for (const row of rm.inline_keyboard) {
    if (!Array.isArray(row)) continue;
    for (const b of row) if (b) delete b.icon_custom_emoji_id;
  }
  return rm;
}

const TG_API_BASE = (process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''); // env override exists for local testing (stub Telegram API)

/* Outbound send pacing (owner load-reduction order 2026-11-15):
   sendMessage / sendPhoto are funnelled through one paced chain —
   never two sends in flight, at least TG_SEND_GAP_MS between them —
   so a burst (a hundred referral DMs inside a minute) can no longer
   trip Telegram's own rate limits and silently drop messages. The
   call still resolves with the send's real result; only its timing
   is smoothed. Reads (getChatMember, getMe) and interactive answers
   are NOT paced — they must stay instant. Payouts never pass through
   here at all: they are chain operations, not messages. */
const TG_SEND_GAP_MS = 50;
let tgSendChain = Promise.resolve();
let tgLastSendAt = 0;
function tgPaced(fn) {
  const run = async () => {
    const wait = TG_SEND_GAP_MS - (Date.now() - tgLastSendAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { tgLastSendAt = Date.now(); }
  };
  const p = tgSendChain.then(run, run);
  tgSendChain = p.then(() => {}, () => {});
  return p;
}
async function tg(method, body) {
  if (method === 'sendMessage' || method === 'sendPhoto') return tgPaced(() => tgSend(method, body));
  return tgSend(method, body);
}
async function tgSend(method, body) {
  if (!BOT_TOKEN) return null;
  let payload = body;
  if ((method === 'sendMessage' || method === 'sendPhoto') && body && typeof body === 'object') {
    // Premium custom-emoji treatment, applied centrally like the VOLT bot:
    // HTML parse mode when the caller didn't pick one, the message text
    // (sendMessage) or the photo caption (sendPhoto) wrapped via pz(),
    // button icons via premiumizeKeyboard(). Work on copies so a
    // caller-owned keyboard object is never mutated.
    payload = { ...body };
    const field = method === 'sendMessage' ? 'text' : 'caption';
    if (typeof payload[field] === 'string') {
      if (!payload.parse_mode) payload.parse_mode = 'HTML';
      payload[field] = pz(payload[field]);
    }
    if (payload.reply_markup) {
      payload.reply_markup = premiumizeKeyboard(JSON.parse(JSON.stringify(payload.reply_markup)));
    }
  }
  const send = async (p) => {
    try {
      const r = await fetch(`${TG_API_BASE}/bot${BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
        signal: AbortSignal.timeout(10000) // never let a hung Telegram call wedge a request
      });
      return await r.json();
    } catch (e) { console.error('telegram', method, e.message); return null; }
  };
  let res = await send(payload);
  // Telegram rejected a custom emoji / button icon (e.g. EMOJI_ID_INVALID):
  // retry exactly once with the plain, stripped variant — a message is
  // never lost over an icon.
  if ((method === 'sendMessage' || method === 'sendPhoto') && res && !res.ok && /emoji/i.test(String(res.description || ''))) {
    const stripped = { ...payload };
    if (typeof stripped.text === 'string') stripped.text = pzStrip(stripped.text);
    if (typeof stripped.caption === 'string') stripped.caption = pzStrip(stripped.caption);
    if (stripped.reply_markup) stripped.reply_markup = stripPremiumIcons(stripped.reply_markup);
    const retry = await send(stripped);
    if (retry) res = retry;
  }
  return res;
}
/* Resolve a configured channel value to a getChatMember chat_id: a numeric
   id stored by the admin, an @handle, a public t.me/<name> (or t.me/s/<name>)
   link, or a private t.me/c/<id> link (-> -100<id>). Anything else (e.g. a
   t.me/+invite link) cannot be queried and returns null. */
function chatIdOf(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  if (/^-?\d{5,}$/.test(s)) return Number(s);
  const priv = /(?:t\.me|telegram\.me)\/c\/(\d+)/.exec(s);
  if (priv) return Number('-100' + priv[1]);
  const m = /^@([A-Za-z][A-Za-z0-9_]{3,})$/.exec(s) || /(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,})/.exec(s);
  if (m) return '@' + m[1];
  return null;
}
/* REAL server-side membership check via the bot (getChatMember).
   Returns 'member' | 'not-member' | 'unknown'. 'unknown' means the check
   itself could not be performed (unparseable channel config, Telegram
   error — typically because the bot is not a member/admin of the channel,
   or no bot token) and callers must fail CLOSED, never grant. */
async function memberStatus(url, userId) {
  const chatId = chatIdOf(url);
  if (chatId === null) return 'unknown';
  const j = await tg('getChatMember', { chat_id: chatId, user_id: Number(userId) });
  if (!j || !j.ok || !j.result) return 'unknown'; // bot cannot check this channel
  const s = j.result.status;
  if (s === 'creator' || s === 'administrator' || s === 'member') return 'member';
  if (s === 'restricted') return j.result.is_member === true ? 'member' : 'not-member';
  return 'not-member'; // left / kicked
}
async function isMember(url, userId) {
  const m = await memberStatus(url, userId);
  return m === 'member' ? true : m === 'not-member' ? false : null;
}

/* The bot's own username, resolved from the Bot API (getMe) and cached in
   process. The bio task verifies against the REAL username of the deployed
   bot; if getMe is unreachable we fall back to the admin-set
   settings.botUsername. A failed lookup is negatively cached for 60 s so
   state() (a hot path) never hammers Telegram. */
let botMeCache = { username: '', t: 0 };
async function resolveBotUsername(cfg) {
  if (botMeCache.username) return botMeCache.username;
  if (!botMeCache.t || Date.now() - botMeCache.t >= 60000) {
    botMeCache.t = Date.now();
    const j = await tg('getMe');
    if (j && j.ok && j.result && j.result.username) {
      botMeCache.username = String(j.result.username).replace(/^@/, '').trim();
      return botMeCache.username;
    }
  }
  return String((cfg && cfg.botUsername) || '').replace(/^@/, '').trim() || null;
}

const TONAPI_BASE = (process.env.TONAPI_BASE || 'https://tonapi.io/v2').replace(/\/+$/, ''); // env override exists for local testing, like TG_API_BASE
async function ton(path) {
  const r = await fetch(TONAPI_BASE + path, { headers: TONAPI_KEY ? { Authorization: 'Bearer ' + TONAPI_KEY } : {}, signal: AbortSignal.timeout(10000) });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) fail(502, 'TON network is busy, try again');
  return r.json();
}
/* TonAPI plan pacing (live lesson 2026-11-16): the owner's plan is
   the Free tier = 1 request/sec, and the deep scans below page
   through results back-to-back — an unpaced second page lands
   inside the same second as the first and dies on a 429, which
   aborted the whole cursor walk every tick even with a valid key
   installed (five rapid probes from the instance: 429 429 429 200
   429). Page fetches inside the deep scans are therefore spaced by
   TONAPI_PAGE_GAP_MS (default 1100; tests set 0) and a failed page
   is retried in place with growing waits before the failure is
   allowed to propagate — a page is only ever accepted whole, so
   the cursor's contiguity guarantee is unaffected. */
const TONAPI_PAGE_GAP_MS = (() => { const v = Number(process.env.TONAPI_PAGE_GAP_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 1100; })();
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function tonPage(qs) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleepMs([1500, 3000, 6000][attempt - 1]);
    try { return await ton(qs); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
async function rawAddress(addr) {
  // Already-raw addresses normalise locally — the same result the
  // tonapi parse returns for this shape. TonConnect always reports
  // the raw form, so binds stop spending a network call on parsing
  // (and stop failing when tonapi rate-limits). Only user-friendly
  // forms still go to the parse endpoint.
  const mRaw = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(String(addr || '').trim());
  if (mRaw) return mRaw[1] + ':' + mRaw[2].toLowerCase();
  const j = await ton('/address/' + encodeURIComponent(addr) + '/parse');
  if (!j || !j.raw_form) fail(400, 'Invalid wallet address');
  return j.raw_form;
}
/* Hold reads (permanent fix, owner order 2026-11-15; CROSS-CHECK
   hardening, owner order 2026-11-24, closing the phantom-hold
   exploit): every hold in the system funnels through here. Concurrent
   reads of the same wallet coalesce into one call (the boot /
   double-tap bursts). The balance is read from BOTH providers —
   tonapi AND toncenter v3 — and the LOWER value wins: a single
   provider returning a wrong, inflated figure during an outage (the
   2026-11-23 exploit window) can no longer be acted on, because the
   other provider's read caps it. If EITHER provider fails, the read
   throws and every caller treats that as "no fresh data" (claims
   answer 503, syncs keep the stored value, the watcher skips) —
   never as a state change. Deliberately NO result cache: a sync must
   reflect the chain NOW (buy coins -> sync -> activation flips on
   that very read); a cached value broke exactly that loop in
   testing (t11 R6 / t12) and is not worth the saved calls. */
const holdInflight = new Map();
async function jettonHoldViaToncenter(raw) {
  const j = await tonc('/jetton/wallets?owner_address=' + encodeURIComponent(raw) + '&jetton_address=' + encodeURIComponent(JETTON) + '&limit=1');
  // Only a well-formed answer counts as a read: a genuine "no jetton
  // wallet" is 200 + an empty list. A null (404/400) or malformed
  // body is a FAILED read and must throw — never a fake zero that
  // could deactivate a referral or misreport a balance.
  if (!j || !Array.isArray(j.jetton_wallets)) fail(502, 'TON network is busy, try again');
  const w = j.jetton_wallets[0];
  if (!w) return 0;
  return parseFloat(w.balance || '0') / Math.pow(10, await jettonDecimals());
}
async function jettonHold(raw) {
  const flying = holdInflight.get(raw);
  if (flying) return flying;
  const run = (async () => {
    const j = await ton('/accounts/' + encodeURIComponent(raw) + '/jettons/' + JETTON);
    const a = !j ? 0 : parseFloat(j.balance || '0') / Math.pow(10, (j.jetton && j.jetton.decimals) || 9);
    const b = await jettonHoldViaToncenter(raw);
    if (!Number.isFinite(a) || !Number.isFinite(b)) fail(503, 'Hold check failed, please try again');
    return Math.min(a, b);
  })();
  holdInflight.set(raw, run);
  run.then(() => holdInflight.delete(raw), () => holdInflight.delete(raw));
  return run;
}
/* The jetton's decimals, resolved once from tonapi jetton info and
   cached for the process — the same source and `decimals || 9`
   semantics jettonHold uses (metadata.decimals arrives as a string).
   A failed lookup is NOT cached: the caller gets the 9 fallback for
   this call and the next call retries the resolution. */
let _jettonDecimals = null;
async function jettonDecimals() {
  if (_jettonDecimals !== null) return _jettonDecimals;
  try {
    const j = await ton('/jettons/' + JETTON);
    const n = Number(j && j.metadata ? j.metadata.decimals : undefined) || 9;
    if (Number.isFinite(n) && n > 0 && n <= 18) { _jettonDecimals = n; return n; }
  } catch (e) { /* fall through to the uncached fallback */ }
  return 9;
}

/* ---------- wallet verification: TON Center v3 reads (owner order 2026-11-14) ---------- */
/* Normalise any TON address (raw "0:ab..", bounceable/non-bounceable
   user-friendly base64) to lowercase raw form, locally — no API call.
   User-friendly form is 36 bytes: flags(1) workchain(1, signed)
   hash(32) crc16(2). Unknown shapes pass through lowercased so a
   comparison simply fails instead of throwing. */
function toRawAddress(addr) {
  const s = String(addr || '').trim();
  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (m) return m[1] + ':' + m[2].toLowerCase();
  try {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 36) return b.readInt8(1) + ':' + b.subarray(2, 34).toString('hex');
  } catch (e) { /* fall through */ }
  return s.toLowerCase();
}
/* Inverse of toRawAddress for DISPLAY in bot messages (mirrors the
   frontend friendlyAddr helper byte for byte): raw "wc:hex64" -> the
   non-bounceable user-friendly form (0x51 tag) Tonkeeper shows.
   Anything not in raw form passes through unchanged. */
function toFriendlyAddress(addr) {
  const s = String(addr || '').trim();
  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (!m) return s;
  const payload = [0x51, parseInt(m[1], 10) & 0xff];
  for (let i = 0; i < 64; i += 2) payload.push(parseInt(m[2].substr(i, 2), 16));
  let crc = 0; // CRC16-XModem over the 34 payload bytes
  for (const b of payload) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    crc &= 0xffff;
  }
  const bytes = Buffer.from([...payload, (crc >> 8) & 0xff, crc & 0xff]);
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const shortFriendlyAddress = (addr) => { const f = toFriendlyAddress(addr); return f ? f.slice(0, 6) + '...' + f.slice(-6) : ''; };
/* Privacy mask for the PUBLIC payouts-channel post (owner order
   2026-11-17): first 4 chars + exactly 11 asterisks + everything
   from char index 15 on — the middle of the address can neither be
   copied nor reconstructed, and the total length is preserved.
   Strings too short to mask (≤15 chars) pass through unchanged. */
const maskAddr = (s) => { const f = String(s || ''); return f.length > 15 ? f.slice(0, 4) + '***********' + f.slice(15) : f; };
/* "14 Nov 2026" — the one date shape bot messages use (no slashes, so
   nothing can be bidi-shuffled in mixed-direction chats). */
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDayMonYear(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.getDate() + ' ' + MONTHS_EN[d.getMonth()] + ' ' + d.getFullYear();
}
async function tonc(path) {
  // Key pool: start at the round-robin key; a 429 (that key's own
  // rate limit) retries with the NEXT key, up to one full pass over
  // the pool. 404/400 keep their "no data" meaning on any key; any
  // other failure still fails the read, exactly as before — a pool
  // must never turn a failed read into a fake answer.
  const attempts = Math.max(1, TONCENTER_KEYS.length);
  for (let i = 0; i < attempts; i++) {
    const key = nextToncKey();
    const r = await fetch(TON_API_BASE + path, { headers: key ? { 'X-API-Key': key } : {}, signal: AbortSignal.timeout(10000) });
    if (r.status === 404 || r.status === 400) return null;
    if (r.status === 429 && i < attempts - 1) continue;
    if (!r.ok) fail(502, 'TON network is busy, try again');
    return r.json();
  }
  fail(502, 'TON network is busy, try again');
}
/* Transactions of one account, newest (desc) or oldest (asc) first.
   TON_API_BASE is toncenter v3, whose ordering parameter is
   `sort=asc|desc`. (The tonapi.io name `sort_order` is silently
   IGNORED by toncenter — every query then falls back to newest-first,
   which once made the age lookup read the newest transaction instead
   of the oldest. Regression-covered in test_local5 V14.) */
async function toncTransactions(rawAddr, limit, order) {
  const j = await tonc('/transactions?account=' + encodeURIComponent(rawAddr) + '&limit=' + limit + '&sort=' + order);
  return (j && Array.isArray(j.transactions)) ? j.transactions : [];
}
/* Deep newest-first scan of one account's transactions — the
   verification paths' workhorse (owner order 2026-11-16). After the
   app reopened to everyone, the deposit wallet began receiving
   ~150–190 fee payments an hour, so the fixed 50-transaction window
   the paths used before covered only ~20 minutes: a payment whose
   owner was not yet marked pending, or whose tick hiccuped, aged
   out of the window and could never be matched again (player 3935
   paid correctly at 07:59 and surfaced as a support case hours
   later, his payment ~600 transactions deep).
   The scan runs on tonapi, whose account-transactions endpoint
   pages correctly with before_lt (each page returns transactions
   strictly older than the previous page's last lt — verified live
   2026-11-16). toncenter v3 cannot do this at all: probed live the
   same day, its lt/hash parameters act as an EXACT-match filter
   (and a base64 hash is rejected with 422), while offset and to_lt
   are silently ignored — every variant returned either the first
   page again or the cursor transaction alone. tonapi transactions
   are normalised into the toncenter shape the consumers already
   read (hash / in_msg.source / in_msg.value / text comment), so
   verifyCheck, the watcher and the sweep share one code path.
   Pages are deduplicated by canonical hash, and the walk stops on
   a short page, a non-advancing lt, or a page that adds nothing
   new, so a misbehaving provider degrades instead of looping. */
function normalizeTonapiTx(tx) {
  const im = (tx && tx.in_msg) || {};
  const body = (im.decoded_body && typeof im.decoded_body === 'object') ? im.decoded_body : {};
  const text = typeof body.text === 'string' ? body.text : (typeof body.comment === 'string' ? body.comment : '');
  const src = (im.source && typeof im.source === 'object') ? (im.source.address || '') : (im.source || '');
  return {
    hash: tx && tx.hash, lt: tx && tx.lt, now: tx && tx.utime,
    in_msg: {
      source: src,
      value: String(im.value !== undefined && im.value !== null ? im.value : '0'),
      message_content: text ? { decoded: { type: 'text_comment', comment: text } } : undefined,
      comment: text || undefined
    }
  };
}
async function tonapiTransactionsDeep(rawAddr, maxTotal) {
  const out = [];
  const seen = new Set();
  let beforeLt = null;
  let firstPage = true;
  while (out.length < maxTotal) {
    const limit = Math.min(100, maxTotal - out.length);
    let qs = '/blockchain/accounts/' + encodeURIComponent(rawAddr) + '/transactions?limit=' + limit;
    if (beforeLt !== null) qs += '&before_lt=' + encodeURIComponent(beforeLt);
    if (!firstPage && TONAPI_PAGE_GAP_MS > 0) await sleepMs(TONAPI_PAGE_GAP_MS);
    firstPage = false;
    const j = await tonPage(qs);
    if (!j) {
      // ton() answers null on 404/400: on the first page that is a
      // provider failure (the caller falls back to toncenter); on a
      // later page, keep whatever was already gathered.
      if (!out.length) return null;
      break;
    }
    const txs = Array.isArray(j.transactions) ? j.transactions : [];
    if (!txs.length) break;
    let added = 0;
    for (const tx of txs) {
      const h = txHashHex(tx && tx.hash);
      if (!h || seen.has(h)) continue;
      seen.add(h);
      out.push(normalizeTonapiTx(tx));
      added++;
    }
    if (!added) break; // provider repeating itself — never spin
    const lastLt = Number(txs[txs.length - 1] && txs[txs.length - 1].lt);
    if (!Number.isFinite(lastLt) || (beforeLt !== null && lastLt >= beforeLt)) break;
    beforeLt = lastLt;
    if (txs.length < limit) break;
  }
  return out;
}
/* toncenter fallback for the deep scan (see the note above: its
   lt/hash walk is an exact-match filter in practice, so this
   degrades to a single 100-transaction page — still never worse
   than the pre-2026-11-16 behaviour, and it keeps the verification
   paths alive if tonapi is down). */
async function toncTransactionsDeep(rawAddr, maxTotal) {
  const out = [];
  const seen = new Set();
  let lt = null, hash = null;
  while (out.length < maxTotal) {
    const limit = Math.min(100, maxTotal - out.length);
    let qs = '/transactions?account=' + encodeURIComponent(rawAddr) + '&limit=' + limit + '&sort=desc';
    if (lt !== null && hash) qs += '&lt=' + encodeURIComponent(lt) + '&hash=' + encodeURIComponent(txHashHex(hash) || hash);
    const j = await tonc(qs);
    const txs = (j && Array.isArray(j.transactions)) ? j.transactions : [];
    if (!txs.length) break;
    let added = 0;
    for (const tx of txs) {
      const h = txHashHex(tx && tx.hash);
      if (h && seen.has(h)) continue;
      if (h) seen.add(h);
      out.push(tx);
      added++;
    }
    if (!added) break; // cursor ignored by the API — never spin
    const last = txs[txs.length - 1];
    lt = last && last.lt !== undefined && last.lt !== null ? String(last.lt) : null;
    hash = last && last.hash ? String(last.hash) : null;
    if (txs.length < limit || lt === null || !hash) break;
  }
  return out;
}
/* The one entry point the verification paths use: tonapi deep scan
   first, toncenter single-page fallback when tonapi cannot answer. */
async function depositTransactionsDeep(rawAddr, maxTotal) {
  try {
    const via = await tonapiTransactionsDeep(rawAddr, maxTotal);
    if (via && via.length) return via;
    if (via) return via; // a clean (empty) tonapi answer is authoritative
  } catch (e) { /* tonapi failed — fall through to the toncenter page */ }
  return toncTransactionsDeep(rawAddr, Math.min(maxTotal, 100));
}
/* Wallet age in whole days = time since the wallet's FIRST transaction
   (the ascending query). A wallet with no transactions at all is 0. */
async function fetchWalletAgeDays(raw) {
  const txs = await toncTransactions(raw, 1, 'asc');
  if (!txs.length) return 0;
  const first = Number(txs[0].now) || 0; // toncenter v3: unix seconds
  if (!first) return 0;
  return Math.max(0, Math.floor((Date.now() / 1000 - first) / 86400));
}
/* The age is cached on the player (walletAgeDays/walletAgeAt/
   walletAgeFor) for at most WALLET_AGE_CACHE_MS and only ever for the
   wallet it was computed for — a different wallet always recomputes.
   The cache also carries a version stamp (walletAgeV): caches written
   before the ascending-query fix (which, via the sort_order bug,
   stored the age of the NEWEST transaction) carry no stamp and are
   recomputed once, then stamped and behave as before. */
const WALLET_AGE_CACHE_MS = 3 * 60 * 60 * 1000;
const WALLET_AGE_CACHE_V = 2;
async function walletAgeDays(ref, p, wallet) {
  if (p.walletAgeV === WALLET_AGE_CACHE_V && p.walletAgeFor === wallet && p.walletAgeAt && (Date.now() - p.walletAgeAt) < WALLET_AGE_CACHE_MS && Number(p.walletAgeDays) >= 0) {
    return Number(p.walletAgeDays);
  }
  const days = await fetchWalletAgeDays(wallet);
  try { await ref.update({ walletAgeDays: days, walletAgeAt: Date.now(), walletAgeFor: wallet, walletAgeV: WALLET_AGE_CACHE_V }); } catch (e) { /* the cache is advisory */ }
  return days;
}
/* Decode the text comment of an incoming message, robustly:
   1. the API's own decoded body (message_content.decoded, type
      'text_comment') when present;
   2. otherwise the raw body hex: a text comment's body is the 4-byte
      opcode 0x00000000 followed by the UTF-8 text;
   3. a plain `comment` field, if an API variant provides one. */
function decodeTextComment(inMsg) {
  const mc = (inMsg && inMsg.message_content) || null;
  if (mc) {
    const dec = mc.decoded;
    if (dec && typeof dec.comment === 'string' && dec.comment) return dec.comment;
    const bodyHex = typeof mc.body === 'string' ? mc.body : (typeof mc.body_hex === 'string' ? mc.body_hex : '');
    if (/^(?:[0-9a-fA-F]{2})+$/.test(bodyHex)) {
      const buf = Buffer.from(bodyHex, 'hex');
      if (buf.length > 4 && buf.readUInt32BE(0) === 0) {
        const txt = buf.subarray(4).toString('utf8');
        if (txt) return txt;
      }
    }
  }
  if (inMsg && typeof inMsg.comment === 'string' && inMsg.comment) return inMsg.comment;
  return null;
}
const inMsgSourceRaw = (inMsg) => toRawAddress((inMsg && typeof inMsg.source === 'object' && inMsg.source) ? (inMsg.source.address || '') : ((inMsg && inMsg.source) || ''));
/* toncenter v3 returns tx.hash in BASE64 (44 chars, may contain '+',
   '/' and a trailing '='), NOT hex. Canonicalise to lowercase hex
   before ANY use: the hex form is the verifyClaims RTDB key (a base64
   '/' would be an illegal, path-splitting RTDB key) and the stored
   verifyTx (hex is what tonviewer links expect). A 64-char hex string
   passes through lowercased; a base64 string (standard or URL-safe
   alphabet) is used only if it decodes to exactly 32 bytes; anything
   else yields '' and the transaction is skipped as malformed. */
function txHashHex(h) {
  const s = String(h || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    try {
      const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (buf.length === 32) return buf.toString('hex');
    } catch (e) { /* fall through */ }
  }
  return '';
}
/* Keep the inviter's referral entry for this player in sync with the
   player's verified state (the Friends list renders the entry's flag —
   storing it on the entry keeps state() free of per-referral lookups).
   Best-effort by design: it must never fail a verify/void operation. */
async function syncRefVerifiedFlag(uid, verified) {
  try {
    const me = await getVal(P(uid));
    const inv = me && me.invitedBy;
    if (!inv) return;
    await txUpdate(P(inv).child('referrals'), (cur) => {
      const refs = asRefArray(cur);
      if (!refs.some((r) => String(r.id) === String(uid))) return { skip: true };
      return { value: refs.map((r) => (String(r.id) === String(uid) ? { ...r, verified: !!verified } : r)) };
    });
  } catch (e) { console.error('refVerifiedFlag', e.message); }
}

/* Same keep-in-sync pattern for the player's chosen avatar: the
   inviter's Friends list renders the entry's avatar image, so the
   choice is mirrored onto the referral entry when it is set.
   Best-effort by design: it must never fail the setAvatar action. */
async function syncRefAvatar(uid, n) {
  try {
    const me = await getVal(P(uid));
    const inv = me && me.invitedBy;
    if (!inv) return;
    await txUpdate(P(inv).child('referrals'), (cur) => {
      const refs = asRefArray(cur);
      if (!refs.some((r) => String(r.id) === String(uid))) return { skip: true };
      return { value: refs.map((r) => (String(r.id) === String(uid) ? { ...r, avatar: n } : r)) };
    });
  } catch (e) { console.error('refAvatar', e.message); }
}

/* ---------- referral DMs to the inviter (owner order 2026-11-15) ----------
   Two messages, in the same simple style as the payout DM — tg()
   applies pz() premium-emoji wrapping and premium button icons
   centrally. Best-effort by design: a failed DM never fails the
   action that triggered it. */
async function sendRefJoinDM(inviterId, user) {
  try {
    const cfg = await getConfig();
    const botUname = await resolveBotUsername(cfg);
    const kb = botUname ? { inline_keyboard: [[{ text: '🧟 Open ZOM', url: `https://t.me/${botUname}/app` }]] } : undefined;
    const name = esc(String((user && user.first_name) || 'Zombie').trim() || 'Zombie');
    await tg('sendMessage', { chat_id: String(inviterId), text: `🧟 <b>New Zombie in the Horde!</b>\n👤 <b>${name}</b> just rose from the grave and joined ZOM with your link.\n💡 When they verify their wallet and hold ${Number(cfg.refMinHold) || 400}+ ${esc(cfg.coinSym)}, they turn <b>Active ✅</b> — and you earn <b>5%</b> of everything they dig up.`, reply_markup: kb });
  } catch (e) { console.error('ref join dm', e.message); }
}
async function sendRefActiveDM(inviterId, inviteeName, cfg) {
  try {
    const botUname = await resolveBotUsername(cfg);
    const kb = botUname ? { inline_keyboard: [[{ text: '🧟 Open ZOM', url: `https://t.me/${botUname}/app` }]] } : undefined;
    const name = esc(String(inviteeName || 'Zombie').trim() || 'Zombie');
    await tg('sendMessage', { chat_id: String(inviterId), text: `✅ <b>Your Zombie is ACTIVE!</b>\n👤 <b>${name}</b> is now <b>Active ✅</b>\n💰 You earn <b>5%</b> of everything they mine — it lands in your pending referral profits. Keep the horde digging! 🪦🧟`, reply_markup: kb });
  } catch (e) { console.error('ref active dm', e.message); }
}

/* Append this player to the inviter's referral list (exactly once)
   and send the inviter the new-referral DM. Used by state() at
   signup, by state()'s late-attribution path and by the bot /start
   ref_ param. Returns true when the entry was actually appended. */
/* Referral-list writes transact on the referrals CHILD, never on
   the whole inviter record (owner order 2026-11-15: a referral must
   be recorded immediately, not in a later repair cycle). A
   whole-record transaction aborts whenever ANY field of the hot
   inviter record changes mid-flight — his own activity, commission
   accruals, other joins — and under a signup burst that contention
   is exactly what silently ate appends (Hisham: 25 of 26). On the
   child path only actual referral-list writes contend with each
   other. RTDB arrays can read back as objects when sparse, so
   normalize defensively. */
const asRefArray = (v) => (Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []));
async function appendRefEntry(inviterId, entry) {
  return txUpdate(P(inviterId).child('referrals'), (cur) => {
    const refs = asRefArray(cur);
    if (refs.length >= 3000) return { skip: true, out: false }; // cap re-checked on the freshest value
    if (refs.some((r) => String(r.id) === String(entry.id))) return { skip: true, out: 'exists' };
    return { value: [...refs, entry], out: true };
  });
}
/* Last-resort in-process ladder for an append that still lost its
   contention war twice in a row: retry over the next ~15 s in the
   background (the caller's action is already complete), and let
   the 10-minute repair sweep be the final net after that. */
function retryRefAppendLater(inviterId, entry, user, silent) {
  // Record the handoff in the repair queue FIRST (owner load order
  // 2026-11-15): if this process dies before the ladder finishes,
  // the repair tick picks the entry up from the queue instead of the
  // loss waiting for the daily full reconciliation. The queue entry
  // is removed the moment the append lands, by whichever path lands it.
  rtdb().ref('refRepairQueue/' + entry.id).set({ inv: String(inviterId), at: Date.now() }).catch(() => {});
  (async () => {
    for (const wait of [1500, 4000, 10000]) {
      await new Promise((r) => setTimeout(r, wait));
      const ok = await appendRefEntry(inviterId, entry).catch(() => false);
      if (ok) {
        rtdb().ref('refRepairQueue/' + entry.id).remove().catch(() => {});
        if (!silent) sendRefJoinDM(inviterId, user).catch(() => {});
        return;
      }
    }
    console.error('refAppend deferred to repair sweep', inviterId, entry.id);
  })().catch(() => {});
}
async function attributeReferral(user, inviterId, deviceHash, opts) {
  const silent = !!(opts && opts.silent); // repair-sweep appends: no join DM (it is not a live join)
  const atTs = (opts && Number(opts.at)) || Date.now(); // the sweep backfills the real join time
  try {
    const inv = await getVal(P(inviterId));
    if (!inv) return false;
    const dup = !!(inv.deviceHash && deviceHash && inv.deviceHash === deviceHash);
    const entry = { id: String(user.id), name: clean(user.first_name || 'Zombie', 64), deviceHash: deviceHash || '', status: dup ? '⚠️ Duplicate' : 'Pending ⏳', profit: 0, at: atTs, avatar: 0 };
    let appended = await appendRefEntry(inviterId, entry).catch(() => false);
    if (!appended) { // the burst outlasted the tx retries: one quick inline retry before handing off
      await new Promise((r) => setTimeout(r, 400));
      appended = await appendRefEntry(inviterId, entry).catch(() => false);
    }
    if (!appended) { retryRefAppendLater(inviterId, entry, user, silent); return false; }
    if (!silent) sendRefJoinDM(inviterId, user).catch(() => {});
    return true;
  } catch (e) { console.error('attributeReferral', e.message); return false; }
}

/* Referral activation is a LIVE state (see the ACTIVE_REF_STATUS
   note): ACTIVE while the invitee is wallet-verified AND holds at
   least refMinHold. This re-evaluates it after every event that can
   change either input (wallet sync, verification completion,
   unlink): the invitee's commission gate (refBonusPaid) and the
   inviter's entry status follow the state in both directions —
   selling below the minimum deactivates again. The became-active DM
   fires only on the FIRST upward flip (entry.activeDmAt latch).
   '⚠️ Duplicate' entries never flip. Best-effort: never fails the
   caller's action. */
async function syncReferralActive(uid, cfg) {
  try {
    uid = String(uid);
    const me = await getVal(P(uid));
    if (!me || !me.invitedBy) return;
    const need = Number(cfg && cfg.refMinHold) || 200;
    const active = me.walletVerified === true && (Number(me.hold) || 0) >= need;
    if ((me.refBonusPaid === true) !== active) {
      await txUpdate(P(uid), (d) => {
        if (d === null) return { skip: true };
        const a = d.walletVerified === true && (Number(d.hold) || 0) >= need;
        if ((d.refBonusPaid === true) === a) return { skip: true };
        return { value: { ...d, refBonusPaid: a } };
      });
    }
    const invId = String(me.invitedBy);
    const res = await txUpdate(P(invId).child('referrals'), (cur) => {
      let changed = false, dm = false;
      const refs = asRefArray(cur).map((r) => {
        if (String(r.id) !== uid) return r;
        if (r.status === '⚠️ Duplicate') return r;
        const want = active ? 'Verified ✅' : 'Pending ⏳';
        if (r.status === want) return r;
        changed = true;
        const nr = { ...r, status: want };
        if (active && !nr.activeDmAt) { nr.activeDmAt = Date.now(); dm = true; }
        return nr;
      });
      if (!changed) return { skip: true, out: null };
      return { value: refs, out: { dm } };
    });
    if (res && res.dm) await sendRefActiveDM(invId, me.name, cfg || await getConfig());
  } catch (e) { console.error('refActiveSync', e.message); }
}

const newPlayer = (user, extra) => ({
  id: String(user.id), name: clean(user.first_name || 'Zombie', 64), username: clean(user.username || 'user', 64),
  deviceHash: '', mined: 0, hold: 0, lastCollectTime: Date.now(), walletAddr: '', banned: false, invitedBy: null,
  refBonusPaid: false, refCommissionEarned: 0, pendingRefComm: 0, lastWithdrawTime: 0, adsWatched: 0,
  earnMining: 0, earnDaily: 0, earnTasks: 0, earnRef: 0, // lifetime earnings by source (owner review card, 2026-11-14); pre-existing players read as 0 until they earn again
  lastAdUtcDay: dayOf(Date.now()), adsDay: 0, adsDayCount: 0, task1Done: false, task2Done: false, task3Done: false, task1At: 0, task2At: 0, task3At: 0, taskXDone: false, taskXAt: 0, taskXVisitAt: 0, holdTaskAt: {}, bioTaskDone: false, dailyStreak: 0, lastDailyCheckIn: 0,
  lastSeen: Date.now(), referrals: [], createdAt: Date.now(), avatar: 0, ...extra
});

/* Create the caller's player record if it does not exist yet (same
   newPlayer defaults as state, but with NO referral side-effects —
   referral attribution happens only in state). Every player action calls
   this first, so a legitimate first-run call can no longer hit the
   'User not found' 404: the frontend fires `state` and TonConnect's
   `wallet` independently at cold start (and taps can land before state),
   and each action used to assume the record was already there. */
async function ensurePlayer(c) {
  const ref = P(c.user.id);
  const dev = clean(c.body.deviceHash, 64);
  const created = await txUpdate(ref, (cur) => {
    if (cur !== null) return { skip: true, out: false };
    return { value: newPlayer(c.user, { deviceHash: dev, invitedBy: null }), out: true };
  });
  if (created) await assignUserNo(c.user.id);
  return ref;
}

/* ---------- permanent sequential user numbers (wallet verification) ----------
   Every player owns a permanent sequential userNo (1, 2, 3, ...),
   assigned at creation from the meta/counters `users` counter — the
   same transaction pattern withdraw() uses for withdrawal numbers.
   Players created before this feature get their number lazily, the
   first time a verify action needs it (ensureUserNo). A number, once
   assigned, never changes; a concurrently assigned duplicate number is
   simply skipped (a gap), never reused. Best-effort: a numbering
   failure must never break the action that triggered it. */
async function assignUserNo(uid) {
  // One full retry before giving up: the counter and the player write
  // are both txUpdate-hardened now, so a failure here is transient
  // (contention / a just-restarted process), and verifyInfo's
  // last-resort 500 must stay reserved for genuinely impossible
  // states — never for a real player on a cold process.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ref = P(uid);
      const cur = await getVal(ref);
      if (!cur) return 0; // no record to number — callers ensure it first; nothing to retry
      if (Number(cur.userNo) > 0) return Number(cur.userNo);
      const n = await bumpCounter('users');
      if (!n) continue;
      const out = await txUpdate(ref, (d) => {
        if (d === null) return { skip: true, out: 0 };
        if (Number(d.userNo) > 0) return { skip: true, out: Number(d.userNo) }; // a racer assigned first; n stays a gap
        return { value: { ...d, userNo: n }, out: n };
      });
      if (out) return out;
      const again = await getVal(ref); // out 0 with no error: re-read — a racer's number may have landed
      if (again && Number(again.userNo) > 0) return Number(again.userNo);
    } catch (e) { console.error('assignUserNo', e.message); }
  }
  return 0;
}
async function ensureUserNo(uid) {
  const p = await getVal(P(uid));
  if (p && Number(p.userNo) > 0) return Number(p.userNo);
  return assignUserNo(uid);
}

async function withdrawalsOfUser(uid) {
  const v = await getVal(rtdb().ref('withdrawals').orderByChild('userId').equalTo(String(uid)).limitToFirst(50));
  return Object.values(v || {});
}

/* ---------- player actions ---------- */
async function state(c) {
  const ref = P(c.user.id);
  const dev = clean(c.body.deviceHash, 64);
  const existing = await getVal(ref);
  if (existing) {
    // Contention diet (round 3, incident 2026-11-14): lastSeen (with
    // the name/username refresh riding along) is written ONLY when
    // the stored value is older than 60 s — state is the app's
    // heartbeat, and an unthrottled write here kept the whole player
    // record hot enough to starve whole-record transactions into
    // 'maxretry' aborts. Regression-covered in test_local6 (W4).
    if (Date.now() - (existing.lastSeen || 0) > 60000) await ref.update({ name: clean(c.user.first_name || 'Zombie', 64), username: clean(c.user.username || 'user', 64), lastSeen: Date.now(), ...(dev ? { deviceHash: dev } : {}) });
    // Late attribution (owner order 2026-11-15): a record created by a
    // bot first contact (/start or the write-access welcome — both
    // ensurePlayer with no referral data) or by an action that raced
    // ahead of the first state used to lose its inviter forever,
    // because attribution only ran at record creation. A still-fresh
    // account (created < 24 h ago, nothing earned yet) arriving WITH
    // a referral param is attributed now instead.
    if (!existing.invitedBy) {
      const spL = String(c.startParam || '').replace(/^ref_/, '').trim();
      const fresh = Date.now() - (Number(existing.createdAt) || 0) < 86400000;
      const earned = (Number(existing.mined) || 0) > 0 || (Number(existing.earnDaily) || 0) > 0 || (Number(existing.earnTasks) || 0) > 0 || (Number(existing.earnRef) || 0) > 0;
      if (fresh && !earned && isId(spL) && spL !== String(c.user.id)) {
        const invL = await getVal(P(spL));
        if (invL && (invL.referrals || []).length < 3000) {
          const set = await txUpdate(ref, (cur) => {
            if (cur === null || cur.invitedBy) return { skip: true, out: false };
            return { value: { ...cur, invitedBy: spL }, out: true };
          });
          if (set) await attributeReferral(c.user, spL, dev);
        }
      }
    }
  } else {
    const sp = String(c.startParam || '').replace(/^ref_/, '').trim();
    let inv = null, invRef = null;
    if (isId(sp) && sp !== String(c.user.id)) { invRef = P(sp); inv = await getVal(invRef); }
    const ok = !!(inv && (inv.referrals || []).length < 3000);
    // create-if-absent, atomically on the player node (was one Firestore tx
    // together with the inviter's referral append — see PORT_NOTES.md)
    const created = await txUpdate(ref, (cur) => {
      if (cur !== null) return { skip: true, out: false };
      return { value: newPlayer(c.user, { deviceHash: dev, invitedBy: ok ? sp : null }), out: true };
    });
    if (created) await assignUserNo(c.user.id); // permanent sequential userNo from meta/counters (see assignUserNo)
    if (created && ok) await attributeReferral(c.user, sp, dev);
  }
  await noteSignals(String(c.user.id), clientKeys(c.body.fp));
  // Multi-account detection (report-only): refresh this player's linked
  // accounts. The links accumulate silently — no alert is sent (owner
  // order 2026-11-14; the owner reads them via /multi). Strictly
  // best-effort — wrapped so it can never fail, block or delay state.
  // Load diet (owner order 2026-11-15): the recompute reads the whole
  // device/fingerprint registries, so it runs at most once per
  // MULTI_CHECK_MS per player — or immediately when the presented
  // device changed — instead of on every single state call. The
  // stored links a /multi report or a withdrawal card reads can
  // therefore lag a few minutes behind a brand-new link.
  const devKey = clean(c.body._deviceId, 128) || dev; // the device identity the link detection actually keys on (the AntiFraud deviceId, legacy deviceHash as fallback)
  const multiDue = !existing || !!(devKey && devKey !== (existing.multiDeviceKey || '')) || Date.now() - (Number(existing.multiCheckedAt) || 0) > MULTI_CHECK_MS;
  if (multiDue) {
    try { await updateMultiLinks(String(c.user.id), c.body); } catch (e) { console.error('multiLinks', e.message); }
    ref.update({ multiCheckedAt: Date.now(), ...(devKey ? { multiDeviceKey: devKey } : {}) }).catch(() => {});
  }
  const [player, wds] = await Promise.all([getVal(ref), withdrawalsOfUser(c.user.id)]);
  // Lazy userNo heal for pre-feature (legacy) records: assignUserNo
  // only runs at record creation and ensureUserNo only inside the
  // verify flow, so a player created before userNo existed kept
  // userNo 0 forever — and every userNo-gated surface in the app
  // (avatar picker, Mine verification state, the ZM-<userNo>
  // verify comment) silently skipped him (live case 2026-11-15:
  // RaseenRacing_Support + ABO MALAZ browsed unverified with a gold
  // COLLECT button). state() is the one action every session calls,
  // so the record heals here on its next open and THIS response
  // already carries the number. No-op for everyone else.
  if (player && !(Number(player.userNo) > 0)) {
    const healedNo = await ensureUserNo(c.user.id);
    if (healedNo) player.userNo = healedNo;
  }
  // Expose the bot's REAL username (getMe, cached) so the bio task shows and
  // verifies the right handle; falls back to the settings value inside
  // resolveBotUsername, and publicConfig's copy is kept when both are empty.
  const botUsername = await resolveBotUsername(c.cfg);
  const pub = publicPlayer(player);
  // Compatibility for older frontends: agedHold now mirrors the
  // player's current stored hold; no aged-hold judgment is computed.
  if (player) pub.agedHold = Number(player.hold) || 0;
  return { player: pub, settings: { ...publicConfig(c.cfg), ...(botUsername ? { botUsername } : {}) }, withdrawals: wds, now: Date.now() };
}

/* Avatar choice (owner order 2026-11-14): at first registration the
   player picks one of the 8 painted avatars; the choice is stored on
   the player record and mirrored onto the inviter's referral entry
   (syncRefAvatar) — it replaces the Telegram photo everywhere the app
   shows the player (profile card, Friends lists). Re-picking is
   allowed (harmless, idempotent) but the app only offers it once. */
async function setAvatar(c) {
  const n = Number(c.body.n);
  if (!Number.isInteger(n) || n < 1 || n > 8) fail(400, 'Bad avatar');
  const ref = await ensurePlayer(c);
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    // Owner order 2026-11-14: the warrior is chosen ONCE, forever.
    if (Number.isInteger(d.avatar) && d.avatar >= 1 && d.avatar <= 8) return { error: new Fail(409, 'Avatar already chosen') };
    return { value: { ...d, avatar: n }, out: { success: true, avatar: n } };
  });
  await syncRefAvatar(c.user.id, n);
  return out;
}

/* ---------- mining levels («packages»): server mirror of the app table ----------
   The levels live in the frontend (customLevels in the frontend index.html) — LEVEL_DEFS below is a value-for-value copy of that
   array and the two MUST stay in sync: collect() pays the player's
   REAL level rate from this table (owner order 2026-11-14 — profit
   follows the package your hold puts you in, not a flat rate).
   buildLevelsTable() replicates the frontend's rebuildLevelsTable()
   operation for operation: levels 1-30 take LEVEL_DEFS scaled by
   cfg.lvl1PerDay (scale = lvl1PerDay/250, perDay kept to 2dp);
   levels 31-100 derive recursively from level 30 (reqHold ×1.15,
   perDay ×1.12, both Math.round). levelPerDay() replicates
   getCurrentLevelObj: the highest level whose reqHold <= hold,
   iterating ascending and stopping at the first level that fails.
   The hold is the player's synced on-chain hold (player.hold — the
   same value state() ships and the app itself tiers on). */
const LEVEL_DEFS = [
  { req: 0, day: 250 }, { req: 400, day: 300 }, { req: 2500, day: 500 }, { req: 5000, day: 750 },
  { req: 10000, day: 1000 }, { req: 14000, day: 1200 }, { req: 20000, day: 1500 }, { req: 24000, day: 1800 },
  { req: 30000, day: 2500 }, { req: 36000, day: 2800 }, { req: 44000, day: 3200 }, { req: 52000, day: 3600 },
  { req: 62000, day: 4100 }, { req: 74000, day: 4700 }, { req: 88000, day: 5400 }, { req: 104000, day: 6200 },
  { req: 122000, day: 7100 }, { req: 142000, day: 8100 }, { req: 164000, day: 9200 }, { req: 190000, day: 10500 },
  { req: 220000, day: 12000 }, { req: 252000, day: 13600 }, { req: 288000, day: 15400 }, { req: 328000, day: 17400 },
  { req: 372000, day: 19600 }, { req: 420000, day: 22000 }, { req: 472000, day: 24600 }, { req: 528000, day: 27400 },
  { req: 588000, day: 30400 }, { req: 652000, day: 33600 }
];
function buildLevelsTable(cfg) {
  const scale = (Number(cfg && cfg.lvl1PerDay) || 250) / 250;
  const table = [];
  for (let i = 1; i <= 100; i++) {
    let reqHold, perDay;
    if (i <= 30) {
      reqHold = LEVEL_DEFS[i - 1].req;
      perDay = +(LEVEL_DEFS[i - 1].day * scale).toFixed(2);
    } else {
      const prevLvl = table[i - 2];
      reqHold = Math.round(prevLvl.reqHold * 1.15);
      perDay = Math.round(prevLvl.perDay * 1.12);
    }
    table.push({ level: i, reqHold, perDay });
  }
  return table;
}
function levelPerDay(table, hold) {
  let cur = table[0];
  for (const l of table) { if (hold >= l.reqHold) cur = l; else break; }
  return cur.perDay;
}

async function collect(c) {
  requireAdGate(c);
  const ref = await ensurePlayer(c);
  // The table is built ONCE per call, outside the transaction: the
  // txUpdate callback may re-run under contention, so inside it the
  // rate is a pure function of this table + the fresh chain read
  // taken just below (the same pattern holdTask uses).
  const levels = buildLevelsTable(c.cfg);
  const p = await getVal(ref);
  if (!p) fail(404, 'User not found'); // unreachable after ensurePlayer; kept as a guard
  if (p.banned === true) fail(403, 'Account banned');
  if (!p.walletAddr) fail(403, 'Verify your wallet first');
  /* Fresh-hold mining (owner order 2026-11-24, closing the
     phantom-hold exploit): the mining rate is judged on a FRESH
     on-chain read of the player's VERIFIED wallet — never the
     stored `hold`, which a bad chain read or a stale sync could
     inflate (the kishan_verma / RAJ case: 92k–166k mined against
     wallets that never held more than ~2,500 ZOM). Mining requires
     a VERIFIED wallet (owner order 2026-11-15), and the verified
     wallet must be the currently bound wallet — checked here AND
     again inside the credit transaction against the exact address
     the chain read used. A chain-read failure fails CLOSED (503,
     nothing credited, the mining clock is left untouched). */
  const raw = p.walletAddr;
  if (p.walletVerified !== true || (p.verifiedWallet || '') !== raw) fail(403, 'Verify your wallet first');
  let freshHold;
  try { freshHold = await jettonHold(raw); } catch (e) { fail(503, 'Hold check failed, please try again'); }
  if (!Number.isFinite(freshHold)) fail(503, 'Hold check failed, please try again');
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (d.walletVerified !== true || (d.verifiedWallet || '') !== raw || (d.walletAddr || '') !== raw) return { error: new Fail(403, 'Verify your wallet first') };
    const now = Date.now();
    const elapsed = Math.max(0, (now - (Number(d.lastCollectTime) || now)) / 1000);
    if (elapsed < MIN_COLLECT_SEC) return { error: new Fail(400, 'Wait 10 seconds') };
    const added = Math.min(86400, elapsed) * (levelPerDay(levels, freshHold) / 86400);
    return {
      value: { ...d, mined: (Number(d.mined) || 0) + added, earnMining: (Number(d.earnMining) || 0) + added, lastCollectTime: now, hold: freshHold, holdCheckedAt: now },
      out: { added, inviterId: d.invitedBy && d.refBonusPaid ? String(d.invitedBy) : null }
    };
  });
  if (out.inviterId) {
    // the inviter's commission was written in the same Firestore transaction;
    // here it is a second transaction right after (see PORT_NOTES.md)
    await txUpdate(P(out.inviterId), (inv) => {
      if (inv === null || inv.banned === true) return { skip: true };
      const cut = out.added * (Number(c.cfg.refClaimPercent) || 0) / 100;
      const refs = (inv.referrals || []).map((r) => (String(r.id) === String(c.user.id) ? { ...r, profit: (Number(r.profit) || 0) + cut } : r));
      return { value: { ...inv, pendingRefComm: (Number(inv.pendingRefComm) || 0) + cut, referrals: refs } };
    });
  }
  return { success: true, added: out.added };
}

async function daily(c) {
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const now = Date.now(), today = dayOf(now), last = dayOf(d.lastDailyCheckIn || 0);
    if (today === last) return { error: new Fail(400, 'Already claimed today') };
    const streak = last === today - 1 ? ((d.dailyStreak || 0) % 40) + 1 : 1;
    const reward = DAILY[streak - 1];
    return {
      value: { ...d, dailyStreak: streak, lastDailyCheckIn: now, mined: (Number(d.mined) || 0) + reward, earnDaily: (Number(d.earnDaily) || 0) + reward },
      out: { success: true, reward, streak }
    };
  });
}

/* Channel tasks (owner order 2026-11-17): RENEWABLE every 24 hours —
   no longer one-time. Each claim stamps taskNAt; a re-claim inside
   24 h of the last claim is refused, and once 24 h have passed the
   task can be claimed again (membership is re-verified on every
   claim, as before). Legacy migration: a player who claimed before
   this feature has taskNDone=true but NO taskNAt — he is claimable
   immediately ONCE (no migration timestamp is invented), and from
   that claim on, the 24 h cycle runs off taskNAt. taskNDone stays
   set (the app paints claimed/renewing state from the pair). */
async function task(c) {
  const n = Number(c.body.n);
  if (n !== 1 && n !== 2 && n !== 3) fail(400, 'Bad task');
  const ref = await ensurePlayer(c);
  // REAL membership verification through the bot (getChatMember) before any
  // reward: not a member -> 403; the check itself unavailable (bot not in
  // the channel / bad channel config) -> 503, fail CLOSED with a distinct
  // error so the owner can tell the two apart. (Previously an unverifiable
  // channel silently PASSED the check and the reward was granted on the
  // client's say-so.)
  const m = await memberStatus(c.cfg['channel' + n], c.user.id);
  if (m === 'not-member') fail(403, 'Join the channel first');
  if (m === 'unknown') fail(503, 'Channel check unavailable — bot must be an admin in the channel');
  const key = 'task' + n + 'Done';
  const atKey = 'task' + n + 'At';
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const now = Date.now();
    const lastAt = Number(d[atKey]) || 0;
    if (lastAt && now - lastAt < 86400000) return { error: new Fail(400, 'Already claimed — task renews every 24 hours') };
    const reward = Number(c.cfg.taskReward) || 50;
    return {
      value: { ...d, [key]: true, [atKey]: now, mined: (Number(d.mined) || 0) + reward, earnTasks: (Number(d.earnTasks) || 0) + reward },
      out: { success: true, reward, nextAt: now + 86400000 }
    };
  });
}

/* X (Twitter) follow task (owner order 2026-11-23): same shape as the
   channel tasks — pays cfg.taskReward, renewable every 24 h — but an X
   follow cannot be verified through the Telegram bot, so the claim is
   gated on a server-stamped visit: taskXVisit stamps taskXVisitAt when
   the player opens the X page from inside the app, and the claim
   requires that stamp to be at least 10 s old (time to actually hit
   Follow) and no older than 10 min. The 24 h timer is re-checked
   inside the credit transaction, like the channel tasks. */
async function taskXVisit(c) {
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    return { value: { ...d, taskXVisitAt: Date.now() }, out: { success: true } };
  });
}
async function taskX(c) {
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const now = Date.now();
    const lastAt = Number(d.taskXAt) || 0;
    if (lastAt && now - lastAt < 86400000) return { error: new Fail(400, 'Already claimed — task renews every 24 hours') };
    const visitAt = Number(d.taskXVisitAt) || 0;
    if (!visitAt || now - visitAt < 10000) return { error: new Fail(403, 'Open the X page first, follow, then claim') };
    if (now - visitAt > 600000) return { error: new Fail(403, 'Visit expired — open the X page again') };
    const reward = Number(c.cfg.taskReward) || 50;
    return {
      value: { ...d, taskXDone: true, taskXAt: now, taskXVisitAt: 0, mined: (Number(d.mined) || 0) + reward, earnTasks: (Number(d.earnTasks) || 0) + reward },
      out: { success: true, reward, nextAt: now + 86400000 }
    };
  });
}

const HOLD_DEFS_FALLBACK = [ { hold: 1250, reward: 300 }, { hold: 2500, reward: 500 }, { hold: 5000, reward: 1000 }, { hold: 10000, reward: 1500 }, { hold: 20000, reward: 2500 } ];
function holdDefsOf(cfg) { return (Array.isArray(cfg && cfg.holdTaskDefs) && cfg.holdTaskDefs.length) ? cfg.holdTaskDefs : HOLD_DEFS_FALLBACK; }
function holdRenewMs(cfg) { const d = Number(cfg && cfg.holdRenewDays); return (Number.isFinite(d) && d > 0 ? d : 7) * 86400000; }
function lastHoldClaimAt(p) { const m = (p && p.holdTaskAt) || {}; let last = 0; for (const k of Object.keys(m)) { const v = Number(m[k]) || 0; if (v > last) last = v; } return last; }
function highestHoldTier(defs, hold) { let h = 0; for (let i = 0; i < defs.length; i++) { if (hold >= Number(defs[i].hold)) h = i + 1; } return h; }
/* Hold tasks (owner order 2026-11-17; top-tier-only + weekly
   renewal owner order 2026-11-19; current-hold judgment owner
   order 2026-11-20): five tiers in cfg.holdTaskDefs. A claim pays
   ONLY the highest tier the player's CURRENT hold qualifies for
   (owner: «اللي محتفظ بـ20,000 ياخد مكافأة المستوى الخامس بس
   (2,500) بدل مجموع الخمسة (5,800)»). One claim stamps every tier
   (holdTaskAt) and claims renew every cfg.holdRenewDays days
   (default 7), shared across tiers. The hold is read FRESH from
   the chain at claim time — never the stored/synced `hold`, which
   may be stale: a player who sold after the last sync must not be
   paid for coins he no longer holds. A chain read failure fails
   CLOSED (503, nothing granted); the tier timer is re-checked
   inside the credit transaction so two racing claims cannot both
   win. On success the fresh hold is also written back to the
   record, like a wallet sync would. */

/* ---------- Adsgram ads (owner order 2026-11-19) ----------
   Two flows, both built on server-issued single-use tickets (the
   VOLT model the owner pointed at):
   1) REWARD ads (Tasks page): adTicket{purpose:'reward'} -> the
      client shows the ad -> adClaim{ticket} pays adReward coins,
      at most adDailyLimit per day. The ticket is random, bound to
      this user, deleted by ANY claim attempt, and worthless until
      it has aged adMinWatchSec — so a script replaying the claim
      request gets nothing: no ticket, no pay; a forged ticket, no
      pay; the same ticket twice, no pay; too fast, no pay.
   2) GATE ads: the big money buttons (collect / refAch /
      withdraw) run only with a fresh 'gate' ticket
      (requireAdGate), earned the same way and aged at least
      adGateMinSec. The Tasks-page claims (daily / task /
      holdTask) were UNGATED by owner order 2026-11-19 — no
      forced ad on tasks.
   AD_GATE_DISABLED=1 in the server ENVIRONMENT (never settable
   by a request) exists only so the local API test suites, which
   drive the API without a browser, can run; production never
   sets it. adsEnabled=0 in settings disables everything. */
const AD_TICKET_TTL_MS = 10 * 60 * 1000;
const adTickets = new Map(); // ticket -> { uid, purpose, at }
const AD_GATE_DISABLED = process.env.AD_GATE_DISABLED === '1';
function adsOn(cfg) { return Number(cfg && cfg.adsEnabled) !== 0; }
function adSweep(now) { for (const [t, r] of adTickets) { if (now - r.at > AD_TICKET_TTL_MS) adTickets.delete(t); } }
function issueAdTicket(uid, purpose, cfg) {
  if (!adsOn(cfg)) fail(503, 'Ads are disabled');
  const now = Date.now(); adSweep(now);
  const ticket = crypto.randomBytes(18).toString('hex');
  adTickets.set(ticket, { uid: String(uid), purpose, at: now });
  return ticket;
}
function takeAdTicket(c, purpose, minAgeMs) {
  const t = String((c.body && (c.body.adGate || c.body.ticket)) || '');
  const rec = t ? adTickets.get(t) : null;
  if (!rec) fail(403, 'Watch the ad first');
  adTickets.delete(t); // single-use: consumed by ANY presentation
  if (rec.uid !== String(c.user.id) || rec.purpose !== purpose) fail(403, 'Watch the ad first');
  const age = Date.now() - rec.at;
  if (age < minAgeMs) fail(400, 'Watch the full ad first');
  if (age > AD_TICKET_TTL_MS) fail(400, 'Ad session expired, try again');
}
/* No-fill waiver (owner order 2026-11-19): when Adsgram itself
   has no ad to serve (its show() promise REJECTS — an ad closed
   early RESOLVES with done:false and never qualifies), the gated
   action may proceed once without an ad. The waiver is issued
   by the server against a real gate ticket the client already
   holds (the ticket is consumed by the exchange), is bound to
   the user, single-use, short-lived, and rate-limited per user
   — it rescues genuine no-fill periods without becoming a
   general bypass. The reward flow never accepts a waiver:
   no ad shown, no ad reward. */
const AD_WAIVER_TTL_MS = 10 * 60 * 1000;
const AD_WAIVER_MAX_PER_HOUR = 20;
const adWaivers = new Map(); // token -> { uid, at }
const adWaiverUse = new Map(); // uid -> [timestamps]
function takeAdWaiver(c) {
  const t = String((c.body && c.body.adWaiver) || '');
  const rec = t ? adWaivers.get(t) : null;
  if (!rec) return false;
  adWaivers.delete(t); // single-use: consumed by ANY presentation
  if (rec.uid !== String(c.user.id)) return false;
  if (Date.now() - rec.at > AD_WAIVER_TTL_MS) return false;
  return true;
}
async function adNoFill(c) {
  if (!adsOn(c.cfg)) fail(503, 'Ads are disabled');
  const t = String((c.body && c.body.ticket) || '');
  const rec = t ? adTickets.get(t) : null;
  if (!rec) fail(403, 'Watch the ad first');
  adTickets.delete(t); // the gate ticket is spent on the exchange
  if (rec.uid !== String(c.user.id) || rec.purpose !== 'gate') fail(403, 'Watch the ad first');
  const uid = String(c.user.id), now = Date.now();
  const uses = (adWaiverUse.get(uid) || []).filter(x => now - x < 3600000);
  if (uses.length >= AD_WAIVER_MAX_PER_HOUR) fail(429, 'Too many ad issues, try later');
  uses.push(now); adWaiverUse.set(uid, uses);
  const waiver = crypto.randomBytes(18).toString('hex');
  adWaivers.set(waiver, { uid, at: now });
  return { success: true, waiver };
}
function requireAdGate(c) {
  if (AD_GATE_DISABLED || !adsOn(c.cfg)) return;
  if (c.body && c.body.adWaiver) { if (takeAdWaiver(c)) return; fail(403, 'Watch the ad first'); }
  takeAdTicket(c, 'gate', (Number(c.cfg.adGateMinSec) > 0 ? Number(c.cfg.adGateMinSec) : 5) * 1000);
}
async function adTicket(c) {
  const purpose = String((c.body && c.body.purpose) || 'gate');
  if (purpose !== 'gate' && purpose !== 'reward') fail(400, 'Bad purpose');
  if (purpose === 'reward') {
    const ref = await ensurePlayer(c); const p = await getVal(ref);
    if (!p) fail(404, 'User not found');
    if (p.banned === true) fail(403, 'Account banned');
    const limit = Number(c.cfg.adDailyLimit) > 0 ? Number(c.cfg.adDailyLimit) : 10;
    const used = (Number(p.adsDay) === dayOf(Date.now())) ? (Number(p.adsDayCount) || 0) : 0;
    if (used >= limit) fail(400, 'Daily ad limit reached');
    return { success: true, ticket: issueAdTicket(c.user.id, 'reward', c.cfg), adsLeft: limit - used };
  }
  return { success: true, ticket: issueAdTicket(c.user.id, 'gate', c.cfg) };
}
async function adClaim(c) {
  if (!adsOn(c.cfg)) fail(503, 'Ads are disabled');
  const ref = await ensurePlayer(c);
  const p = await getVal(ref);
  if (!p) fail(404, 'User not found');
  if (p.banned === true) fail(403, 'Account banned');
  takeAdTicket(c, 'reward', (Number(c.cfg.adMinWatchSec) > 0 ? Number(c.cfg.adMinWatchSec) : 15) * 1000);
  const reward = Number(c.cfg.adReward) > 0 ? Number(c.cfg.adReward) : 5;
  const limit = Number(c.cfg.adDailyLimit) > 0 ? Number(c.cfg.adDailyLimit) : 10;
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const today = dayOf(Date.now());
    const used = (Number(d.adsDay) === today) ? (Number(d.adsDayCount) || 0) : 0;
    if (used >= limit) return { error: new Fail(400, 'Daily ad limit reached') };
    return {
      value: { ...d, adsDay: today, adsDayCount: used + 1, mined: (Number(d.mined) || 0) + reward, earnTasks: (Number(d.earnTasks) || 0) + reward },
      out: { success: true, reward, adsLeft: limit - used - 1 }
    };
  });
}

async function holdTask(c) {
  const defs = holdDefsOf(c.cfg);
  const tier = Number(c.body.tier);
  if (!Number.isInteger(tier) || tier < 1 || tier > defs.length) fail(400, 'Bad task');
  const def = defs[tier - 1];
  if (!(Number(def && def.hold) > 0) || !(Number(def && def.reward) > 0)) fail(500, 'Server error');
  const ref = await ensurePlayer(c);
  const p = await getVal(ref);
  if (!p) fail(404, 'User not found'); // unreachable after ensurePlayer; kept as a guard
  if (p.banned === true) fail(403, 'Account banned');
  if (!p.walletAddr) fail(400, 'Connect wallet first');
  /* Wallet-ownership proof (owner order 2026-11-18, closing the
     bind-any-address exploit): hold tasks pay ONLY against the
     player's VERIFIED wallet. Binding an address is just a string in
     a request — anyone could bind a rich wallet they do not control
     and claim every tier against its balance (the Lyass_21 / Adam
     cases). The 0.05 TON verification payment FROM the wallet is the
     only proof of control, so an unverified binding earns nothing
     here. The same check is repeated inside the credit transaction
     below against the exact address the chain read used. */
  const raw = p.walletAddr;
  if (p.walletVerified !== true || (p.verifiedWallet || '') !== raw) fail(403, 'Verify your wallet first');
  /* Current-hold gate: this claim's fresh on-chain read is the
     amount judged against the tiers. The verified-wallet check and
     the shared renewal are re-checked inside the credit
     transaction below. */
  const renewMs = holdRenewMs(c.cfg);
  const renewDays = Math.round(renewMs / 86400000);
  /* Shared renewal (owner order 2026-11-19): a claim pays ONCE for
     all tiers — the highest tier the current hold qualifies for — so
     the renewal is judged on the LAST claim of ANY tier. */
  const lastAt = lastHoldClaimAt(p);
  if (lastAt && Date.now() - lastAt < renewMs) fail(400, 'Task renews every ' + renewDays + ' days');
  let hold;
  try { hold = await jettonHold(raw); } catch (e) { fail(503, 'Hold check failed, please try again'); }
  if (hold < Number(defs[0].hold)) fail(403, 'Hold at least ' + Number(defs[0].hold).toLocaleString('en-US') + ' $ZOM in your wallet');
  const top0 = highestHoldTier(defs, hold);
  if (top0 < 1) fail(403, 'Hold at least ' + Number(defs[0].hold).toLocaleString('en-US') + ' $ZOM in your wallet');
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if ((d.walletAddr || '') !== raw || d.walletVerified !== true || (d.verifiedWallet || '') !== raw) return { error: new Fail(403, 'Verify your wallet first') };
    const now = Date.now();
    const at = lastHoldClaimAt(d);
    if (at && now - at < renewMs) return { error: new Fail(400, 'Task renews every ' + renewDays + ' days') };
    const top = highestHoldTier(defs, hold);
    if (top < 1) return { error: new Fail(403, 'Hold at least ' + Number(defs[0].hold).toLocaleString('en-US') + ' $ZOM in your wallet') };
    const reward = Number(defs[top - 1].reward);
    const stamps = { ...(d.holdTaskAt || {}) };
    for (let i = 1; i <= defs.length; i++) stamps[i] = now;
    return {
      value: { ...d, holdTaskAt: stamps, hold, mined: (Number(d.mined) || 0) + reward, earnTasks: (Number(d.earnTasks) || 0) + reward },
      out: { success: true, reward, tier: top, nextAt: now + renewMs }
    };
  });
}

/* Bio task: the player adds the bot's username to their Telegram bio.
   Verified server-side with getChat (the Bot API returns the other party's
   bio for a private chat) against the bot's REAL username (getMe). Like the
   channel tasks this fails CLOSED, with three distinct answers so the
   player always knows the next step:
   - getChat itself fails (Telegram error) → 503, nothing granted.
   - getChat works but the bio is EMPTY/missing → 403 'Bio not visible
     yet': Telegram only exposes a user's bio to a bot the user has
     actually started/messaged, so a Mini-App-only user reads as bio-less
     even if they set one — the fix is to open the bot chat and press
     Start, NOT to edit the bio again.
   - bio present but the username is not in it → 403 'Add the bot
     username to your bio first'.
   Granted once, flag bioTaskDone. The check and the credit are shared
   (checkBio / creditBioReward) with the in-bot /start flow below. */
/* Shared bio check for BOTH verification paths (the API bioTask action
   and the bot's /start flow below): resolves the bot's REAL username and
   reads the user's bio via getChat. Never throws; returns a status:
   'unavailable' (no username resolvable / getChat failed — fail closed),
   'empty' (bio missing or blank), 'mismatch' (bio present without the
   username), 'match'. */
async function checkBio(userId, cfg) {
  const uname = await resolveBotUsername(cfg);
  if (!uname) return { status: 'unavailable', uname: null };
  const j = await tg('getChat', { chat_id: Number(userId) });
  if (!j || !j.ok || !j.result) return { status: 'unavailable', uname };
  const bio = String(j.result.bio || '');
  if (!bio.trim()) return { status: 'empty', uname };
  if (!bio.toLowerCase().includes(uname.toLowerCase())) return { status: 'mismatch', uname };
  return { status: 'match', uname };
}
/* The one and only bio-reward credit path — used by the API action and
   by the bot flow, so both credit identically (cfg.bioReward added to
   mined, bioTaskDone flag) and the transaction guard keeps it
   once-only per player. */
function creditBioReward(userId, cfg) {
  return txUpdate(P(userId), (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (d.bioTaskDone) return { error: new Fail(400, 'Already claimed') };
    const reward = Number(cfg.bioReward) || 50;
    return {
      value: { ...d, bioTaskDone: true, mined: (Number(d.mined) || 0) + reward, earnTasks: (Number(d.earnTasks) || 0) + reward },
      out: { success: true, reward }
    };
  });
}

/* Legacy API path (already-open Mini Apps): same shared check + credit,
   with the original Fail answers preserved verbatim. New clients use
   the in-bot flow below — the card no longer calls this action — but
   cached clients still can, and it stays fully functional. */
async function bioTask(c) {
  await ensurePlayer(c);
  const chk = await checkBio(c.user.id, c.cfg);
  if (chk.status === 'unavailable') fail(503, 'Bio check unavailable — open the bot chat and press Start, then retry');
  if (chk.status === 'empty') fail(403, 'Bio not visible yet — open the bot chat, press Start, then claim again');
  if (chk.status === 'mismatch') fail(403, 'Add the bot username to your bio first');
  return creditBioReward(c.user.id, c.cfg);
}

/* ---------- bot updates: in-bot bio verification (webhook) ----------
   The bot used to be send-only; it now ALSO receives Telegram updates
   through a webhook on this same endpoint, for one job: the in-bot bio
   verification flow (owner decision 2026-11-14 ~03:21). Telegram only
   shows a user's bio to a bot at/after the user's latest interaction
   with the bot, so the in-app Claim often read a stale/empty bio; when
   the user instead opens the bot via the app's deep link and presses
   Start, THAT interaction refreshes the bio and the bot verifies it on
   the spot, granting through the very same creditBioReward() the API
   bioTask action uses.

   Security: setWebhook is self-registered (once per process, by
   ensureWebhook below) with secret_token = first 32 hex chars of
   sha256(BOT_TOKEN); Telegram echoes it in the
   x-telegram-bot-api-secret-token header of every update post and the
   handler answers 401 to anything else. Delivery dedupe: an
   in-process FIFO set of processed update_ids (cap 500) plus the
   bioTaskDone transaction guard make crediting idempotent even if
   Telegram retries a delivery or the set was trimmed. */
const APP_URL = 'https://zombie-mine.vercel.app/';
const WELCOME_IMAGE_URL = 'https://zombie-mine.vercel.app/welcome-banner.webp?v=3'; // ?v=2: the titled banner replaced v1 at the same path; Telegram caches photo-by-URL
const webhookSecret = () => crypto.createHash('sha256').update(BOT_TOKEN || '').digest('hex').slice(0, 32);
let webhookRegistered = false;
function ensureWebhook() {
  if (webhookRegistered || !BOT_TOKEN) return;
  webhookRegistered = true;
  // Fire-and-forget: a failed registration (Telegram down, local stub)
  // must never crash or delay boot; the next process start retries.
  Promise.resolve(tg('setWebhook', {
    url: process.env.PUBLIC_URL || 'https://zombie-api-9x27.duckdns.org/',
    secret_token: webhookSecret(),
    allowed_updates: ['message', 'callback_query']
  })).catch(() => {});
}
const seenUpdateIds = new Set();
function markUpdateSeen(updateId) {
  if (seenUpdateIds.has(updateId)) return false;
  seenUpdateIds.add(updateId);
  while (seenUpdateIds.size > 500) seenUpdateIds.delete(seenUpdateIds.values().next().value); // FIFO trim
  return true;
}

const BIO_TEXTS = {
  en: {
    // AdVOLT-mirrored copy (owner order 2026-11-14): NO name line —
    // header / intro / 3 bullets / closing, one sentence per line.
    // (The name argument is kept for signature parity with ar/ru.)
    welcome: (name) => `🧟 Welcome to ZOMBIE MINER! 🧟\n\nThe dead don't sleep — and the gold buried under their graves is waiting for YOU:\n🪦 Dig up ZOM every day and rise from level 1 to 100.\n🦴 Smash the tasks, crack open the coins, fill your crypt!\n🧟‍♂️ Raise your horde — invite friends, earn 5% of their mining!\n\nTap the button below… and START DIGGING! ⚰️🦇`,
    warrior: 'Zombie',
    openApp: '🧟 Open ZOM',
    payoutsChannel: '💀 Payouts',
    newsChannel: '🦇 News',
    granted: (reward, sym) => `✅ Bio verified! +${reward} ${sym} was dug up and added to your balance.`,
    already: '✅ Your bio is already verified — the reward is already buried in your crypt.',
    instruct: (uname) => `🧟 To verify your bio:\n1. Add @${uname} to your Telegram bio.\n2. Then open this link again and press Start: https://t.me/${uname}?start=bio`,
    retry: '⚠️ The crypt is silent — could not check your bio right now. Rise and try again in a minute.',
    // Wallet-verification success DM (owner order 2026-11-14): sent
    // once, by whichever path completes the verification (the in-app
    // Check button or the background deposit watcher) — the verified
    // badge announcement with the wallet facts.
    verifiedMsg: (o) => `⚰️✅ <b>WALLET VERIFIED!</b> ✅⚰️\n\n🧟 Congratulations, <b>${o.name}</b> — you have RISEN, and your wallet is now <b>VERIFIED</b>! The blue badge glows next to your name everywhere in ZOMBIE MINER! 💀\n\n👛 <b>Wallet:</b> <code>${o.walletShort}</code>\n🗓️ <b>Wallet age:</b> ${o.ageDays} days\n🔢 <b>Your mark:</b> ZOM-${o.userNo}\n📅 <b>Verified on:</b> ${o.date}\n\n🪦 Now DIG, zombie — the whole mine is yours! 🧟‍♂️⚰️`
  },
  ar: {
    welcome: (name) => `🧟🔥 قف أيها الزومبي! 🔥🧟\n\nأهلًا بك يا ${name} في ZOMBIE MINER — هنا الموتى لا ينامون… والذهب المدفون تحت قبورهم لا ينتظر إلا من يجرؤ على الحفر! ⚰️\n\n🪦 في مقبرة الكنوز تبدأ حكايتك: احفر وعدّن ZOM كل ٢٤ ساعة، واصعد من زومبي مبتدئ (المستوى 1) إلى ملك الموتى (المستوى 100)! 💀 كل مستوى يضاعف قوة تعدينك — وقبرك يفيض بالغنائم 💰\n\nطريقك إلى الكنز:\n• 🪦 احفر كل يوم واخطف حصتك قبل غيرك\n• 🪙 اسحق المهام واجمع غنائمها\n• 🧟‍♂️ كوّن قطيعك: ادعُ أصدقاءك واكسب ٥٪ من تعدينهم، للأبد!\n\n💎 اسحب أرباحك إلى محفظة TON — كنز حقيقي في يدك.\n\n🩸 الأحياء يتراجعون. أيها الزومبي… اضغط الزر واحفر! 👇`,
    warrior: 'زومبي',
    openApp: '🧟 افتح التطبيق',
    payoutsChannel: '💀 قناة السحوبات',
    newsChannel: '🦇 قناة الأخبار',
    granted: (reward, sym) => `✅ تم التحقق من البايو! اتضاف +${reward} ${sym} لرصيدك.`,
    already: '✅ البايو بتاعك متحقق منه قبل كده — المكافأة اتضافت خلاص.',
    instruct: (uname) => `📝 عشان يتحقق البايو:\n١. ضيف @${uname} في البايو بتاعك في تيليجرام.\n٢. وبعدين افتح اللينك ده تاني ودوس Start: https://t.me/${uname}?start=bio`,
    retry: '⚠️ مش قادر أتحقق من البايو دلوقتي — جرب تاني بعد دقيقة.'
  },
  ru: {
    welcome: (name) => `🧟🔥 СТОЙ, ЗОМБИ! 🔥🧟\n\nДобро пожаловать, ${name}, в ZOMBIE MINER — мёртвые здесь не спят, а золото под их могилами ждёт лишь тех, кто осмелится копать! ⚰️\n\n🪦 На кладбище сокровищ начинается твоя история: копай и добывай ZOM каждые 24 часа и пройди путь от новичка (уровень 1) до Короля Мёртвых (уровень 100)! 💀 Каждый уровень умножает твою силу добычи — а склеп переполняется добычей 💰\n\nТвой путь к сокровищам:\n• 🪦 Копай каждый день и забирай свою долю первым\n• 🪙 Сокрушай задания и собирай добычу\n• 🧟‍♂️ Собирай свою орду: зови друзей и получай 5% от их добычи, навсегда!\n\n💎 Выводи заработок на свой TON-кошелёк — настоящее сокровище в твоих руках.\n\n🩸 Живые отступают. Зомби… жми кнопку и копай! 👇`,
    warrior: 'зомби',
    openApp: '🧟 Открыть приложение',
    payoutsChannel: '💀 Канал выплат',
    newsChannel: '🦇 Канал новостей',
    granted: (reward, sym) => `✅ Био подтверждено! +${reward} ${sym} добавлено на ваш баланс.`,
    already: '✅ Ваше био уже подтверждено — награда уже была добавлена.',
    instruct: (uname) => `📝 Чтобы подтвердить био:\n1. Добавьте @${uname} в био вашего Telegram.\n2. Затем снова откройте эту ссылку и нажмите Start: https://t.me/${uname}?start=bio`,
    retry: '⚠️ Не удалось проверить био прямо сейчас — попробуйте ещё раз через минуту.'
  }
};
const bioLangOf = (from) => {
  // Owner order 2026-11-14: the bot's language is FIXED to English for
  // everyone — the welcome and all bio replies are always the English
  // texts, whatever the user's Telegram language_code says. The ar/ru
  // text objects above stay in the code untouched for a possible
  // future revert; just restore the language_code selection below.
  void from;
  return 'en';
  // (previous selection, kept for the revert:)
  // const lc = String((from && from.language_code) || '').toLowerCase();
  // return lc.startsWith('ar') ? 'ar' : lc.startsWith('ru') ? 'ru' : 'en';
};

/* ---------- owner-only emoji-harvest tools ----------
   Mirrors the AdVOLT messages bot's admin tools, adapted to this
   server's raw tg() style. Gated STRICTLY to OWNER_ID in a private
   chat (and, like everything on this endpoint, behind the webhook
   secret); anyone else falls through to the normal handling,
   completely untouched. Three tools:
     /emojipack <name> — list every sticker of a t.me/addemoji pack as
                         'char → <code>custom_emoji_id</code>'.
     /emojihunt        — sweep the built-in candidate packs for the
                         WANTED glyphs and report what is still missing.
     (extractor)       — any other owner message that carries custom-
                         emoji entities gets an ID listing back.
   Whenever a WANTED glyph's ID surfaces through ANY of the three, it
   is auto-saved into the RTDB `premiumEmoji` node, so pz() starts
   rendering that glyph premium (animated) everywhere the bot writes. */
const EMOJI_WANTED = ['🦴', '🔥', '⚰', '🦇', '🪦', '🩸', '👇', '🌩', '🎯'];
const EMOJI_WANTED_SET = new Set(EMOJI_WANTED);
const EMOJI_PACK_CANDIDATES = ['RestrictedEmoji']; // Telegram's official animated standard-emoji pack (ex-Telemoji); extend this list to hunt more packs
const bareEmoji = (ch) => String(ch || '').replace(/\uFE0F/g, '');

async function emojiPack(chatId, name) {
  if (!name) {
    await tg('sendMessage', { chat_id: chatId, text: 'Usage: /emojipack <packName> — the name from a t.me/addemoji/<packName> link' });
    return;
  }
  const j = await tg('getStickerSet', { name });
  if (!j || !j.ok || !j.result) {
    await tg('sendMessage', { chat_id: chatId, text: '❌ ' + esc((j && j.description) || 'pack not found') });
    return;
  }
  const stickers = Array.isArray(j.result.stickers) ? j.result.stickers : [];
  const found = {};
  for (const s of stickers) {
    const bare = bareEmoji(s && s.emoji);
    if (bare && EMOJI_WANTED_SET.has(bare) && s.custom_emoji_id) found[bare] = String(s.custom_emoji_id);
  }
  await saveHarvestedEmoji(found);
  const total = stickers.length;
  let lines = stickers.map((s) => `${(s && s.emoji) || '?'} → <code>${s && s.custom_emoji_id}</code>`);
  let truncated = false;
  if (lines.length > 200) { lines = lines.slice(0, 200); truncated = true; }
  const build = () => `🎨 <b>${esc(j.result.title || name)}</b> (${total})\n\n${lines.join('\n')}${truncated ? `\n… (truncated — ${total} stickers in the pack)` : ''}`;
  let body = build();
  while (body.length > 3900 && lines.length > 1) { lines.pop(); truncated = true; body = build(); }
  await tg('sendMessage', { chat_id: chatId, text: body });
}

async function emojiHunt(chatId) {
  const sections = [];
  for (const name of EMOJI_PACK_CANDIDATES) {
    const j = await tg('getStickerSet', { name });
    if (!j || !j.ok || !j.result) {
      sections.push(`🎨 <b>${esc(name)}</b>\n❌ ${esc((j && j.description) || 'pack not found')}`);
      continue;
    }
    const stickers = Array.isArray(j.result.stickers) ? j.result.stickers : [];
    const found = {};
    const lines = [];
    for (const s of stickers) {
      const bare = bareEmoji(s && s.emoji);
      if (bare && EMOJI_WANTED_SET.has(bare) && s.custom_emoji_id) {
        if (!(bare in found)) lines.push(`${s.emoji} → <code>${s.custom_emoji_id}</code>`);
        found[bare] = String(s.custom_emoji_id);
      }
    }
    await saveHarvestedEmoji(found);
    sections.push(`🎨 <b>${esc(j.result.title || name)}</b> — ${lines.length} wanted found\n${lines.join('\n') || '(none of the wanted glyphs in this pack)'}`);
  }
  const have = new Set(Object.keys(harvestedEmoji).map(bareEmoji));
  const missing = EMOJI_WANTED.filter((w) => !have.has(w));
  sections.push(missing.length ? `Still missing: ${missing.join(' ')}` : '✅ All wanted emoji harvested!');
  await tg('sendMessage', { chat_id: chatId, text: sections.join('\n\n') });
}

/* Returns true when a tool consumed the message. Runs BEFORE the
   /start handling. Also dispatched here, under the same admin
   gate: /multi <telegramId> — the on-demand multi-account link tree
   (see multiTree; owner order 2026-11-14) — and /withdrawals, the
   pending-withdrawal review walk (see the withdrawal-review
   section; owner order 2026-11-14). The entity extractor only
   fires when the text does NOT start with '/', so it can never
   swallow the owner's /start, /emojipack, /emojihunt or /multi
   messages. */
async function handleOwnerTools(msg, text) {
  if (!msg.from) return false;
  await getConfig();
  if (!isAdminUid(msg.from.id)) return false;
  const chatId = msg.chat.id;
  if (/^\/emojihunt(@\w+)?(\s|$)/.test(text)) { await emojiHunt(chatId); return true; }
  const pm = /^\/emojipack(@\w+)?(?:\s+(\S+))?/.exec(text);
  if (pm) { await emojiPack(chatId, (pm[2] || '').trim()); return true; }
  const mm = /^\/multi(@\w+)?(?:\s+(.+))?$/.exec(text);
  if (mm) { await multiTree(chatId, (mm[2] || '').trim()); return true; }
  if (/^\/withdrawals(@\w+)?(\s|$)/.test(text)) { await startWdReview(chatId); return true; }
  if (text.startsWith('/')) return false; // commands (incl. /start) never reach the extractor
  const rawText = typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : '');
  const ents = [].concat(msg.entities || [], msg.caption_entities || []);
  const customs = ents.filter((e) => e && e.type === 'custom_emoji' && e.custom_emoji_id);
  if (!customs.length) return false;
  const byId = new Map(); // distinct custom emoji only, first occurrence wins
  for (const e of customs) if (!byId.has(String(e.custom_emoji_id))) byId.set(String(e.custom_emoji_id), e);
  const lines = [];
  const found = {};
  for (const [id, e] of byId) {
    const glyph = rawText.substring(e.offset, e.offset + e.length); // Telegram offsets are UTF-16 code units; JS slicing matches
    lines.push(`${glyph} → <code>${id}</code>`);
    const bare = bareEmoji(glyph);
    if (bare && EMOJI_WANTED_SET.has(bare)) found[bare] = id;
  }
  await saveHarvestedEmoji(found);
  await tg('sendMessage', { chat_id: chatId, text: `🎨 Premium emoji IDs:\n\n${lines.join('\n')}` });
  return true;
}

/* One /start message (private chats only; anything else is ignored).
   Param 'bio' = the dedicated verification flow: always answers with
   the outcome (granted / already / instructions / retry) and is the
   ONLY bot path that checks or credits the bio task. A plain /start
   sends ONE welcome message — the banner photo with the simple
   welcome copy as its caption and the keyboard attached (owner order
   2026-11-14; plain-text fallback only if the photo send fails) —
   and never touches the bio task at all: no check, no credit, no
   grant or 'already verified' note (owner order 2026-11-14: bio
   messages only when the bio task is explicitly requested). A
   matching unclaimed bio is credited only via /start bio or the API
   bioTask action. A message carrying write_access_allowed — first
   contact via the direct app link, where the user never sends
   /start — triggers the same welcome, but ONLY for a genuinely new
   player (owner order 2026-11-14). */

/* The welcome message itself: ONE sendPhoto — the banner photo
   carrying the welcome copy as its caption and the keyboard attached
   (owner order 2026-11-14; the copy is sized to fit Telegram's
   1024-char caption limit). If that send fails (bad photo URL,
   Telegram hiccup), fall back to the plain text message with the
   same copy + keyboard so the greeting is never lost. Shared by
   plain /start and the write_access_allowed trigger below — both
   deliver the identical message. */
async function sendWelcome(chatId, cfg, T, displayName) {
  // Owner-approved welcome layout: Open App alone on row 1; news
  // (cfg.channel1) then payouts (cfg.channel2) side by side on row 2 —
  // AdVOLT's order (News | Payments), owner order 2026-11-14 — each
  // included only when its cfg URL is a non-empty string. tg() attaches
  // the premium button icons and strips the plain label emoji.
  // Row 1 is a plain URL button to the bot's own app link
  // (https://t.me/<bot>/app), NOT a web_app button: Telegram renders a
  // web_app button as a detached bar under the message, while a URL
  // button renders glued to the message as a classic inline keyboard —
  // the AdVOLT welcome look (owner order 2026-11-14). The username is
  // resolved at runtime via resolveBotUsername (getMe-cached); only if
  // it cannot be resolved do we fall back to the web_app button, so
  // the Open button never breaks.
  const botUname = await resolveBotUsername(cfg);
  const openBtn = botUname
    ? { text: T.openApp, url: `https://t.me/${botUname}/app` }
    : { text: T.openApp, web_app: { url: APP_URL } };
  const rows = [[openBtn]];
  const channelRow = [];
  if (typeof cfg.channel1 === 'string' && cfg.channel1.trim()) channelRow.push({ text: T.newsChannel, url: cfg.channel1 });
  if (typeof cfg.channel2 === 'string' && cfg.channel2.trim()) channelRow.push({ text: T.payoutsChannel, url: cfg.channel2 });
  if (channelRow.length) rows.push(channelRow);
  const welcomeKb = { inline_keyboard: rows };
  const photoRes = await tg('sendPhoto', {
    chat_id: chatId, photo: WELCOME_IMAGE_URL, caption: T.welcome(displayName),
    reply_markup: welcomeKb
  });
  if (!photoRes || !photoRes.ok) {
    await tg('sendMessage', {
      chat_id: chatId, text: T.welcome(displayName),
      reply_markup: welcomeKb
    });
  }
}

async function handleBotMessage(msg) {
  if (!msg || !msg.from || !msg.chat || msg.chat.type !== 'private') return;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  // Owner-only emoji-harvest tools run BEFORE the /start handling and
  // consume the message when they fire. For everyone else — and for the
  // owner's own /start — they are completely silent (see handleOwnerTools).
  if (await handleOwnerTools(msg, text)) return;
  const from = msg.from;
  if (!/^\d+$/.test(String(from.id))) return;
  const chatId = msg.chat.id;
  // Owner-only maintenance (owner order 2026-11-14): while
  // settings/global.ownerOnly is on, a non-owner gets the update
  // notice instead of the welcome / bio flow. Owner unaffected.
  {
    const cfgM = await getConfig();
    const ownerOnlyLiveM = await getVal(rtdb().ref('settings/global/ownerOnly')); // fresh, like the API gate — the emergency brake never waits for the config cache
    if (ownerOnlyLiveM === true && !isTesterUid(String(from.id), cfgM)) {
      try { await tg('sendMessage', { chat_id: chatId, text: '🧟🔧 The mine is being re-dug — ZOMBIE MINER is updating right now. Rise again in a few minutes!' }); } catch (e) { /* the notice is best-effort */ }
      return;
    }
  }
  // First contact via the DIRECT APP LINK: those users never send
  // /start, so Telegram's write_access_allowed service message — sent
  // when the user grants the Mini App write access (the app requests
  // it on launch) and carrying NO text — is their welcome trigger, and
  // it is handled here, BEFORE the text//start gate below. The welcome
  // goes out ONLY for a genuinely new player: read the player first,
  // create after the check (ensurePlayer does not report creation).
  // An existing player re-granting access hears nothing at all.
  // (Owner order 2026-11-14.)
  if (msg.write_access_allowed) {
    const cfgW = await getConfig();
    const existed = (await getVal(P(from.id))) !== null;
    await ensurePlayer({ user: from, body: {} }); // same creation path as the API actions
    if (!existed) {
      const TW = BIO_TEXTS[bioLangOf(from)];
      await sendWelcome(chatId, cfgW, TW, esc(String(from.first_name || '').trim() || TW.warrior));
    }
    return;
  }
  if (!text.startsWith('/start')) return;
  const parts = text.split(/\s+/);
  if (!/^\/start(@[A-Za-z0-9_]+)?$/.test(parts[0])) return;
  const param = parts[1] || '';
  const cfg = await getConfig();
  await ensurePlayer({ user: from, body: {} }); // same creation path as the API actions
  // A /start that carries a referral param (ref_<id>) attributes the
  // fresh record right here — the same fresh-account rule as state()'s
  // late attribution — so a bot-first contact never burns the referral.
  const refM = /^ref_(\d+)$/.exec(param);
  if (refM && refM[1] !== String(from.id)) {
    try {
      const meS = await getVal(P(from.id));
      if (meS && !meS.invitedBy && Date.now() - (Number(meS.createdAt) || 0) < 86400000 && !(Number(meS.mined) > 0)) {
        const invS = await getVal(P(refM[1]));
        if (invS && (invS.referrals || []).length < 3000) {
          const setS = await txUpdate(P(from.id), (cur) => {
            if (cur === null || cur.invitedBy) return { skip: true, out: false };
            return { value: { ...cur, invitedBy: refM[1] }, out: true };
          });
          if (setS) await attributeReferral(from, refM[1], '');
        }
      }
    } catch (e) { console.error('startRef', e.message); }
  }
  const T = BIO_TEXTS[bioLangOf(from)];
  if (param !== 'bio') {
    // The EN caption no longer interpolates the name (AdVOLT-style copy,
    // owner order 2026-11-14); displayName is still composed — escaped —
    // because the ar/ru texts kept in the file for a possible revert do
    // use it. tg() runs pz() over the caption, which only wraps emoji.
    await sendWelcome(chatId, cfg, T, esc(String(from.first_name || '').trim() || T.warrior));
    return;
  }
  // '/start bio' only from here on: the one bot path that checks the
  // bio and credits the reward.
  const chk = await checkBio(from.id, cfg);
  let outcome = chk.status, reward = 0;
  if (chk.status === 'match') {
    try {
      const r = await creditBioReward(from.id, cfg);
      outcome = 'granted'; reward = r.reward;
    } catch (e) {
      outcome = (e instanceof Fail && e.message === 'Already claimed') ? 'already' : 'unavailable';
    }
  }
  if (outcome === 'granted') await tg('sendMessage', { chat_id: chatId, text: T.granted(reward, cfg.coinSym) });
  else if (outcome === 'already') await tg('sendMessage', { chat_id: chatId, text: T.already });
  else if (outcome === 'unavailable') await tg('sendMessage', { chat_id: chatId, text: T.retry });
  else await tg('sendMessage', { chat_id: chatId, text: T.instruct(chk.uname) }); // 'empty' or 'mismatch'
}

/* Referral achievements: milestones for ACTIVE (verified) referrals only.
   The count is recomputed inside the player transaction on the freshest
   referrals array — 'Pending ⏳'/'⚠️ Duplicate' entries never count — and
   each milestone can be claimed exactly once (refAchClaimed[n] = timestamp
   is the dedupe memory). */
const REF_ACH_MILESTONES = [1, 10, 25, 50, 100];
async function refAch(c) {
  const n = Number(c.body.n);
  if (!REF_ACH_MILESTONES.includes(n)) fail(400, 'Bad milestone');
  requireAdGate(c);
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (countActiveRefs(d.referrals) < n) return { error: new Fail(400, 'Not enough active referrals') };
    const claimed = (d.refAchClaimed && typeof d.refAchClaimed === 'object') ? d.refAchClaimed : {};
    if (claimed[n]) return { error: new Fail(400, 'Already claimed') };
    const reward = Number(c.cfg['refAchReward' + n]) || 0;
    return {
      value: { ...d, mined: (Number(d.mined) || 0) + reward, earnRef: (Number(d.earnRef) || 0) + reward, refAchClaimed: { ...claimed, [n]: Date.now() } },
      out: { success: true, reward, milestone: n }
    };
  });
}

async function wallet(c) {
  const ref = await ensurePlayer(c); // TonConnect can fire this before state at cold start — never 404 a first-run user
  const p = await getVal(ref);
  if (!p) fail(404, 'User not found'); // unreachable after ensurePlayer; kept as a guard
  if (p.banned === true) fail(403, 'Account banned');
  const raw = c.body.address ? await rawAddress(String(c.body.address).slice(0, 100)) : p.walletAddr;
  if (!raw) fail(400, 'Connect a wallet first');
  /* System wallets can never be bound (owner order 2026-11-24): the
     payout wallet and the verify-deposit wallet belong to the game
     itself. Binding one by address alone is just a string in a
     request, but it made a player's displayed hold/level mirror the
     game's own treasury — reject it outright so the cosmetic hole is
     closed too, not only the paying paths. */
  const sysWallets = [c.cfg.payoutWallet, c.cfg.verifyDepositWallet].filter(Boolean).map(toRawAddress);
  if (sysWallets.includes(raw)) fail(403, 'This wallet cannot be linked');
  /* Idempotent re-sync (round 3, incident 2026-11-14): the 8 s sync
     cooldown guards against bind churn, but a call whose address
     normalises to the wallet ALREADY bound changes nothing — it is
     the same sync retried (the app's own hold-sync button, or a
     re-link attempt for the same wallet after a dropped session).
     Failing it with 429 made a legitimately bound wallet look
     rejected and looped the client. Same-wallet calls therefore run
     the full normal flow below (ownership claim included) minus the
     cooldown failure; binding a DIFFERENT wallet inside the window
     still gets the 429 exactly as before. */
  /* ONE WALLET PER ACCOUNT (owner order 2026-11-23, multi-phone
     glitch): the same Telegram account opened on two phones restored
     a DIFFERENT TonConnect wallet on each phone, and every app open
     silently REBOUND the account to that phone's wallet — the bound
     wallet, the hold and the verification flipped back and forth
     depending on which phone synced last, so one account effectively
     shopped holds across as many wallets as it had phones. A bind
     that names a DIFFERENT wallet while one is already bound is now
     rejected: switching wallets is an explicit act — Disconnect
     (unlink) first, then connect the new wallet. Same-wallet syncs
     and binds onto an empty binding are unaffected. */
  if ((p.walletAddr || '') && raw !== (p.walletAddr || '')) fail(409, 'A different wallet is linked to this account. Disconnect it first to link another wallet.');
  if (raw !== (p.walletAddr || '') && Date.now() - (p.lastSyncAt || 0) < 8000) fail(429, 'Please wait a few seconds');
  /* The chain read must never decide whether a bind succeeds (live
     incident 2026-11-15): under the signup flood, tonapi rate-limits
     this server's single IP and jettonHold throws — and because the
     read sat BEFORE the claim + bind writes, the whole bind was
     rejected and players looped on "Not connected" although
     TonConnect had connected fine. The bind now always persists; the
     hold is best-effort: a fresh read wins; a failed read keeps the
     stored hold for the SAME wallet and falls back to 0 for a
     DIFFERENT wallet (a new wallet is never credited with the old
     one's balance). The next sync corrects the number. */
  let hold = 0, holdFresh = false;
  try { hold = await jettonHold(raw); holdFresh = true; } catch (e) { /* chain read failed — bind anyway */ }
  if (!holdFresh) hold = (raw === (p.walletAddr || '')) ? (Number(p.hold) || 0) : 0;
  const uid = String(c.user.id);
  // claim the wallet node first (the Firestore original checked ownership
  // inside its transaction before writing anything — same net effect here).
  // PERMANENCE APPLIES TO VERIFIED CLAIMS ONLY (revised by owner order
  // 2026-11-18, closing the registry-squatting side of the
  // bind-any-address exploit): a registry node stamped verified:true by
  // completeVerification is permanent — it belongs to that account
  // forever and blocks every other account. A node WITHOUT the verified
  // stamp is only a provisional binding: binding an address is just a
  // string, it proves nothing, so it blocks nobody — the next account
  // to bind the address takes the provisional claim over. (Under the
  // old rule anyone could permanently squat any wallet, including the
  // project's own payout wallet, by merely naming its address.)
  await txUpdate(walletDoc(raw), (w) => {
    if (w === null) return { value: { userId: uid } };
    if (String(w.userId) !== uid) {
      if (w.verified === true) return { error: new Fail(400, 'This wallet is linked to another account') };
      return { value: { userId: uid } };
    }
    return { skip: true };
  });
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    // Wallet verification is bound to ONE wallet (owner order
    // 2026-11-14): binding a DIFFERENT address than the verified one
    // voids the verification — the new wallet must be verified again.
    // Re-syncing the same verified wallet keeps it.
    const voidsVerify = d.walletVerified === true && (d.verifiedWallet || '') !== raw;
    // A pending verification intent belongs to ONE wallet: binding a
    // different address clears it (verifyInfo re-marks it for the new
    // wallet); re-syncing the same wallet keeps it.
    const addrChanged = (d.walletAddr || '') !== raw;
    return {
      value: { ...d, walletAddr: raw, hold, lastSyncAt: holdFresh ? Date.now() : (d.lastSyncAt || 0), ...(voidsVerify ? { walletVerified: false, verifiedWallet: '', verifiedAt: 0, verifyTx: '', lastVerifyTx: d.verifyTx || '' } : {}), ...(addrChanged ? { verifyPendingAt: 0 } : {}) },
      out: { oldAddr: d.walletAddr || '', voided: voidsVerify }
    };
  });
  if (out.voided) await syncRefVerifiedFlag(uid, false);
  // The registry node of the previously bound wallet is deliberately
  // NOT removed here. If that wallet was VERIFIED for this account the
  // node is permanent — it can only ever be re-linked here. If it was
  // never verified the node is a provisional claim that any later
  // binder takes over (see the claim above), so leaving it costs
  // nothing and keeps a re-link by this account seamless.
  // Referral activation is a live state (verified + hold >= minimum):
  // re-evaluate it against the hold/verification this sync just wrote —
  // reaching the minimum activates, dropping below it deactivates.
  await syncReferralActive(uid, c.cfg);
  return { success: true, hold };
}

async function unlink(c) {
  const ref = await ensurePlayer(c);
  const out = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    // Disconnecting voids the wallet verification with the binding
    // (owner order 2026-11-14): a wallet bound later — even the same
    // one — must be verified again.
    const wasVerified = d.walletVerified === true;
    return {
      value: { ...d, walletAddr: '', hold: 0, verifyPendingAt: 0, ...(wasVerified ? { walletVerified: false, verifiedWallet: '', verifiedAt: 0, verifyTx: '', lastVerifyTx: d.verifyTx || '' } : {}) },
      out: { oldAddr: d.walletAddr || '', voided: wasVerified }
    };
  });
  if (out.voided) await syncRefVerifiedFlag(String(c.user.id), false);
  // Unlinking zeroes the hold and voids verification: the referral
  // deactivates (live activation state — see syncReferralActive).
  await syncReferralActive(String(c.user.id), c.cfg);
  // The wallets-registry node is deliberately KEPT: unlinking
  // disconnects the wallet from this account. A VERIFIED node stays
  // registered to this account forever and can only be re-linked
  // here; an unverified node remains a provisional claim in this
  // account's name until another binder takes it over (the claim in
  // wallet() rejects another userId only for verified nodes).
  return { success: true };
}

/* ---------- wallet verification actions (owner order 2026-11-14) ----------
   verifyInfo: everything the Profile verification card needs — the
   player's permanent userNo, the exact payment instructions (deposit
   wallet, fee, comment ZM-<userNo>) and the on-chain age of the
   currently bound wallet.
   verifyCheck: re-validates EVERYTHING server-side and then confirms
   the fee payment on-chain: it scans the deposit wallet's newest
   incoming transactions for one sent FROM the player's bound wallet,
   worth at least the fee (1% tolerance), carrying the EXACT comment,
   whose hash has not been claimed before (verifyClaims/{txHash}).
   On a match it claims the hash, marks the player verified, flags the
   wallets-registry node, and syncs the inviter's referral entry. */
const verifyComment = (userNo) => 'ZOM-' + userNo;
const legacyVerifyComment = (userNo) => 'ZM-' + userNo; // pre-2026-11-21 prefix - still accepted by matchers so payments already sent with it are not lost
async function verifyGatePlayer(c) {
  const ref = await ensurePlayer(c);
  const p = await getVal(ref);
  if (!p) fail(404, 'User not found'); // unreachable after ensurePlayer; kept as a guard
  if (p.banned === true) fail(403, 'Account banned');
  return { ref, p };
}
async function verifyInfo(c) {
  const { ref, p } = await verifyGatePlayer(c);
  const userNo = await ensureUserNo(c.user.id); // lazy assignment for pre-feature players
  if (!userNo) fail(500, 'Server error');
  const wallet = p.walletAddr || '';
  const minAge = Number(c.cfg.verifyMinAgeDays) || 7;
  let ageDays = null;
  if (wallet) ageDays = await walletAgeDays(ref, p, wallet);
  const verified = p.walletVerified === true;
  // Verification intent (owner order 2026-11-14): while a wallet is
  // bound and NOT yet verified, the player is PENDING — the marker is
  // what the background deposit watcher scans for, so a payment sent
  // with the app closed still completes the verification. Set here
  // (the card always loads verifyInfo before offering payment),
  // cleared by completeVerification's flip, by unlink, and by binding
  // a different wallet (see wallet()/unlink()).
  let pending = Number(p.verifyPendingAt) || 0;
  if (wallet && !verified && !pending) {
    pending = Date.now();
    try { await ref.update({ verifyPendingAt: pending }); } catch (e) { /* the marker is advisory; verifyInfo must not fail over it */ }
  } else if ((verified || !wallet) && pending) {
    pending = 0;
    try { await ref.update({ verifyPendingAt: 0 }); } catch (e) { /* advisory, as above */ }
  }
  return {
    userNo,
    depositWallet: String(c.cfg.verifyDepositWallet || ''),
    feeTon: Number(c.cfg.verifyFeeTon) || 0,
    comment: verifyComment(userNo),
    wallet,
    ageDays,
    minAgeDays: minAge,
    ageOk: true, // owner order 2026-11-17: verification is not age-gated (wallet age gates withdrawals instead)
    verified,
    verifiedWallet: p.verifiedWallet || '',
    verifyPending: !!wallet && !verified && pending > 0
  };
}

/* The success messages (owner order 2026-11-14): fired ONCE PER
   PAYMENT, by whichever path wins the verification flip — the
   Verify button's check or the background watcher — never by a
   loser, and never twice for the same payment: completeVerification
   takes the payment's single notification slot (the claim record's
   notifiedAt) before calling this, so a verification that is voided
   (unlink / different-wallet bind) and later re-completed from the
   SAME payment flips the player back to verified silently. The user
   gets the celebratory photo DM (welcome banner + caption,
   premiumized centrally by tg()); the owner gets a deposit alert
   with the tx link. Both are best-effort: a user who never started
   the bot cannot be DM'd, and a message failure must never fail (or
   roll back) a completed verification. */
async function sendVerificationMessages(uid, p, cfg, hash, ageDays) {
  const userNo = Number(p.userNo) || 0;
  try {
    const T = BIO_TEXTS[bioLangOf(null)]; // the bot's language is fixed (see bioLangOf)
    const caption = T.verifiedMsg({
      name: esc(p.name || 'Zombie'),
      walletShort: esc(shortFriendlyAddress(p.walletAddr || '')),
      ageDays: ageDays === null || ageDays === undefined ? '—' : Number(ageDays),
      userNo,
      date: fmtDayMonYear(Date.now())
    });
    const photoRes = await tg('sendPhoto', { chat_id: uid, photo: WELCOME_IMAGE_URL, caption });
    if (!photoRes || !photoRes.ok) await tg('sendMessage', { chat_id: uid, text: caption }); // same fallback as the welcome: never lose the message over the photo
  } catch (e) { console.error('verify user message', uid, e.message); }
  try {
    for (const adminId of adminChatIds()) {
      await tg('sendMessage', {
        chat_id: adminId, parse_mode: 'HTML',
        text: `💰 <b>New wallet verification deposit</b>\n👤 <b>User:</b> ${esc(p.name || '')} (<code>${esc(uid)}</code>) · ZOM-${userNo}\n👛 <b>Wallet:</b> <code>${esc(toFriendlyAddress(p.walletAddr || ''))}</code>\n💵 <b>Amount:</b> ${Number(cfg.verifyFeeTon) || 0} TON\n⚰️ <b>Status:</b> wallet VERIFIED ✅\n🔗 <a href="https://tonviewer.com/transaction/${hash}">View transaction</a>`
      });
    }
  } catch (e) { console.error('verify admin message', uid, e.message); }
}

/* THE shared completion path (owner order 2026-11-14): both the
   verifyCheck action and the background deposit watcher finish a
   verification HERE, so the two can never diverge. The caller has
   already established eligibility (bound wallet, age rule) and found
   a candidate payment; this function claims the payment's hash,
   flips the player to verified in ONE transaction — only if still
   unverified for the same bound wallet — flags the wallets-registry
   node, syncs the inviter's referral entry, and, ONLY when this
   caller won the flip AND the payment has never been announced
   (the claim's notifiedAt slot), sends the success messages.
   Returns { won:true, tx } to the winner; { won:false, reason } to
   everyone else ('already' | 'claimed' | 'banned' | 'nowallet' |
   'missing'). Throws Fail(409) if the bound wallet changed between
   the caller's scan and the flip (verifyCheck's long-standing
   contract; the watcher catches it per player). */
async function completeVerification(uid, hash, cfg) {
  uid = String(uid);
  const ref = P(uid);
  const p = await getVal(ref);
  if (!p) return { won: false, reason: 'missing' };
  if (p.banned === true) return { won: false, reason: 'banned' };
  const wallet = p.walletAddr || '';
  if (!wallet) return { won: false, reason: 'nowallet' };
  if (p.walletVerified === true && p.verifiedWallet === wallet) return { won: false, reason: 'already' };
  const claimRef = rtdb().ref('verifyClaims/' + hash);
  const prior = await getVal(claimRef);
  if (prior && String(prior.userId) !== uid) return { won: false, reason: 'claimed' }; // claimed by someone else — never reusable
  if (!prior) {
    // Claim the hash FIRST (atomic): two racing completions for the
    // same payment can never both pass this point.
    let claimed;
    try {
      claimed = await txUpdate(claimRef, (cur) => {
        if (cur !== null) return { skip: true, out: false };
        return { value: { userId: uid, at: Date.now() }, out: true };
      });
    } catch (e) {
      // Distinguishable in the logs (round 3): txUpdate already
      // retried any maxretry abort internally, so a claim that still
      // throws is the one failure that strands a REAL payment —
      // it must never read like a generic completion error.
      console.error('verify claim FAILED for uid', uid, 'hash', hash, '-', e.message);
      throw e;
    }
    if (!claimed) return { won: false, reason: 'claimed' };
  }
  const flip = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.walletVerified === true) return { skip: true, out: { won: false, reason: 'already' } }; // a racer (the other path) won
    if ((d.walletAddr || '') !== wallet) return { error: new Fail(409, 'Wallet changed, try again') };
    return {
      value: { ...d, walletVerified: true, verifiedWallet: wallet, verifiedAt: Date.now(), verifyTx: hash, verifyPendingAt: 0, lastVerifyTx: '' },
      out: { won: true, player: { ...d, walletAddr: wallet, userNo: Number(d.userNo) || 0, name: d.name || '' } }
    };
  });
  if (!flip || !flip.won) return { won: false, reason: (flip && flip.reason) || 'already' };
  // Stamp the wallets-registry node as THIS player's verified claim:
  // ownership and the verified flag are written together, atomically.
  // (A provisional claim another account placed on this address must
  // never inherit the verified stamp — the payment just proved whose
  // wallet this is. From here the claim is permanent: see wallet().)
  await txUpdate(walletDoc(wallet), () => ({ value: { userId: uid, verified: true } }));
  await syncRefVerifiedFlag(uid, true);
  // Verification is one of the two activation conditions: if the hold
  // already meets the minimum, the referral turns Active right here.
  await syncReferralActive(uid, cfg);
  let ageDays = null;
  try { ageDays = await walletAgeDays(ref, flip.player, wallet); } catch (e) { /* the caption falls back to '—' */ }
  /* Once per payment (owner order 2026-11-14): the flip above can
     be won MORE than once for the same payment — void the
     verification (unlink / different-wallet bind), rebind, and the
     same-user claim fall-through up top completes it again. The
     flip must still land (the player really is verified again),
     but the messages may only ever be sent once for this payment,
     so first take the notification slot on the claim record
     atomically: mark-then-send. A claim stranded by a completion
     that never won its flip has no notifiedAt yet, so its eventual
     win still takes the slot and sends — that win IS the payment's
     first (and only) announcement. If the Telegram send itself
     fails after the mark, the messages are best-effort by design
     and are NOT retried: the owner's "once only" outranks delivery
     retries. If the mark itself fails, skip the send rather than
     risk a duplicate later; a future re-completion can still take
     the slot and announce. */
  let notify = false;
  try {
    notify = await txUpdate(claimRef, (cur) => {
      if (!cur || typeof cur !== 'object') return { skip: true, out: false }; // no claim record — defensive: never announce an unclaimed payment
      if (cur.notifiedAt) return { skip: true, out: false }; // this payment already announced itself
      return { value: { ...cur, notifiedAt: Date.now() }, out: true };
    });
  } catch (e) { console.error('verify notify-mark FAILED for uid', uid, 'hash', hash, '-', e.message); }
  if (notify) await sendVerificationMessages(uid, flip.player, cfg, hash, ageDays);
  try {
    const cs = Number(cfg.contestStartsAt || 0);
    if (cs > 0 && Date.now() >= cs && Number(flip.player.contestBaseAt || 0) !== cs) {
      await P(uid).update({ contestBase: Number(flip.player.hold) || 0, contestBaseAt: cs });
    }
  } catch (e) { /* baseline stamping is best-effort; the snapshot covers the rest */ }
  return { won: true, tx: hash };
}

async function verifyCheck(c) {
  const { ref, p } = await verifyGatePlayer(c);
  const uid = String(c.user.id);
  const wallet = p.walletAddr || '';
  if (!wallet) fail(400, 'Connect a wallet first');
  // Already verified for THIS wallet: nothing to re-prove.
  if (p.walletVerified === true && p.verifiedWallet === wallet) return { verified: true, tx: p.verifyTx || '', already: true };
  const userNo = await ensureUserNo(uid);
  if (!userNo) fail(500, 'Server error');
  // Owner order 2026-11-17: no wallet-age gate here — verification is
  // open at any wallet age; the age rule now gates withdrawals only.
  const feeTon = Number(c.cfg.verifyFeeTon) || 0;
  const minNano = BigInt(Math.floor(feeTon * 1e9 * 0.99)); // 1% tolerance for wallet-side rounding
  const comment = verifyComment(userNo);
  /* Manual re-check, first stop (owner root-fix order 2026-11-16):
     if one of this player's payments already sits in the unresolved
     registry (e.g. he paid while his wallet binding was mid-flight),
     retry it here before scanning — this button never creates a new
     pending and never charges anything; it only re-examines. */
  try {
    const all = (await getVal(rtdb().ref('verifyUnresolved'))) || {};
    for (const [hash, e] of Object.entries(all)) {
      if (!e || e.status !== 'open' || Number(e.userNo) !== Number(userNo)) continue;
      const o = await processVerifyCandidate({ hash, userNo, source: e.source || '', valueNano: e.valueNano || '0' }, c.cfg, { origin: 'check' });
      if (o === 'WON') return { verified: true, tx: hash };
      if (o === 'already') return { verified: true, tx: p.verifyTx || hash, already: true };
    }
  } catch (e) { /* advisory — the deep scan below still runs */ }
  const depRaw = toRawAddress(c.cfg.verifyDepositWallet);
  // Deep scan (owner order 2026-11-16): the player is actively
  // waiting on this answer, and at the post-reopening deposit rate
  // the newest 50 transactions cover only ~20 minutes — a payment
  // sent earlier (e.g. from the wallet app with the app closed) sat
  // hundreds of transactions deep and this check answered 404
  // forever. Page back up to VERIFY_CHECK_SCAN transactions before
  // declaring the payment missing.
  const txs = await depositTransactionsDeep(depRaw, VERIFY_CHECK_SCAN);
  for (const tx of txs) {
    const inMsg = tx && tx.in_msg;
    if (!inMsg) continue;
    if (inMsgSourceRaw(inMsg) !== wallet) continue; // must be sent FROM the player's bound wallet
    let val;
    try { val = BigInt(String(inMsg.value || '0')); } catch (e) { continue; }
    if (val < minNano) continue;
    const text = decodeTextComment(inMsg);
    if (!text || (text.trim() !== comment && text.trim() !== legacyVerifyComment(userNo))) continue;
    const hash = txHashHex(tx.hash); // toncenter v3 sends base64 — canonical hex before the guard/claim/store
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) continue;
    const done = await completeVerification(uid, hash, c.cfg);
    if (done.won) return { verified: true, tx: hash };
    if (done.reason === 'already') return { verified: true, tx: p.verifyTx || hash, already: true }; // the watcher won the race mid-scan
    // 'claimed' (this payment belongs to another user) and friends:
    // keep scanning — another transaction may still be this player's.
  }
  fail(404, 'Payment not found yet');
}

/* ---------- deposit-cursor verification processor (owner root-fix order 2026-11-16) ----------
   WHY THIS REPLACED THE PENDING-CENTRIC WATCHER: the old tick first
   built the eligible-pending set (fresh wallet-age determinations
   budgeted per tick, oldest first) and only then scanned the newest
   200 deposits — with ~1000 pendings, a player who paid NOW waited
   behind hundreds of stale intents for an age slot (case 14920:
   paid 19:00, still unverified 19:15+), and any payment that aged
   out of the scan window before its turn was lost to the live path.
   THE DEPOSIT IS NOW THE TRIGGER. A persisted cursor
   (meta/depositCursor = the newest FULLY processed deposit
   transaction) walks the deposit wallet's history on tonapi's real
   before_lt paging:
   - every tick collects every transaction newer than the cursor
     (walking back until the cursor transaction itself is found) and
     processes the range OLDEST -> NEWEST;
   - the cursor advances in ONE write, only after every outcome in
     the range has been recorded (a completion, or an unresolved
     entry with a reason) — a crash or a tonapi outage leaves the
     cursor untouched, so the next tick retries the identical range
     and nothing is ever skipped;
   - deposits arriving DURING a walk sit above the snapshot head and
     are picked up by the next tick (before_lt pages are anchored by
     lt and never shift);
   - processing is idempotent end to end (completeVerification's
     atomic verifyClaims claim + guarded flip + once-per-payment
     notification), so re-processing a range after a crash completes
     every payment exactly once;
   - a payment that cannot complete (no such player, wallet not the
     bound one, wallet too young, banned, under-value, claim owned
     by another account) is written to verifyUnresolved/{hash} with
     a machine-readable reason and is NEVER auto-deleted: the hourly
     reconciler re-examines open entries until they settle.
   The pending marker (verifyPendingAt) is untouched — it remains
   the app's "checking" signal and verifyCheck's job — but it no
   longer gates discovery: a player who pays before ever opening the
   verification card is found by his deposit alone. First boot with
   no cursor processes the newest VERIFY_CURSOR_INIT_SCAN deposits
   as the initial range (older history belongs to the reconciler). */
const VERIFY_WATCH_MS = (() => { const v = Number(process.env.VERIFY_WATCH_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 20000; })(); // default 20 s (owner load-reduction order 2026-11-15; env still overrides — production runs 60000)
const VERIFY_CURSOR_PAGES = (() => { const v = Number(process.env.VERIFY_CURSOR_PAGES); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 100; })(); // pages of 100 per steady-state walk (10,000 tx cap ≈ 2 days of peak flood)
const VERIFY_CURSOR_INIT_SCAN = (() => { const v = Number(process.env.VERIFY_CURSOR_INIT_SCAN); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 2000; })(); // deposits processed by the first tick when no cursor exists yet
const VERIFY_RECHECK_BATCH = (() => { const v = Number(process.env.VERIFY_RECHECK_BATCH); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 200; })(); // open unresolved entries re-examined per sweep
const VERIFY_CHECK_SCAN = (() => { const v = Number(process.env.VERIFY_CHECK_SCAN); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 500; })(); // deposit transactions scanned by one in-app verifyCheck before it may answer "not found"
const depositCursorRef = () => rtdb().ref('meta/depositCursor');
const verifyHealthRef = () => rtdb().ref('meta/verifyHealth');
const unresolvedRef = (hash) => rtdb().ref('verifyUnresolved/' + hash);

async function writeVerifyHealth(patch) {
  try {
    const cur = (await getVal(verifyHealthRef())) || {};
    await verifyHealthRef().set({ ...cur, ...patch });
  } catch (e) { /* health is advisory — never fail a tick over it */ }
}

/* tonapi-only backward walk over the deposit wallet (newest ->
   oldest, normalised, deduplicated by canonical hash). Unlike
   depositTransactionsDeep there is NO toncenter fallback here: the
   cursor's contiguity guarantee needs real paging, and a degraded
   single page would silently corrupt it — a provider failure throws
   and the caller aborts the tick with the cursor untouched.
   stopPred(normalisedTx) ends the walk BEFORE that transaction
   (it and everything older are excluded). */
async function tonapiWalkBack(rawAddr, maxTxs, stopPred) {
  const out = [];
  const seen = new Set();
  let beforeLt = null;
  let firstPage = true;
  while (out.length < maxTxs) {
    const limit = Math.min(100, maxTxs - out.length);
    let qs = '/blockchain/accounts/' + encodeURIComponent(rawAddr) + '/transactions?limit=' + limit;
    if (beforeLt !== null) qs += '&before_lt=' + encodeURIComponent(beforeLt);
    if (!firstPage && TONAPI_PAGE_GAP_MS > 0) await sleepMs(TONAPI_PAGE_GAP_MS);
    firstPage = false;
    const j = await tonPage(qs);
    if (!j) throw new Fail(502, 'tonapi walk: empty answer');
    const txs = Array.isArray(j.transactions) ? j.transactions : [];
    if (!txs.length) break;
    let added = 0;
    let stopped = false;
    for (const tx of txs) {
      const h = txHashHex(tx && tx.hash);
      if (!h || seen.has(h)) continue;
      const ntx = normalizeTonapiTx(tx);
      if (stopPred && stopPred(ntx)) { stopped = true; break; }
      seen.add(h);
      out.push(ntx);
      added++;
    }
    if (stopped) break;
    if (!added) break; // provider repeating itself — never spin
    const lastLt = Number(txs[txs.length - 1] && txs[txs.length - 1].lt);
    if (!Number.isFinite(lastLt) || (beforeLt !== null && lastLt >= beforeLt)) break;
    beforeLt = lastLt;
    if (txs.length < limit) break;
  }
  return out;
}

/* Record (or refresh) an unresolved deposit. Entries are NEVER
   deleted automatically (owner order 2026-11-16): a settled entry
   flips to status 'completed' and stays as history. A failure of
   this write throws to the caller on purpose — an outcome that
   cannot be recorded must not let the cursor advance past it. */
async function recordUnresolved(cand, reason, uid) {
  const now = Date.now();
  await txUpdate(unresolvedRef(cand.hash), (cur) => {
    if (cur && cur.status === 'completed') return { skip: true, out: false };
    if (cur) return { value: { ...cur, reason, uid: uid || cur.uid || '', lastCheckedAt: now, checks: (Number(cur.checks) || 1) + 1 }, out: true };
    return { value: { userNo: cand.userNo, uid: uid || '', source: cand.source, valueNano: String(cand.valueNano), reason, status: 'open', firstSeenAt: now, lastCheckedAt: now, checks: 1 }, out: true };
  });
}
async function markUnresolvedCompleted(hash) {
  try {
    await txUpdate(unresolvedRef(hash), (cur) => {
      if (!cur || cur.status === 'completed') return { skip: true, out: false };
      return { value: { ...cur, status: 'completed', completedAt: Date.now(), lastCheckedAt: Date.now() }, out: true };
    });
  } catch (e) { /* advisory: the verification itself already landed */ }
}

/* THE shared candidate processor: one payment-shaped deposit
   ({ hash, userNo, source, valueNano }) is validated end to end and
   either completed through completeVerification or recorded in
   verifyUnresolved with the reason. Validation order (owner order
   2026-11-16): value >= fee (1% tolerance) -> claim state -> player
   exists -> not banned -> bound wallet == deposit source -> complete.
   Owner order 2026-11-17: wallet age no longer gates verification —
   it gates withdrawals instead (see withdraw()). The ctx parameter
   (and its ageBudget) is kept for caller compatibility but is no
   longer used here. Returns one of:
   'WON' | 'already' | 'unresolved' | 'skip'. */
async function processVerifyCandidate(cand, cfg, ctx) {
  const feeTon = Number(cfg.verifyFeeTon) || 0;
  const minNano = BigInt(Math.floor(feeTon * 1e9 * 0.99));
  let val;
  try { val = BigInt(String(cand.valueNano || '0')); } catch (e) { return 'skip'; }
  if (val < minNano) { await recordUnresolved(cand, 'undervalue'); return 'unresolved'; }
  const claim = await getVal(rtdb().ref('verifyClaims/' + cand.hash));
  const found = await queryPlayersByChild('userNo', 'equalTo', cand.userNo);
  const entries = found ? Object.entries(found) : [];
  if (!entries.length) {
    if (claim && claim.userId) return 'already'; // claimed by a player who no longer resolves — nothing actionable
    await recordUnresolved(cand, 'no-player');
    return 'unresolved';
  }
  /* userNo is unique in production (counter-assigned transactionally);
     if a duplicate record ever shares it, the payer is the entry whose
     bound wallet actually sent this deposit — a wallet-less namesake
     must never shadow him and eat the payment as 'no-wallet'. */
  const [uid, p] = entries.find(([, q]) => q && q.walletAddr && q.walletAddr === cand.source) || entries[0];
  if (claim && String(claim.userId) === uid && p && p.walletVerified === true) { await markUnresolvedCompleted(cand.hash); return 'already'; }
  if (claim && String(claim.userId) !== uid) { await recordUnresolved(cand, 'claim-conflict', uid); return 'unresolved'; }
  if (!p || p.banned === true) { await recordUnresolved(cand, 'banned', uid); return 'unresolved'; }
  const wallet = p.walletAddr || '';
  if (p.walletVerified === true && wallet && p.verifiedWallet === wallet) { await markUnresolvedCompleted(cand.hash); return 'already'; }
  if (!wallet) { await recordUnresolved(cand, 'no-wallet', uid); return 'unresolved'; }
  if (cand.source !== wallet) { await recordUnresolved(cand, 'source-mismatch', uid); return 'unresolved'; }
  // Owner order 2026-11-17: no wallet-age validation here any more —
  // a payer whose wallet is younger than 7 days completes like anyone
  // else (the age rule now gates withdrawals in withdraw()).
  let done;
  try { done = await completeVerification(uid, cand.hash, cfg); } catch (e) {
    await recordUnresolved(cand, 'error:' + String((e && e.message) || e).slice(0, 80), uid);
    return 'unresolved';
  }
  if (done.won) { await markUnresolvedCompleted(cand.hash); return 'WON'; }
  if (done.reason === 'already') { await markUnresolvedCompleted(cand.hash); return 'already'; }
  await recordUnresolved(cand, done.reason === 'claimed' ? 'claim-conflict' : (done.reason || 'error'), uid);
  return 'unresolved';
}

/* One raw deposit transaction -> candidate (or 'skip' when it is not
   a verification payment at all: no exact ZM-<userNo> comment). */
async function processVerifyDeposit(tx, cfg, ctx) {
  const inMsg = tx && tx.in_msg;
  if (!inMsg) return 'skip';
  const text = decodeTextComment(inMsg);
  if (!text) return 'skip';
  const m = /^(?:ZOM|ZM)-(\d+)$/.exec(text.trim());
  if (!m) return 'skip';
  const hash = txHashHex(tx.hash);
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return 'skip';
  return processVerifyCandidate({ hash, userNo: Number(m[1]), source: inMsgSourceRaw(inMsg), valueNano: String(inMsg.value || '0') }, cfg, ctx);
}

let verifyWatchRunning = false;
async function verifyWatchTick() {
  if (verifyWatchRunning) return; // ticks never overlap
  verifyWatchRunning = true;
  try {
    const cfg = await getConfig();
    const depRaw = toRawAddress(cfg.verifyDepositWallet);
    /* Re-completion pass: a verification voided by a wallet change
       keeps lastVerifyTx pointing at the payment that verified the
       player before. If he re-binds THAT wallet (the wallets
       registry still shows it verified for him) and re-pends, the
       same payment completes him again — it sits at or below the
       cursor, so the walk will never see it again. No new fee, and
       the claim's notifiedAt keeps the re-completion silent
       (once-per-payment messaging). */
    try {
      const pend = await queryPlayersByChild('verifyPendingAt', 'startAt', 1);
      for (const [uid, p] of Object.entries(pend || {})) {
        if (!p || p.walletVerified === true || p.banned === true) continue;
        const ltx = String(p.lastVerifyTx || '');
        if (!/^[0-9a-fA-F]{64}$/.test(ltx) || !p.walletAddr) continue;
        const claim = await getVal(rtdb().ref('verifyClaims/' + ltx));
        if (!claim || String(claim.userId) !== uid) continue;
        const wdoc = await getVal(walletDoc(p.walletAddr));
        if (!wdoc || String(wdoc.userId) !== uid || wdoc.verified !== true) continue;
        const done = await completeVerification(uid, ltx, cfg);
        if (done.won) console.log('[verifyCursor] re-completed uid=' + uid + ' from his original payment (void + rebind of the same wallet)');
      }
    } catch (e) { console.error('verifyCursor recompletion pass', e.message); }
    const cursor = await getVal(depositCursorRef());
    const isInit = !cursor || !cursor.hash;
    const maxTxs = isInit ? VERIFY_CURSOR_INIT_SCAN : VERIFY_CURSOR_PAGES * 100;
    let stopPred = null;
    if (!isInit) {
      const cLt = Number(cursor.lt) || 0;
      const cHash = String(cursor.hash);
      stopPred = (ntx) => ntx.hash === cHash || (Number(ntx.lt) || 0) < cLt;
    }
    let walked;
    try {
      walked = await tonapiWalkBack(depRaw, maxTxs, stopPred); // newest -> oldest, cursor tx excluded
    } catch (walkErr) {
      /* tonapi unreachable: degrade to ONE fallback page (the newest
         100 deposits via depositTransactionsDeep's toncenter path)
         and process it WITHOUT advancing the cursor. Contiguity is
         preserved — the cursor stays frozen and the full range is
         re-walked when tonapi recovers (processing is idempotent) —
         while in-page payers still complete during the outage
         instead of waiting for it to end. If the fallback also
         yields nothing, rethrow into the stall bookkeeping below. */
      const page = await depositTransactionsDeep(depRaw, 100);
      if (!page.length) throw walkErr;
      const outcomes = {};
      for (const tx of page.slice().reverse()) {
        const o = await processVerifyDeposit(tx, cfg, { origin: 'cursor-fallback' });
        outcomes[o] = (outcomes[o] || 0) + 1;
      }
      await writeVerifyHealth({ lastTickAt: Date.now(), lastFallbackAt: Date.now() });
      console.log('[verifyCursor] tonapi down — fallback page=' + page.length + ' (cursor held) ' + Object.entries(outcomes).map(([k, v]) => k + '=' + v).join(' '));
      return;
    }
    if (!walked.length) {
      if (isInit) {
        try { await depositCursorRef().set({ lt: 0, hash: '', utime: 0, processedTotal: 0, updatedAt: Date.now() }); } catch (e) { /* retried next tick */ }
      }
      await writeVerifyHealth({ lastTickAt: Date.now() });
      return;
    }
    const range = walked.slice().reverse(); // OLDEST -> NEWEST
    const outcomes = {};
    for (const tx of range) {
      const o = await processVerifyDeposit(tx, cfg, { origin: isInit ? 'cursor-init' : 'cursor' });
      outcomes[o] = (outcomes[o] || 0) + 1;
    }
    /* THE cursor advance (owner point 1): one write, only now —
       every deposit in the range has a recorded outcome above. Any
       throw before this line leaves the persisted cursor untouched
       and the identical range is retried by the next tick. */
    const head = walked[0];
    const processedTotal = (cursor && Number(cursor.processedTotal) || 0) + range.length;
    await depositCursorRef().set({ lt: Number(head.lt) || 0, hash: head.hash, utime: Number(head.now) || 0, processedTotal, updatedAt: Date.now() });
    await writeVerifyHealth({ lastTickAt: Date.now(), lastAdvanceAt: Date.now(), cursorLt: Number(head.lt) || 0, cursorUtime: Number(head.now) || 0, processedTotal });
    console.log('[verifyCursor] ' + (isInit ? 'init ' : '') + 'processed=' + range.length + ' ' + Object.entries(outcomes).map(([k, v]) => k + '=' + v).join(' '));
  } catch (e) {
    console.error('verifyCursor tick', e.message);
    /* Stall alert (owner point 7): if the cursor has not advanced
       for over 10 minutes while ticks keep failing, tell the admins
       once an hour at most. The deposits are NOT lost — the frozen
       cursor means the whole range is retried when the provider
       recovers — but a human should know the fast path is stuck. */
    try {
      const h = (await getVal(verifyHealthRef())) || {};
      const now = Date.now();
      const stalledFor = now - (Number(h.lastAdvanceAt) || now);
      await verifyHealthRef().set({ ...h, lastTickAt: now, lastTickErrorAt: now, lastTickError: String((e && e.message) || e).slice(0, 120) });
      if (stalledFor > 10 * 60 * 1000 && now - (Number(h.stallAlertedAt) || 0) > 60 * 60 * 1000) {
        await verifyHealthRef().set({ ...h, lastTickAt: now, lastTickErrorAt: now, stallAlertedAt: now });
        for (const adminId of adminChatIds()) {
          await tg('sendMessage', { chat_id: adminId, parse_mode: 'HTML', text: `⚠️ <b>ZM verification cursor stalled</b>\nNo deposit processed for ${Math.floor(stalledFor / 60000)} min (last error: ${esc(String((e && e.message) || e).slice(0, 120))}).\nDeposits are safe — the cursor is frozen and the range will be retried automatically; the hourly reconciler is the backstop.` });
        }
      }
    } catch (e2) { /* the alert path must never wedge the watcher */ }
  } finally {
    verifyWatchRunning = false;
  }
}
let verifyWatchStarted = false;
function startVerifyWatcher() {
  if (verifyWatchStarted) return;
  verifyWatchStarted = true;
  if (!(VERIFY_WATCH_MS > 0)) return; // 0 = disabled
  const bootTick = setTimeout(() => { verifyWatchTick(); }, 15000); // one early tick ~15 s after boot
  if (bootTick.unref) bootTick.unref();
  const iv = setInterval(() => { verifyWatchTick(); }, VERIFY_WATCH_MS);
  if (iv.unref) iv.unref();
}

/* ---------- verification reconciler (owner orders 2026-11-16) ----------
   The structural backstop behind the cursor, in two phases.
   Phase 1 re-examines every OPEN verifyUnresolved entry (budgeted):
   a deposit that failed because the wallet was not yet bound, the
   wallet was too young, or the player was mid-fix is retried until
   it settles — entries are never deleted, settled ones flip to
   'completed'. Phase 2 is the deep historical scan: it pages back
   over the deposit wallet's newest VERIFY_SWEEP_SCAN transactions
   and routes every payment-shaped deposit through the same
   processVerifyCandidate as the cursor path, so anything the cursor
   has not covered (history from before its initialisation, a gap
   beyond one walk's page cap) is completed — or recorded
   unresolved — here. Fresh wallet-age determinations are budgeted
   per sweep across both phases; cached ages are free. Sweeps never
   overlap; failures are logged and swallowed. VERIFY_SWEEP_MS: 0
   disables (tests). */
const VERIFY_SWEEP_MS = (() => { const v = Number(process.env.VERIFY_SWEEP_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 3600000; })(); // default 1 h
const VERIFY_SWEEP_SCAN = (() => { const v = Number(process.env.VERIFY_SWEEP_SCAN); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 2000; })(); // deposit transactions paged per sweep (~11 h of flood at the 2026-11-16 rate)
const VERIFY_SWEEP_AGE_BATCH = (() => { const v = Number(process.env.VERIFY_SWEEP_AGE_BATCH); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 120; })(); // fresh wallet-age determinations per sweep
let verifySweepRunning = false;
async function verifySweepTick() {
  if (verifySweepRunning) return; // sweeps never overlap
  verifySweepRunning = true;
  try {
    const cfg = await getConfig();
    const notes = [];
    let completed = 0;
    let rechecked = 0;
    const ageBudget = { left: VERIFY_SWEEP_AGE_BATCH };
    /* Phase 1: re-examine open unresolved entries, oldest first. */
    try {
      const all = (await getVal(rtdb().ref('verifyUnresolved'))) || {};
      const openEntries = Object.entries(all).filter(([, e]) => e && e.status === 'open')
        .sort((a, b) => (Number(a[1].firstSeenAt) || 0) - (Number(b[1].firstSeenAt) || 0));
      for (const [hash, e] of openEntries.slice(0, VERIFY_RECHECK_BATCH)) {
        rechecked++;
        const o = await processVerifyCandidate({ hash, userNo: Number(e.userNo) || 0, source: e.source || '', valueNano: e.valueNano || '0' }, cfg, { origin: 'recheck', ageBudget });
        if (o === 'WON') { completed++; notes.push(e.userNo + ': WON(recheck)'); }
      }
      const openCount = openEntries.length;
      const h = (await getVal(verifyHealthRef())) || {};
      await writeVerifyHealth({ openUnresolved: openCount, lastRecheckAt: Date.now() });
      /* Backlog surge alert (owner point 7): once per 6 h at most. */
      if (openCount > 50 && Date.now() - (Number(h.surgeAlertedAt) || 0) > 6 * 60 * 60 * 1000) {
        await writeVerifyHealth({ surgeAlertedAt: Date.now() });
        for (const adminId of adminChatIds()) {
          await tg('sendMessage', { chat_id: adminId, parse_mode: 'HTML', text: `⚠️ <b>ZM verification backlog</b>\n${openCount} deposits are recorded unresolved (paid but not yet completable — wrong wallet, too young, or no matching player). They are kept and re-checked hourly; none are deleted.` });
        }
      }
    } catch (e) { console.error('verifySweep recheck', e.message); }
    /* Phase 2: deep historical scan through the shared processor. */
    const depRaw = toRawAddress(cfg.verifyDepositWallet);
    const txs = await depositTransactionsDeep(depRaw, VERIFY_SWEEP_SCAN);
    const byUserNo = new Map(); // payer userNo -> [candidates, oldest first]
    for (const tx of txs) {
      const inMsg = tx && tx.in_msg;
      if (!inMsg) continue;
      const text = decodeTextComment(inMsg);
      if (!text) continue;
      const m = /^(?:ZOM|ZM)-(\d+)$/.exec(text.trim());
      if (!m) continue;
      const hash = txHashHex(tx.hash);
      if (!/^[0-9a-fA-F]{64}$/.test(hash)) continue;
      const userNo = Number(m[1]);
      if (!byUserNo.has(userNo)) byUserNo.set(userNo, []);
      byUserNo.get(userNo).unshift({ hash, userNo, source: inMsgSourceRaw(inMsg), valueNano: String(inMsg.value || '0') });
    }
    for (const [userNo, payments] of byUserNo) {
      for (const cand of payments) {
        const o = await processVerifyCandidate(cand, cfg, { origin: 'sweep', ageBudget });
        if (o === 'WON') { completed++; notes.push(userNo + ': WON ' + cand.hash.slice(0, 10) + '…'); break; }
        if (o === 'already') break;
        // 'unresolved': the reason is recorded — try the payer's next payment
      }
    }
    console.log('[verifySweep] rechecked=' + rechecked + ' scanned=' + txs.length + ' payers=' + byUserNo.size + ' completed=' + completed + (notes.length ? ' | ' + notes.join('; ') : ''));
  } catch (e) {
    console.error('verifySweep tick', e.message);
  } finally {
    verifySweepRunning = false;
  }
}
let verifySweepStarted = false;
function startVerifySweeper() {
  if (verifySweepStarted) return;
  verifySweepStarted = true;
  if (!(VERIFY_SWEEP_MS > 0)) return; // 0 = disabled
  const bootTick = setTimeout(() => { verifySweepTick(); }, 120000); // first sweep ~2 min after boot — drains whatever predates the cursor
  if (bootTick.unref) bootTick.unref();
  const iv = setInterval(() => { verifySweepTick(); }, VERIFY_SWEEP_MS);
  if (iv.unref) iv.unref();
}

/* ---------- referral hold watcher (owner order 2026-11-15) ----------
   Activation is a live state (wallet-verified AND hold >= refMinHold),
   but its inputs used to move only when the invitee opened the app and
   synced his wallet: sell the coins on an exchange without ever
   opening the bot and the inviter kept seeing "Verified ✅" forever.
   This watcher re-reads the on-chain hold of every VERIFIED invitee
   with a bound wallet on a slow tick and re-runs syncReferralActive,
   so buys and sells reflect on their own — the app never has to open
   (and a background activation fires the inviter's DM from
   syncReferralActive, exactly like an in-app one). A failed chain
   read skips the player: a network hiccup must never deactivate
   anyone — only a successful read may move a hold. */
const REF_HOLD_WATCH_MS = (() => { const v = Number(process.env.REF_HOLD_WATCH_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 180000; })(); // default 3 min (was 1 min — the sweep was the single biggest tonapi consumer under the signup flood; env still overrides)
const REF_HOLD_WATCH_BATCH = (() => { const v = Number(process.env.REF_HOLD_WATCH_BATCH); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 90; })(); // candidates re-read per tick, stalest first (see refHoldWatchTick)
const MULTI_CHECK_MS = (() => { const v = Number(process.env.MULTI_CHECK_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 600000; })(); // per-player multi-link recompute cadence in state() (owner load-reduction order 2026-11-15); default 10 min, env overrides, 0 = recompute on every state call
let refHoldWatchRunning = false;
async function refHoldWatchTick() {
  if (refHoldWatchRunning) return; // ticks never overlap
  refHoldWatchRunning = true;
  try {
    const queried = await queryPlayersByChild('walletVerified', 'equalTo', true);
    const players = queried || await getVal(rtdb().ref('players'));
    if (!players) return;
    const cands = Object.entries(players).filter(([, p]) => p && p.walletVerified === true && (p.walletAddr || '') && p.banned !== true);
    if (!cands.length) return;
    // Batch cap (incident 2026-11-15): the candidate set grows with
    // the verified population (447 during the flood) and re-reading
    // ALL of them every tick keeps the chain layer busy around the
    // clock, starving player-facing reads. Stalest-first ordering
    // rotates coverage — every candidate is re-read within a few
    // ticks — and an in-app sync still refreshes a hold the moment
    // it matters to the player himself.
    cands.sort((a, b) => ((Number(a[1].holdCheckedAt) || Number(a[1].lastSyncAt) || 0)) - ((Number(b[1].holdCheckedAt) || Number(b[1].lastSyncAt) || 0))); // rotate by last CHECK, not last sync (2026-11-23 starvation fix)
    const batch = cands.slice(0, REF_HOLD_WATCH_BATCH);
    const cfg = await getConfig();
    const notes = [];
    // Concurrency pool (owner tuning order 2026-11-23): the old
    // sequential loop needed ~1-3 min for one 300 batch, so ticks
    // overran their own interval and a full sweep of every verified
    // player's wallet crawled. 12 workers keep the chain layer busy
    // without flooding it (jettonHold dedupes in-flight reads of the
    // same wallet), so one batch finishes in seconds and the whole
    // verified population is re-read every sweep cycle.
    const WATCH_CONCURRENCY = 12;
    let bi = 0;
    const worker = async () => {
      while (bi < batch.length) {
        const [uid, p] = batch[bi++];
        try {
          const hold = await jettonHold(p.walletAddr);
          if (!Number.isFinite(hold)) throw new Error('hold read not finite');
          const holdChanged = Math.abs(hold - (Number(p.hold) || 0)) >= 1e-9;
          if (!holdChanged) { await P(uid).update({ holdCheckedAt: Date.now() }); continue; } // unchanged: stamp the check so this player rotates to the back of the queue instead of clogging the stalest-first front forever (2026-11-23)
          await P(uid).update({ hold, lastSyncAt: Date.now(), holdCheckedAt: Date.now() });
          if (p.invitedBy) await syncReferralActive(uid, cfg);
          notes.push(uid + ': hold ' + (Number(p.hold) || 0) + '->' + hold);
        } catch (e) {
          // Failed read: NEVER touch the hold or the referral state
          // (fail-closed — a network hiccup must not deactivate
          // anyone), but stamp the check so a broken wallet rotates
          // to the back of the queue instead of clogging the front
          // and starving every player behind it.
          try { await P(uid).update({ holdCheckedAt: Date.now() }); } catch (_) {}
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WATCH_CONCURRENCY, batch.length) }, worker));
    if (notes.length) console.log('[refHoldWatch] ' + notes.join('; '));
  } catch (e) {
    console.error('refHoldWatch tick', e.message);
  } finally {
    refHoldWatchRunning = false;
  }
}
let refHoldWatchStarted = false;
function startRefHoldWatcher() {
  if (refHoldWatchStarted) return;
  refHoldWatchStarted = true;
  if (!(REF_HOLD_WATCH_MS > 0)) return; // 0 = disabled
  const bootTick = setTimeout(() => { refHoldWatchTick(); }, 30000); // first sweep ~30 s after boot
  if (bootTick.unref) bootTick.unref();
  const iv = setInterval(() => { refHoldWatchTick(); }, REF_HOLD_WATCH_MS);
  if (iv.unref) iv.unref();
}

/* ---------- referral repair sweep (owner case 2026-11-15, Hisham) ----
   Attribution writes the invitee's invitedBy on the invitee's own
   (cold) record and appends the entry to the INVITER's (hot) record
   in a second step. Under the signup flood that append could lose
   its transaction-retry war on the hot record and fail — silently
   and permanently: the invitee kept his inviter, the inviter never
   saw him (25 of one player's 26 referrals vanished this way;
   50 entries across 15 inviters in one evening). No code path ever
   retried the append. This sweep is the retry, forever: every
   REF_REPAIR_MS it reconciles the two sides — any player whose
   invitedBy points at an inviter whose list lacks his entry gets
   the entry restored (silently, with his real join time), and his
   activation state is re-synced. Idempotent: the append dedupes by
   id inside its transaction, so a healthy list is never touched. */
const REF_REPAIR_MS = (() => { const v = Number(process.env.REF_REPAIR_MS); return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 600000; })(); // default 10 min; env overrides, 0 disables
let refRepairRunning = false;
async function refRepairTick() {
  if (refRepairRunning) return; // ticks never overlap
  refRepairRunning = true;
  try {
    const cfg = await getConfig();
    /* Queue first (owner load order 2026-11-15): appends that lost
       their contention war AND exhausted the in-process retry ladder
       leave an entry in refRepairQueue (written at handoff time, so
       even a process restart cannot lose it). Processing the queue
       costs one small read instead of downloading every player. */
    const queue = await getVal(rtdb().ref('refRepairQueue'));
    if (queue) {
      let qFixed = 0;
      for (const [inviteeId, ent] of Object.entries(queue)) {
        if (qFixed >= 200) break; // per-tick cap; the next tick continues
        const p = await getVal(P(inviteeId));
        if (!p || !p.invitedBy || String(p.invitedBy) !== String(ent && ent.inv)) {
          await rtdb().ref('refRepairQueue/' + inviteeId).remove().catch(() => {}); // stale entry (record gone / inviter changed)
          continue;
        }
        const inv = await getVal(P(String(p.invitedBy)));
        if (inv && (inv.referrals || []).some((r) => String(r.id) === String(inviteeId))) {
          await rtdb().ref('refRepairQueue/' + inviteeId).remove().catch(() => {}); // already landed via another path
          continue;
        }
        const ok = await attributeReferral({ id: inviteeId, first_name: p.name || 'Zombie' }, String(p.invitedBy), p.deviceHash || '', { silent: true, at: Number(p.createdAt) || Date.now() });
        if (ok) {
          qFixed++;
          await syncReferralActive(inviteeId, cfg);
          await rtdb().ref('refRepairQueue/' + inviteeId).remove().catch(() => {});
        }
      }
      if (qFixed) console.log('[refRepair] restored ' + qFixed + ' queued referral entries');
    }
    /* Full reconciliation at most once a day: it downloads the whole
       players node, which grows with every signup — as the standing
       sweep it was the priciest background read in the system. It
       remains as the final safety net for any loss class the queue
       cannot know about. The stamp is written BEFORE the pass so a
       crash mid-pass cannot hot-loop it. */
    const meta = await getVal(rtdb().ref('meta/refRepair'));
    if (Date.now() - (Number(meta && meta.fullAt) || 0) < 86400000) return;
    await rtdb().ref('meta/refRepair').update({ fullAt: Date.now() }).catch(() => {});
    const players = await getVal(rtdb().ref('players'));
    if (!players) return;
    let repaired = 0;
    for (const [uid, p] of Object.entries(players)) {
      if (repaired >= 200) break; // per-pass cap; the next pass continues
      if (!p || !p.invitedBy) continue;
      const inv = players[String(p.invitedBy)];
      if (!inv) continue;
      if ((inv.referrals || []).some((r) => String(r.id) === String(uid))) continue;
      const ok = await attributeReferral({ id: uid, first_name: p.name || 'Zombie' }, String(p.invitedBy), p.deviceHash || '', { silent: true, at: Number(p.createdAt) || Date.now() });
      if (ok) { repaired++; await syncReferralActive(uid, cfg); }
    }
    if (repaired) console.log('[refRepair] restored ' + repaired + ' missing referral entries');
  } catch (e) {
    console.error('refRepair tick', e.message);
  } finally {
    refRepairRunning = false;
  }
}
let refRepairStarted = false;
function startRefRepairWatcher() {
  if (refRepairStarted) return;
  refRepairStarted = true;
  if (!(REF_REPAIR_MS > 0)) return; // 0 = disabled
  const bootTick = setTimeout(() => { refRepairTick(); }, 45000); // first sweep ~45 s after boot
  if (bootTick.unref) bootTick.unref();
  const iv = setInterval(() => { refRepairTick(); }, REF_REPAIR_MS);
  if (iv.unref) iv.unref();
}

async function refCollect(c) {
  const ref = await ensurePlayer(c);
  return txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    const amt = Number(d.pendingRefComm) || 0;
    if (amt <= 0) return { error: new Fail(400, 'No pending referral profits') };
    return {
      value: { ...d, pendingRefComm: 0, mined: (Number(d.mined) || 0) + amt, refCommissionEarned: (Number(d.refCommissionEarned) || 0) + amt, earnRef: (Number(d.earnRef) || 0) + amt },
      out: { success: true, amount: amt }
    };
  });
}

/* True when uid is on the withdrawal-cooldown exemption list
   (cfg.withdrawCooldownExempt, seeded by DEFAULTS). RTDB may hand
   a stored list back as an array or as an object of values — both
   are normalised to strings before comparing. */
function isCooldownExempt(cfg, uid) {
  const raw = cfg ? cfg.withdrawCooldownExempt : null;
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  return list.map((v) => String(v)).includes(String(uid));
}

async function withdraw(c) {
  requireAdGate(c);
  const cfg = c.cfg, ref = await ensurePlayer(c);
  const amt = Math.floor(Number(c.body.amount));
  const pre = await getVal(ref);
  if (!pre) fail(404, 'User not found');
  const addr = pre.walletAddr;
  if (!addr) fail(400, 'Connect TON wallet first');
  // Owner order 2026-11-14: no withdrawal without a VERIFIED wallet.
  // Connecting is not enough — the 0.05 TON verification must be done
  // (binding a different wallet voids it — see wallet()), so a true
  // flag here always refers to the currently bound wallet.
  if (pre.walletVerified !== true) fail(403, 'Verify your wallet first');
  // Owner order 2026-11-17: the wallet-age rule moved here from
  // verification — withdrawing requires the bound wallet to be at
  // least withdrawMinAgeDays old (verification itself is open at any
  // age). Age is read through the same cache-aware helper the
  // verification paths use.
  const wdMinAge = Number(cfg.withdrawMinAgeDays) || 7;
  const wdAge = await walletAgeDays(ref, pre, addr);
  if (wdAge === null || wdAge === undefined) fail(503, 'Wallet age check failed, please try again');
  if (Number(wdAge) < wdMinAge) fail(403, 'Wallet too new for withdrawal: ' + Number(wdAge) + ' days, needs ' + wdMinAge);
  if (!Number.isFinite(amt) || amt < Number(cfg.minWithdraw)) fail(400, 'Minimum is ' + cfg.minWithdraw);
  const hold = await jettonHold(addr); // re-checked on-chain at withdrawal time
  const needHold = Math.ceil(amt * Number(cfg.holdPercentReq) / 100);
  // The requirement is judged on the CURRENT hold: the fresh
  // on-chain total read immediately above.
  if (hold < needHold) fail(400, 'Need ' + needHold + ' in wallet hold (yours: ' + Math.floor(hold) + ')');
  const fee = Math.ceil(amt * Number(cfg.withdrawFeePercent) / 100), net = amt - fee;
  // Firestore original: balance deduction + counter increment + withdrawal
  // doc were ONE transaction. RTDB: player transaction (all guards live
  // here), then the counter transaction (serialises wd numbers), then the
  // doc write — see PORT_NOTES.md for the atomicity caveat.
  const cdExempt = isCooldownExempt(cfg, c.user.id);
  const me = await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(500, 'Server error') }; // player was pre-checked above; matches the original crashing on a vanished doc
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (d.walletAddr !== addr) return { error: new Fail(409, 'Wallet changed, try again') };
    if (!cdExempt && Date.now() - (d.lastWithdrawTime || 0) < 86400000) return { error: new Fail(429, 'You can request once every 24 hours') };
    if (amt > (Number(d.mined) || 0)) return { error: new Fail(400, 'Insufficient balance') };
    return {
      // Exempt accounts keep lastWithdrawTime at 0: the app's own
      // countdown lock reads the same field, so it never locks either.
      value: { ...d, mined: (Number(d.mined) || 0) - amt, lastWithdrawTime: cdExempt ? 0 : Date.now(), hold },
      out: { name: d.name }
    };
  });
  const num = await bumpCounter('withdrawals');
  const wd = { wdNum: num, userId: String(c.user.id), userName: clean(me.name, 64), walletAddr: addr, amt, net, fee, status: 'Pending ⏳', timestamp: Date.now() };
  await rtdb().ref('withdrawals/wd_' + num).set(wd);
  // NO automatic payout any more (owner order 2026-11-14 ~07:29):
  // withdrawals wait for the owner's manual decision. NO review
  // card is sent from here (owner order 2026-11-14, round 2):
  // cards are presented ONLY when the owner pulls the queue with
  // /withdrawals — approve there fires attemptPayout (see the
  // withdrawal-review section below).
  let rk = null;
  try { rk = await riskOf(c.user.id); } catch (e) { console.error('risk', e.message); }
  if (cfg.adminChatId) {
    await tg('sendMessage', {
      chat_id: cfg.adminChatId, parse_mode: 'HTML',
      text: `🔔 <b>New withdrawal #${wd.wdNum}</b>\n👤 ${esc(wd.userName)} (<code>${esc(wd.userId)}</code>)\n💰 ${wd.amt} ${esc(cfg.coinSym)}\n💎 Net: ${wd.net}\n👛 <code>${esc(wd.walletAddr)}</code>${rk && rk.level !== 'low' ? '\n⚠️ تعدد حسابات: ' + (rk.level === 'high' ? 'عالي' : 'متوسط') : ''}`
    });
  }
  return { success: true, wdNum: wd.wdNum };
}

/* ---------- automatic $ZOM jetton payouts (owner order 2026-11-14) ----------
   When PAYOUT_MNEMONIC is configured, an APPROVED withdrawal is
   paid by attemptPayout(), which pays the NET amount in the
   $ZOM jetton from the payout wallet to the player's bound
   wallet. (Approval moved from withdraw()-time to the owner's bot
   review card — owner order 2026-11-14 ~07:29; see the withdrawal-
   review section.) Safety comes from a tiny state machine on the
   withdrawal record itself (field `payoutState`):

     (absent)/'none'  --claim-->  'paying'  --confirmed-->  'paid'
                                    |
                                    +-- any failure -->  'failed'

   - The claim is ONE transaction on the withdrawal node: only the
     caller that flips absent/'none' -> 'paying' may broadcast, so
     retries, double invocations and process restarts can never
     produce a second transfer for the same record.
   - 'paying' is hands-off forever: if the process dies mid-broadcast
     the transfer may or may not have landed, and only a human may
     resolve it (adminWd refuses to touch 'paying'/'paid' records).
   - 'failed' is never auto-retried either: an explicit future admin
     action is the only way back (out of scope here). A failure
     NEVER re-credits the player automatically — the deduction made
     by withdraw() stands, exactly like a manual payout that is still
     waiting, and the owner is DM'd the reason.
   - On success the record is flipped to status 'Paid ✅' with
     payoutState 'paid', payoutTx and payoutAt. payoutTx holds ONLY
     the chain-resolved transaction hash (findTransferTx): the hash
     the seam computes locally from the external message is NOT the
     on-chain tx id for V5R1 wallets (live proof 2026-11-14 — links
     built from it 404 on tonviewer), so it is logged, never stored.
     When resolution times out, payoutTx stays '' and payoutTxLink
     points at the payout wallet's tonviewer page instead.

   The chain layer sits behind getPayoutClient(): production builds
   the real @ton/ton client (createRealPayoutClient); local suites
   point the PAYOUT_STUB_MODULE env var at a fake (the same
   env-override style as TONAPI_BASE / TG_API_BASE) — the state
   machine above never knows the difference. */
function payoutEnabled() {
  return PAYOUT_MNEMONIC.split(/\s+/).filter(Boolean).length === 24;
}

/* The @ton/* libraries are required lazily, only on the payout path:
   a deployment without the feature must boot (and serve everything
   else) even if the packages were somehow missing. */
let _tonLibs = null;
function tonLibs() {
  if (_tonLibs) return _tonLibs;
  _tonLibs = { ton: require('@ton/ton'), core: require('@ton/core'), tcrypto: require('@ton/crypto') };
  return _tonLibs;
}

/* Derive the payout wallet contract address for a mnemonic + wallet
   version ('v5' -> WalletContractV5R1, 'v4' -> WalletContractV4;
   workchain 0, default wallet id — the derivation Tonkeeper uses).
   With the owner's configured mnemonic and 'v5' this yields
   the payout wallet's own address. */
async function derivePayoutAddress(words, version) {
  const { ton, tcrypto } = tonLibs();
  const kp = await tcrypto.mnemonicToPrivateKey(words);
  const Contract = version === 'v4' ? ton.WalletContractV4 : ton.WalletContractV5R1;
  return Contract.create({ workchain: 0, publicKey: kp.publicKey }).address;
}

async function createRealPayoutClient() {
  const { ton, core, tcrypto } = tonLibs();
  const { Address, beginCell, toNano } = core;
  const words = PAYOUT_MNEMONIC.split(/\s+/).filter(Boolean);
  const keyPair = await tcrypto.mnemonicToPrivateKey(words);
  // toncenter v2 JSON-RPC with a key from the same pool the v3 reads use.
  const client = new ton.TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: nextToncKey() || undefined });
  const ownerAddr = await derivePayoutAddress(words, PAYOUT_WALLET_VERSION);
  const Contract = PAYOUT_WALLET_VERSION === 'v4' ? ton.WalletContractV4 : ton.WalletContractV5R1;
  const contract = Contract.create({ workchain: 0, publicKey: keyPair.publicKey });
  const wallet = client.open(contract);
  const masterAddr = Address.parse(JETTON);
  // The payout wallet's own jetton wallet, resolved from the jetton
  // master (get_wallet_address) — needed both to read the balance
  // and as the destination of the internal transfer message.
  async function myJettonWallet() {
    const res = await client.runMethod(masterAddr, 'get_wallet_address', [
      { type: 'slice', cell: beginCell().storeAddress(ownerAddr).endCell() }
    ]);
    return res.stack.readAddress();
  }
  return {
    addressRaw: ownerAddr.toRawString(),
    addressFriendly: ownerAddr.toString(),
    async getTonBalance() { return client.getBalance(ownerAddr); },
    async getJettonBalance() {
      const res = await client.runMethod(await myJettonWallet(), 'get_wallet_data');
      return res.stack.readBigNumber(); // stack: balance, owner, master, code
    },
    /* Standard TEP-74 jetton transfer (op 0x0f8a7ea5) from the payout
       wallet's jetton wallet to the recipient's OWNER wallet (their
       jetton wallet credits them), comment `ZM-<wdNum>` as the
       forward payload so every payout is traceable on-chain.
       Returns after the wallet seqno has moved (the external message
       has landed) — bounded at ~60 s. */
    async sendJetton({ toRaw, amount, comment }) {
      const dest = Address.parse(String(toRaw));
      const jw = await myJettonWallet();
      const seqno = await wallet.getSeqno();
      const forwardPayload = beginCell().storeUint(0, 32).storeStringTail(String(comment || '')).endCell();
      const body = beginCell()
        .storeUint(0x0f8a7ea5, 32)          // transfer op
        .storeUint(0, 64)                   // query id
        .storeCoins(amount)                 // jetton amount, base units
        .storeAddress(dest)                 // recipient owner wallet
        .storeAddress(ownerAddr)            // response destination (excess TON returns here)
        .storeBit(0)                        // no custom payload
        .storeCoins(toNano('0.05'))         // forward TON amount (~0.05)
        .storeBit(1)                        // forward payload in a ref
        .storeRef(forwardPayload)
        .endCell();
      const msg = ton.internal({ to: jw, value: toNano('0.1'), body });
      let txHash = '';
      if (typeof wallet.createTransfer === 'function' && typeof wallet.send === 'function') {
        const ext = await wallet.createTransfer({ seqno, secretKey: keyPair.secretKey, messages: [msg] });
        txHash = ext.hash().toString('hex'); // LOCALLY computed external-message hash — NOT the on-chain tx id for V5R1 wallets (its tonviewer links 404); kept for logging only, findTransferTx resolves the real hash
        await wallet.send(ext);
      } else {
        await wallet.sendTransfer({ seqno, secretKey: keyPair.secretKey, messages: [msg] });
      }
      const deadline = Date.now() + 60000;
      let cur = seqno;
      while (Date.now() < deadline) {
        await txSleep(2500);
        try { cur = await wallet.getSeqno(); } catch (e) { /* a lagging read is not a failure */ }
        if (cur > seqno) break;
      }
      if (cur <= seqno) throw new Error('broadcast unconfirmed: seqno did not move within 60s');
      return { seqno, txHash };
    },
    /* Resolve the REAL on-chain transaction hash of a transfer this
       client just broadcast (called after sendJetton's seqno
       confirmation). Scan the payout wallet's newest transactions
       (toncenter v3, newest first) for OURS: the transaction at or
       after the broadcast whose FIRST out-message goes to our
       jetton wallet carrying a TEP-74 transfer body (op 0x0f8a7ea5)
       with the exact base amount and recipient, AND whose forward
       comment — decoded from the payload ref with the exact layout
       sendJetton builds (uint32 0 + string tail) — equals `comment`
       (ZM-<wdNum>, unique per withdrawal). Polls every 5 s for up
       to ~90 s; a lagging index or a failed read just costs one
       poll. Returns the lowercase hex hash, or null on timeout —
       the caller then links the wallet page, never the local hash. */
    async findTransferTx({ comment, toRaw, amountBase, sinceMs }) {
      const { Cell } = core;
      const jwRaw = toRawAddress((await myJettonWallet()).toRawString());
      const ownerRaw = ownerAddr.toRawString();
      const wantDest = toRawAddress(String(toRaw || ''));
      let wantAmt;
      try { wantAmt = BigInt(amountBase); } catch (e) { return null; }
      const wantComment = String(comment || '');
      const bodyMatches = (cell) => {
        try {
          const s = cell.beginParse();
          if (s.loadUint(32) !== 0x0f8a7ea5) return false;   // TEP-74 transfer op
          s.loadUint(64);                                    // query id
          if (s.loadCoins() !== wantAmt) return false;       // exact base amount
          if (toRawAddress(s.loadAddress().toRawString()) !== wantDest) return false; // recipient owner wallet
          s.loadAddress();                                   // response destination (ourselves)
          s.loadBit();                                       // no custom payload
          s.loadCoins();                                     // forward TON amount
          if (!s.loadBit()) return false;                    // forward payload lives in a ref (sendJetton's layout)
          const f = s.loadRef().beginParse();
          if (f.loadUint(32) !== 0) return false;            // text-comment opcode
          return f.loadStringTail() === wantComment;
        } catch (e) { return false; }
      };
      const cutoff = (Number(sinceMs) || 0) - 15000; // small slack for indexer/clock skew
      const deadline = Date.now() + 90000;
      for (;;) {
        try {
          const txs = await toncTransactions(ownerRaw, 10, 'desc');
          for (const tx of txs) {
            const txMs = (Number(tx && tx.now) || 0) * 1000;
            if (!txMs || txMs < cutoff) continue;
            const outs = (tx && tx.out_msgs) || [];
            if (!Array.isArray(outs) || !outs.length) continue;
            const out = outs[0]; // this wallet sends exactly one internal message per transfer
            const dst = out && typeof out.destination === 'object' && out.destination ? out.destination.address : (out && out.destination);
            if (toRawAddress(dst || '') !== jwRaw) continue; // the message must go to OUR jetton wallet
            const mc = (out && out.message_content) || {};
            const bodyStr = typeof mc.body === 'string' ? mc.body : (typeof mc.body_hex === 'string' ? mc.body_hex : '');
            if (!bodyStr) continue;
            let cell = null;
            try {
              cell = (/^[0-9a-fA-F]+$/.test(bodyStr) && bodyStr.length % 2 === 0)
                ? Cell.fromBoc(Buffer.from(bodyStr, 'hex'))[0]
                : Cell.fromBase64(bodyStr);
            } catch (e) { continue; }
            if (!cell || !bodyMatches(cell)) continue;
            const h = txHashHex(tx.hash); // toncenter v3 hash is base64 — canonical hex
            if (h) return h;
          }
        } catch (e) { /* a lagging/failing read is not a failure — keep polling until the deadline */ }
        if (Date.now() >= deadline) return null;
        await txSleep(5000);
      }
    }
  };
}

let _payoutClientPromise = null;
function getPayoutClient() {
  if (!_payoutClientPromise) {
    _payoutClientPromise = (async () => {
      const stubPath = String(process.env.PAYOUT_STUB_MODULE || '');
      if (stubPath) { const m = require(stubPath); return m.createPayoutClient(); }
      return createRealPayoutClient();
    })();
    // Construction sends nothing, so a failed build must not poison
    // the process: drop the cached promise and let a later attempt
    // rebuild (each attempt re-runs its own claim first anyway).
    _payoutClientPromise.catch(() => { _payoutClientPromise = null; });
  }
  return _payoutClientPromise;
}

/* Owner alert for a failed automatic payout (Arabic admin style, via
   tg() like the other owner DMs). Best-effort: a failed alert must
   never mask the payout failure handling itself. */
async function payoutAlert(wd, reason) {
  if (!wd) return;
  await getConfig();
  const text = `🚨 <b>فشل الدفع التلقائي لسحب #${wd.wdNum}</b>\n👤 ${esc(wd.userName || '')} (<code>${esc(String(wd.userId || ''))}</code>)\n💎 <b>الصافي:</b> ${wd.net} $ZOM\n❌ <b>السبب:</b> ${esc(reason)}\nالسحب لسه «Pending» ورصيد اللاعب اتخصم خلاص — ادفع يدويًا أو ارفضه من لوحة التحكم.`;
  for (const adminId of adminChatIds()) {
    try {
      await tg('sendMessage', { chat_id: adminId, parse_mode: 'HTML', text });
    } catch (e) { console.error('payout alert', e.message); }
  }
}

async function attemptPayout(wdNum) {
  if (!payoutEnabled()) return;
  const num = Math.floor(Number(wdNum));
  if (!Number.isFinite(num) || num <= 0) return;
  const ref = rtdb().ref('withdrawals/wd_' + num);
  let wd = null;
  try {
    // 1) Atomic claim: only the invocation that flips the record
    //    from absent/'none' to 'paying' may proceed; 'paying',
    //    'paid' and 'failed' records are all hands-off (see header).
    wd = await txUpdate(ref, (x) => {
      if (x === null) return { skip: true, out: null };
      if ((x.payoutState || 'none') !== 'none') return { skip: true, out: null };
      return { value: { ...x, payoutState: 'paying', payoutAttemptAt: Date.now() }, out: x };
    });
    if (!wd) return; // claimed by someone else, or not in a payable state
    // 1b) Current-hold figures are still READ and stamped at
    //     approval time (holdCheckAt/holdCheckNeed/holdCheckHave —
    //     audit only), but they do not BLOCK the payout. Owner
    //     order 2026-11-19: payouts are manual-review only, so the
    //     owner's approval IS the decision. The request-time
    //     current-hold check in withdraw() remains the gate. A
    //     failed chain read or a failed stamp never blocks an
    //     approved payout either.
    try {
      const cfgH = await getConfig().catch(() => null);
      const pct = Number(cfgH && cfgH.holdPercentReq) || 0;
      if (pct > 0 && wd.walletAddr) {
        const need = Math.ceil((Number(wd.amt) || 0) * pct / 100);
        let have = null;
        try { have = await jettonHold(wd.walletAddr); } catch (e) { have = null; }
        await ref.update({ holdCheckAt: Date.now(), holdCheckNeed: need, holdCheckHave: have === null ? -1 : have, payoutError: '' });
      }
    } catch (e) { console.error('attemptPayout hold stamp failed (non-blocking)', num, e && e.message); }
    const decimals = await jettonDecimals();
    const amountBase = BigInt(Math.max(0, Math.floor(Number(wd.net) || 0))) * (10n ** BigInt(decimals));
    const client = await getPayoutClient();
    // 2) Balance gate: not enough jettons in the payout wallet is a
    //    clean failure — no broadcast, the record stays Pending for
    //    the manual flow, the owner hears about it once.
    const bal = await client.getJettonBalance();
    if (bal < amountBase) {
      await ref.update({ payoutState: 'failed', payoutError: 'insufficient jetton balance' });
      await payoutAlert(wd, 'insufficient jetton balance');
      return;
    }
    // 3+4) Broadcast the jetton transfer; once the seqno confirms
    //      it landed, resolve the REAL on-chain transaction hash and
    //      only then flip the record to Paid. The seam's returned
    //      hash is computed locally from the external message and,
    //      for V5R1 wallets, is NOT the transaction id (live proof
    //      2026-11-14: the stored local hash 404s on tonviewer while
    //      the transfer sits on-chain under a different hash). It is
    //      logged for forensics and NEVER stored or linked: payoutTx
    //      holds only the chain-resolved hash; when resolution times
    //      out the record keeps payoutTx '' and gains payoutTxLink
    //      (the payout wallet's tonviewer page) as the link target.
    const broadcastAt = Date.now();
    const sent = await client.sendJetton({ toRaw: wd.walletAddr, amount: amountBase, comment: 'ZOM-' + num });
    if (sent && sent.txHash) console.log('payout', num, 'local external hash (not the on-chain tx id):', String(sent.txHash));
    let resolvedTx = '';
    if (typeof client.findTransferTx === 'function') {
      try {
        resolvedTx = String((await client.findTransferTx({ comment: 'ZOM-' + num, toRaw: wd.walletAddr, amountBase, sinceMs: broadcastAt })) || '');
      } catch (e) { console.error('payout tx resolve', num, e.message); }
    }
    if (!/^[0-9a-fA-F]{64}$/.test(resolvedTx)) resolvedTx = '';
    const payoutTxLinkVal = resolvedTx ? '' : 'https://tonviewer.com/' + client.addressFriendly;
    await ref.update({
      status: 'Paid ✅', payoutState: 'paid',
      payoutTx: resolvedTx,
      payoutTxLink: resolvedTx ? null : payoutTxLinkVal, // null deletes a stale link if one ever existed
      payoutAt: Date.now()
    });
    // The celebration (photo DM + payouts-channel post, exactly once
    // via the payoutNotifiedAt claim). It must NEVER flip a completed
    // payout into the failure path below: sendPayoutSuccess swallows
    // its own errors, and this dedicated guard keeps even a surprise
    // throw out of the catch.
    try {
      const cfg = await getConfig();
      const p = await getVal(P(wd.userId)).catch(() => null);
      await sendPayoutSuccess({ ...wd, payoutTx: resolvedTx, payoutTxLink: payoutTxLinkVal }, p, cfg);
    } catch (e) { console.error('payout success notify', num, e.message); }
  } catch (e) {
    // 5) ANY failure lands here exactly once per attempt: mark the
    //    record failed (status stays 'Pending ⏳'), never re-credit,
    //    never broadcast again, and tell the owner why.
    const reason = String((e && e.message) || e || 'unknown error').slice(0, 200);
    console.error('payout', num, reason);
    try { await ref.update({ payoutState: 'failed', payoutError: reason }); } catch (e2) { console.error('payout state write', num, e2.message); }
    if (!wd) { try { wd = await getVal(ref); } catch (e3) { /* the alert tolerates a missing record */ } }
    await payoutAlert(wd, reason);
  }
}

/* ---------- payout success celebration (owner order 2026-11-14) ----------
   ONE shared celebration for EVERY withdrawal that becomes Paid —
   fired by attemptPayout's success path and by adminWd's manual
   approve alike. Two FIXED designs, deliberately different from
   each other (owner correction 2026-11-14): the player's DM is the
   personal one (warrior banner, «Your Payout is Sent!», his wallet,
   the tx button), the payouts-channel post (cfg.channel2) is the
   public proof (treasure-chest banner, «New Payout!», full name
   + the FULL receiver wallet in a code span — the owner reversed
   his earlier no-wallet-in-channel rule).
   Exactly-once is enforced on the record itself: the caller claims
   `payoutNotifiedAt` in a transaction BEFORE sending anything, so
   retries, races and re-approvals can never double-send. The claim
   is taken once the code is committed to attempting the user DM;
   the channel post is best-effort afterwards — its failure is
   logged and never re-opens the claim, never touches the payout
   state (the bot is not yet an admin in that channel; the post will
   simply start landing once the owner promotes it). */
const PAYOUT_DM_BANNER = 'https://zombie-mine.vercel.app/payout-banner2.webp?v=3';       // warrior with the glowing coin
const PAYOUT_CHANNEL_BANNER = 'https://zombie-mine.vercel.app/payout-banner.webp?v=3';   // treasure chest
/* The on-chain link for a paid withdrawal, in precedence order:
   the chain-resolved payoutTx hash (auto path) → payoutTxLink (the
   payout wallet's tonviewer page, stored when hash resolution
   timed out) → the txLink adminWd stored on manual approval → ''.
   No button is better than a dead link: the seam's locally computed
   external hash is never part of this chain — for V5R1 wallets it
   is not the transaction id, and links built from it 404. */
function payoutTxUrl(wd) {
  const h = String((wd && wd.payoutTx) || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(h)) return 'https://tonviewer.com/transaction/' + h;
  if (wd && wd.payoutTxLink) return String(wd.payoutTxLink);
  if (wd && wd.txLink) return String(wd.txLink);
  return '';
}
const fmtCoins = (n) => (Number(n) || 0).toLocaleString('en-US');

async function sendPayoutSuccess(wd, player, cfg) {
  try {
    if (!wd || !wd.wdNum || !cfg) return;
    const num = wd.wdNum;
    const claimed = await txUpdate(rtdb().ref('withdrawals/wd_' + num), (x) => {
      if (x === null) return { skip: true, out: false };
      if (x.payoutNotifiedAt) return { skip: true, out: false };
      return { value: { ...x, payoutNotifiedAt: Date.now() }, out: true };
    });
    if (!claimed) return; // already celebrated (or the record is gone)
    const amount = fmtCoins(wd.net);
    const botUname = await resolveBotUsername(cfg);
    const appUrl = botUname ? `https://t.me/${botUname}/app` : '';
    const txUrl = payoutTxUrl(wd); // shared by BOTH messages' «View Transaction» buttons (owner order 2026-11-14)
    /* ---- the player's DM ---- */
    try {
      const walletRaw = (player && player.walletAddr) || wd.walletAddr || '';
      const rows = [];
      if (appUrl) rows.push([{ text: '🧟 Open ZOM', url: appUrl }]);
      if (txUrl) rows.push([{ text: '🔗 View Transaction', url: txUrl }]);
      const kb = rows.length ? { inline_keyboard: rows } : undefined;
      const caption = `🧟 <b>PAYOUT SENT!</b>\n💎 <b>+${amount} ${esc(cfg.coinSym)}</b> dug out of the mine, straight to your wallet.\n👛 Wallet: <code>${esc(shortFriendlyAddress(walletRaw))}</code>\n📅 ${fmtDayMonYear(Date.now())}`;
      const photoRes = await tg('sendPhoto', { chat_id: String(wd.userId), photo: PAYOUT_DM_BANNER, caption, reply_markup: kb });
      if (!photoRes || !photoRes.ok) {
        await tg('sendMessage', { chat_id: String(wd.userId), text: caption, reply_markup: kb });
      }
    } catch (e) { console.error('payout success dm', num, e.message); }
    /* ---- the payouts-channel post (best-effort) ---- */
    try {
      const chanId = chatIdOf(cfg.channel2);
      if (chanId !== null && chanId !== '') {
        // The display name comes from the PLAYER record (the wd
        // record carries only userName): use the passed-in player
        // when the caller loaded one (attemptPayout), else read it
        // here — adminWd's manual approve passes null.
        const pl = player || await getVal(P(wd.userId)).catch(() => null);
        const fullName = (pl && pl.name) || wd.userName || '';
        const displayName = esc(String(fullName).trim() || 'Zombie');
        const rows = [];
        if (appUrl) rows.push([{ text: '🧟 Start Digging Now', url: appUrl }]);
        if (txUrl) rows.push([{ text: '🔗 View Transaction', url: txUrl }]);
        const kb = rows.length ? { inline_keyboard: rows } : undefined;
        // Public proof style — different wording/layout from the DM:
        // plain FULL name (NO username — owner privacy order
        // 2026-11-17, reversing the earlier «(@username)» addition)
        // + amount + the receiver wallet MASKED in the middle
        // (maskAddr) so nobody can copy or reconstruct it from the
        // public post. NO withdrawal number in either message
        // (owner order 2026-11-17). The DM still shows only the
        // SHORT wallet form.
        const caption = `🧟💰 <b>NEW PAYOUT!</b>\n👤 <b>${displayName}</b>\n💰 <b>${amount} ${esc(cfg.coinSym)}</b>\n👛 <code>${esc(maskAddr(toFriendlyAddress(wd.walletAddr || '')))}</code>\n⚰️ Another zombie just cashed out of the mine!`;
        let ok = false;
        const photoRes = await tg('sendPhoto', { chat_id: chanId, photo: PAYOUT_CHANNEL_BANNER, caption, reply_markup: kb });
        if (photoRes && photoRes.ok) ok = true;
        else {
          const msgRes = await tg('sendMessage', { chat_id: chanId, text: caption, reply_markup: kb });
          ok = !!(msgRes && msgRes.ok);
        }
        if (!ok) console.error('payout channel post failed', num);
      }
    } catch (e) { console.error('payout channel post failed', num, e.message); }
  } catch (e) {
    // The celebration must never break its callers (a completed
    // payout in attemptPayout, an approval in adminWd).
    console.error('payout success', wd && wd.wdNum, e.message);
  }
}

/* ---------- withdrawal review: the owner's bot panel (owner order 2026-11-14 ~07:29) ----------
   Automatic payout-on-request is REPLACED by manual review in the
   bot chat, modelled on the owner's AdVOLT messages bot: the owner
   pulls the pending queue with /withdrawals (round 2: NO card is
   sent when a withdrawal is created) and each withdrawal is
   presented as a review card carrying the full picture
   (identity + player number, wallet + verification + wallet age,
   current in-bot balance, join date, who referred him, his referral
   counts, the LIVE on-chain hold, the multi-account verdict +
   count, where his coins came from, his previous withdrawals) and four decision
   buttons — ✅ approve (fires the EXISTING attemptPayout state
   machine, unchanged), ❌ reject (NO refund: the deducted coins stay
   deducted — the owner's explicit order, deliberately unlike the
   admin panel's reject-refund), 🚫 ban (reject + ban the player),
   ⏭ skip. /withdrawals walks the pending queue one card at a time;
   every decision advances to the next card and the end of the queue
   prints a session summary. Sessions live in a process-local Map —
   a restart just means /withdrawals starts the walk over; the
   cards already in chat keep working because each decision
   re-reads the record and re-checks its status. Decisions are made
   in the DB FIRST and messaged second, so a Telegram failure can
   never corrupt a decision. */
const wdSessions = new Map(); // chatId -> { presented:Set<number>, paid, rejected, banned, skipped }
const fmtAmt = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 }); };
const fmtDateTime = (ts) => fmtDayMonYear(ts) + ' · ' + new Date(Number(ts) || 0).toISOString().slice(11, 19) + ' UTC';

async function pendingWithdrawals() {
  const all = (await getVal(rtdb().ref('withdrawals'))) || {};
  return Object.values(all).filter((w) => w && w.status === 'Pending ⏳').sort((a, b) => (Number(a.wdNum) || 0) - (Number(b.wdNum) || 0));
}

/* The multi-account cluster around a player: the same both-
   directions BFS over the stored multiLinks lists that /multi
   (multiTree) performs — a player's links are its multiLinks.ids
   PLUS every player whose stored ids contain it (the stored lists
   are asymmetric). Returns the BFS order (target first) and each
   node's parent (the account it was first reached through), which
   is what linkReason() labels are read off. */
function multiClusterOf(players, target) {
  const idsOf = (p) => (p && p.multiLinks && Array.isArray(p.multiLinks.ids)) ? p.multiLinks.ids.map(String) : [];
  const listedBy = new Map();
  for (const [uid, p] of Object.entries(players || {})) {
    for (const id of idsOf(p)) {
      if (!listedBy.has(id)) listedBy.set(id, []);
      listedBy.get(id).push(uid);
    }
  }
  const neighborsOf = (uid) => [...new Set([...idsOf(players[uid]), ...(listedBy.get(uid) || [])])]
    .filter((id) => id !== uid && players[id]).sort();
  const parent = new Map([[target, null]]);
  const order = [target];
  for (let i = 0; i < order.length; i++) {
    for (const nb of neighborsOf(order[i])) {
      if (!parent.has(nb)) { parent.set(nb, order[i]); order.push(nb); }
    }
  }
  return { order, parent };
}

async function buildWdReviewCard(wd, position) {
  const cfg = await getConfig();
  const sym = esc(cfg.coinSym);
  const num = Number(wd.wdNum);
  const uid = String(wd.userId);
  const [player, players, prevWds] = await Promise.all([
    getVal(P(uid)),
    getVal(rtdb().ref('players')),
    withdrawalsOfUser(uid)
  ]);
  const p = player || {};
  const allPlayers = players || {};
  const name = esc(p.name || wd.userName || '—');
  const uname = p.username ? ' (@' + esc(p.username) + ')' : '';
  /* multi-account verdict (owner order 2026-11-14, round 2): the
     card shows ONLY the verdict + the cluster size, on its own
     line — never the linked accounts themselves (the full tree
     stays in /multi). The cluster is the stored-link cluster
     (both-directions BFS, as /multi) unioned with riskOf()'s live
     sig-registry links; after the round-2 rule a shared IP
     contributes to NEITHER source. */
  const linked = new Set();
  const { order } = multiClusterOf(allPlayers, uid);
  for (const id of order.slice(1)) linked.add(id);
  try {
    const rk = await riskOf(uid);
    for (const row of (rk && rk.linked) || []) linked.add(String(row.id));
  } catch (e) { /* the stored cluster alone is a complete picture */ }
  const multiLine = linked.size
    ? `🔴 <b>عامل تعدد — مرتبط بـ ${linked.size} حساب</b>`
    : '✅ <b>مش عامل تعدد</b>';
  /* live on-chain hold; a chain hiccup falls back to the player's
     last synced hold, labelled as such */
  let holdTxt;
  try { holdTxt = fmtAmt(await jettonHold(wd.walletAddr || p.walletAddr || '')); }
  catch (e) { holdTxt = fmtAmt(p.hold) + ' (آخر مزامنة)'; }
  const inv = p.invitedBy ? allPlayers[String(p.invitedBy)] : null;
  const invLine = p.invitedBy
    ? (inv ? `<b>${esc(inv.name || '—')}</b>${inv.username ? ' (@' + esc(inv.username) + ')' : ''} — <code>${esc(String(p.invitedBy))}</code>` : `<code>${esc(String(p.invitedBy))}</code>`)
    : 'دخول مباشر (بدون إحالة)';
  const refTotal = Object.values(allPlayers).filter((x) => x && String(x.invitedBy) === uid).length;
  const refActive = countActiveRefs(p.referrals); // the exact counter state() ships as player.activeRefs
  const prev = (prevWds || []).filter((w) => Number(w.wdNum) !== num);
  const prevSum = prev.reduce((s, w) => s + (Number(w.amt) || 0), 0);
  const verifiedLine = p.walletVerified === true
    ? '✅ موثّقة' + (Number(p.verifiedAt) > 0 ? ` (${fmtDayMonYear(p.verifiedAt)})` : '')
    : '❌ غير موثّقة';
  const ageLine = (p.walletAgeDays !== undefined && p.walletAgeDays !== null && Number.isFinite(Number(p.walletAgeDays)))
    ? `\n🕰 عمر المحفظة: ${Number(p.walletAgeDays)} يوم` : '';
  const joinLine = Number(p.createdAt) > 0
    ? `${fmtDayMonYear(p.createdAt)} (منذ ${Math.max(0, Math.floor((Date.now() - Number(p.createdAt)) / 86400000))} يوم)`
    : '—';
  /* earnings sources (owner order 2026-11-14, round 2): the
     earn* counters only started counting when they shipped, so a
     pre-existing player reads all zeros and the grid looks broken.
     When EVERY source is zero, say so in one honest line instead —
     presentation only, the counters themselves are never invented. */
  const sourcesAllZero = !(Number(p.earnMining) || 0) && !(Number(p.earnDaily) || 0) && !(Number(p.earnTasks) || 0) && !(Number(p.earnRef) || 0) && !(Number(p.refCommissionEarned) || 0);
  const sourcesBlock = sourcesAllZero
    ? '📊 <b>مصادر أرباحه:</b> مفيش أرباح متسجلة بالمصدر لحد دلوقتي'
    : `📊 <b>مصادر أرباحه:</b>\n🪦 التعدين: ${fmtAmt(p.earnMining)} · 📅 الدخول اليومي: ${fmtAmt(p.earnDaily)}\n✅ المهام: ${fmtAmt(p.earnTasks)} · 👥 الإحالات: ${fmtAmt(p.earnRef)} · 💸 عمولات محصّلة: ${fmtAmt(p.refCommissionEarned)}`;
  /* Layout (owner order 2026-11-14, round 2): one fact per line,
     a blank line between sections. With the multi section reduced
     to a single verdict line the card stays far under Telegram's
     4096 cap by construction — no shedding pass any more. */
  const text = [
    `🔍 <b>طلب سحب #${num}</b>${position ? ` — سحب ${position.index} من ${position.total}` : ''}`,
    '',
    `👤 <b>${name}</b>${uname}`,
    `🆔 <code>${esc(uid)}</code> · رقم اللاعب: ${Number(p.userNo) || '—'}`,
    '',
    `💰 <b>مبلغ السحب:</b> ${fmtCoins(wd.amt)} ${sym}`,
    `🧾 الرسوم: ${fmtCoins(wd.fee)} · الصافي: <b>${fmtCoins(wd.net)} ${sym}</b>`,
    '',
    `👛 <b>المحفظة:</b> <code>${esc(toFriendlyAddress(wd.walletAddr || p.walletAddr || ''))}</code>`,
    `⚰️ التوثيق: ${verifiedLine}${ageLine}`,
    '',
    `💎 <b>رصيده في البوت الآن:</b> ${fmtAmt(p.mined)} ${sym} (بعد خصم السحب)`,
    `🪙 الهولد على الشبكة الآن: ${holdTxt} ${sym}`,
    '',
    `🗓 في البوت من: ${joinLine}`,
    `🔗 أحاله: ${invLine}`,
    `👥 إحالاته: ${refTotal} · النشطة: ${refActive}`,
    '',
    multiLine,
    '',
    sourcesBlock,
    '',
    `⌛ سحوبات سابقة: ${prev.length} (إجمالي ${fmtCoins(prevSum)} ${sym})`,
    `⏱ وقت الطلب: ${fmtDateTime(wd.timestamp)}`
  ].join('\n');
  const keyboard = {
    inline_keyboard: [
      [{ text: '✅ موافقة', callback_data: 'wdok:' + num }, { text: '❌ رفض', callback_data: 'wdno:' + num }],
      [{ text: '🚫 حظر المستخدم', callback_data: 'wdban:' + num }, { text: '⏭ تخطي', callback_data: 'wdskip:' + num }]
    ]
  };
  return { text, keyboard };
}

/* Send one review card for a withdrawal. Default target is the
   owner; review sessions pass their chat explicitly. With OWNER_ID
   unset there is nobody to review with — skip silently. */
async function sendWdReviewCard(wdNum, position, chatId) {
  const target = (chatId !== undefined && chatId !== null) ? chatId : OWNER_ID;
  if (!target) return;
  const wd = await getVal(rtdb().ref('withdrawals/wd_' + Number(wdNum)));
  if (!wd) return;
  const card = await buildWdReviewCard(wd, position);
  await tg('sendMessage', { chat_id: target, parse_mode: 'HTML', text: card.text, reply_markup: card.keyboard });
}

function ensureWdSession(chatId, num) {
  let s = wdSessions.get(chatId);
  if (!s) { s = { presented: new Set(), paid: 0, rejected: 0, banned: 0, skipped: 0 }; wdSessions.set(chatId, s); }
  if (num !== undefined && num !== null) s.presented.add(Number(num));
  return s;
}

/* Send the session's next card: the lowest still-pending withdrawal
   this session has not presented yet. Returns false at queue end. */
async function sendNextWdCard(chatId) {
  const s = wdSessions.get(chatId);
  if (!s) return false;
  const pending = await pendingWithdrawals();
  const rest = pending.filter((w) => !s.presented.has(Number(w.wdNum)));
  if (!rest.length) return false;
  const next = rest[0];
  const position = { index: s.presented.size + 1, total: s.presented.size + rest.length };
  s.presented.add(Number(next.wdNum));
  await sendWdReviewCard(Number(next.wdNum), position, chatId);
  return true;
}

/* After a decision/skip: present the next card, or close the
   session with its summary when the queue is exhausted. */
async function advanceWdSession(chatId) {
  const s = wdSessions.get(chatId);
  if (!s) return;
  let sent = false;
  try { sent = await sendNextWdCard(chatId); } catch (e) { console.error('wd session next', e.message); }
  if (sent) return;
  wdSessions.delete(chatId);
  try {
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🏁 <b>انتهت المراجعة</b> — ✅ مدفوع: ${s.paid} · ❌ مرفوض: ${s.rejected} · 🚫 محظور: ${s.banned} · ⏭ متخطى: ${s.skipped}` });
  } catch (e) { console.error('wd session summary', e.message); }
}

/* /withdrawals (owner-only, dispatched from handleOwnerTools):
   start a fresh review walk over the pending queue. */
async function startWdReview(chatId) {
  const pending = await pendingWithdrawals();
  if (!pending.length) {
    await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: 'لا توجد سحوبات معلّقة ✅' });
    return;
  }
  wdSessions.set(chatId, { presented: new Set(), paid: 0, rejected: 0, banned: 0, skipped: 0 });
  await sendNextWdCard(chatId);
}

/* The review-card buttons (callback_query updates). Strictly
   owner-only; the callback is ALWAYS answered (a spinning button
   is a broken button). Every decision is committed to the DB
   before any message moves, and every Telegram call is
   best-effort — a messaging failure never corrupts a decision. */
async function handleBotCallback(cq) {
  let answered = false;
  const answer = async (text, alert) => {
    if (answered || !cq || !cq.id) return;
    answered = true;
    try { await tg('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: !!alert } : {}) }); } catch (e) { /* best-effort */ }
  };
  try {
    const fromId = cq && cq.from ? String(cq.from.id) : '';
    await getConfig();
    if (!isAdminUid(fromId)) { await answer('⛔ للمالك فقط', true); return; }
    const m = /^wd(ok|no|ban|skip):(\d+)$/.exec(String((cq && cq.data) || ''));
    if (!m) { await answer(''); return; }
    const op = m[1], num = Number(m[2]);
    const msg = (cq && cq.message) || {};
    const chatId = msg.chat ? msg.chat.id : Number(OWNER_ID);
    const editCard = async (suffix) => {
      if (!msg.message_id || chatId === undefined || chatId === null) return;
      try {
        await tg('editMessageText', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', text: String(msg.text || '') + suffix, reply_markup: { inline_keyboard: [] } });
      } catch (e) { console.error('wd card edit', num, e.message); }
    };
    const ref = rtdb().ref('withdrawals/wd_' + num);
    const wd = await getVal(ref);
    if (!wd || wd.status !== 'Pending ⏳') {
      await answer('اتقرر في السحب ده خلاص');
      if (wd) await editCard(`\n\n— <b>الحالة الحالية:</b> ${esc(wd.status)}`);
      return;
    }
    if (op === 'skip') {
      const s = ensureWdSession(chatId, num);
      s.skipped++;
      await answer('تم التخطي');
      await advanceWdSession(chatId);
      return;
    }
    if (op === 'ok') {
      if (!payoutEnabled()) { await answer('الدفع التلقائي مش مفعّل على السيرفر', true); return; }
      if (wd.payoutState === 'paying') { await answer('الدفع جاري تنفيذه بالفعل'); return; }
      ensureWdSession(chatId, num);
      await answer('جاري الدفع…');
      await editCard('\n\n✅ <b>تمت الموافقة — جاري الدفع…</b>');
      // Fire the EXISTING payout state machine WITHOUT awaiting it
      // in the webhook path (seqno confirmation + tx-hash
      // resolution can take a couple of minutes). The settle
      // handler reports the outcome to the owner and only then
      // advances the review session.
      attemptPayout(num).then(async () => {
        try {
          const fin = await getVal(ref);
          const cfg = await getConfig();
          if (fin && fin.status === 'Paid ✅') {
            const s = wdSessions.get(chatId);
            if (s) s.paid++;
            const txUrl = payoutTxUrl(fin);
            await tg('sendMessage', {
              chat_id: chatId, parse_mode: 'HTML',
              text: `💸 <b>سحب #${num} اتدفع</b> — ${fmtCoins(fin.net)} ${esc(cfg.coinSym)}`,
              ...(txUrl ? { reply_markup: { inline_keyboard: [[{ text: '🔗 View Transaction', url: txUrl }]] } } : {})
            });
          } else if (fin && fin.payoutState === 'failed') {
            await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `⚠️ <b>سحب #${num}: الدفع فشل</b> — ${esc(fin.payoutError || 'خطأ غير معروف')} (السحب لسه معلّق)` });
          } else {
            await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `ℹ️ سحب #${num}: الدفع اتقرر أو جاري من مكان تاني — الحالة الحالية: ${esc((fin && fin.status) || '؟')}` });
          }
        } catch (e) { console.error('wd approve followup', num, e.message); }
        await advanceWdSession(chatId);
      }).catch((e) => console.error('wd approve payout', num, e.message));
      return;
    }
    /* wdno / wdban: flip the record FIRST (atomically — a second
       tap on a stale card loses the race and changes nothing),
       then message. NO refund either way: the deducted coins stay
       deducted (owner's explicit order). */
    const flip = await txUpdate(ref, (x) => {
      if (x === null) return { skip: true, out: null };
      if (x.status !== 'Pending ⏳') return { skip: true, out: null };
      return { value: { ...x, status: 'Rejected ❌', decidedAt: Date.now() }, out: x };
    });
    if (!flip) { await answer('اتقرر في السحب ده خلاص'); return; }
    const s = ensureWdSession(chatId, num);
    const cfg = await getConfig();
    if (op === 'ban') {
      try {
        const pref = P(wd.userId);
        if ((await getVal(pref)) !== null) await pref.update({ banned: true });
      } catch (e) { console.error('wd ban', num, e.message); }
      s.banned++;
      await answer('تم حظر المستخدم ورفض السحب');
      await editCard('\n\n🚫 <b>تم حظر المستخدم ورفض السحب — لم تُسترد العملات</b>');
      try { await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🚫 تم حظر <b>${esc(wd.userName || '')}</b> ورفض سحبه #${num} (${fmtCoins(wd.amt)} ${esc(cfg.coinSym)}) — لم تُسترد عملاته` }); } catch (e) { console.error('wd ban confirm', num, e.message); }
    } else {
      s.rejected++;
      await answer('تم الرفض');
      await editCard('\n\n❌ <b>تم الرفض — لم تُسترد العملات</b>');
      try { await tg('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `❌ تم رفض سحب #${num} (<b>${esc(wd.userName || '')}</b> — ${fmtCoins(wd.amt)} ${esc(cfg.coinSym)}) ولم تُسترد عملاته` }); } catch (e) { console.error('wd reject confirm', num, e.message); }
    }
    await advanceWdSession(chatId);
  } catch (e) {
    console.error('bot callback', e.message);
    await answer('');
  }
}

/* Boot line (owner order 2026-11-14): one startup line, always —
   the disabled line, or the live wallet + balances when enabled.
   Balances are best-effort: a chain hiccup at boot is logged,
   never fatal. */
async function initPayout() {
  if (!payoutEnabled()) {
    console.log(PAYOUT_MNEMONIC ? '[payout] disabled (PAYOUT_MNEMONIC is not a 24-word mnemonic)' : '[payout] disabled (PAYOUT_MNEMONIC not set)');
    return;
  }
  try {
    const client = await getPayoutClient();
    let tonTxt = '?', jTxt = '?';
    try { tonTxt = (Number(await client.getTonBalance()) / 1e9).toFixed(4); } catch (e) { /* best-effort */ }
    try {
      const d = await jettonDecimals();
      jTxt = (Number(await client.getJettonBalance()) / Math.pow(10, d)).toLocaleString('en-US');
    } catch (e) { /* best-effort */ }
    console.log(`[payout] wallet ${client.addressFriendly} | TON ${tonTxt} | ZOM ${jTxt}`);
  } catch (e) {
    console.error('[payout] init failed:', e.message);
  }
}

/* ---------- owner-only actions ---------- */
function owner(c) {
  if (!isAdminUid(c.user.id)) fail(403, 'Forbidden');
  if (Date.now() / 1000 - (c.authDate || 0) > 3600) fail(401, 'Reopen the app to use the admin tools');
}

async function adminState(c) {
  owner(c);
  const [playersObj, wdsObj] = await Promise.all([
    getVal(rtdb().ref('players').orderByChild('lastSeen').limitToLast(300)),
    getVal(rtdb().ref('withdrawals').orderByChild('wdNum').limitToLast(200))
  ]);
  // RTDB queries return the newest N in ascending order — sort desc in code
  // to match Firestore's orderBy(..., 'desc') results.
  const players = Object.values(playersObj || {}).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  // Multi-account links (report-only): each entry's persisted multiLinks
  // {count, ids} is enriched in the response with the linked users'
  // names/usernames (from this page where possible, else a direct read).
  const byId = new Map(players.map((p) => [String(p.id), p]));
  await Promise.all(players.filter((p) => p.multiLinks && (p.multiLinks.ids || []).length).map(async (p) => {
    const users = [];
    for (const id of (p.multiLinks.ids || []).slice(0, MULTI_IDS_CAP)) {
      let src = byId.get(String(id));
      if (!src) { try { src = await getVal(P(id)); } catch (e) { src = null; } }
      if (src) users.push({ id: String(id), name: src.name || '', username: src.username || '' });
    }
    p.multiLinks = { ...p.multiLinks, users };
  }));
  const wds = Object.entries(wdsObj || {}).map(([docId, v]) => ({ docId, ...v })).sort((a, b) => (b.wdNum || 0) - (a.wdNum || 0));
  // Verified badges in the admin withdrawal list: one bounded lookup
  // per distinct withdrawal user (from this page where possible).
  {
    const seen = new Map();
    await Promise.all([...new Set(wds.map((x) => String(x.userId)))].map(async (id) => {
      let src = byId.get(id);
      if (!src) { try { src = await getVal(P(id)); } catch (e) { src = null; } }
      seen.set(id, !!(src && src.walletVerified === true));
    }));
    wds.forEach((x) => { x.userVerified = seen.get(String(x.userId)) === true; });
  }
  const pending = wds.filter((x) => String(x.status).includes('Pending')).slice(0, 15);
  await Promise.all(pending.map(async (x) => { try { x.risk = await riskOf(x.userId); } catch (e) { console.error('risk', e.message); } }));
  return { players, withdrawals: wds, config: c.cfg };
}

async function adminBan(c) {
  owner(c);
  if (!isId(c.body.id)) fail(400, 'Bad id');
  const ref = P(c.body.id);
  // Firestore .update() errors on a missing doc (-> 500 in the handler);
  // RTDB update() would silently create a stub, so check first to match.
  if ((await getVal(ref)) === null) fail(500, 'Server error');
  await ref.update({ banned: c.body.banned === true });
  return { success: true };
}

async function adminAdjust(c) {
  owner(c);
  const amt = Number(c.body.amount);
  // |amt| bound: an unbounded value (e.g. 1e308 from a fat-fingered panel
  // input) would make `mined` un-storable (Infinity) and fail writes later.
  if (!isId(c.body.id) || !Number.isFinite(amt) || Math.abs(amt) > 1e12) fail(400, 'Bad input');
  const ref = P(c.body.id);
  if ((await getVal(ref)) === null) fail(500, 'Server error'); // same missing-doc behaviour as adminBan
  await ref.update({ mined: admin.database.ServerValue.increment(amt) });
  return { success: true };
}

async function adminWd(c) {
  owner(c);
  const docId = String(c.body.docId || '');
  if (!/^wd_\d+$/.test(docId)) fail(400, 'Bad id'); // docId is used as an RTDB path segment — never let it traverse
  const ref = rtdb().ref('withdrawals/' + docId);
  const reject = c.body.decision === 'reject';
  const txHash = clean(c.body.txHash, 100).trim();
  // the status flip stays atomic on the withdrawal node (double-processing
  // guard); the reject refund is applied right after — see PORT_NOTES.md
  const w = await txUpdate(ref, (x) => {
    if (x === null) return { error: new Fail(404, 'Not found') };
    // The auto-payout state machine owns 'paying'/'paid' records: a
    // manual decision here could double-pay (approve while a jetton
    // broadcast is in flight) or double-credit (reject-refund a
    // transfer that already landed). 'Paid ✅' via payout is final.
    if (x.payoutState === 'paid' || x.payoutState === 'paying') return { error: new Fail(400, 'Already processed') };
    if (!String(x.status).includes('Pending')) return { error: new Fail(400, 'Already processed') };
    const upd = reject
      ? { status: 'Rejected ❌' }
      : { status: 'Paid ✅', txLink: txHash ? 'https://tonviewer.com/transaction/' + encodeURIComponent(txHash) : 'https://tonviewer.com/' + encodeURIComponent(x.walletAddr) };
    return { value: { ...x, ...upd }, out: x };
  });
  if (reject) {
    try {
      await P(w.userId).update({ mined: admin.database.ServerValue.increment(w.amt) });
    } catch (e) {
      // Never leave a withdrawal marked Rejected while its refund failed:
      // flip it back to its Pending status so the owner can retry, then
      // surface the error. (The Firestore original did flip+refund in one
      // transaction; RTDB cannot — see PORT_NOTES.md.)
      try { await ref.update({ status: w.status }); } catch (e2) { console.error('adminWd revert', e2.message); }
      throw e;
    }
  }
  if (!reject) {
    // The shared payout celebration (photo DM + payouts-channel
    // post) — the same helper the automatic payout fires, exactly
    // once via the payoutNotifiedAt claim, so a manually approved
    // withdrawal celebrates identically and can never double-send
    // (e.g. auto-paid first, approved later — already refused above
    // by the payoutState guard, and the claim would stop it anyway).
    try {
      const txLink = txHash ? 'https://tonviewer.com/transaction/' + encodeURIComponent(txHash) : 'https://tonviewer.com/' + encodeURIComponent(w.walletAddr);
      await sendPayoutSuccess({ ...w, txLink }, null, c.cfg);
    } catch (e) { console.error('adminWd celebrate', e.message); }
  }
  if (!reject && c.cfg.payoutChannel) {
    const url = txHash ? 'https://tonviewer.com/transaction/' + encodeURIComponent(txHash) : 'https://tonviewer.com/' + encodeURIComponent(w.walletAddr);
    const a = String(w.walletAddr);
    // 'Start Mining Now' points at the direct app link built from the
    // RESOLVED real username (getMe, via resolveBotUsername) — the
    // admin-set cfg.botUsername goes stale (owner order 2026-11-14).
    // Only if no username can be resolved at all do we keep the old
    // ?startapp construction so the button still renders.
    const startUname = (await resolveBotUsername(c.cfg)) || String(c.cfg.botUsername || '').replace(/^@/, '').trim();
    const startUrl = startUname ? `https://t.me/${startUname}/app` : `https://t.me/${c.cfg.botUsername}?startapp`;
    await tg('sendMessage', {
      chat_id: c.cfg.payoutChannel, parse_mode: 'HTML',
      text: `🧟✅ <b>Withdrawal Proof #${w.wdNum} | ${esc(c.cfg.brandTitle)}</b>\n\n🔢 <b>Operation ID:</b> <code>#${w.wdNum}</code>\n👤 <b>Player:</b> ${esc(w.userName)} (<code>${esc(String(w.userId).slice(0, 4))}***</code>)\n💰 <b>Withdrawn Amount:</b> ${w.amt} ${esc(c.cfg.coinSym)}\n💎 <b>Net Sent:</b> ${w.net} ${esc(c.cfg.coinSym)}\n👛 <b>Receiver Wallet:</b> <code>${esc(a.slice(0, 6) + '...' + a.slice(-6))}</code>\n\n@${esc(c.cfg.botUsername)}`,
      reply_markup: { inline_keyboard: [[{ text: '🔗 View Real TX Link', url }], [{ text: '🧟 Start Digging Now', url: startUrl }]] }
    });
  }
  return { success: true };
}

async function adminSettings(c) {
  owner(c);
  const s = c.body.settings || {}, out = {};
  for (const k of NUM_KEYS) if (s[k] !== undefined) { const v = Number(s[k]); if (!Number.isFinite(v) || v < 0 || v > 1e12) fail(400, 'Bad ' + k); if ((k === 'withdrawFeePercent' || k === 'holdPercentReq') && v > 100) fail(400, 'Bad ' + k); out[k] = v; } // percents above 100 would make withdraw nets negative / holds impossible
  for (const k of STR_KEYS) if (s[k] !== undefined) out[k] = clean(s[k], 300);
  out.botToken = null; // was FieldValue.delete(): null in an RTDB update() deletes the child
  await rtdb().ref('settings/global').update(out);
  cfgCache = null;
  return { success: true };
}

/* ---------- admin PANEL API (owner order 2026-11-17) ----------
   Key-guarded actions for the web admin panel. These are NOT
   Telegram actions: the handler dispatches any action starting
   with 'panel' to PANEL_ACTIONS BEFORE the initData gate, with a
   minimal context { body, cfg, ip } — there is no c.user and nothing
   in this section may touch one. Every action re-checks the key
   itself (panelKey): ADMIN_PANEL_KEY is read from the env at call
   time; unset disables the panel (503), a mismatch is 401.
   Money rules are the LIVE ones, never the legacy adminWd ones:
   approvals go through attemptPayout, rejections use the
   bot-callback flip (Pending -> Rejected, NO refund), and
   verifications go through completeVerification. Consequential
   writes are audit-logged to meta/panelAudit; the owner's panel
   requests live in meta/panelRequests (both meta/ docs). */
/* Embedded admin panel page (owner order 2026-11-17): the panel
   HTML is served ONLY by this server at GET /panel behind Basic
   Auth — the GitHub repo is public, so the page must not live in
   it. Source file: the panel HTML embedded below as base64 —
   regenerate by re-encoding the panel HTML to base64. */
const PANEL_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImFyIiBkaXI9InJ0bCI+CjxoZWFkPgo8bWV0YSBjaGFyc2V0PSJ1dGYtOCI+CjxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsIGluaXRpYWwtc2NhbGU9MSI+Cjx0aXRsZT7ZhNmI2K3YqSDYqtit2YPZhSBaT01CSUUgTUlORTwvdGl0bGU+CjxzdHlsZT4KICA6cm9vdHsKICAgIC0tYmc6IzEyMTAwZDsgLS1iZzI6IzE3MTQxMDsgLS1jYXJkOiMxZTFhMTQ7IC0tY2FyZDI6IzI2MjExYTsKICAgIC0tbGluZTojM2QzNTI3OyAtLWdvbGQ6I2Q5YTQ0MTsgLS1nb2xkMjojZjBjODY5OyAtLXR4dDojZjJlYWQ4OwogICAgLS1tdXQ6I2FiOWQ4MDsgLS1yZWQ6I2U1NTM0YjsgLS1ncmVlbjojNGNhZjdkOyAtLXllbGxvdzojZTNiYTNjOwogICAgLS1ibHVlOiM1YWEyZTg7CiAgfQogICp7Ym94LXNpemluZzpib3JkZXItYm94fQogIGh0bWwsYm9keXttYXJnaW46MDtwYWRkaW5nOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdHh0KTsKICAgIGZvbnQtZmFtaWx5OiJTZWdvZSBVSSIsVGFob21hLEFyaWFsLHNhbnMtc2VyaWY7Zm9udC1zaXplOjE1cHh9CiAgLmhpZGRlbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fQogIGJ1dHRvbntmb250LWZhbWlseTppbmhlcml0O2N1cnNvcjpwb2ludGVyfQogIGlucHV0LHNlbGVjdCx0ZXh0YXJlYXtmb250LWZhbWlseTppbmhlcml0O2JhY2tncm91bmQ6dmFyKC0tYmcyKTtjb2xvcjp2YXIoLS10eHQpOwogICAgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjhweCAxMHB4O2ZvbnQtc2l6ZToxNHB4fQogIGlucHV0OmZvY3VzLHNlbGVjdDpmb2N1cyx0ZXh0YXJlYTpmb2N1c3tvdXRsaW5lOjFweCBzb2xpZCB2YXIoLS1nb2xkKX0KICAuYnRue2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE4MGRlZyx2YXIoLS1nb2xkMiksdmFyKC0tZ29sZCkpO2NvbG9yOiMyNDFhMDU7CiAgICBib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjlweDtwYWRkaW5nOjhweCAxNnB4O2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTRweH0KICAuYnRuOmFjdGl2ZXt0cmFuc2Zvcm06dHJhbnNsYXRlWSgxcHgpfQogIC5idG4tZ2hvc3R7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjp2YXIoLS1nb2xkMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1nb2xkKX0KICAuYnRuLWRhbmdlcntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsI2YwNjg1ZiwjYzkzYTMyKTtjb2xvcjojZmZmO2JvcmRlcjpub25lOwogICAgYm9yZGVyLXJhZGl1czo5cHg7cGFkZGluZzo4cHggMTRweDtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjE0cHh9CiAgLmJ0bi1zbWFsbHtwYWRkaW5nOjVweCAxMHB4O2ZvbnQtc2l6ZToxM3B4O2JvcmRlci1yYWRpdXM6N3B4fQogIC5idG5bZGlzYWJsZWRde29wYWNpdHk6LjU7Y3Vyc29yOmRlZmF1bHR9CiAgLyogLS0tLS0tLS0tLSBnYXRlIC0tLS0tLS0tLS0gKi8KICAjZ2F0ZXttaW4taGVpZ2h0OjEwMHZoO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtwYWRkaW5nOjIwcHh9CiAgLmdhdGUtY2FyZHtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tZ29sZCk7Ym9yZGVyLXJhZGl1czoxNnB4OwogICAgcGFkZGluZzoyOHB4IDI0cHg7bWF4LXdpZHRoOjM4MHB4O3dpZHRoOjEwMCU7dGV4dC1hbGlnbjpjZW50ZXI7CiAgICBib3gtc2hhZG93OjAgMTBweCA0MHB4IHJnYmEoMCwwLDAsLjUpfQogIC5nYXRlLWNhcmQgaDF7bWFyZ2luOjZweCAwIDJweDtmb250LXNpemU6MjJweDtjb2xvcjp2YXIoLS1nb2xkMil9CiAgLmdhdGUtY2FyZCBwe2NvbG9yOnZhcigtLW11dCk7bWFyZ2luOjRweCAwIDE2cHg7Zm9udC1zaXplOjEzcHh9CiAgLmdhdGUtY2FyZCBpbnB1dHt3aWR0aDoxMDAlO3RleHQtYWxpZ246Y2VudGVyO21hcmdpbi1ib3R0b206MTJweH0KICAuZ2F0ZS1jYXJkIC5idG57d2lkdGg6MTAwJX0KICAjZ2F0ZS1lcnJ7Y29sb3I6dmFyKC0tcmVkKTttaW4taGVpZ2h0OjIwcHg7Zm9udC1zaXplOjEzcHg7bWFyZ2luLXRvcDoxMHB4fQogIC8qIC0tLS0tLS0tLS0gbGF5b3V0IC0tLS0tLS0tLS0gKi8KICBoZWFkZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtwYWRkaW5nOjEycHggMTZweDsKICAgIGJhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgdmFyKC0tbGluZSk7cG9zaXRpb246c3RpY2t5O3RvcDowO3otaW5kZXg6NX0KICBoZWFkZXIgLnR0bHtmb250LXNpemU6MThweDtmb250LXdlaWdodDo4MDA7Y29sb3I6dmFyKC0tZ29sZDIpfQogIGhlYWRlciAuc3B7ZmxleDoxfQogIG5hdiN0YWJze2Rpc3BsYXk6ZmxleDtnYXA6NnB4O2ZsZXgtd3JhcDp3cmFwO3BhZGRpbmc6MTBweCAxNnB4IDB9CiAgbmF2I3RhYnMgYnV0dG9ue2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Y29sb3I6dmFyKC0tbXV0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOwogICAgYm9yZGVyLWJvdHRvbTpub25lO2JvcmRlci1yYWRpdXM6MTBweCAxMHB4IDAgMDtwYWRkaW5nOjlweCAxNHB4O2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjcwMH0KICBuYXYjdGFicyBidXR0b24ub257Y29sb3I6IzI0MWEwNTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsdmFyKC0tZ29sZDIpLHZhcigtLWdvbGQpKX0KICBtYWlue3BhZGRpbmc6MTRweCAxNnB4IDQwcHg7bWF4LXdpZHRoOjExODBweDttYXJnaW46MCBhdXRvfQogIHNlY3Rpb24udGFicGFuZXtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjAgMTJweCAxMnB4IDEycHg7cGFkZGluZzoxNnB4fQogIC8qIC0tLS0tLS0tLS0gY2FyZHMgJiB0YWJsZXMgLS0tLS0tLS0tLSAqLwogIC5jYXJkc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpbGwsbWlubWF4KDE2MHB4LDFmcikpO2dhcDoxMHB4fQogIC5zdGF0e2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxNHB4fQogIC5zdGF0IC52e2ZvbnQtc2l6ZToyNHB4O2ZvbnQtd2VpZ2h0OjgwMDtjb2xvcjp2YXIoLS1nb2xkMil9CiAgLnN0YXQgLmt7Y29sb3I6dmFyKC0tbXV0KTtmb250LXNpemU6MTNweDttYXJnaW4tdG9wOjJweH0KICAuc3RhdC53YXJuIC52e2NvbG9yOnZhcigtLXllbGxvdyl9CiAgdGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjE0cHh9CiAgdGgsdGR7cGFkZGluZzo4cHggOHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpO3RleHQtYWxpZ246cmlnaHQ7dmVydGljYWwtYWxpZ246dG9wfQogIHRoe2NvbG9yOnZhcigtLW11dCk7Zm9udC1zaXplOjEyLjVweDtmb250LXdlaWdodDo3MDA7d2hpdGUtc3BhY2U6bm93cmFwfQogIHRyLnJvd2xpbmt7Y3Vyc29yOnBvaW50ZXJ9CiAgdHIucm93bGluazpob3ZlciB0ZHtiYWNrZ3JvdW5kOnZhcigtLWNhcmQyKX0KICAuYmFkZ2V7ZGlzcGxheTppbmxpbmUtYmxvY2s7cGFkZGluZzoxcHggOHB4O2JvcmRlci1yYWRpdXM6MjBweDtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo3MDB9CiAgLmItZ3JlZW57YmFja2dyb3VuZDpyZ2JhKDc2LDE3NSwxMjUsLjE4KTtjb2xvcjp2YXIoLS1ncmVlbil9CiAgLmItcmVke2JhY2tncm91bmQ6cmdiYSgyMjksODMsNzUsLjE2KTtjb2xvcjp2YXIoLS1yZWQpfQogIC5iLXllbGxvd3tiYWNrZ3JvdW5kOnJnYmEoMjI3LDE4Niw2MCwuMTYpO2NvbG9yOnZhcigtLXllbGxvdyl9CiAgLmItZ3JleXtiYWNrZ3JvdW5kOnJnYmEoMTcxLDE1NywxMjgsLjE2KTtjb2xvcjp2YXIoLS1tdXQpfQogIC5iLWJsdWV7YmFja2dyb3VuZDpyZ2JhKDkwLDE2MiwyMzIsLjE2KTtjb2xvcjp2YXIoLS1ibHVlKX0KICAubW9ub3tmb250LWZhbWlseTpDb25zb2xhcyxtb25vc3BhY2U7Zm9udC1zaXplOjEyLjVweDt3b3JkLWJyZWFrOmJyZWFrLWFsbH0KICAubXV0e2NvbG9yOnZhcigtLW11dCl9IC5zbWFsbHtmb250LXNpemU6MTIuNXB4fQogIC50b29sYmFye2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tYm90dG9tOjEycHh9CiAgLnRvb2xiYXIgLnNwe2ZsZXg6MX0KICAuY2hpcHN7ZGlzcGxheTpmbGV4O2dhcDo2cHg7ZmxleC13cmFwOndyYXB9CiAgLmNoaXBzIGJ1dHRvbntiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6dmFyKC0tbXV0KTsKICAgIGJvcmRlci1yYWRpdXM6MjBweDtwYWRkaW5nOjVweCAxNHB4O2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTNweH0KICAuY2hpcHMgYnV0dG9uLm9ue2NvbG9yOiMyNDFhMDU7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHZhcigtLWdvbGQyKSx2YXIoLS1nb2xkKSk7Ym9yZGVyLWNvbG9yOnZhcigtLWdvbGQpfQogIC5wYWdlcntkaXNwbGF5OmZsZXg7Z2FwOjhweDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjttYXJnaW4tdG9wOjEycHh9CiAgLyogLS0tLS0tLS0tLSBkcmF3ZXIgLyBtb2RhbCAvIHRvYXN0IC0tLS0tLS0tLS0gKi8KICAjZHJhd2VyLXdyYXB7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjU1KTt6LWluZGV4OjIwfQogICNkcmF3ZXJ7cG9zaXRpb246YWJzb2x1dGU7dG9wOjA7Ym90dG9tOjA7aW5zZXQtaW5saW5lLXN0YXJ0OjA7d2lkdGg6bWluKDU2MHB4LDk2dncpOwogICAgYmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlci1pbmxpbmUtZW5kOjFweCBzb2xpZCB2YXIoLS1nb2xkKTtvdmVyZmxvdy15OmF1dG87cGFkZGluZzoxOHB4fQogICNkcmF3ZXIgaDJ7bWFyZ2luOjAgMCAycHg7Zm9udC1zaXplOjE5cHg7Y29sb3I6dmFyKC0tZ29sZDIpfQogIC5rdntkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjEzMHB4IDFmcjtnYXA6NXB4IDEwcHg7Zm9udC1zaXplOjE0cHg7bWFyZ2luOjEycHggMH0KICAua3YgLmt7Y29sb3I6dmFyKC0tbXV0KX0KICAuc2VjLXR7Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOnZhcigtLWdvbGQyKTttYXJnaW46MThweCAwIDhweDtmb250LXNpemU6MTVweH0KICAuYWN0LXJvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXI7bWFyZ2luOjhweCAwfQogICNtb2RhbC13cmFwe3Bvc2l0aW9uOmZpeGVkO2luc2V0OjA7YmFja2dyb3VuZDpyZ2JhKDAsMCwwLC42KTt6LWluZGV4OjMwOwogICAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3BhZGRpbmc6MThweH0KICAubW9kYWwtY2FyZHtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tZ29sZCk7Ym9yZGVyLXJhZGl1czoxNHB4OwogICAgbWF4LXdpZHRoOjQ0MHB4O3dpZHRoOjEwMCU7cGFkZGluZzoyMHB4fQogIC5tb2RhbC1jYXJkIGgze21hcmdpbjowIDAgOHB4O2NvbG9yOnZhcigtLWdvbGQyKX0KICAubW9kYWwtY2FyZCAuYm9keXtjb2xvcjp2YXIoLS10eHQpO2ZvbnQtc2l6ZToxNHB4O2xpbmUtaGVpZ2h0OjEuNzt3aGl0ZS1zcGFjZTpwcmUtbGluZX0KICAubW9kYWwtY2FyZCAucm93e2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2p1c3RpZnktY29udGVudDpmbGV4LXN0YXJ0O21hcmdpbi10b3A6MTZweH0KICAjdG9hc3R7cG9zaXRpb246Zml4ZWQ7Ym90dG9tOjE4cHg7aW5zZXQtaW5saW5lLXN0YXJ0OjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWCg1MCUpOwogICAgei1pbmRleDo0MDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo4cHg7YWxpZ24taXRlbXM6Y2VudGVyfQogIFtkaXI9InJ0bCJdICN0b2FzdHt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKX0KICAudG9hc3QtaXR7YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWdvbGQpO2NvbG9yOnZhcigtLXR4dCk7CiAgICBib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxMHB4IDE4cHg7Zm9udC1zaXplOjE0cHg7Ym94LXNoYWRvdzowIDhweCAzMHB4IHJnYmEoMCwwLDAsLjUpO21heC13aWR0aDo5MnZ3fQogIC50b2FzdC1pdC5lcnJ7Ym9yZGVyLWNvbG9yOnZhcigtLXJlZCk7Y29sb3I6I2ZmYjNhZX0KICBwcmUuanNvbntiYWNrZ3JvdW5kOnZhcigtLWJnKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTBweDsKICAgIHBhZGRpbmc6MTBweDtmb250LXNpemU6MTJweDtvdmVyZmxvdzphdXRvO21heC1oZWlnaHQ6MzAwcHg7ZGlyZWN0aW9uOmx0cjt0ZXh0LWFsaWduOmxlZnR9CiAgZGV0YWlsc3ttYXJnaW46MTBweCAwfQogIHN1bW1hcnl7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6dmFyKC0tZ29sZDIpO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTRweH0KICAuY2ZnLWdyaWR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maWxsLG1pbm1heCgyMzBweCwxZnIpKTtnYXA6MTBweCAxNnB4fQogIC5jZmctZ3JpZCBsYWJlbHtkaXNwbGF5OmJsb2NrO2NvbG9yOnZhcigtLW11dCk7Zm9udC1zaXplOjEyLjVweDttYXJnaW4tYm90dG9tOjRweH0KICAuY2ZnLWdyaWQgaW5wdXR7d2lkdGg6MTAwJX0KICAuZGVmLXJvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDthbGlnbi1pdGVtczpjZW50ZXI7bWFyZ2luLWJvdHRvbTo4cHh9CiAgLmRlZi1yb3cgaW5wdXR7d2lkdGg6MTMwcHh9CiAgdGV4dGFyZWF7d2lkdGg6MTAwJTttaW4taGVpZ2h0Ojc0cHg7cmVzaXplOnZlcnRpY2FsfQogIC5yZXEtaXR7YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEycHggMTRweDttYXJnaW4tYm90dG9tOjEwcHh9CiAgLnJlcS1pdCAudHh0e3doaXRlLXNwYWNlOnByZS13cmFwO2xpbmUtaGVpZ2h0OjEuN30KICAucmVxLWl0IC5yZXBseXtiYWNrZ3JvdW5kOnZhcigtLWJnKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDsKICAgIHBhZGRpbmc6MTJweCAxNHB4O21hcmdpbi10b3A6MTBweH0KICAucmVxLWl0IC5yZXBseS1ib2R5e3doaXRlLXNwYWNlOnByZS13cmFwO2xpbmUtaGVpZ2h0OjEuOTtmb250LXNpemU6MTQuNXB4O3dvcmQtYnJlYWs6YnJlYWstd29yZH0KICAucmVwbHktaGVhZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7bWFyZ2luLWJvdHRvbTo4cHh9CiAgLnJlcGx5LWhlYWQgLnNwe2ZsZXg6MX0KICAuY29weS1idG57YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLWdvbGQyKTsKICAgIGJvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NHB4IDEycHg7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcn0KICAuY29weS1idG46YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTYpfQogIC5lbXB0eXtjb2xvcjp2YXIoLS1tdXQpO3RleHQtYWxpZ246Y2VudGVyO3BhZGRpbmc6MjZweCAwfQogIC5zcGlue2NvbG9yOnZhcigtLW11dCk7dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzoyNnB4IDB9CiAgYXtjb2xvcjp2YXIoLS1ibHVlKX0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KCjwhLS0gPT09PT09PT0ga2V5IGdhdGUgPT09PT09PT0gLS0+CjxkaXYgaWQ9ImdhdGUiPgogIDxkaXYgY2xhc3M9ImdhdGUtY2FyZCI+CiAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6NDBweCI+4pqU77iPPC9kaXY+CiAgICA8aDE+2YTZiNit2Kkg2KrYrdmD2YUgWk9NQklFIE1JTkU8L2gxPgogICAgPHA+2K/YrtmR2YQg2YXZgdiq2KfYrSDYp9mE2YTZiNit2Kkg2YTZhNmF2KrYp9io2LnYqTwvcD4KICAgIDxpbnB1dCBpZD0iZ2F0ZS1rZXkiIHR5cGU9InBhc3N3b3JkIiBwbGFjZWhvbGRlcj0i2YXZgdiq2KfYrSDYp9mE2YTZiNit2KkiIGF1dG9jb21wbGV0ZT0ib2ZmIj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImdhdGUtYnRuIj7Yr9iu2YjZhDwvYnV0dG9uPgogICAgPGRpdiBpZD0iZ2F0ZS1lcnIiPjwvZGl2PgogIDwvZGl2Pgo8L2Rpdj4KCjwhLS0gPT09PT09PT0gYXBwID09PT09PT09IC0tPgo8ZGl2IGlkPSJhcHAiIGNsYXNzPSJoaWRkZW4iPgogIDxoZWFkZXI+CiAgICA8c3BhbiBjbGFzcz0idHRsIj7impTvuI8g2YTZiNit2Kkg2KrYrdmD2YUgWk9NQklFIE1JTkU8L3NwYW4+CiAgICA8c3BhbiBjbGFzcz0ic3AiPjwvc3Bhbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0bi1naG9zdCBidG4tc21hbGwiIGlkPSJidG4tcmVmcmVzaCI+4p+zINiq2K3Yr9mK2Ks8L2J1dHRvbj4KICAgIDxidXR0b24gY2xhc3M9ImJ0bi1naG9zdCBidG4tc21hbGwiIGlkPSJidG4ta2V5Ij7Yqti62YrZitixINin2YTZhdmB2KrYp9itPC9idXR0b24+CiAgPC9oZWFkZXI+CiAgPG5hdiBpZD0idGFicyI+CiAgICA8YnV0dG9uIGRhdGEtdGFiPSJzdGF0cyIgY2xhc3M9Im9uIj7Yp9mE2LHYptmK2LPZitipPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtdGFiPSJwbGF5ZXJzIj7Yp9mE2YTYp9i52KjZitmGPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtdGFiPSJ3ZHMiPtin2YTYs9it2YjYqNin2Ko8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS10YWI9ImJvdW50eSI+2KfZhNio2KfZiNmG2KrZijwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLXRhYj0idmVyaWZ5Ij7Yp9mE2KrZiNir2YrZgtin2Ko8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS10YWI9ImNvbmZpZyI+2KfZhNil2LnYr9in2K/Yp9iqPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtdGFiPSJyZXF1ZXN0cyI+2KfZhNi32YTYqNin2Ko8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS10YWI9ImF1ZGl0Ij7Ys9is2YQg2KfZhNil2KzYsdin2KHYp9iqPC9idXR0b24+CiAgPC9uYXY+CiAgPG1haW4+CiAgICA8c2VjdGlvbiBjbGFzcz0idGFicGFuZSIgaWQ9InBhbmUtc3RhdHMiPjwvc2VjdGlvbj4KICAgIDxzZWN0aW9uIGNsYXNzPSJ0YWJwYW5lIGhpZGRlbiIgaWQ9InBhbmUtcGxheWVycyI+PC9zZWN0aW9uPgogICAgPHNlY3Rpb24gY2xhc3M9InRhYnBhbmUgaGlkZGVuIiBpZD0icGFuZS13ZHMiPjwvc2VjdGlvbj4KICAgIDxzZWN0aW9uIGNsYXNzPSJ0YWJwYW5lIGhpZGRlbiIgaWQ9InBhbmUtYm91bnR5Ij48L3NlY3Rpb24+CiAgICA8c2VjdGlvbiBjbGFzcz0idGFicGFuZSBoaWRkZW4iIGlkPSJwYW5lLXZlcmlmeSI+PC9zZWN0aW9uPgogICAgPHNlY3Rpb24gY2xhc3M9InRhYnBhbmUgaGlkZGVuIiBpZD0icGFuZS1jb25maWciPjwvc2VjdGlvbj4KICAgIDxzZWN0aW9uIGNsYXNzPSJ0YWJwYW5lIGhpZGRlbiIgaWQ9InBhbmUtcmVxdWVzdHMiPjwvc2VjdGlvbj4KICAgIDxzZWN0aW9uIGNsYXNzPSJ0YWJwYW5lIGhpZGRlbiIgaWQ9InBhbmUtYXVkaXQiPjwvc2VjdGlvbj4KICA8L21haW4+CjwvZGl2PgoKPGRpdiBpZD0iZHJhd2VyLXdyYXAiIGNsYXNzPSJoaWRkZW4iPjxkaXYgaWQ9ImRyYXdlciI+PC9kaXY+PC9kaXY+CjxkaXYgaWQ9Im1vZGFsLXdyYXAiIGNsYXNzPSJoaWRkZW4iPjxkaXYgY2xhc3M9Im1vZGFsLWNhcmQiPgogIDxoMyBpZD0ibW9kYWwtdGl0bGUiPjwvaDM+CiAgPGRpdiBjbGFzcz0iYm9keSIgaWQ9Im1vZGFsLWJvZHkiPjwvZGl2PgogIDxkaXYgY2xhc3M9InJvdyI+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJtb2RhbC1vayI+2KrYo9mD2YrYrzwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IiBpZD0ibW9kYWwtY2FuY2VsIj7YpdmE2LrYp9ihPC9idXR0b24+CiAgPC9kaXY+CjwvZGl2PjwvZGl2Pgo8ZGl2IGlkPSJ0b2FzdCI+PC9kaXY+Cgo8c2NyaXB0PgoidXNlIHN0cmljdCI7Ci8qID09PT09PT09PT09PT09PT09IGhlbHBlcnMgPT09PT09PT09PT09PT09PT0gKi8KY29uc3QgJCA9IChzLCByKSA9PiAociB8fCBkb2N1bWVudCkucXVlcnlTZWxlY3RvcihzKTsKY29uc3QgJCQgPSAocywgcikgPT4gWy4uLihyIHx8IGRvY3VtZW50KS5xdWVyeVNlbGVjdG9yQWxsKHMpXTsKY29uc3QgZXNjID0gKHMpID0+IFN0cmluZyhzID09IG51bGwgPyAiIiA6IHMpLnJlcGxhY2UoL1smPD4iJ10vZywgKGNoKSA9PiAoeyAiJiI6ICImYW1wOyIsICI8IjogIiZsdDsiLCAiPiI6ICImZ3Q7IiwgJyInOiAiJnF1b3Q7IiwgIiciOiAiJiMzOTsiIH1bY2hdKSk7CmNvbnN0IGZtdE4gPSAobikgPT4gKE51bWJlcihuKSB8fCAwKS50b0xvY2FsZVN0cmluZygiZW4tVVMiKTsKY29uc3QgZm10RGF0ZSA9ICh0cykgPT4geyBpZiAoIXRzKSByZXR1cm4gIuKAlCI7IHRyeSB7IHJldHVybiBuZXcgRGF0ZShOdW1iZXIodHMpKS50b0xvY2FsZVN0cmluZygiYXItRUctdS1udS1sYXRuIiwgeyB0aW1lWm9uZTogIkFmcmljYS9DYWlybyIsIGRheTogIjItZGlnaXQiLCBtb250aDogIjItZGlnaXQiLCB5ZWFyOiAibnVtZXJpYyIsIGhvdXI6ICIyLWRpZ2l0IiwgbWludXRlOiAiMi1kaWdpdCIgfSk7IH0gY2F0Y2ggKGUpIHsgcmV0dXJuIG5ldyBEYXRlKE51bWJlcih0cykpLnRvTG9jYWxlU3RyaW5nKCk7IH0gfTsKY29uc3QgYm5BZ2VUeHQgPSAodHMpID0+IHsgY29uc3QgbXMgPSBEYXRlLm5vdygpIC0gTnVtYmVyKHRzKTsgaWYgKCFpc0Zpbml0ZShtcykgfHwgbXMgPCAwKSByZXR1cm4gItin2YTYotmGIjsgY29uc3QgaCA9IE1hdGguZmxvb3IobXMgLyAzNjAwMDAwKTsgaWYgKGggPCAxKSByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcihtcyAvIDYwMDAwKSkgKyAiINiv2YLZitmC2KkiOyBpZiAoaCA8IDI0KSByZXR1cm4gaCArICIg2LPYp9i52KkiOyBjb25zdCBkID0gTWF0aC5mbG9vcihoIC8gMjQpOyByZXR1cm4gZCArICIg2YrZiNmFINmIIiArIChoICUgMjQpICsgIiDYs9in2LnYqSI7IH07CmNvbnN0IHNob3J0QWRkciA9IChhKSA9PiB7IGEgPSBTdHJpbmcoYSB8fCAiIik7IHJldHVybiBhLmxlbmd0aCA+IDE4ID8gYS5zbGljZSgwLCAxMCkgKyAi4oCmIiArIGEuc2xpY2UoLTYpIDogKGEgfHwgIuKAlCIpOyB9Owpjb25zdCBBVkFUQVJfTkFNRVMgPSB7IDE6ICJTSElFTERCRUFSRVIiLCAyOiAiU0lMRU5UQkxBREUiLCAzOiAiSVJPTkJFQVJEIiwgNDogIkZMQU1FSEVBUlQiLCA1OiAiU1RPTkVCRUFSRCIsIDY6ICJXT0xGS0lOIiwgNzogIkVNQkVSV0lTUCIsIDg6ICJTVE9STUJPUk4iIH07CgpsZXQgS0VZID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oInpvbWJpZV9hZG1pbl9rZXkiKSB8fCAiIjsKY29uc3QgYXBpQmFzZSA9ICgpID0+IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCJ6b21iaWVfYXBpX2Jhc2UiKSB8fCAiaHR0cHM6Ly96b21iaWUtYXBpLTl4MjcuZHVja2Rucy5vcmciOwphc3luYyBmdW5jdGlvbiBhcGkoYWN0aW9uLCBwYXlsb2FkKSB7CiAgY29uc3QgciA9IGF3YWl0IGZldGNoKGFwaUJhc2UoKSwgeyBtZXRob2Q6ICJQT1NUIiwgaGVhZGVyczogeyAiQ29udGVudC1UeXBlIjogImFwcGxpY2F0aW9uL2pzb24iIH0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgYWN0aW9uLCBrZXk6IEtFWSwgLi4uKHBheWxvYWQgfHwge30pIH0pIH0pOwogIGxldCBqID0gbnVsbDsgdHJ5IHsgaiA9IGF3YWl0IHIuanNvbigpOyB9IGNhdGNoIChlKSB7IC8qIGlnbm9yZSAqLyB9CiAgaWYgKCFyLm9rKSB7IGNvbnN0IGVyciA9IG5ldyBFcnJvcigoaiAmJiBqLmVycm9yKSB8fCAoIkhUVFAgIiArIHIuc3RhdHVzKSk7IGVyci5zdGF0dXMgPSByLnN0YXR1czsgdGhyb3cgZXJyOyB9CiAgcmV0dXJuIGo7Cn0KZnVuY3Rpb24gdG9hc3QobXNnLCBpc0VycikgewogIGNvbnN0IGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCJkaXYiKTsKICBkLmNsYXNzTmFtZSA9ICJ0b2FzdC1pdCIgKyAoaXNFcnIgPyAiIGVyciIgOiAiIik7CiAgZC5pbm5lckhUTUwgPSBtc2c7CiAgJCgiI3RvYXN0IikuYXBwZW5kQ2hpbGQoZCk7CiAgc2V0VGltZW91dCgoKSA9PiBkLnJlbW92ZSgpLCBpc0VyciA/IDcwMDAgOiA0NTAwKTsKfQpmdW5jdGlvbiBlcnJUb2FzdChlKSB7IHRvYXN0KCLinYwgIiArIGVzYyhlLm1lc3NhZ2UgfHwgZSksIHRydWUpOyB9CmxldCBtb2RhbFJlc29sdmUgPSBudWxsOwpmdW5jdGlvbiBzaG93Q29uZmlybSh0aXRsZSwgYm9keSwgb2tUZXh0LCBkYW5nZXIpIHsKICAkKCIjbW9kYWwtdGl0bGUiKS50ZXh0Q29udGVudCA9IHRpdGxlOwogICQoIiNtb2RhbC1ib2R5IikudGV4dENvbnRlbnQgPSBib2R5OwogIGNvbnN0IG9rID0gJCgiI21vZGFsLW9rIik7CiAgb2sudGV4dENvbnRlbnQgPSBva1RleHQgfHwgItiq2KPZg9mK2K8iOwogIG9rLmNsYXNzTmFtZSA9IGRhbmdlciA/ICJidG4tZGFuZ2VyIiA6ICJidG4iOwogICQoIiNtb2RhbC13cmFwIikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXMpID0+IHsgbW9kYWxSZXNvbHZlID0gcmVzOyB9KTsKfQokKCIjbW9kYWwtb2siKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpID0+IHsgJCgiI21vZGFsLXdyYXAiKS5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsgaWYgKG1vZGFsUmVzb2x2ZSkgbW9kYWxSZXNvbHZlKHRydWUpOyB9KTsKJCgiI21vZGFsLWNhbmNlbCIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCkgPT4geyAkKCIjbW9kYWwtd3JhcCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOyBpZiAobW9kYWxSZXNvbHZlKSBtb2RhbFJlc29sdmUoZmFsc2UpOyB9KTsKCi8qID09PT09PT09PT09PT09PT09IGdhdGUgPT09PT09PT09PT09PT09PT0gKi8KYXN5bmMgZnVuY3Rpb24gdHJ5RW50ZXIoKSB7CiAgY29uc3QgZXJyID0gJCgiI2dhdGUtZXJyIik7IGVyci50ZXh0Q29udGVudCA9ICIiOwogIHRyeSB7CiAgICBhd2FpdCBhcGkoInBhbmVsU3RhdHMiKTsKICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKCJ6b21iaWVfYWRtaW5fa2V5IiwgS0VZKTsKICAgICQoIiNnYXRlIikuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7CiAgICAkKCIjYXBwIikuY2xhc3NMaXN0LnJlbW92ZSgiaGlkZGVuIik7CiAgICBsb2FkU3RhdHMoKTsKICB9IGNhdGNoIChlKSB7CiAgICBpZiAoZS5zdGF0dXMgPT09IDUwMykgZXJyLnRleHRDb250ZW50ID0gItin2YTZhNmI2K3YqSDYutmK2LEg2YXZgdi52ZHZhNipINi52YTZiSDYp9mE2LPZitix2YHYsSAo2KfZhNmF2YHYqtin2K0g2LrZitixINmF2LbYqNmI2LcpLiI7CiAgICBlbHNlIGlmIChlLnN0YXR1cyA9PT0gNDAxKSBlcnIudGV4dENvbnRlbnQgPSAi2KfZhNmF2YHYqtin2K0g2LrZitixINi12K3ZititLiI7CiAgICBlbHNlIGVyci50ZXh0Q29udGVudCA9ICLYqti52LDYsSDYp9mE2KfYqti12KfZhCDYqNin2YTYs9mK2LHZgdixOiAiICsgZS5tZXNzYWdlOwogIH0KfQokKCIjZ2F0ZS1idG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpID0+IHsgS0VZID0gJCgiI2dhdGUta2V5IikudmFsdWUudHJpbSgpOyB0cnlFbnRlcigpOyB9KTsKJCgiI2dhdGUta2V5IikuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsIChlKSA9PiB7IGlmIChlLmtleSA9PT0gIkVudGVyIikgeyBLRVkgPSBlLnRhcmdldC52YWx1ZS50cmltKCk7IHRyeUVudGVyKCk7IH0gfSk7CiQoIiNidG4ta2V5IikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKSA9PiB7CiAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oInpvbWJpZV9hZG1pbl9rZXkiKTsgS0VZID0gIiI7CiAgJCgiI2FwcCIpLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOyAkKCIjZ2F0ZSIpLmNsYXNzTGlzdC5yZW1vdmUoImhpZGRlbiIpOyAkKCIjZ2F0ZS1rZXkiKS52YWx1ZSA9ICIiOwp9KTsKJCgiI2J0bi1yZWZyZXNoIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKSA9PiB7IGNvbnN0IHQgPSBjdXJyZW50VGFiOyBsb2FkZWRbdF0gPSBmYWxzZTsgc2hvd1RhYih0KTsgfSk7CgovKiA9PT09PT09PT09PT09PT09PSB0YWJzID09PT09PT09PT09PT09PT09ICovCmxldCBjdXJyZW50VGFiID0gInN0YXRzIjsKY29uc3QgbG9hZGVkID0ge307CmNvbnN0IGxvYWRlcnMgPSB7fTsKZnVuY3Rpb24gc2hvd1RhYih0KSB7CiAgY3VycmVudFRhYiA9IHQ7CiAgJCQoIiN0YWJzIGJ1dHRvbiIpLmZvckVhY2goKGIpID0+IGIuY2xhc3NMaXN0LnRvZ2dsZSgib24iLCBiLmRhdGFzZXQudGFiID09PSB0KSk7CiAgJCQoInNlY3Rpb24udGFicGFuZSIpLmZvckVhY2goKHMpID0+IHMuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIikpOwogICQoIiNwYW5lLSIgKyB0KS5jbGFzc0xpc3QucmVtb3ZlKCJoaWRkZW4iKTsKICBpZiAoIWxvYWRlZFt0XSAmJiBsb2FkZXJzW3RdKSB7IGxvYWRlZFt0XSA9IHRydWU7IGxvYWRlcnNbdF0oKTsgfQp9CiQkKCIjdGFicyBidXR0b24iKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCkgPT4gc2hvd1RhYihiLmRhdGFzZXQudGFiKSkpOwoKLyogPT09PT09PT09PT09PT09PT0gc3RhdHMgPT09PT09PT09PT09PT09PT0gKi8KYXN5bmMgZnVuY3Rpb24gbG9hZFN0YXRzKCkgewogIGNvbnN0IHBhbmUgPSAkKCIjcGFuZS1zdGF0cyIpOwogIHBhbmUuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9InNwaW4iPtis2KfYsdmNINin2YTYqtit2YXZitmE4oCmPC9kaXY+JzsKICB0cnkgewogICAgY29uc3QgcyA9IGF3YWl0IGFwaSgicGFuZWxTdGF0cyIpOwogICAgY29uc3QgcCA9IHMucGxheWVycyB8fCB7fSwgdyA9IHMud2l0aGRyYXdhbHMgfHwge30sIHYgPSBzLnZlcmlmeSB8fCB7fTsKICAgIGNvbnN0IHN0YXQgPSAoaywgdmFsLCB3YXJuKSA9PiBgPGRpdiBjbGFzcz0ic3RhdCR7d2FybiA/ICIgd2FybiIgOiAiIn0iPjxkaXYgY2xhc3M9InYiPiR7dmFsfTwvZGl2PjxkaXYgY2xhc3M9ImsiPiR7a308L2Rpdj48L2Rpdj5gOwogICAgbGV0IGh0bWwgPSAnPGRpdiBjbGFzcz0iY2FyZHMiPicKICAgICAgKyBzdGF0KCLYpdis2YXYp9mE2Yog2KfZhNmE2KfYudio2YrZhiIsIGZtdE4ocC50b3RhbCkpCiAgICAgICsgc3RhdCgi2KfZhNmF2YjYq9mR2YLZiNmGIOKchSIsIGZtdE4ocC52ZXJpZmllZCkpCiAgICAgICsgc3RhdCgi2KfZhNmF2K3YuNmI2LHZiNmGIPCfmqsiLCBmbXROKHAuYmFubmVkKSkKICAgICAgKyBzdGF0KCLYrNiv2KfYryDYp9mE2YbZh9in2LHYr9ipIiwgZm10TihwLm5ld1RvZGF5KSkKICAgICAgKyBzdGF0KCLYpdis2YXYp9mE2Yog2KfZhNmF2LnYr9mR2YYiLCBmbXROKHAudG90YWxNaW5lZCkpCiAgICAgICsgc3RhdCgi2LPYrdmI2KjYp9iqINmF2LnZhNmR2YLYqSDij7MiLCBmbXROKHcucGVuZGluZyksIHcucGVuZGluZyA+IDApCiAgICAgICsgc3RhdCgi2LPYrdmI2KjYp9iqINmF2K/ZgdmI2LnYqSIsIGZtdE4ody5wYWlkQ291bnQpKQogICAgICArIHN0YXQoItiz2K3ZiNio2KfYqiDZhdix2YHZiNi22KkiLCBmbXROKHcucmVqZWN0ZWRDb3VudCkpCiAgICAgICsgc3RhdCgi2KrZiNir2YrZgtin2Kog2YXZgdiq2YjYrdipIOKaoO+4jyIsIGZtdE4odi5vcGVuVW5yZXNvbHZlZCksIHYub3BlblVucmVzb2x2ZWQgPiAwKQogICAgICArICI8L2Rpdj4iOwogICAgaHRtbCArPSAnPGRpdiBjbGFzcz0ic2VjLXQiPtmF2K3Zgdi42Kkg2KfZhNiv2YHYuTwvZGl2PjxkaXYgY2xhc3M9ImNhcmRzIj4nCiAgICAgICsgKHMucGF5b3V0CiAgICAgICAgPyBzdGF0KCLYsdi12YrYryBUT04iLCBOdW1iZXIocy5wYXlvdXQudG9uKS50b0ZpeGVkKDQpKSArIHN0YXQoItix2LXZitivIFpNIiwgZm10TihzLnBheW91dC56b20pKQogICAgICAgIDogJzxkaXYgY2xhc3M9InN0YXQiPjxkaXYgY2xhc3M9InYiPuKAlDwvZGl2PjxkaXYgY2xhc3M9ImsiPtin2YTYr9mB2Lkg2LrZitixINmF2YHYudmR2YQg2KPZiCDYqti52LDYsdiqINin2YTZgtix2KfYodipPC9kaXY+PC9kaXY+JykKICAgICAgKyAiPC9kaXY+IjsKICAgIGh0bWwgKz0gJzxkaXYgY2xhc3M9InNlYy10Ij7Yrdin2YTYqSDYp9mE2KrZiNir2YrZgiDYp9mE2KrZhNmC2KfYptmKPC9kaXY+PGRpdiBjbGFzcz0iY2FyZHMiPicKICAgICAgKyBzdGF0KCLZhdiv2YHZiNi52KfYqiDZhdi52KfZhNmO2KzYqSIsIGZtdE4odi5wcm9jZXNzZWRUb3RhbCkpCiAgICAgICsgc3RhdCgi2KrYo9iu2LEg2KfZhNmF2KTYtNixICjYq9in2YbZitipKSIsIHYuY3Vyc29yTGFnU2VjID09IG51bGwgPyAi4oCUIiA6IGZtdE4odi5jdXJzb3JMYWdTZWMpLCB2LmN1cnNvckxhZ1NlYyA+IDYwMCkKICAgICAgKyBzdGF0KCLYqti02LrZitmEINin2YTYs9mK2LHZgdixIiwgTWF0aC5mbG9vcigocy51cHRpbWVTZWMgfHwgMCkgLyAzNjAwKSArICIg2LPYp9i52KkiKQogICAgICArIHN0YXQoItmI2YLYqiDYp9mE2LPZitix2YHYsSIsIGVzYyhmbXREYXRlKHMuc2VydmVyVGltZSkpKQogICAgICArICI8L2Rpdj4iOwogICAgcGFuZS5pbm5lckhUTUwgPSBodG1sOwogIH0gY2F0Y2ggKGUpIHsgcGFuZS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHkiPtiq2LnYsNixINiq2K3ZhdmK2YQg2KfZhNil2K3Ytdin2KbZitin2Ko8L2Rpdj4nOyBlcnJUb2FzdChlKTsgfQp9CmxvYWRlcnMuc3RhdHMgPSBsb2FkU3RhdHM7CgovKiA9PT09PT09PT09PT09PT09PSBwbGF5ZXJzID09PT09PT09PT09PT09PT09ICovCmNvbnN0IHBsU3RhdGUgPSB7IHE6ICIiLCBwYWdlOiAwLCB0b3RhbDogMCwgcGFnZXM6IDAgfTsKYXN5bmMgZnVuY3Rpb24gbG9hZFBsYXllcnMoKSB7CiAgY29uc3QgcGFuZSA9ICQoIiNwYW5lLXBsYXllcnMiKTsKICBwYW5lLmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InRvb2xiYXIiPgogICAgICA8aW5wdXQgaWQ9InBsLXEiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSLYqNit2Ks6INix2YLZhSDZhNin2LnYqCAoMS02INij2LHZgtin2YUpINij2Ygg2KLZitiv2Yog2KrZitmE2YrYrNix2KfZhSDYo9mIINin2LPZhSAvINmK2YjYstixIiBzdHlsZT0iZmxleDoxO21pbi13aWR0aDoyMjBweCIgdmFsdWU9IiR7ZXNjKHBsU3RhdGUucSl9Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0icGwtc2VhcmNoIj7YqNit2Ks8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IiBpZD0icGwtYWxsIj7Yp9mE2YPZhCAo2KfZhNij2K3Yr9irINmG2LTYp9i32YvYpyk8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0icGwtYm9keSI+PGRpdiBjbGFzcz0ic3BpbiI+2KzYp9ix2Y0g2KfZhNiq2K3ZhdmK2YTigKY8L2Rpdj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InBhZ2VyIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IGJ0bi1zbWFsbCIgaWQ9InBsLXByZXYiPtin2YTYs9in2KjZgjwvYnV0dG9uPgogICAgICA8c3BhbiBjbGFzcz0ibXV0IiBpZD0icGwtcGluZm8iPjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IGJ0bi1zbWFsbCIgaWQ9InBsLW5leHQiPtin2YTYqtin2YTZijwvYnV0dG9uPgogICAgPC9kaXY+YDsKICAkKCIjcGwtc2VhcmNoIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKSA9PiB7IHBsU3RhdGUucSA9ICQoIiNwbC1xIikudmFsdWUudHJpbSgpOyBwbFN0YXRlLnBhZ2UgPSAwOyBmZXRjaFBsYXllcnMoKTsgfSk7CiAgJCgiI3BsLXEiKS5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIiwgKGUpID0+IHsgaWYgKGUua2V5ID09PSAiRW50ZXIiKSB7IHBsU3RhdGUucSA9IGUudGFyZ2V0LnZhbHVlLnRyaW0oKTsgcGxTdGF0ZS5wYWdlID0gMDsgZmV0Y2hQbGF5ZXJzKCk7IH0gfSk7CiAgJCgiI3BsLWFsbCIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCkgPT4geyBwbFN0YXRlLnEgPSAiIjsgJCgiI3BsLXEiKS52YWx1ZSA9ICIiOyBwbFN0YXRlLnBhZ2UgPSAwOyBmZXRjaFBsYXllcnMoKTsgfSk7CiAgJCgiI3BsLXByZXYiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpID0+IHsgaWYgKHBsU3RhdGUucGFnZSA+IDApIHsgcGxTdGF0ZS5wYWdlLS07IGZldGNoUGxheWVycygpOyB9IH0pOwogICQoIiNwbC1uZXh0IikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKSA9PiB7IGlmIChwbFN0YXRlLnBhZ2UgPCBwbFN0YXRlLnBhZ2VzIC0gMSkgeyBwbFN0YXRlLnBhZ2UrKzsgZmV0Y2hQbGF5ZXJzKCk7IH0gfSk7CiAgZmV0Y2hQbGF5ZXJzKCk7Cn0KYXN5bmMgZnVuY3Rpb24gZmV0Y2hQbGF5ZXJzKCkgewogIGNvbnN0IGJvZHkgPSAkKCIjcGwtYm9keSIpOyBpZiAoIWJvZHkpIHJldHVybjsKICBib2R5LmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJzcGluIj7YrNin2LHZjSDYp9mE2KrYrdmF2YrZhOKApjwvZGl2Pic7CiAgdHJ5IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoInBhbmVsUGxheWVycyIsIHsgcTogcGxTdGF0ZS5xLCBwYWdlOiBwbFN0YXRlLnBhZ2UgfSk7CiAgICBwbFN0YXRlLnRvdGFsID0gci50b3RhbDsgcGxTdGF0ZS5wYWdlcyA9IHIucGFnZXM7IHBsU3RhdGUucGFnZSA9IHIucGFnZTsKICAgICQoIiNwbC1waW5mbyIpLnRleHRDb250ZW50ID0gYNi12YHYrdipICR7ci5wYWdlICsgMX0g2YXZhiAke01hdGgubWF4KHIucGFnZXMsIDEpfSDigJQg2KfZhNil2KzZhdin2YTZiiAke2ZtdE4oci50b3RhbCl9YDsKICAgIGlmICghci5yb3dzLmxlbmd0aCkgeyBib2R5LmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eSI+2YTYpyDYqtmI2KzYryDZhtiq2KfYptisPC9kaXY+JzsgcmV0dXJuOyB9CiAgICBib2R5LmlubmVySFRNTCA9IGA8dGFibGU+PHRoZWFkPjx0cj4KICAgICAgPHRoPtin2YTZhNin2LnYqDwvdGg+PHRoPtix2YLZhTwvdGg+PHRoPtmF2LnYr9mR2YY8L3RoPjx0aD7Zh9mI2YTYrzwvdGg+PHRoPtiq2YjYq9mK2YI8L3RoPjx0aD7Yrdin2YTYqTwvdGg+PHRoPtii2K7YsSDYuNmH2YjYsTwvdGg+CiAgICAgIDwvdHI+PC90aGVhZD48dGJvZHk+JHtyLnJvd3MubWFwKChwKSA9PiBgCiAgICAgIDx0ciBjbGFzcz0icm93bGluayIgZGF0YS1pZD0iJHtlc2MocC5pZCl9Ij4KICAgICAgICA8dGQ+PGI+JHtlc2MocC5uYW1lIHx8ICLigJQiKX08L2I+ICR7cC51c2VybmFtZSA/IGA8c3BhbiBjbGFzcz0ibXV0Ij5AJHtlc2MocC51c2VybmFtZSl9PC9zcGFuPmAgOiAiIn08YnI+PHNwYW4gY2xhc3M9Im1vbm8gbXV0Ij4ke2VzYyhwLmlkKX08L3NwYW4+PC90ZD4KICAgICAgICA8dGQ+JHtwLnVzZXJObyB8fCAi4oCUIn08L3RkPgogICAgICAgIDx0ZD4ke2ZtdE4ocC5taW5lZCl9PC90ZD4KICAgICAgICA8dGQ+JHtmbXROKHAuaG9sZCl9PC90ZD4KICAgICAgICA8dGQ+JHtwLndhbGxldFZlcmlmaWVkID8gJzxzcGFuIGNsYXNzPSJiYWRnZSBiLWdyZWVuIj7ZhdmI2KvZkdmCIOKchTwvc3Bhbj4nIDogJzxzcGFuIGNsYXNzPSJiYWRnZSBiLWdyZXkiPti62YrYsSDZhdmI2KvZkdmCPC9zcGFuPid9PC90ZD4KICAgICAgICA8dGQ+JHtwLmJhbm5lZCA/ICc8c3BhbiBjbGFzcz0iYmFkZ2UgYi1yZWQiPtmF2K3YuNmI2LEg8J+aqzwvc3Bhbj4nIDogJzxzcGFuIGNsYXNzPSJiYWRnZSBiLWdyZWVuIj7Zhti02Lc8L3NwYW4+J308L3RkPgogICAgICAgIDx0ZCBjbGFzcz0ic21hbGwiPiR7ZXNjKGZtdERhdGUocC5sYXN0U2VlbikpfTwvdGQ+CiAgICAgIDwvdHI+YCkuam9pbigiIil9PC90Ym9keT48L3RhYmxlPmA7CiAgICAkJCgiI3BsLWJvZHkgdHIucm93bGluayIpLmZvckVhY2goKHRyKSA9PiB0ci5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpID0+IG9wZW5QbGF5ZXIodHIuZGF0YXNldC5pZCkpKTsKICB9IGNhdGNoIChlKSB7IGJvZHkuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij7Yqti52LDYsSDYp9mE2KrYrdmF2YrZhDwvZGl2Pic7IGVyclRvYXN0KGUpOyB9Cn0KbG9hZGVycy5wbGF5ZXJzID0gbG9hZFBsYXllcnM7CgovKiA9PT09PT09PT09PT09PT09PSBwbGF5ZXIgZHJhd2VyID09PT09PT09PT09PT09PT09ICovCmxldCBkcmF3ZXJQbGF5ZXJJZCA9IG51bGw7CmZ1bmN0aW9uIGNsb3NlRHJhd2VyKCkgeyAkKCIjZHJhd2VyLXdyYXAiKS5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsgZHJhd2VyUGxheWVySWQgPSBudWxsOyB9CiQoIiNkcmF3ZXItd3JhcCIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpID0+IHsgaWYgKGUudGFyZ2V0LmlkID09PSAiZHJhd2VyLXdyYXAiKSBjbG9zZURyYXdlcigpOyB9KTsKCmFzeW5jIGZ1bmN0aW9uIG9wZW5QbGF5ZXIoaWQpIHsKICBkcmF3ZXJQbGF5ZXJJZCA9IFN0cmluZyhpZCk7CiAgY29uc3Qgd3JhcCA9ICQoIiNkcmF3ZXItd3JhcCIpLCBkciA9ICQoIiNkcmF3ZXIiKTsKICB3cmFwLmNsYXNzTGlzdC5yZW1vdmUoImhpZGRlbiIpOwogIGRyLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJzcGluIj7YrNin2LHZjSDYp9mE2KrYrdmF2YrZhOKApjwvZGl2Pic7CiAgdHJ5IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoInBhbmVsUGxheWVyIiwgeyBpZDogZHJhd2VyUGxheWVySWQgfSk7CiAgICByZW5kZXJEcmF3ZXIocik7CiAgfSBjYXRjaCAoZSkgeyBkci5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHkiPtiq2LnYsNixINiq2K3ZhdmK2YQg2KfZhNmE2KfYudioPC9kaXY+JzsgZXJyVG9hc3QoZSk7IH0KfQpmdW5jdGlvbiBrdihrLCB2KSB7IHJldHVybiBgPGRpdiBjbGFzcz0iayI+JHtrfTwvZGl2PjxkaXY+JHt2fTwvZGl2PmA7IH0KZnVuY3Rpb24gcmVuZGVyRHJhd2VyKHIpIHsKICBjb25zdCBwID0gci5wbGF5ZXIgfHwge30sIGRyID0gJCgiI2RyYXdlciIpOwogIGNvbnN0IHZlcmlmaWVkID0gcC53YWxsZXRWZXJpZmllZCA9PT0gdHJ1ZTsKICBjb25zdCBvcGVuUmVjID0gKHIudmVyaWZ5UmVjb3JkcyB8fCBbXSkuZmluZCgoeCkgPT4geC5zdGF0dXMgPT09ICJvcGVuIik7CiAgbGV0IGh0bWwgPSBgCiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtnYXA6OHB4Ij4KICAgICAgPGRpdiBzdHlsZT0iZmxleDoxIj4KICAgICAgICA8aDI+JHtlc2MocC5uYW1lIHx8ICLigJQiKX0gJHt2ZXJpZmllZCA/ICLwn5uh77iP4pyFIiA6ICIifSAke3AuYmFubmVkID8gIvCfmqsiIDogIiJ9PC9oMj4KICAgICAgICA8ZGl2IGNsYXNzPSJtdXQiPiR7cC51c2VybmFtZSA/ICJAIiArIGVzYyhwLnVzZXJuYW1lKSA6ICIifSDCtyDYsdmC2YUg2KfZhNmE2KfYudioIDxiPiR7cC51c2VyTm8gfHwgIuKAlCJ9PC9iPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IGJ0bi1zbWFsbCIgaWQ9ImRyLWNsb3NlIj7inJUg2KXYutmE2KfZgjwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJrdiI+CiAgICAgICR7a3YoItii2YrYr9mKINiq2YrZhNmK2KzYsdin2YUiLCBgPHNwYW4gY2xhc3M9Im1vbm8iPiR7ZXNjKHAuaWQgfHwgZHJhd2VyUGxheWVySWQpfTwvc3Bhbj5gKX0KICAgICAgJHtrdigi2KfZhNij2YHYp9iq2KfYsSIsIHAuYXZhdGFyID8gYCR7cC5hdmF0YXJ9IOKAlCAke2VzYyhBVkFUQVJfTkFNRVNbcC5hdmF0YXJdIHx8ICIiKX1gIDogIti62YrYsSDZhdiu2KrYp9ixIil9CiAgICAgICR7a3YoItin2YTZhdit2YHYuNipIiwgcC53YWxsZXRBZGRyID8gYDxzcGFuIGNsYXNzPSJtb25vIj4ke2VzYyhwLndhbGxldEFkZHIpfTwvc3Bhbj5gIDogIti62YrYsSDZhdix2KjZiNi32KkiKX0KICAgICAgJHtrdigi2KfZhNiq2YjYq9mK2YIiLCB2ZXJpZmllZCA/IGDZhdmI2KvZkdmCIOKchSDigJQgJHtlc2MoZm10RGF0ZShwLnZlcmlmaWVkQXQpKX1gIDogIti62YrYsSDZhdmI2KvZkdmCIil9CiAgICAgICR7a3YoIti52YXYsSDYp9mE2YXYrdmB2LjYqSIsIHAud2FsbGV0QWdlRGF5cyA9PSBudWxsID8gIuKAlCIgOiBmbXROKHAud2FsbGV0QWdlRGF5cykgKyAiINmK2YjZhSIpfQogICAgICAke2t2KCLYp9mE2YfZiNmE2K8gKNii2K7YsSDZhdiy2KfZhdmG2KkpIiwgZm10TihwLmhvbGQpICsgIiBaTSIpfQogICAgICAke2t2KCLYp9mE2YXYudiv2ZHZhiIsICI8Yj4iICsgZm10TihwLm1pbmVkKSArICI8L2I+IFpNIil9CiAgICAgICR7a3YoItij2LHYqNin2K0g2KfZhNiq2LnYr9mK2YYiLCBmbXROKHAuZWFybk1pbmluZykpfQogICAgICAke2t2KCLYo9ix2KjYp9itINin2YTZhdmH2KfZhSIsIGZtdE4ocC5lYXJuVGFza3MpKX0KICAgICAgJHtrdigi2KPYsdio2KfYrSDYp9mE2YrZiNmF2YrYqSIsIGZtdE4ocC5lYXJuRGFpbHkpKX0KICAgICAgJHtrdigi2KPYsdio2KfYrSDYp9mE2KXYrdin2YTYp9iqIiwgZm10TihwLmVhcm5SZWYpKX0KICAgICAgJHtrdigi2LnZhdmI2YTYqSDYpdit2KfZhNin2Kog2YXYudmE2YLYqSIsIGZtdE4ocC5wZW5kaW5nUmVmQ29tbSkpfQogICAgICAke2t2KCLYp9mE2KXYrdin2YTYp9iqIiwgZm10TigocC5yZWZlcnJhbHMgfHwgW10pLmxlbmd0aCkgKyAiICjZhdmI2KvZkdmC2Kk6ICIgKyBmbXROKChwLnJlZmVycmFscyB8fCBbXSkuZmlsdGVyKCh4KSA9PiB4ICYmIHgudmVyaWZpZWQgPT09IHRydWUpLmxlbmd0aCkgKyAiKSIpfQogICAgICAke2t2KCLYr9i52KfZhyIsIHIuaW52aXRlciA/IGAke2VzYyhyLmludml0ZXIubmFtZSB8fCAiIil9ICR7ci5pbnZpdGVyLnVzZXJuYW1lID8gIkAiICsgZXNjKHIuaW52aXRlci51c2VybmFtZSkgOiAiIn0gKNix2YLZhSAke3IuaW52aXRlci51c2VyTm8gfHwgIuKAlCJ9KWAgOiAocC5pbnZpdGVkQnkgPyBgPHNwYW4gY2xhc3M9Im1vbm8iPiR7ZXNjKHAuaW52aXRlZEJ5KX08L3NwYW4+YCA6ICLigJQiKSl9CiAgICAgICR7a3YoItiq2KfYsdmK2K4g2KfZhNin2YbYttmF2KfZhSIsIGVzYyhmbXREYXRlKHAuY3JlYXRlZEF0KSkpfQogICAgICAke2t2KCLYotiu2LEg2LjZh9mI2LEiLCBlc2MoZm10RGF0ZShwLmxhc3RTZWVuKSkpfQogICAgICAke2t2KCLYqNi12YXYqSDYp9mE2KzZh9in2LIiLCBwLmRldmljZUhhc2ggPyBgPHNwYW4gY2xhc3M9Im1vbm8iPiR7ZXNjKHAuZGV2aWNlSGFzaCl9PC9zcGFuPmAgOiAi4oCUIil9CiAgICAgICR7a3YoItin2YTYrdin2YTYqSIsIHAuYmFubmVkID8gJzxzcGFuIGNsYXNzPSJiYWRnZSBiLXJlZCI+2YXYrdi42YjYsSDwn5qrPC9zcGFuPicgOiAnPHNwYW4gY2xhc3M9ImJhZGdlIGItZ3JlZW4iPtmG2LTYtzwvc3Bhbj4nKX0KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0ic2VjLXQiPtil2KzYsdin2KHYp9iqPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJhY3Qtcm93Ij4KICAgICAgPGJ1dHRvbiBjbGFzcz0iJHtwLmJhbm5lZCA/ICJidG4iIDogImJ0bi1kYW5nZXIifSIgaWQ9ImRyLWJhbiI+JHtwLmJhbm5lZCA/ICLZgdmDINin2YTYrdi42LEiIDogIvCfmqsg2K3YuNixINin2YTZhNin2LnYqCJ9PC9idXR0b24+CiAgICAgICR7dmVyaWZpZWQgPyAiIiA6ICc8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJkci12ZXJpZnkiPvCfm6HvuI8g2KrZiNir2YrZgiDZitiv2YjZiiDYp9mE2KLZhjwvYnV0dG9uPid9CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImFjdC1yb3ciPgogICAgICA8aW5wdXQgaWQ9ImRyLWFkaiIgdHlwZT0ibnVtYmVyIiBwbGFjZWhvbGRlcj0i2KrYudiv2YrZhCDYp9mE2LHYtdmK2K86INmF2KjZhNi6ICgrINij2YggLSkiIHN0eWxlPSJ3aWR0aDoyMTBweCI+CiAgICAgIDxidXR0b24gY2xhc3M9ImJ0bi1naG9zdCIgaWQ9ImRyLWFkai1idG4iPtiq2LfYqNmK2YIg2KfZhNiq2LnYr9mK2YQ8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iYWN0LXJvdyI+CiAgICAgIDxzZWxlY3QgaWQ9ImRyLWF2YXRhciI+CiAgICAgICAgJHtbMCwgMSwgMiwgMywgNCwgNSwgNiwgNywgOF0ubWFwKChhKSA9PiBgPG9wdGlvbiB2YWx1ZT0iJHthfSIgJHtOdW1iZXIocC5hdmF0YXIgfHwgMCkgPT09IGEgPyAic2VsZWN0ZWQiIDogIiJ9PiR7YSA9PT0gMCA/ICIwIOKAlCDYqti12YHZitixICjYutmK2LEg2YXYrtiq2KfYsSkiIDogYSArICIg4oCUICIgKyBBVkFUQVJfTkFNRVNbYV19PC9vcHRpb24+YCkuam9pbigiIil9CiAgICAgIDwvc2VsZWN0PgogICAgICA8YnV0dG9uIGNsYXNzPSJidG4tZ2hvc3QiIGlkPSJkci1hdmF0YXItYnRuIj7Yqti52YrZitmGINin2YTYo9mB2KfYqtin2LE8L2J1dHRvbj4KICAgIDwvZGl2PmA7CiAgaWYgKHIucmlzaykgewogICAgaHRtbCArPSBgPGRpdiBjbGFzcz0ic2VjLXQiPtiq2YLZitmK2YUg2KrYudiv2K8g2KfZhNit2LPYp9io2KfYqjwvZGl2PjxkZXRhaWxzPjxzdW1tYXJ5Pti52LHYtiDYp9mE2KrZgtmK2YrZhTwvc3VtbWFyeT48cHJlIGNsYXNzPSJqc29uIj4ke2VzYyhKU09OLnN0cmluZ2lmeShyLnJpc2ssIG51bGwsIDEpKX08L3ByZT48L2RldGFpbHM+YDsKICB9CiAgY29uc3Qgd2RzID0gci53aXRoZHJhd2FscyB8fCBbXTsKICBodG1sICs9IGA8ZGl2IGNsYXNzPSJzZWMtdCI+2LPYrdmI2KjYp9iq2YcgKCR7d2RzLmxlbmd0aH0pPC9kaXY+YDsKICBodG1sICs9IHdkcy5sZW5ndGggPyBgPHRhYmxlPjx0aGVhZD48dHI+PHRoPtix2YLZhTwvdGg+PHRoPtin2YTZhdio2YTYujwvdGg+PHRoPtin2YTYtdin2YHZijwvdGg+PHRoPtin2YTYrdin2YTYqTwvdGg+PHRoPtin2YTYqtin2LHZitiuPC90aD48L3RyPjwvdGhlYWQ+PHRib2R5PgogICAgJHt3ZHMubWFwKCh3KSA9PiBgPHRyPjx0ZD4jJHt3LndkTnVtIHx8ICLigJQifTwvdGQ+PHRkPiR7Zm10Tih3LmFtdCl9PC90ZD48dGQ+JHtmbXROKHcubmV0KX08L3RkPjx0ZD4ke2VzYyh3LnN0YXR1cyB8fCAiIil9PC90ZD48dGQgY2xhc3M9InNtYWxsIj4ke2VzYyhmbXREYXRlKHcuY3JlYXRlZEF0IHx8IHcuYXQpKX08L3RkPjwvdHI+YCkuam9pbigiIil9CiAgICA8L3Rib2R5PjwvdGFibGU+YCA6ICc8ZGl2IGNsYXNzPSJtdXQgc21hbGwiPtmE2Kcg2KrZiNis2K8g2LPYrdmI2KjYp9iqPC9kaXY+JzsKICBjb25zdCB2cnMgPSByLnZlcmlmeVJlY29yZHMgfHwgW107CiAgaHRtbCArPSBgPGRpdiBjbGFzcz0ic2VjLXQiPtiz2KzZhNin2Kog2KrZiNir2YrZgtmHICgke3Zycy5sZW5ndGh9KTwvZGl2PmA7CiAgaHRtbCArPSB2cnMubGVuZ3RoID8gYDx0YWJsZT48dGhlYWQ+PHRyPjx0aD7Yp9mE2K3Yp9mE2Kk8L3RoPjx0aD7Yp9mE2LPYqNioPC90aD48dGg+2KfZhNmC2YrZhdipPC90aD48dGg+2KfZhNiq2KfYsdmK2K48L3RoPjwvdHI+PC90aGVhZD48dGJvZHk+CiAgICAke3Zycy5tYXAoKHgpID0+IGA8dHI+PHRkPiR7eC5zdGF0dXMgPT09ICJvcGVuIiA/ICc8c3BhbiBjbGFzcz0iYmFkZ2UgYi15ZWxsb3ciPtmF2YHYqtmI2K08L3NwYW4+JyA6ICc8c3BhbiBjbGFzcz0iYmFkZ2UgYi1ncmVlbiI+2YXYrdmE2YjZhDwvc3Bhbj4nfTwvdGQ+PHRkPiR7ZXNjKHgucmVhc29uIHx8ICIiKX08L3RkPjx0ZD4ke3gudmFsdWVOYW5vID8gKE51bWJlcih4LnZhbHVlTmFubykgLyAxZTkpICsgIiBUT04iIDogIuKAlCJ9PC90ZD48dGQgY2xhc3M9InNtYWxsIj4ke2VzYyhmbXREYXRlKHgudXRpbWUgPyB4LnV0aW1lICogMTAwMCA6IHguZmlyc3RTZWVuQXQpKX08L3RkPjwvdHI+YCkuam9pbigiIil9CiAgICA8L3Rib2R5PjwvdGFibGU+YCA6ICc8ZGl2IGNsYXNzPSJtdXQgc21hbGwiPtmE2Kcg2KrZiNis2K8g2LPYrNmE2KfYqjwvZGl2Pic7CiAgaHRtbCArPSBgPGRldGFpbHM+PHN1bW1hcnk+2YPZhCDYqNmK2KfZhtin2Kog2KfZhNmE2KfYudioIChKU09OKTwvc3VtbWFyeT48cHJlIGNsYXNzPSJqc29uIj4ke2VzYyhKU09OLnN0cmluZ2lmeShwLCBudWxsLCAxKSl9PC9wcmU+PC9kZXRhaWxzPmA7CiAgZHIuaW5uZXJIVE1MID0gaHRtbDsKCiAgJCgiI2RyLWNsb3NlIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCBjbG9zZURyYXdlcik7CiAgJCgiI2RyLWJhbiIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgYXN5bmMgKCkgPT4gewogICAgY29uc3QgdGFyZ2V0ID0gIXAuYmFubmVkOwogICAgaWYgKCFhd2FpdCBzaG93Q29uZmlybSh0YXJnZXQgPyAi2K3YuNixINin2YTZhNin2LnYqCIgOiAi2YHZgyDYrdi42LEg2KfZhNmE2KfYudioIiwgYCR7dGFyZ2V0ID8gItit2LjYsSIgOiAi2YHZgyDYrdi42LEifSAke3AubmFtZSB8fCAiIn0gKNix2YLZhSAke3AudXNlck5vIHx8ICLigJQifSnYn2AsIHRhcmdldCA/ICLYrdi42LEiIDogItmB2YMg2KfZhNit2LjYsSIsIHRhcmdldCkpIHJldHVybjsKICAgIHRyeSB7IGF3YWl0IGFwaSgicGFuZWxCYW4iLCB7IGlkOiBkcmF3ZXJQbGF5ZXJJZCwgYmFubmVkOiB0YXJnZXQgfSk7IHRvYXN0KHRhcmdldCA/ICLYqtmFINin2YTYrdi42LEg8J+aqyIgOiAi2KrZhSDZgdmDINin2YTYrdi42LEiKTsgb3BlblBsYXllcihkcmF3ZXJQbGF5ZXJJZCk7IGxvYWRlZC5wbGF5ZXJzID0gZmFsc2U7IH0KICAgIGNhdGNoIChlKSB7IGVyclRvYXN0KGUpOyB9CiAgfSk7CiAgY29uc3QgdkJ0biA9ICQoIiNkci12ZXJpZnkiKTsKICBpZiAodkJ0bikgdkJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGFzeW5jICgpID0+IHsKICAgIGlmICghYXdhaXQgc2hvd0NvbmZpcm0oItiq2YjYq9mK2YIg2YrYr9mI2YoiLCBg2KrZiNir2YrZgiDZhdit2YHYuNipICR7cC5uYW1lIHx8ICIifSAo2LHZgtmFICR7cC51c2VyTm8gfHwgIuKAlCJ9KSDYp9mE2KLZhtifXG7Ys9mK2LXZhNmHINil2LTYudin2LEg2KfZhNiq2YjYq9mK2YIg2KfZhNix2LPZhdmKLmAsICLYqtmI2KvZitmCIiwgZmFsc2UpKSByZXR1cm47CiAgICB0cnkgewogICAgICBjb25zdCByZXMgPSBvcGVuUmVjID8gYXdhaXQgYXBpKCJwYW5lbFZlcmlmeVJlc29sdmUiLCB7IGhhc2g6IG9wZW5SZWMuaGFzaCB9KSA6IGF3YWl0IGFwaSgicGFuZWxWZXJpZnlQbGF5ZXIiLCB7IGlkOiBkcmF3ZXJQbGF5ZXJJZCB9KTsKICAgICAgaWYgKHJlcy53b24pIHRvYXN0KCLYqtmFINin2YTYqtmI2KvZitmCIOKchSIpOyBlbHNlIHRvYXN0KCLZhNmFINmK2KrZhTogIiArIGVzYyhyZXMucmVhc29uIHx8ICIiKSwgdHJ1ZSk7CiAgICAgIG9wZW5QbGF5ZXIoZHJhd2VyUGxheWVySWQpOwogICAgfSBjYXRjaCAoZSkgeyBlcnJUb2FzdChlKTsgfQogIH0pOwogICQoIiNkci1hZGotYnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCBhc3luYyAoKSA9PiB7CiAgICBjb25zdCBhbXQgPSBOdW1iZXIoJCgiI2RyLWFkaiIpLnZhbHVlKTsKICAgIGlmICghYW10IHx8ICFOdW1iZXIuaXNGaW5pdGUoYW10KSkgeyB0b2FzdCgi2K/YrtmR2YQg2YXYqNmE2LrZi9inINi12K3Zitit2YvYpyIsIHRydWUpOyByZXR1cm47IH0KICAgIGlmICghYXdhaXQgc2hvd0NvbmZpcm0oItiq2LnYr9mK2YQg2KfZhNix2LXZitivIiwgYNiq2LnYr9mK2YQg2LHYtdmK2K8gJHtwLm5hbWUgfHwgIiJ9INio2YXZgtiv2KfYsSAke2FtdCA+IDAgPyAiKyIgOiAiIn0ke2ZtdE4oYW10KX0gWk3Yn1xu2KfZhNix2LXZitivINin2YTYrdin2YTZijogJHtmbXROKHAubWluZWQpfWAsICLYqti32KjZitmCIiwgYW10IDwgMCkpIHJldHVybjsKICAgIHRyeSB7IGNvbnN0IHJlcyA9IGF3YWl0IGFwaSgicGFuZWxBZGp1c3QiLCB7IGlkOiBkcmF3ZXJQbGF5ZXJJZCwgYW1vdW50OiBhbXQgfSk7IHRvYXN0KCLYp9mE2LHYtdmK2K8g2KfZhNis2K/ZitivOiAiICsgZm10TihyZXMubWluZWQpKTsgb3BlblBsYXllcihkcmF3ZXJQbGF5ZXJJZCk7IH0KICAgIGNhdGNoIChlKSB7IGVyclRvYXN0KGUpOyB9CiAgfSk7CiAgJCgiI2RyLWF2YXRhci1idG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGFzeW5jICgpID0+IHsKICAgIGNvbnN0IGF2ID0gTnVtYmVyKCQoIiNkci1hdmF0YXIiKS52YWx1ZSk7CiAgICB0cnkgeyBhd2FpdCBhcGkoInBhbmVsU2V0QXZhdGFyIiwgeyBpZDogZHJhd2VyUGxheWVySWQsIGF2YXRhcjogYXYgfSk7IHRvYXN0KCLYqtmFINiq2LnZitmK2YYg2KfZhNij2YHYp9iq2KfYsSIpOyBvcGVuUGxheWVyKGRyYXdlclBsYXllcklkKTsgfQogICAgY2F0Y2ggKGUpIHsgZXJyVG9hc3QoZSk7IH0KICB9KTsKfQoKLyogPT09PT09PT09PT09PT09PT0gd2l0aGRyYXdhbHMgPT09PT09PT09PT09PT09PT0gKi8KY29uc3Qgd2RTdGF0ZSA9IHsgc3RhdHVzOiAicGVuZGluZyIgfTsKY29uc3QgV0RfRklMVEVSUyA9IFtbInBlbmRpbmciLCAi2YXYudmE2ZHZgtipIOKPsyJdLCBbInBhaWQiLCAi2YXYr9mB2YjYudipIOKchSJdLCBbInJlamVjdGVkIiwgItmF2LHZgdmI2LbYqSDinYwiXSwgWyJhbGwiLCAi2KfZhNmD2YQiXV07CmFzeW5jIGZ1bmN0aW9uIGxvYWRXZHMoKSB7CiAgY29uc3QgcGFuZSA9ICQoIiNwYW5lLXdkcyIpOwogIHBhbmUuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idG9vbGJhciI+PGRpdiBjbGFzcz0iY2hpcHMiPiR7V0RfRklMVEVSUy5tYXAoKFt2LCB0XSkgPT4gYDxidXR0b24gZGF0YS1zdD0iJHt2fSIgY2xhc3M9IiR7d2RTdGF0ZS5zdGF0dXMgPT09IHYgPyAib24iIDogIiJ9Ij4ke3R9PC9idXR0b24+YCkuam9pbigiIil9PC9kaXY+CiAgICA8c3BhbiBjbGFzcz0ic3AiPjwvc3Bhbj48c3BhbiBjbGFzcz0ibXV0IHNtYWxsIj7Yp9i52KrZhdin2K8g2KfZhNiz2K3YqCA9INil2LHYs9in2YQg2YHYudmE2Yog2YXZhiDZhdit2YHYuNipINin2YTYr9mB2Lkgwrcg2KfZhNix2YHYtiDZhtmH2KfYptmKINmI2KjYr9mI2YYg2KfYs9iq2LHYr9in2K88L3NwYW4+PC9kaXY+CiAgICA8ZGl2IGlkPSJ3ZC1ib2R5Ij48ZGl2IGNsYXNzPSJzcGluIj7YrNin2LHZjSDYp9mE2KrYrdmF2YrZhOKApjwvZGl2PjwvZGl2PmA7CiAgJCQoIiNwYW5lLXdkcyAuY2hpcHMgYnV0dG9uIikuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpID0+IHsgd2RTdGF0ZS5zdGF0dXMgPSBiLmRhdGFzZXQuc3Q7IGxvYWRXZHMoKTsgfSkpOwogIGZldGNoV2RzKCk7Cn0KYXN5bmMgZnVuY3Rpb24gZmV0Y2hXZHMoKSB7CiAgY29uc3QgYm9keSA9ICQoIiN3ZC1ib2R5Iik7IGlmICghYm9keSkgcmV0dXJuOwogIGJvZHkuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9InNwaW4iPtis2KfYsdmNINin2YTYqtit2YXZitmE4oCmPC9kaXY+JzsKICB0cnkgewogICAgY29uc3QgciA9IGF3YWl0IGFwaSgicGFuZWxXaXRoZHJhd2FscyIsIHsgc3RhdHVzOiB3ZFN0YXRlLnN0YXR1cyB9KTsKICAgIGlmICghci5yb3dzLmxlbmd0aCkgeyBib2R5LmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eSI+2YTYpyDYqtmI2KzYryDYs9it2YjYqNin2Kog2YHZiiDZh9iw2Ycg2KfZhNit2KfZhNipPC9kaXY+JzsgcmV0dXJuOyB9CiAgICBib2R5LmlubmVySFRNTCA9IGA8dGFibGU+PHRoZWFkPjx0cj48dGg+2LHZgtmFPC90aD48dGg+2KfZhNmE2KfYudioPC90aD48dGg+2KfZhNmF2KjZhNi6PC90aD48dGg+2KfZhNix2LPZiNmFPC90aD48dGg+2KfZhNi12KfZgdmKPC90aD48dGg+2KfZhNmF2K3Zgdi42Kk8L3RoPjx0aD7Yp9mE2KrYp9ix2YrYrjwvdGg+PHRoPtin2YTYrdin2YTYqTwvdGg+PHRoPjwvdGg+PC90cj48L3RoZWFkPjx0Ym9keT4KICAgICAgJHtyLnJvd3MubWFwKCh3KSA9PiBgPHRyPgogICAgICAgIDx0ZD4jJHt3LndkTnVtIHx8ICLigJQifTwvdGQ+CiAgICAgICAgPHRkPjxiPiR7ZXNjKHcudXNlck5hbWUgfHwgIuKAlCIpfTwvYj4gJHt3LnVzZXJWZXJpZmllZCA/ICLwn5uh77iPIiA6ICIifTxicj48c3BhbiBjbGFzcz0ibW9ubyBtdXQiPiR7ZXNjKHcudXNlcklkIHx8ICIiKX08L3NwYW4+PC90ZD4KICAgICAgICA8dGQ+JHtmbXROKHcuYW10KX08L3RkPjx0ZD4ke2ZtdE4ody5mZWUpfTwvdGQ+PHRkPjxiPiR7Zm10Tih3Lm5ldCl9PC9iPjwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJtb25vIiB0aXRsZT0iJHtlc2Mody53YWxsZXRBZGRyIHx8ICIiKX0iPiR7ZXNjKHNob3J0QWRkcih3LndhbGxldEFkZHIpKX08L3NwYW4+PC90ZD4KICAgICAgICA8dGQgY2xhc3M9InNtYWxsIj4ke2VzYyhmbXREYXRlKHcuY3JlYXRlZEF0IHx8IHcuYXQpKX08L3RkPgogICAgICAgIDx0ZD4ke2VzYyh3LnN0YXR1cyB8fCAiIil9JHt3LnBheW91dFN0YXRlICYmIHcucGF5b3V0U3RhdGUgIT09ICJub25lIiA/IGA8YnI+PHNwYW4gY2xhc3M9ImJhZGdlIGItZ3JleSI+JHtlc2Mody5wYXlvdXRTdGF0ZSl9PC9zcGFuPmAgOiAiIn0ke3cucGF5b3V0VHggPyBgPGJyPjxhIGhyZWY9Imh0dHBzOi8vdG9udmlld2VyLmNvbS90cmFuc2FjdGlvbi8ke2VzYyh3LnBheW91dFR4KX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj7Yp9mE2YXYudin2YXZhNipPC9hPmAgOiAiIn08L3RkPgogICAgICAgIDx0ZD4ke1N0cmluZyh3LnN0YXR1cyB8fCAiIikuaW5jbHVkZXMoIlBlbmRpbmciKSA/IGAKICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tc21hbGwiIGRhdGEtYWN0PSJvayIgZGF0YS1udW09IiR7dy53ZE51bX0iPtin2LnYqtmF2KfYrzwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IGJ0bi1zbWFsbCIgZGF0YS1hY3Q9Im5vIiBkYXRhLW51bT0iJHt3LndkTnVtfSI+2LHZgdi2PC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4tZGFuZ2VyIGJ0bi1zbWFsbCIgZGF0YS1hY3Q9ImJhbiIgZGF0YS1udW09IiR7dy53ZE51bX0iPtit2LjYsSvYsdmB2LY8L2J1dHRvbj5gIDogIiJ9CiAgICAgICAgPC90ZD48L3RyPmApLmpvaW4oIiIpfQogICAgICA8L3Rib2R5PjwvdGFibGU+YDsKICAgICQkKCIjd2QtYm9keSBbZGF0YS1hY3RdIikuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpID0+IHdkQWN0aW9uKGIuZGF0YXNldC5hY3QsIE51bWJlcihiLmRhdGFzZXQubnVtKSwgci5yb3dzLmZpbmQoKHgpID0+IHgud2ROdW0gPT09IE51bWJlcihiLmRhdGFzZXQubnVtKSkpKSk7CiAgfSBjYXRjaCAoZSkgeyBib2R5LmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eSI+2KrYudiw2LEg2KfZhNiq2K3ZhdmK2YQ8L2Rpdj4nOyBlcnJUb2FzdChlKTsgfQp9CmFzeW5jIGZ1bmN0aW9uIHdkQWN0aW9uKGFjdCwgbnVtLCB3KSB7CiAgaWYgKCF3KSByZXR1cm47CiAgdHJ5IHsKICAgIGlmIChhY3QgPT09ICJvayIpIHsKICAgICAgaWYgKCFhd2FpdCBzaG93Q29uZmlybSgi2KfYudiq2YXYp9ivINiz2K3YqCIsIGDYp9i52KrZhdin2K8g2LPYrdioICMke251bX0g2YTZhNin2LnYqCAke3cudXNlck5hbWUgfHwgIiJ92J9cbtiz2YrYqtmFINil2LHYs9in2YQgJHtmbXROKHcubmV0KX0gWk0g2YHYudmE2YrZi9inINil2YTZiSDYp9mE2YXYrdmB2LjYqTpcbiR7dy53YWxsZXRBZGRyIHx8ICIifVxuKNin2YTZhdio2YTYuiAke2ZtdE4ody5hbXQpfSDigJQg2KfZhNix2LPZiNmFICR7Zm10Tih3LmZlZSl9KWAsICLYp9i52KrZhdin2K8g2YjYpdix2LPYp9mEIiwgZmFsc2UpKSByZXR1cm47CiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGFwaSgicGFuZWxXZEFwcHJvdmUiLCB7IHdkTnVtOiBudW0gfSk7CiAgICAgIGlmIChyZXMucGF5b3V0U3RhdGUgPT09ICJwYWlkIikgdG9hc3QoYNiq2YUg2KfZhNiv2YHYuSDinIUgIyR7bnVtfSR7cmVzLnBheW91dFR4ID8gYCDigJQgPGEgaHJlZj0iaHR0cHM6Ly90b252aWV3ZXIuY29tL3RyYW5zYWN0aW9uLyR7ZXNjKHJlcy5wYXlvdXRUeCl9IiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+2KfZhNmF2LnYp9mF2YTYqTwvYT5gIDogIiJ9YCk7CiAgICAgIGVsc2UgdG9hc3QoYNmG2KrZitis2Kkg2KfZhNin2LnYqtmF2KfYrzogJHtlc2MocmVzLnN0YXR1cyB8fCAiIil9IC8gJHtlc2MocmVzLnBheW91dFN0YXRlIHx8ICIiKX0ke3Jlcy5wYXlvdXRFcnJvciA/ICIg4oCUICIgKyBlc2MocmVzLnBheW91dEVycm9yKSA6ICIifWAsIHJlcy5wYXlvdXRTdGF0ZSAhPT0gInBhaWQiKTsKICAgIH0gZWxzZSBpZiAoYWN0ID09PSAibm8iKSB7CiAgICAgIGlmICghYXdhaXQgc2hvd0NvbmZpcm0oItix2YHYtiDYs9it2KgiLCBg2LHZgdi2INiz2K3YqCAjJHtudW19ICgke2ZtdE4ody5hbXQpfSBaTSnYn1xu2YTZhiDYqtmP2LPYqtix2K8g2KfZhNi52YXZhNin2Kog2YTZhNin2LnYqCDigJQg2YLYsdin2LEg2YbZh9in2KbZii5gLCAi2LHZgdi2INmG2YfYp9im2YoiLCB0cnVlKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGkoInBhbmVsV2RSZWplY3QiLCB7IHdkTnVtOiBudW0gfSk7CiAgICAgIHRvYXN0KGDYqtmFINix2YHYtiDYp9mE2LPYrdioICMke251bX0g4p2MYCk7CiAgICB9IGVsc2UgaWYgKGFjdCA9PT0gImJhbiIpIHsKICAgICAgaWYgKCFhd2FpdCBzaG93Q29uZmlybSgi2K3YuNixICsg2LHZgdi2IiwgYNit2LjYsSDYp9mE2YTYp9i52KggJHt3LnVzZXJOYW1lIHx8ICIifSDZiNix2YHYtiDYs9it2KjZhyAjJHtudW192J9cbtmE2YYg2KrZj9iz2KrYsdivINin2YTYudmF2YTYp9iqLmAsICLYrdi42LEg2YjYsdmB2LYiLCB0cnVlKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGkoInBhbmVsV2RCYW4iLCB7IHdkTnVtOiBudW0gfSk7CiAgICAgIHRvYXN0KGDYqtmFINit2LjYsSDYp9mE2YTYp9i52Kgg2YjYsdmB2LYg2KfZhNiz2K3YqCAjJHtudW19IPCfmqtgKTsKICAgIH0KICAgIGxvYWRlZC5zdGF0cyA9IGZhbHNlOyBmZXRjaFdkcygpOwogIH0gY2F0Y2ggKGUpIHsgZXJyVG9hc3QoZSk7IH0KfQpsb2FkZXJzLndkcyA9IGxvYWRXZHM7CgovKiA9PT09PT09PT09PT09PT09PSB2ZXJpZnkgcXVldWUgPT09PT09PT09PT09PT09PT0gKi8KYXN5bmMgZnVuY3Rpb24gbG9hZFZlcmlmeSgpIHsKICBjb25zdCBwYW5lID0gJCgiI3BhbmUtdmVyaWZ5Iik7CiAgcGFuZS5pbm5lckhUTUwgPSAnPGRpdiBpZD0idnEtYm9keSI+PGRpdiBjbGFzcz0ic3BpbiI+2KzYp9ix2Y0g2KfZhNiq2K3ZhdmK2YTigKY8L2Rpdj48L2Rpdj4nOwogIHRyeSB7CiAgICBjb25zdCByID0gYXdhaXQgYXBpKCJwYW5lbFZlcmlmeVF1ZXVlIik7CiAgICBjb25zdCBib2R5ID0gJCgiI3ZxLWJvZHkiKTsKICAgIGlmICghci5yb3dzLmxlbmd0aCkgeyBib2R5LmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eSI+2YTYpyDYqtmI2KzYryDYqtmI2KvZitmC2KfYqiDYudin2YTZgtipIPCfjok8L2Rpdj4nOyByZXR1cm47IH0KICAgIGJvZHkuaW5uZXJIVE1MID0gYDx0YWJsZT48dGhlYWQ+PHRyPjx0aD7Yp9mE2KrYp9ix2YrYrjwvdGg+PHRoPtin2YTZhNin2LnYqDwvdGg+PHRoPtix2YLZhTwvdGg+PHRoPtin2YTZhdi12K/YsTwvdGg+PHRoPtin2YTZgtmK2YXYqTwvdGg+PHRoPtin2YTYs9io2Kg8L3RoPjx0aD7Zgdit2YjYtdin2Ko8L3RoPjx0aD48L3RoPjwvdHI+PC90aGVhZD48dGJvZHk+CiAgICAgICR7ci5yb3dzLm1hcCgoeCkgPT4gYDx0cj4KICAgICAgICA8dGQgY2xhc3M9InNtYWxsIj4ke2VzYyhmbXREYXRlKHgudXRpbWUgPyB4LnV0aW1lICogMTAwMCA6IG51bGwpKX08L3RkPgogICAgICAgIDx0ZD4ke3gucGxheWVyID8gYDxiPiR7ZXNjKHgucGxheWVyLm5hbWUgfHwgIuKAlCIpfTwvYj4gJHt4LnBsYXllci51c2VybmFtZSA/IGA8c3BhbiBjbGFzcz0ibXV0Ij5AJHtlc2MoeC5wbGF5ZXIudXNlcm5hbWUpfTwvc3Bhbj5gIDogIiJ9YCA6ICc8c3BhbiBjbGFzcz0ibXV0Ij7ZhNin2LnYqCDYutmK2LEg2YXZiNis2YjYrzwvc3Bhbj4nfTwvdGQ+CiAgICAgICAgPHRkPiR7eC51c2VyTm8gfHwgIuKAlCJ9PC90ZD4KICAgICAgICA8dGQ+PHNwYW4gY2xhc3M9Im1vbm8iIHRpdGxlPSIke2VzYyh4LnNvdXJjZSB8fCAiIil9Ij4ke2VzYyhzaG9ydEFkZHIoeC5zb3VyY2UpKX08L3NwYW4+PC90ZD4KICAgICAgICA8dGQ+JHt4LnZhbHVlTmFubyA/IChOdW1iZXIoeC52YWx1ZU5hbm8pIC8gMWU5KSArICIgVE9OIiA6ICLigJQifTwvdGQ+CiAgICAgICAgPHRkPjxzcGFuIGNsYXNzPSJiYWRnZSBiLXllbGxvdyI+JHtlc2MoeC5yZWFzb24gfHwgIiIpfTwvc3Bhbj48L3RkPgogICAgICAgIDx0ZD4ke3guY2hlY2tzIHx8IDB9PC90ZD4KICAgICAgICA8dGQ+JHt4LnBsYXllciA/IGA8YnV0dG9uIGNsYXNzPSJidG4tZ2hvc3QgYnRuLXNtYWxsIiBkYXRhLW9wZW49IiR7ZXNjKHgucGxheWVyLmlkKX0iPtmB2KrYrTwvYnV0dG9uPmAgOiAiIn0KICAgICAgICAke3gucGxheWVyICYmICF4LnBsYXllci53YWxsZXRWZXJpZmllZCA/IGA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLXNtYWxsIiBkYXRhLXJlc29sdmU9IiR7ZXNjKHguaGFzaCl9IiBkYXRhLW5hbWU9IiR7ZXNjKHgucGxheWVyLm5hbWUgfHwgIiIpfSI+2KrZiNir2YrZgiDYp9mE2KLZhjwvYnV0dG9uPmAgOiAiIn08L3RkPgogICAgICA8L3RyPmApLmpvaW4oIiIpfQogICAgICA8L3Rib2R5PjwvdGFibGU+YDsKICAgICQkKCIjdnEtYm9keSBbZGF0YS1vcGVuXSIpLmZvckVhY2goKGIpID0+IGIuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKSA9PiBvcGVuUGxheWVyKGIuZGF0YXNldC5vcGVuKSkpOwogICAgJCQoIiN2cS1ib2R5IFtkYXRhLXJlc29sdmVdIikuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGFzeW5jICgpID0+IHsKICAgICAgaWYgKCFhd2FpdCBzaG93Q29uZmlybSgi2KrZiNir2YrZgiDZitiv2YjZiiIsIGDYqtmI2KvZitmCINin2YTZhNin2LnYqCAke2IuZGF0YXNldC5uYW1lfSDZhdmGINiv2YHYudipINin2YTYqtmI2KvZitmCINmH2LDZh9ifXG7Ys9mK2LXZhNmHINil2LTYudin2LEg2KfZhNiq2YjYq9mK2YIg2KfZhNix2LPZhdmKLmAsICLYqtmI2KvZitmCIiwgZmFsc2UpKSByZXR1cm47CiAgICAgIHRyeSB7CiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgYXBpKCJwYW5lbFZlcmlmeVJlc29sdmUiLCB7IGhhc2g6IGIuZGF0YXNldC5yZXNvbHZlIH0pOwogICAgICAgIGlmIChyZXMud29uKSB0b2FzdCgi2KrZhSDYp9mE2KrZiNir2YrZgiDinIUiKTsgZWxzZSB0b2FzdCgi2YTZhSDZitiq2YU6ICIgKyBlc2MocmVzLnJlYXNvbiB8fCAiIiksIHRydWUpOwogICAgICAgIGxvYWRlZC5zdGF0cyA9IGZhbHNlOyBsb2FkVmVyaWZ5KCk7CiAgICAgIH0gY2F0Y2ggKGUpIHsgZXJyVG9hc3QoZSk7IH0KICAgIH0pKTsKICB9IGNhdGNoIChlKSB7ICQoIiN2cS1ib2R5IikuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij7Yqti52LDYsSDYp9mE2KrYrdmF2YrZhDwvZGl2Pic7IGVyclRvYXN0KGUpOyB9Cn0KbG9hZGVycy52ZXJpZnkgPSBsb2FkVmVyaWZ5OwoKLyogPT09PT09PT09PT09PT09PT0gY29uZmlnID09PT09PT09PT09PT09PT09ICovCmNvbnN0IE5VTV9GSUVMRFMgPSBbCiAgWyJ0YXNrUmV3YXJkIiwgItmF2YPYp9mB2KPYqSDZhdmH2KfZhSDYp9mE2YLZhtmI2KfYqiJdLCBbImJpb1Jld2FyZCIsICLZhdmD2KfZgdij2Kkg2YXZh9mF2Kkg2KfZhNio2KfZitmIIl0sCiAgWyJyZWZBY2hSZXdhcmQxIiwgItmF2YPYp9mB2KPYqSDYpdit2KfZhNipIOKAlCDZhdix2K3ZhNipIDEiXSwgWyJyZWZBY2hSZXdhcmQxMCIsICLZhdmD2KfZgdij2Kkg2KXYrdin2YTYqSDigJQg2YXYsdit2YTYqSAxMCJdLAogIFsicmVmQWNoUmV3YXJkMjUiLCAi2YXZg9in2YHYo9ipINil2K3Yp9mE2Kkg4oCUINmF2LHYrdmE2KkgMjUiXSwgWyJyZWZBY2hSZXdhcmQ1MCIsICLZhdmD2KfZgdij2Kkg2KXYrdin2YTYqSDigJQg2YXYsdit2YTYqSA1MCJdLAogIFsicmVmQWNoUmV3YXJkMTAwIiwgItmF2YPYp9mB2KPYqSDYpdit2KfZhNipIOKAlCDZhdix2K3ZhNipIDEwMCJdLCBbInJlZkNsYWltUGVyY2VudCIsICLZhtiz2KjYqSDYudmF2YjZhNipINin2YTYpdit2KfZhNin2KogJSJdLAogIFsicmVmTWluSG9sZCIsICLYrdivINin2YTZh9mI2YTYryDZhNiq2YHYudmK2YQg2KfZhNil2K3Yp9mE2KkiXSwgWyJtaW5XaXRoZHJhdyIsICLYp9mE2K3YryDYp9mE2KPYr9mG2Ykg2YTZhNiz2K3YqCJdLAogIFsiaG9sZFBlcmNlbnRSZXEiLCAi2YbYs9io2Kkg2KfZhNmH2YjZhNivINin2YTZhdi32YTZiNio2Kkg2YTZhNiz2K3YqCAlIl0sIFsid2l0aGRyYXdGZWVQZXJjZW50IiwgItix2LPZiNmFINin2YTYs9it2KggJSJdLAogIFsidmVyaWZ5RmVlVG9uIiwgItix2LPZiNmFINin2YTYqtmI2KvZitmCIChUT04pIl0sIFsid2l0aGRyYXdNaW5BZ2VEYXlzIiwgIti52YXYsSDYp9mE2YXYrdmB2LjYqSDYp9mE2KPYr9mG2Ykg2YTZhNiz2K3YqCAo2KPZitin2YUpIl0sCiAgWyJ2ZXJpZnlNaW5BZ2VEYXlzIiwgIti52YXYsSDYp9mE2YXYrdmB2LjYqSDZhNmE2KrZiNir2YrZgiAo2YLYr9mK2YUg4oCUINi62YrYsSDZhdiz2KrYrtiv2YUpIl0sIFsibHZsMVBlckRheSIsICLYo9ix2KjYp9itINin2YTZitmI2YUg2YTZhNmF2LPYqtmI2YkgMSJdCl07CmNvbnN0IFNUUl9GSUVMRFMgPSBbCiAgWyJicmFuZFRpdGxlIiwgItin2LPZhSDYp9mE2LnZhNin2YXYqSJdLCBbImNvaW5TeW0iLCAi2LHZhdiyINin2YTYudmF2YTYqSJdLCBbImNoYW5uZWwxIiwgItix2KfYqNi3INin2YTZgtmG2KfYqSAxIl0sCiAgWyJjaGFubmVsMiIsICLYsdin2KjYtyDYp9mE2YLZhtin2KkgMiJdLCBbImNoYW5uZWwzIiwgItix2KfYqNi3INin2YTZgtmG2KfYqSAzIl0sIFsiYm90VXNlcm5hbWUiLCAi2YrZiNiy2LEg2KfZhNio2YjYqiJdLAogIFsiYnV5U3dhcFVybCIsICLYsdin2KjYtyDYp9mE2LTYsdin2KEiXSwgWyJ2ZXJpZnlEZXBvc2l0V2FsbGV0IiwgItmF2K3Zgdi42Kkg2KXZitiv2KfYuSDYp9mE2KrZiNir2YrZgiJdLAogIFsicGF5b3V0V2FsbGV0IiwgItmF2K3Zgdi42Kkg2KfZhNiv2YHYuSJdLCBbInBheW91dENoYW5uZWwiLCAi2YLZhtin2Kkg2KXYq9io2KfYqiDYp9mE2K/Zgdi5Il0sIFsiYWRtaW5DaGF0SWQiLCAi2KLZitiv2Yog2LTYp9iqINin2YTYpdiv2KfYsdipIl0KXTsKbGV0IGNmZ1NuYXAgPSBudWxsOwphc3luYyBmdW5jdGlvbiBsb2FkQ29uZmlnKCkgewogIGNvbnN0IHBhbmUgPSAkKCIjcGFuZS1jb25maWciKTsKICBwYW5lLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJzcGluIj7YrNin2LHZjSDYp9mE2KrYrdmF2YrZhOKApjwvZGl2Pic7CiAgdHJ5IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoInBhbmVsQ29uZmlnR2V0Iik7CiAgICBjb25zdCBjZmcgPSByLmNvbmZpZyB8fCB7fTsKICAgIGNmZ1NuYXAgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KGNmZykpOwogICAgY29uc3QgbnVtSW4gPSAoW2ssIHRdKSA9PiBgPGRpdj48bGFiZWw+JHt0fSA8c3BhbiBjbGFzcz0ibW9ubyBtdXQiPiR7a308L3NwYW4+PC9sYWJlbD48aW5wdXQgdHlwZT0ibnVtYmVyIiBzdGVwPSJhbnkiIGlkPSJjZmctJHtrfSIgdmFsdWU9IiR7Y2ZnW2tdID09IG51bGwgPyAiIiA6IGVzYyhjZmdba10pfSI+PC9kaXY+YDsKICAgIGNvbnN0IHN0ckluID0gKFtrLCB0XSkgPT4gYDxkaXY+PGxhYmVsPiR7dH0gPHNwYW4gY2xhc3M9Im1vbm8gbXV0Ij4ke2t9PC9zcGFuPjwvbGFiZWw+PGlucHV0IHR5cGU9InRleHQiIGlkPSJjZmctJHtrfSIgdmFsdWU9IiR7ZXNjKGNmZ1trXSA9PSBudWxsID8gIiIgOiBjZmdba10pfSI+PC9kaXY+YDsKICAgIGNvbnN0IGRlZnMgPSBBcnJheS5pc0FycmF5KGNmZy5ob2xkVGFza0RlZnMpICYmIGNmZy5ob2xkVGFza0RlZnMubGVuZ3RoID8gY2ZnLmhvbGRUYXNrRGVmcyA6IFtdOwogICAgcGFuZS5pbm5lckhUTUwgPSBgCiAgICAgIDxkaXYgY2xhc3M9InNlYy10IiBzdHlsZT0ibWFyZ2luLXRvcDowIj7Yp9mE2YLZitmFINin2YTYsdmC2YXZitipPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNmZy1ncmlkIj4ke05VTV9GSUVMRFMubWFwKG51bUluKS5qb2luKCIiKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic2VjLXQiPtmG2LXZiNi1INmI2LHZiNin2KjYtzwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjZmctZ3JpZCI+JHtTVFJfRklFTERTLm1hcChzdHJJbikuam9pbigiIil9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNlYy10Ij7ZhdmH2KfZhSDYp9mE2KfYrdiq2YHYp9i4ICjZh9mI2YTYryDihpAg2YXZg9in2YHYo9ipKTwvZGl2PgogICAgICA8ZGl2IGlkPSJjZmctZGVmcyI+JHtkZWZzLm1hcCgoZCkgPT4gZGVmUm93KGQpKS5qb2luKCIiKX08L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IGJ0bi1zbWFsbCIgaWQ9ImNmZy1kZWYtYWRkIj4rINil2LbYp9mB2Kkg2YXYs9iq2YjZiTwvYnV0dG9uPgogICAgICA8ZGl2IGNsYXNzPSJzZWMtdCI+2KPYrtix2Yk8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0LXJvdyI+PGxhYmVsIHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjhweDthbGlnbi1pdGVtczpjZW50ZXIiPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgaWQ9ImNmZy1vd25lck9ubHkiICR7Y2ZnLm93bmVyT25seSA/ICJjaGVja2VkIiA6ICIifSBzdHlsZT0id2lkdGg6MThweDtoZWlnaHQ6MThweCI+INmI2LbYuSDYp9mE2LXZitin2YbYqSDigJQg2KfZhNiq2LfYqNmK2YIg2YTZhNmF2KfZhNmDINmB2YLYtyAob3duZXJPbmx5KTwvbGFiZWw+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdC1yb3ciPjxsYWJlbCBjbGFzcz0ibXV0IHNtYWxsIiBzdHlsZT0id2lkdGg6MTAwJSI+2KfZhNmF2K/Ysdin2KEg2KfZhNil2LbYp9mB2YrZiNmGICjYotmK2K/Zitin2Kog2KrZitmE2YrYrNix2KfZhSDZhdmB2LXZiNmE2Kkg2KjZgdmI2KfYtdmEKSDigJQgYWRtaW5Vc2VycwogICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iY2ZnLWFkbWluVXNlcnMiIHZhbHVlPSIke2VzYygoY2ZnLmFkbWluVXNlcnMgfHwgW10pLmpvaW4oIiwgIikpfSIgc3R5bGU9IndpZHRoOjEwMCU7bWFyZ2luLXRvcDo0cHgiPjwvbGFiZWw+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdC1yb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjE2cHgiPjxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImNmZy1zYXZlIj7YrdmB2Lgg2KfZhNiq2LrZitmK2LHYp9iqPC9idXR0b24+CiAgICAgIDxzcGFuIGNsYXNzPSJtdXQgc21hbGwiPtiq2Y/YrdmB2Lgg2YHZgti3INin2YTYrdmC2YjZhCDYp9mE2YXYudiv2ZHZhNipLiDYp9mE2KXYudiv2KfYr9in2Kog2KfZhNmF2K3ZgdmI2LjYqSDZgdi52YTZitmL2Kcg2YHZiiDZgtin2LnYr9ipINin2YTYqNmK2KfZhtin2Kog2KrYuNmH2LEg2KPYs9mB2YQg2KfZhNi12YHYrdipLjwvc3Bhbj48L2Rpdj4KICAgICAgPGRldGFpbHM+PHN1bW1hcnk+2KfZhNil2LnYr9in2K/Yp9iqINin2YTZhdit2YHZiNi42KkgKHNldHRpbmdzL2dsb2JhbCk8L3N1bW1hcnk+PHByZSBjbGFzcz0ianNvbiI+JHtlc2MoSlNPTi5zdHJpbmdpZnkoci5zdG9yZWQgfHwge30sIG51bGwsIDEpKX08L3ByZT48L2RldGFpbHM+YDsKICAgICQoIiNjZmctZGVmLWFkZCIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCkgPT4geyAkKCIjY2ZnLWRlZnMiKS5pbnNlcnRBZGphY2VudEhUTUwoImJlZm9yZWVuZCIsIGRlZlJvdyh7IGhvbGQ6ICIiLCByZXdhcmQ6ICIiIH0pKTsgYmluZERlZkRlbCgpOyB9KTsKICAgIGJpbmREZWZEZWwoKTsKICAgICQoIiNjZmctc2F2ZSIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgc2F2ZUNvbmZpZyk7CiAgfSBjYXRjaCAoZSkgeyBwYW5lLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eSI+2KrYudiw2LEg2KfZhNiq2K3ZhdmK2YQ8L2Rpdj4nOyBlcnJUb2FzdChlKTsgfQp9CmZ1bmN0aW9uIGRlZlJvdyhkKSB7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJkZWYtcm93Ij48c3BhbiBjbGFzcz0ibXV0IHNtYWxsIj7Zh9mI2YTYrzwvc3Bhbj48aW5wdXQgdHlwZT0ibnVtYmVyIiBjbGFzcz0iZGVmLWhvbGQiIHZhbHVlPSIke2QuaG9sZCA9PSBudWxsID8gIiIgOiBlc2MoZC5ob2xkKX0iPjxzcGFuIGNsYXNzPSJtdXQgc21hbGwiPtmF2YPYp9mB2KPYqTwvc3Bhbj48aW5wdXQgdHlwZT0ibnVtYmVyIiBjbGFzcz0iZGVmLXJld2FyZCIgdmFsdWU9IiR7ZC5yZXdhcmQgPT0gbnVsbCA/ICIiIDogZXNjKGQucmV3YXJkKX0iPjxidXR0b24gY2xhc3M9ImJ0bi1kYW5nZXIgYnRuLXNtYWxsIGRlZi1kZWwiPtit2LDZgTwvYnV0dG9uPjwvZGl2PmA7Cn0KZnVuY3Rpb24gYmluZERlZkRlbCgpIHsgJCQoIiNjZmctZGVmcyAuZGVmLWRlbCIpLmZvckVhY2goKGIpID0+IGIub25jbGljayA9ICgpID0+IGIuY2xvc2VzdCgiLmRlZi1yb3ciKS5yZW1vdmUoKSk7IH0KYXN5bmMgZnVuY3Rpb24gc2F2ZUNvbmZpZygpIHsKICBpZiAoIWNmZ1NuYXApIHJldHVybjsKICBjb25zdCBvdXQgPSB7fTsKICBmb3IgKGNvbnN0IFtrXSBvZiBOVU1fRklFTERTKSB7CiAgICBjb25zdCB2ID0gJCgiI2NmZy0iICsgaykudmFsdWUudHJpbSgpOwogICAgY29uc3QgbnYgPSB2ID09PSAiIiA/IG51bGwgOiBOdW1iZXIodik7CiAgICBpZiAobnYgIT09IE51bWJlcihjZmdTbmFwW2tdID09IG51bGwgPyBudWxsIDogY2ZnU25hcFtrXSkgJiYgbnYgIT09IG51bGwpIG91dFtrXSA9IG52OwogIH0KICBmb3IgKGNvbnN0IFtrXSBvZiBTVFJfRklFTERTKSB7CiAgICBjb25zdCB2ID0gJCgiI2NmZy0iICsgaykudmFsdWU7CiAgICBpZiAodiAhPT0gU3RyaW5nKGNmZ1NuYXBba10gPT0gbnVsbCA/ICIiIDogY2ZnU25hcFtrXSkpIG91dFtrXSA9IHY7CiAgfQogIGNvbnN0IGRlZnMgPSAkJCgiI2NmZy1kZWZzIC5kZWYtcm93IikubWFwKChyb3cpID0+ICh7IGhvbGQ6IE51bWJlcigkKCIuZGVmLWhvbGQiLCByb3cpLnZhbHVlKSwgcmV3YXJkOiBOdW1iZXIoJCgiLmRlZi1yZXdhcmQiLCByb3cpLnZhbHVlKSB9KSk7CiAgaWYgKEpTT04uc3RyaW5naWZ5KGRlZnMpICE9PSBKU09OLnN0cmluZ2lmeShjZmdTbmFwLmhvbGRUYXNrRGVmcyB8fCBbXSkpIG91dC5ob2xkVGFza0RlZnMgPSBkZWZzOwogIGNvbnN0IGFkbWlucyA9ICQoIiNjZmctYWRtaW5Vc2VycyIpLnZhbHVlLnNwbGl0KCIsIikubWFwKChzKSA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwogIGlmIChKU09OLnN0cmluZ2lmeShhZG1pbnMpICE9PSBKU09OLnN0cmluZ2lmeSgoY2ZnU25hcC5hZG1pblVzZXJzIHx8IFtdKS5tYXAoU3RyaW5nKSkpIG91dC5hZG1pblVzZXJzID0gYWRtaW5zOwogIGNvbnN0IG9vID0gJCgiI2NmZy1vd25lck9ubHkiKS5jaGVja2VkOwogIGlmIChvbyAhPT0gISFjZmdTbmFwLm93bmVyT25seSkgb3V0Lm93bmVyT25seSA9IG9vOwogIGlmICghT2JqZWN0LmtleXMob3V0KS5sZW5ndGgpIHsgdG9hc3QoItmE2Kcg2KrZiNis2K8g2KrYutmK2YrYsdin2Kog2YTYrdmB2LjZh9inIik7IHJldHVybjsgfQogIGlmIChvdXQub3duZXJPbmx5ID09PSB0cnVlICYmICFhd2FpdCBzaG93Q29uZmlybSgi2YjYtti5INin2YTYtdmK2KfZhtipIiwgItiq2YHYudmK2YQg2YjYtti5INin2YTYtdmK2KfZhtipINiz2YrYutmE2YIg2KfZhNiq2LfYqNmK2YIg2LnZhNmJINmD2YQg2KfZhNmE2KfYudio2YrZhiAo2LnYr9inINin2YTZhdiv2LHYp9ihKS4g2YXYqtij2YPYr9ifIiwgItiq2YHYudmK2YQiLCB0cnVlKSkgcmV0dXJuOwogIHRyeSB7CiAgICBjb25zdCByZXMgPSBhd2FpdCBhcGkoInBhbmVsQ29uZmlnU2V0IiwgeyBzZXR0aW5nczogb3V0IH0pOwogICAgdG9hc3QoItiq2YUg2K3Zgdi4OiAiICsgZXNjKChyZXMuYXBwbGllZCB8fCBbXSkuam9pbigi2IwgIikpKTsKICAgIGxvYWRlZC5jb25maWcgPSBmYWxzZTsgbG9hZENvbmZpZygpOwogIH0gY2F0Y2ggKGUpIHsgZXJyVG9hc3QoZSk7IH0KfQpsb2FkZXJzLmNvbmZpZyA9IGxvYWRDb25maWc7CgovKiA9PT09PT09PT09PT09PT09PSByZXF1ZXN0cyA9PT09PT09PT09PT09PT09PSAqLwphc3luYyBmdW5jdGlvbiBsb2FkUmVxdWVzdHMoKSB7CiAgY29uc3QgcGFuZSA9ICQoIiNwYW5lLXJlcXVlc3RzIik7CiAgcGFuZS5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJzZWMtdCIgc3R5bGU9Im1hcmdpbi10b3A6MCI+2KfYt9mE2Kgg2YXZhiDYp9mE2YXYs9in2LnYrzwvZGl2PgogICAgPHAgY2xhc3M9Im11dCBzbWFsbCIgc3R5bGU9Im1hcmdpbi10b3A6MCI+2KfZg9iq2Kgg2LfZhNio2YMg2YfZhtinICjYs9ik2KfZhCDYudmGINin2YTYqNmI2KrYjCDYqti52K/ZitmE2Iwg2KrZgtix2YrYseKApikg2YjYs9mK2LXZhCDYpdmE2Ykg2KfZhNmF2LPYp9i52K8g2YHZiiDYp9mE2LTYp9iq2Iwg2YjYsdiv2Ycg2LPZiti42YfYsSDZh9mG2Kcg2YjZgdmKINin2YTYtNin2KouPC9wPgogICAgPHRleHRhcmVhIGlkPSJyZXEtdGV4dCIgcGxhY2Vob2xkZXI9Itin2YPYqtioINi32YTYqNmD4oCmIj48L3RleHRhcmVhPgogICAgPGRpdiBjbGFzcz0iYWN0LXJvdyI+PGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0icmVxLXNlbmQiPtil2LHYs9in2YQg2KfZhNi32YTYqDwvYnV0dG9uPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic2VjLXQiPtin2YTYt9mE2KjYp9iqPC9kaXY+CiAgICA8ZGl2IGlkPSJyZXEtYm9keSI+PGRpdiBjbGFzcz0ic3BpbiI+2KzYp9ix2Y0g2KfZhNiq2K3ZhdmK2YTigKY8L2Rpdj48L2Rpdj5gOwogICQoIiNyZXEtc2VuZCIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgYXN5bmMgKCkgPT4gewogICAgY29uc3QgdCA9ICQoIiNyZXEtdGV4dCIpLnZhbHVlLnRyaW0oKTsKICAgIGlmICghdCkgeyB0b2FzdCgi2KfZg9iq2Kgg2KfZhNi32YTYqCDYo9mI2YTZi9inIiwgdHJ1ZSk7IHJldHVybjsgfQogICAgdHJ5IHsgYXdhaXQgYXBpKCJwYW5lbFJlcXVlc3RBZGQiLCB7IHRleHQ6IHQgfSk7ICQoIiNyZXEtdGV4dCIpLnZhbHVlID0gIiI7IHRvYXN0KCLYqtmFINil2LHYs9in2YQg2KfZhNi32YTYqCDinIUiKTsgZmV0Y2hSZXF1ZXN0cygpOyB9CiAgICBjYXRjaCAoZSkgeyBlcnJUb2FzdChlKTsgfQogIH0pOwogIGZldGNoUmVxdWVzdHMoKTsKfQphc3luYyBmdW5jdGlvbiBmZXRjaFJlcXVlc3RzKCkgewogIGNvbnN0IGJvZHkgPSAkKCIjcmVxLWJvZHkiKTsgaWYgKCFib2R5KSByZXR1cm47CiAgdHJ5IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoInBhbmVsUmVxdWVzdExpc3QiKTsKICAgIGlmICghci5yb3dzLmxlbmd0aCkgeyBib2R5LmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eSI+2YTYpyDYqtmI2KzYryDYt9mE2KjYp9iqINio2LnYrzwvZGl2Pic7IHJldHVybjsgfQogICAgd2luZG93Ll9yZXFSZXBsaWVzID0ge307CiAgICByLnJvd3MuZm9yRWFjaCgoeCkgPT4geyBpZiAoeC5yZXBseSkgd2luZG93Ll9yZXFSZXBsaWVzW3guaWRdID0geC5yZXBseTsgfSk7CiAgICBib2R5LmlubmVySFRNTCA9IHIucm93cy5tYXAoKHgpID0+IGA8ZGl2IGNsYXNzPSJyZXEtaXQiPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjhweDthbGlnbi1pdGVtczpjZW50ZXIiPgogICAgICAgICR7eC5zdGF0dXMgPT09ICJkb25lIiA/ICc8c3BhbiBjbGFzcz0iYmFkZ2UgYi1ncmVlbiI+2KrZhSDYp9mE2LHYryDinIU8L3NwYW4+JyA6ICc8c3BhbiBjbGFzcz0iYmFkZ2UgYi15ZWxsb3ciPtis2K/ZitivIOKPszwvc3Bhbj4nfQogICAgICAgIDxzcGFuIGNsYXNzPSJtdXQgc21hbGwiPiR7ZXNjKGZtdERhdGUoeC5hdCkpfTwvc3Bhbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InR4dCI+JHtlc2MoeC50ZXh0KX08L2Rpdj4KICAgICAgJHt4LnJlcGx5ID8gYDxkaXYgY2xhc3M9InJlcGx5Ij48ZGl2IGNsYXNzPSJyZXBseS1oZWFkIj48Yj7YsdivINin2YTZhdiz2KfYudivPC9iPiA8c3BhbiBjbGFzcz0ibXV0IHNtYWxsIj4ke2VzYyhmbXREYXRlKHgucmVwbGllZEF0KSl9PC9zcGFuPjxzcGFuIGNsYXNzPSJzcCI+PC9zcGFuPjxidXR0b24gY2xhc3M9ImNvcHktYnRuIiBkYXRhLWNvcHlyZXE9IiR7eC5pZH0iPvCfk4sg2YbYs9iuINin2YTYsdivPC9idXR0b24+PC9kaXY+PGRpdiBjbGFzcz0icmVwbHktYm9keSI+JHtlc2MoeC5yZXBseSl9PC9kaXY+PC9kaXY+YCA6ICIifQogICAgPC9kaXY+YCkuam9pbigiIik7CiAgICBib2R5LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWNvcHlyZXFdIikuZm9yRWFjaCgoYikgPT4gYi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpID0+IGNvcHlSZXBseVRleHQoYi5nZXRBdHRyaWJ1dGUoImRhdGEtY29weXJlcSIpKSkpOwogIH0gY2F0Y2ggKGUpIHsgYm9keS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHkiPtiq2LnYsNixINin2YTYqtit2YXZitmEPC9kaXY+JzsgZXJyVG9hc3QoZSk7IH0KfQphc3luYyBmdW5jdGlvbiBjb3B5UmVwbHlUZXh0KGlkKSB7CiAgY29uc3QgdCA9ICh3aW5kb3cuX3JlcVJlcGxpZXMgfHwge30pW2lkXTsKICBpZiAoIXQpIHJldHVybjsKICB0cnkgeyBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCh0KTsgdG9hc3QoItin2KrZhtiz2K4g2KfZhNix2K8g4pyFIik7IHJldHVybjsgfSBjYXRjaCAoZSkgeyAvKiBmYWxsYmFjayBiZWxvdyAqLyB9CiAgY29uc3QgdGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCJ0ZXh0YXJlYSIpOwogIHRhLnZhbHVlID0gdDsgdGEuc3R5bGUucG9zaXRpb24gPSAiZml4ZWQiOyB0YS5zdHlsZS5vcGFjaXR5ID0gIjAiOwogIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQodGEpOyB0YS5zZWxlY3QoKTsKICB0cnkgeyBkb2N1bWVudC5leGVjQ29tbWFuZCgiY29weSIpOyB0b2FzdCgi2KfYqtmG2LPYriDYp9mE2LHYryDinIUiKTsgfSBjYXRjaCAoXykgeyB0b2FzdCgi2KrYudiw2LEg2KfZhNmG2LPYriIsIHRydWUpOyB9CiAgdGEucmVtb3ZlKCk7Cn0KbG9hZGVycy5yZXF1ZXN0cyA9IGxvYWRSZXF1ZXN0czsKCi8qID09PT09PT09PT09PT09PT09IGF1ZGl0ID09PT09PT09PT09PT09PT09ICovCmFzeW5jIGZ1bmN0aW9uIGxvYWRBdWRpdCgpIHsKICBjb25zdCBwYW5lID0gJCgiI3BhbmUtYXVkaXQiKTsKICBwYW5lLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJzcGluIj7YrNin2LHZjSDYp9mE2KrYrdmF2YrZhOKApjwvZGl2Pic7CiAgdHJ5IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoInBhbmVsQXVkaXRMaXN0Iik7CiAgICBpZiAoIXIucm93cy5sZW5ndGgpIHsgcGFuZS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHkiPtmE2Kcg2KrZiNis2K8g2KXYrNix2KfYodin2Kog2YXYs9is2YTYqSDYqNi52K88L2Rpdj4nOyByZXR1cm47IH0KICAgIHBhbmUuaW5uZXJIVE1MID0gYDx0YWJsZT48dGhlYWQ+PHRyPjx0aD7Yp9mE2YjZgtiqPC90aD48dGg+2KfZhNil2KzYsdin2KE8L3RoPjx0aD7Yp9mE2YfYr9mBPC90aD48dGg+2KfZhNiq2YHYp9i12YrZhDwvdGg+PC90cj48L3RoZWFkPjx0Ym9keT4KICAgICAgJHtyLnJvd3MubWFwKCh4KSA9PiBgPHRyPjx0ZCBjbGFzcz0ic21hbGwiIHN0eWxlPSJ3aGl0ZS1zcGFjZTpub3dyYXAiPiR7ZXNjKGZtdERhdGUoeC5hdCkpfTwvdGQ+PHRkPiR7ZXNjKHguYWN0aW9uKX08L3RkPjx0ZD48c3BhbiBjbGFzcz0ibW9ubyI+JHtlc2MoeC50YXJnZXQgfHwgIiIpfTwvc3Bhbj48L3RkPjx0ZD4ke2VzYyh4LmRldGFpbCB8fCAiIil9PC90ZD48L3RyPmApLmpvaW4oIiIpfQogICAgICA8L3Rib2R5PjwvdGFibGU+YDsKICB9IGNhdGNoIChlKSB7IHBhbmUuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij7Yqti52LDYsSDYp9mE2KrYrdmF2YrZhDwvZGl2Pic7IGVyclRvYXN0KGUpOyB9Cn0KbG9hZGVycy5hdWRpdCA9IGxvYWRBdWRpdDsKCi8qID09PT09PT09PT09PT09PT09IGJvdW50eSA9PT09PT09PT09PT09PT09PSAqLwpsZXQgYm5BbGxSb3dzID0gW10sIGJuRmlsdGVyID0gImFsbCI7CmZ1bmN0aW9uIGJuRmlsdGVyZWRSb3dzKCkgewogIHJldHVybiBibkFsbFJvd3MuZmlsdGVyKCh4KSA9PiB7CiAgICBjb25zdCBzdCA9IFN0cmluZyh4LnN0YXR1cyB8fCAiIik7CiAgICBpZiAoYm5GaWx0ZXIgPT09ICJwZW5kaW5nIikgcmV0dXJuIHN0LmluY2x1ZGVzKCJQZW5kaW5nIik7CiAgICBpZiAoYm5GaWx0ZXIgPT09ICJhcHByb3ZlZCIpIHJldHVybiBzdC5pbmNsdWRlcygiQXBwcm92ZWQiKTsKICAgIGlmIChibkZpbHRlciA9PT0gInJlamVjdGVkIikgcmV0dXJuIHN0LmluY2x1ZGVzKCJSZWplY3RlZCIpOwogICAgcmV0dXJuIHRydWU7CiAgfSk7Cn0KZnVuY3Rpb24gc3luY0JuQ2hpcHMoKSB7CiAgJCQoIiNibi1maWx0ZXJzIFtkYXRhLWJuZl0iKS5mb3JFYWNoKChiKSA9PiB7IGIuY2xhc3NOYW1lID0gYi5kYXRhc2V0LmJuZiA9PT0gYm5GaWx0ZXIgPyAiYnRuIGJ0bi1zbWFsbCIgOiAiYnRuLWdob3N0IGJ0bi1zbWFsbCI7IH0pOwogIGNvbnN0IGMgPSAkKCIjYm4tY291bnQiKTsKICBpZiAoYykgewogICAgY29uc3QgbiA9IHsgYWxsOiBibkFsbFJvd3MubGVuZ3RoLCBwZW5kaW5nOiAwLCBhcHByb3ZlZDogMCwgcmVqZWN0ZWQ6IDAgfTsKICAgIGJuQWxsUm93cy5mb3JFYWNoKCh4KSA9PiB7IGNvbnN0IHN0ID0gU3RyaW5nKHguc3RhdHVzIHx8ICIiKTsgaWYgKHN0LmluY2x1ZGVzKCJQZW5kaW5nIikpIG4ucGVuZGluZysrOyBlbHNlIGlmIChzdC5pbmNsdWRlcygiQXBwcm92ZWQiKSkgbi5hcHByb3ZlZCsrOyBlbHNlIGlmIChzdC5pbmNsdWRlcygiUmVqZWN0ZWQiKSkgbi5yZWplY3RlZCsrOyB9KTsKICAgIGMudGV4dENvbnRlbnQgPSAi2KfZhNmD2YQ6ICIgKyBuLmFsbCArICIgwrcg2KfZhNmF2LnZhNmR2YLYqTogIiArIG4ucGVuZGluZyArICIgwrcg2KfZhNmF2YLYqNmI2YTYqTogIiArIG4uYXBwcm92ZWQgKyAiIMK3INin2YTZhdix2YHZiNi22Kk6ICIgKyBuLnJlamVjdGVkOwogIH0KfQphc3luYyBmdW5jdGlvbiBsb2FkQm91bnR5KCkgewogIGNvbnN0IHBhbmUgPSAkKCIjcGFuZS1ib3VudHkiKTsKICBwYW5lLmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InRvb2xiYXIiPjxzcGFuIGNsYXNzPSJtdXQgc21hbGwiPtin2LnYqtmF2KfYryDYt9mE2Kgg2KfZhNio2KfZiNmG2KrZiiA9INil2LHYs9in2YQg2KfZhNmF2YPYp9mB2KPYqSDZgdi52YTZitmL2Kcg2YXZhiDZhdit2YHYuNipINin2YTYr9mB2Lkg2KXZhNmJINmF2K3Zgdi42Kkg2KfZhNmE2KfYudioINio2KrYudmE2YrZgiDCq2JvdW50eSBmcm9tIFpPTUJJRV9NSU5FUl9ib3TCuyDigJQg2YjZiti12YQg2YTZhNin2LnYqCDYsdiz2KfZhNipINmI2YrZhtiy2YQg2YXZhti02YjYsSDZgdmKINmC2YbYp9ipINin2YTZhdiv2YHZiNi52KfYqiDYqNi12YjYsdipINin2YTYqNin2YjZhtiq2Yogwrcg2KfZhNix2YHYtiDZhNinINmK2K3YsdmR2YMg2KPZiiDYo9mF2YjYp9mEPC9zcGFuPgogICAgPHNwYW4gY2xhc3M9InNwIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IGJ0bi1zbWFsbCIgaWQ9ImJuLXJlZnJlc2giPtiq2K3Yr9mK2Ks8L2J1dHRvbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InRvb2xiYXIiIGlkPSJibi1maWx0ZXJzIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICA8YnV0dG9uIGRhdGEtYm5mPSJhbGwiPtin2YTZg9mEPC9idXR0b24+CiAgICAgIDxidXR0b24gZGF0YS1ibmY9InBlbmRpbmciPuKPsyDYp9mE2YXYudmE2ZHZgtipINio2LM8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBkYXRhLWJuZj0iYXBwcm92ZWQiPtin2YTZhdmC2KjZiNmE2Kk8L2J1dHRvbj4KICAgICAgPGJ1dHRvbiBkYXRhLWJuZj0icmVqZWN0ZWQiPtin2YTZhdix2YHZiNi22Kk8L2J1dHRvbj4KICAgICAgPHNwYW4gY2xhc3M9InNwIj48L3NwYW4+PHNwYW4gY2xhc3M9Im11dCBzbWFsbCIgaWQ9ImJuLWNvdW50Ij48L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9ImJuLWJvZHkiPjxkaXYgY2xhc3M9InNwaW4iPtis2KfYsdmNINin2YTYqtit2YXZitmE4oCmPC9kaXY+PC9kaXY+YDsKICAkKCIjYm4tcmVmcmVzaCIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCkgPT4gZmV0Y2hCb3VudHkoKSk7CiAgJCQoIiNibi1maWx0ZXJzIFtkYXRhLWJuZl0iKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCkgPT4geyBibkZpbHRlciA9IGIuZGF0YXNldC5ibmY7IHN5bmNCbkNoaXBzKCk7IHJlbmRlckJvdW50eSgpOyB9KSk7CiAgc3luY0JuQ2hpcHMoKTsKICBmZXRjaEJvdW50eSgpOwp9CmFzeW5jIGZ1bmN0aW9uIGZldGNoQm91bnR5KCkgewogIGNvbnN0IGJvZHkgPSAkKCIjYm4tYm9keSIpOyBpZiAoIWJvZHkpIHJldHVybjsKICBib2R5LmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJzcGluIj7YrNin2LHZjSDYp9mE2KrYrdmF2YrZhOKApjwvZGl2Pic7CiAgdHJ5IHsKICAgIGNvbnN0IHIgPSBhd2FpdCBhcGkoInBhbmVsQm91bnR5TGlzdCIpOwogICAgYm5BbGxSb3dzID0gci5yb3dzIHx8IFtdOwogICAgc3luY0JuQ2hpcHMoKTsKICAgIHJlbmRlckJvdW50eSgpOwogIH0gY2F0Y2ggKGUpIHsgYm9keS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHkiPtiq2LnYsNixINin2YTYqtit2YXZitmEPC9kaXY+JzsgZXJyVG9hc3QoZSk7IH0KfQpmdW5jdGlvbiByZW5kZXJCb3VudHkoKSB7CiAgY29uc3QgYm9keSA9ICQoIiNibi1ib2R5Iik7IGlmICghYm9keSkgcmV0dXJuOwogIGNvbnN0IHJvd3MgPSBibkZpbHRlcmVkUm93cygpOwogIGlmICghYm5BbGxSb3dzLmxlbmd0aCkgeyBib2R5LmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eSI+2YTYpyDYqtmI2KzYryDYt9mE2KjYp9iqINio2KfZiNmG2KrZiiDYqNi52K88L2Rpdj4nOyByZXR1cm47IH0KICBpZiAoIXJvd3MubGVuZ3RoKSB7IGJvZHkuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5Ij4nICsgKGJuRmlsdGVyID09PSAicGVuZGluZyIgPyAi2YTYpyDYqtmI2KzYryDYt9mE2KjYp9iqINmF2LnZhNmR2YLYqSDwn46JIiA6ICLZhNinINiq2YjYrNivINi32YTYqNin2Kog2YHZiiDZh9iw2Kcg2KfZhNmC2LPZhSIpICsgJzwvZGl2Pic7IHJldHVybjsgfQogIGJvZHkuaW5uZXJIVE1MID0gcm93cy5tYXAoKHgpID0+IHsKICAgICAgY29uc3QgcCA9IHgucGxheWVyIHx8IHt9OwogICAgICBjb25zdCBzdCA9IFN0cmluZyh4LnN0YXR1cyB8fCAiIik7CiAgICAgIGNvbnN0IHBlbmRpbmcgPSBzdC5pbmNsdWRlcygiUGVuZGluZyIpOwogICAgICBjb25zdCBhcHByb3ZlZCA9IHN0LmluY2x1ZGVzKCJBcHByb3ZlZCIpOwogICAgICBjb25zdCBiYWRnZSA9IHBlbmRpbmcgPyAiYi15ZWxsb3ciIDogYXBwcm92ZWQgPyAiYi1ncmVlbiIgOiAiYi1yZWQiOwogICAgICByZXR1cm4gYDxkaXYgY2xhc3M9InJlcS1pdCI+CiAgICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDo4cHg7ZmxleC13cmFwOndyYXA7YWxpZ24taXRlbXM6Y2VudGVyIj4KICAgICAgICAgIDxiPiMke3guYm5OdW19PC9iPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImJhZGdlIGItZ3JleSI+JHtlc2MoeC50eXBlIHx8ICIiKX0gwrcgJHtlc2MoeC5wbGF0Zm9ybSB8fCAiIil9PC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9ImJhZGdlICR7YmFkZ2V9Ij4ke2VzYyh4LnN0YXR1cyB8fCAiIil9PC9zcGFuPgogICAgICAgICAgJHt4LmltcG9ydGVkID8gJzxzcGFuIGNsYXNzPSJiYWRnZSBiLWdyZXkiPtmF2LPYqtix2KzYuSDZhdmGINin2YTYrNmH2KfYsjwvc3Bhbj4nIDogIiJ9CiAgICAgICAgICA8c3BhbiBjbGFzcz0ibXV0IHNtYWxsIj4ke2ZtdERhdGUoeC5jcmVhdGVkQXQpfTwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJzcCI+PC9zcGFuPgogICAgICAgICAgJHthcHByb3ZlZCAmJiB4LnBheVR4ID8gYDxhIGhyZWY9Imh0dHBzOi8vdG9udmlld2VyLmNvbS90cmFuc2FjdGlvbi8ke2VzYyh4LnBheVR4KX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj7Yp9mE2YXYudin2YXZhNipPC9hPmAgOiAiIn0KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+PGI+JHtlc2MocC5uYW1lIHx8ICLigJQiKX08L2I+ICR7cC51c2VybmFtZSA/IGA8c3BhbiBjbGFzcz0ibXV0Ij5AJHtlc2MocC51c2VybmFtZSl9PC9zcGFuPmAgOiAiIn0gJHtwLndhbGxldFZlcmlmaWVkID8gIvCfm6HvuI8iIDogIiJ9ICR7cC5iYW5uZWQgPyAi8J+aqyIgOiAiIn0KICAgICAgICAgIDxicj48c3BhbiBjbGFzcz0ibW9ubyBtdXQiPiR7ZXNjKHAuaWQgfHwgeC51c2VySWQgfHwgIiIpfTwvc3Bhbj4gwrcg2YTYp9i52Kgg2LHZgtmFICR7cC51c2VyTm8gfHwgIuKAlCJ9CiAgICAgICAgICA8YnI+PHNwYW4gY2xhc3M9Im11dCBzbWFsbCI+2KfZhNmF2K3Zgdi42Kk6PC9zcGFuPiA8c3BhbiBjbGFzcz0ibW9ubyIgdGl0bGU9IiR7ZXNjKHAud2FsbGV0QWRkciB8fCAiIil9Ij4ke2VzYyhzaG9ydEFkZHIocC53YWxsZXRBZGRyIHx8ICIiKSl9PC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij48c3BhbiBjbGFzcz0ibXV0IHNtYWxsIj7Ysdin2KjYtyDYp9mE2YXZhti02YjYsTo8L3NwYW4+IDxhIGhyZWY9IiR7ZXNjKHgubGluayB8fCAiIyIpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPiR7ZXNjKHgubGluayB8fCAiIil9PC9hPgogICAgICAgICAgJHt4LmNoYW5uZWwgPyBgPGJyPjxzcGFuIGNsYXNzPSJtdXQgc21hbGwiPtin2YTZgtmG2KfYqTo8L3NwYW4+ICR7ZXNjKHguY2hhbm5lbCl9YCA6ICIifQogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6OHB4O2Rpc3BsYXk6ZmxleDtnYXA6MTZweDtmbGV4LXdyYXA6d3JhcCI+CiAgICAgICAgICA8c3Bhbj7wn5GlINil2KzZhdin2YTZiiDYp9mE2KXYrdin2YTYp9iqOiA8Yj4ke2ZtdE4oeC5yZWZzVG90YWwpfTwvYj48L3NwYW4+CiAgICAgICAgICA8c3Bhbj7inIUg2KfZhNil2K3Yp9mE2KfYqiDYp9mE2YXZiNir2YLYqTogPGI+JHtmbXROKHgucmVmc1ZlcmlmaWVkKX08L2I+PC9zcGFuPgogICAgICAgICAgPHNwYW4+8J+SsCDYpdis2YXYp9mE2Yog2YfZiNmE2K8g2KfZhNil2K3Yp9mE2KfYqjogPGI+JHtmbXROKHgucmVmc0hvbGQpfTwvYj4gWk9NPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgICR7KHgucG9zdGVkQXQgfHwgeC5wb3N0QWdlVW5rbm93bikgPyBgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDo2cHgiPjxzcGFuIGNsYXNzPSJtdXQgc21hbGwiPvCfk4Ug2LnZhdixINin2YTZhdmG2LTZiNixOjwvc3Bhbj4gJHt4LnBvc3RlZEF0ID8gYDxiPiR7Ym5BZ2VUeHQoeC5wb3N0ZWRBdCl9PC9iPiA8c3BhbiBjbGFzcz0ibXV0IHNtYWxsIj4oJHtlc2MoZm10RGF0ZSh4LnBvc3RlZEF0KSl9KTwvc3Bhbj4gJHsoRGF0ZS5ub3coKSAtIE51bWJlcih4LnBvc3RlZEF0KSA8IDEyICogMzYwMDAwMCkgPyAnPHNwYW4gY2xhc3M9ImJhZGdlIGItcmVkIj7wn5S0INmE2YUg2YrZhdixINi52YTZitmHIDEyINiz2KfYudipPC9zcGFuPicgOiAnPHNwYW4gY2xhc3M9ImJhZGdlIGItZ3JlZW4iPuKchSDZhdixINi52YTZitmHIDEyINiz2KfYudipPC9zcGFuPid9YCA6ICc8c3BhbiBjbGFzcz0ibXV0IHNtYWxsIj7YutmK2LEg2YXYudix2YjZgSDigJQg2LHYp9io2Lcg2K7Yp9i12Iwg2YrZj9iq2K3ZgtmCINmK2K/ZiNmK2YvYpzwvc3Bhbj4nfTwvZGl2PmAgOiAiIn0KICAgICAgICA8L2Rpdj4KICAgICAgICAke3BlbmRpbmcgPyBgPGRpdiBjbGFzcz0iYWN0LXJvdyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgICA8aW5wdXQgdHlwZT0ibnVtYmVyIiBtaW49IjUwMCIgbWF4PSIyMDAwMCIgc3RlcD0iMSIgcGxhY2Vob2xkZXI9Itin2YTZhdio2YTYuiA1MDAg4oCTIDIwLDAwMCIgaWQ9ImJuLWFtdC0ke3guYm5OdW19IiBzdHlsZT0id2lkdGg6MTgwcHgiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1zbWFsbCIgZGF0YS1ibmFjdD0ib2siIGRhdGEtbnVtPSIke3guYm5OdW19Ij7Yqtij2YPZitivINmI2KfZhNiv2YHYuTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuLWdob3N0IGJ0bi1zbWFsbCIgZGF0YS1ibmFjdD0ibm8iIGRhdGEtbnVtPSIke3guYm5OdW19Ij7YsdmB2LY8L2J1dHRvbj4KICAgICAgICAgICR7eC5wYXlTdGF0ZSA9PT0gImZhaWxlZCIgPyBgPHNwYW4gY2xhc3M9InNtYWxsIiBzdHlsZT0iY29sb3I6dmFyKC0tcmVkKSI+4pqg77iPINmB2LTZhNiqINmF2K3Yp9mI2YTYqSDYr9mB2Lkg2LPYp9io2YLYqTogJHtlc2MoeC5wYXlFcnJvciB8fCAiIil9PC9zcGFuPmAgOiAiIn0KICAgICAgICA8L2Rpdj5gIDogYXBwcm92ZWQgPyBgPGRpdiBjbGFzcz0ibXV0IHNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPtin2YTZhdmD2KfZgdij2Kkg2KfZhNmF2K/ZgdmI2LnYqTogPGI+JHtmbXROKHgucmV3YXJkKX0gWk9NPC9iPiDCtyAke2ZtdERhdGUoeC5wYWlkQXQgfHwgeC5kZWNpZGVkQXQpfTwvZGl2PmAgOiBgPGRpdiBjbGFzcz0ibXV0IHNtYWxsIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPtiq2YUg2KfZhNix2YHYtiDCtyAke2ZtdERhdGUoeC5kZWNpZGVkQXQpfTwvZGl2PmB9CiAgICAgIDwvZGl2PmA7CiAgICB9KS5qb2luKCIiKTsKICAgICQkKCIjYm4tYm9keSBbZGF0YS1ibmFjdF0iKS5mb3JFYWNoKChiKSA9PiBiLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCkgPT4gYm5BY3Rpb24oYi5kYXRhc2V0LmJuYWN0LCBOdW1iZXIoYi5kYXRhc2V0Lm51bSksIGJuQWxsUm93cy5maW5kKCh5KSA9PiB5LmJuTnVtID09PSBOdW1iZXIoYi5kYXRhc2V0Lm51bSkpKSkpOwp9CmFzeW5jIGZ1bmN0aW9uIGJuQWN0aW9uKGFjdCwgbnVtLCB4KSB7CiAgaWYgKCF4KSByZXR1cm47CiAgY29uc3QgcCA9IHgucGxheWVyIHx8IHt9OwogIHRyeSB7CiAgICBpZiAoYWN0ID09PSAibm8iKSB7CiAgICAgIGlmICghYXdhaXQgc2hvd0NvbmZpcm0oItix2YHYtiDYt9mE2Kgg2KjYp9mI2YbYqtmKIiwgYNix2YHYtiDYt9mE2Kgg2KfZhNio2KfZiNmG2KrZiiAjJHtudW19INmE2YTYp9i52KggJHtwLm5hbWUgfHwgIiJ92J9cbtmE2YYg2YrYqtmFINiv2YHYuSDYo9mKINmF2YPYp9mB2KPYqS5gLCAi2LHZgdi2INin2YTYt9mE2KgiLCB0cnVlKSkgcmV0dXJuOwogICAgICBhd2FpdCBhcGkoInBhbmVsQm91bnR5UmVqZWN0IiwgeyBibk51bTogbnVtIH0pOwogICAgICB0b2FzdChg2KrZhSDYsdmB2LYg2LfZhNioINin2YTYqNin2YjZhtiq2YogIyR7bnVtfSDinYxgKTsKICAgIH0gZWxzZSB7CiAgICAgIGNvbnN0IGlucCA9ICQoIiNibi1hbXQtIiArIG51bSk7CiAgICAgIGNvbnN0IGFtb3VudCA9IE1hdGguZmxvb3IoTnVtYmVyKGlucCAmJiBpbnAudmFsdWUpKTsKICAgICAgaWYgKCFhbW91bnQgfHwgYW1vdW50IDwgNTAwIHx8IGFtb3VudCA+IDIwMDAwKSB7IHRvYXN0KCLimqDvuI8g2KfZg9iq2Kgg2YXYqNmE2LrZi9inINio2YrZhiA1MDAg2YggMjAsMDAwIFpPTSIsIHRydWUpOyByZXR1cm47IH0KICAgICAgaWYgKCFwLndhbGxldEFkZHIpIHsgdG9hc3QoIuKaoO+4jyDYp9mE2YTYp9i52Kgg2YTZhSDZitix2KjYtyDZhdit2YHYuNipIOKAlCDZhNinINmK2YXZg9mGINin2YTYr9mB2LkiLCB0cnVlKTsgcmV0dXJuOyB9CiAgICAgIGlmICghYXdhaXQgc2hvd0NvbmZpcm0oItin2LnYqtmF2KfYryDYqNin2YjZhtiq2YoiLCBg2KfYudiq2YXYp9ivINio2KfZiNmG2KrZiiAjJHtudW19INmE2YTYp9i52KggJHtwLm5hbWUgfHwgIiJ92J9cbtiz2YrYqtmFINil2LHYs9in2YQgJHtmbXROKGFtb3VudCl9IFpPTSDZgdi52YTZitmL2Kcg2KXZhNmJINin2YTZhdit2YHYuNipOlxuJHtwLndhbGxldEFkZHJ9XG7YqNiq2LnZhNmK2YIgwqtib3VudHkgZnJvbSBaT01CSUVfTUlORVJfYm90wrsg4oCUINmI2LPZiti12YQg2YTZhNin2LnYqCDYsdiz2KfZhNipINmI2YrZhtiy2YQg2YXZhti02YjYsSDZgdmKINmC2YbYp9ipINin2YTZhdiv2YHZiNi52KfYqi5gLCAi2KfYudiq2YXYp9ivINmI2KXYsdiz2KfZhCIsIGZhbHNlKSkgcmV0dXJuOwogICAgICBjb25zdCByZXMgPSBhd2FpdCBhcGkoInBhbmVsQm91bnR5QXBwcm92ZSIsIHsgYm5OdW06IG51bSwgYW1vdW50IH0pOwogICAgICBpZiAocmVzLnBheVN0YXRlID09PSAicGFpZCIpIHRvYXN0KGDYqtmFINiv2YHYuSDYp9mE2KjYp9mI2YbYqtmKIOKchSAjJHtudW19IOKAlCAke2ZtdE4ocmVzLnJld2FyZCl9IFpPTSR7cmVzLnBheVR4ID8gYCDigJQgPGEgaHJlZj0iaHR0cHM6Ly90b252aWV3ZXIuY29tL3RyYW5zYWN0aW9uLyR7ZXNjKHJlcy5wYXlUeCl9IiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+2KfZhNmF2LnYp9mF2YTYqTwvYT5gIDogIiJ9YCk7CiAgICAgIGVsc2UgdG9hc3QoYNmG2KrZitis2Kkg2KfZhNin2LnYqtmF2KfYrzogJHtlc2MocmVzLnN0YXR1cyB8fCAiIil9IC8gJHtlc2MocmVzLnBheVN0YXRlIHx8ICIiKX0ke3Jlcy5wYXlFcnJvciA/ICIg4oCUICIgKyBlc2MocmVzLnBheUVycm9yKSA6ICIifWAsIHRydWUpOwogICAgfQogICAgZmV0Y2hCb3VudHkoKTsKICB9IGNhdGNoIChlKSB7IGVyclRvYXN0KGUpOyB9Cn0KbG9hZGVycy5ib3VudHkgPSBsb2FkQm91bnR5OwoKLyogPT09PT09PT09PT09PT09PT0gaW5pdCA9PT09PT09PT09PT09PT09PSAqLwppZiAoS0VZKSB7ICQoIiNnYXRlLWtleSIpLnZhbHVlID0gS0VZOyB0cnlFbnRlcigpOyB9Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K';
const PANEL_HTML = Buffer.from(PANEL_HTML_B64, 'base64').toString('utf8');

/* ---------- panel security: timing-safe key check + failed-key
   lockout with an owner alert (owner order 2026-11-17) ----------
   Failures are counted per client IP (clientIp — the same
   extraction the global per-IP rate limiter uses) over a 10-minute
   window; the 8th failure blocks WRONG-key attempts from that IP
   for 15 minutes (429) and sends ONE Arabic security alert to the
   owner per block episode. A correct key always works (owner
   bypass) and clears the IP's failure list. In-memory by design:
   a restart resets the counters, never the key itself. */
const PANEL_SEC_WINDOW_MS = 10 * 60 * 1000;
const PANEL_SEC_MAX_FAILS = 8;
const PANEL_SEC_BLOCK_MS = 15 * 60 * 1000;
const panelSec = new Map(); // ip -> { fails: number[], blockedUntil: number, alerted: boolean }

function panelKeyEq(given, expected) {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(typeof expected === 'string' ? expected : '');
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function panelSecBlocked(ip, now) {
  const rec = panelSec.get(ip);
  return !!(rec && rec.blockedUntil > now);
}
function panelSecSuccess(ip) {
  const rec = panelSec.get(ip);
  if (!rec) return;
  rec.fails = [];
  if (!(rec.blockedUntil > Date.now())) panelSec.delete(ip);
}
function panelSecFail(ip) {
  const now = Date.now();
  let rec = panelSec.get(ip);
  if (!rec) { rec = { fails: [], blockedUntil: 0, alerted: false }; panelSec.set(ip, rec); }
  if (rec.blockedUntil && rec.blockedUntil <= now) { rec.blockedUntil = 0; rec.alerted = false; }
  rec.fails = rec.fails.filter((t) => now - t < PANEL_SEC_WINDOW_MS);
  rec.fails.push(now);
  if (rec.fails.length >= PANEL_SEC_MAX_FAILS && !rec.blockedUntil) {
    rec.blockedUntil = now + PANEL_SEC_BLOCK_MS;
    if (!rec.alerted) { rec.alerted = true; panelSecAlert(ip); }
  }
}
function panelSecAlert(ip) {
  try {
    if (!OWNER_ID) return;
    const text = '⚠️ تنبيه أمني: محاولات دخول فاشلة متكررة على لوحة تحكم ZOM من العنوان ' + ip + ' — تم حظر محاولات الدخول الخاطئة من هذا العنوان 15 دقيقة.';
    Promise.resolve(tg('sendMessage', { chat_id: OWNER_ID, parse_mode: 'HTML', text })).catch(() => {});
  } catch (e) { /* an alert failure must never affect the request */ }
}

/* GET /panel: the embedded panel page behind Basic Auth (the
   password is the panel key; any username). Wrong or missing
   credentials feed the SAME lockout bucket as wrong panel keys. */
function panelPagePath(req) {
  if (req && typeof req.path === 'string' && req.path) return req.path;
  try { return new URL(String((req && req.url) || ''), 'http://x').pathname; } catch (e) { return ''; }
}
async function servePanelPage(req, res) {
  const k = process.env.ADMIN_PANEL_KEY || '';
  if (!k) return res.status(503).send('Panel disabled');
  const ip = clientIp(req);
  let pass = null;
  const m = /^Basic\s+(.+)$/i.exec(String(req.headers['authorization'] || ''));
  if (m) {
    try {
      const dec = Buffer.from(m[1].trim(), 'base64').toString('utf8');
      const ci = dec.indexOf(':');
      if (ci >= 0) pass = dec.slice(ci + 1);
    } catch (e) { /* pass stays null */ }
  }
  if (pass !== null && panelKeyEq(pass, k)) {
    panelSecSuccess(ip);
    return res.status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'no-store')
      .set('X-Frame-Options', 'DENY')
      .send(PANEL_HTML);
  }
  if (panelSecBlocked(ip, Date.now())) return res.status(429).send('Too many attempts');
  panelSecFail(ip);
  return res.status(401).set('WWW-Authenticate', 'Basic realm="ZOM Panel"').send('Unauthorized');
}

function panelKey(c) {
  const k = process.env.ADMIN_PANEL_KEY || '';
  if (!k) fail(503, 'Panel disabled');
  const ip = c.ip || '';
  // Timing-safe compare (panelKeyEq). A correct key is the owner
  // bypass: it works even while the IP is blocked, and it clears
  // the IP's failure list. A wrong key feeds the lockout bucket;
  // while blocked it is refused 429 with no further processing.
  if (panelKeyEq(c.body && c.body.key, k)) { panelSecSuccess(ip); return; }
  if (panelSecBlocked(ip, Date.now())) fail(429, 'Too many attempts');
  panelSecFail(ip);
  fail(401, 'Bad key');
}

/* Audit helper: appends { at, action, target, detail } to
   meta/panelAudit, keeping the newest 200 entries. Best-effort by
   design — an audit failure never fails the action it describes. */
async function panelAudit(action, target, detail) {
  try {
    await txUpdate(rtdb().ref('meta/panelAudit'), (cur) => {
      const doc = (cur && typeof cur === 'object') ? cur : {};
      const entries = Array.isArray(doc.entries) ? doc.entries : [];
      const next = [...entries, { at: Date.now(), action: String(action), target: String(target || ''), detail: String(detail || '').slice(0, 300) }].slice(-200);
      return { value: { ...doc, entries: next }, out: true };
    });
  } catch (e) { console.error('panelAudit', action, e.message); }
}

/* Full-table scans shared by the panel reads, cached in memory for
   60 s: the panel polls stats and lists, and a fresh full read per
   poll is exactly the load the background watchers were dieted
   off. The data layer paginates table reads, so a scan is exact. */
const PANEL_SCAN_MS = 60000;
let panelScan = { players: null, playersAt: 0, withdrawals: null, withdrawalsAt: 0 };
async function panelPlayersScan() {
  if (panelScan.players && Date.now() - panelScan.playersAt < PANEL_SCAN_MS) return panelScan.players;
  const obj = (await getVal(rtdb().ref('players'))) || {};
  const rows = Object.entries(obj).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => ({ ...v, id: String(v.id || k) }));
  panelScan.players = rows; panelScan.playersAt = Date.now();
  return rows;
}
async function panelWithdrawalsScan() {
  if (panelScan.withdrawals && Date.now() - panelScan.withdrawalsAt < PANEL_SCAN_MS) return panelScan.withdrawals;
  const obj = (await getVal(rtdb().ref('withdrawals'))) || {};
  const rows = Object.entries(obj).filter(([, v]) => v && typeof v === 'object').map(([docId, v]) => ({ docId, ...v }));
  panelScan.withdrawals = rows; panelScan.withdrawalsAt = Date.now();
  return rows;
}

/* Start of today in Africa/Cairo as a UTC ms timestamp. Egypt
   observes DST, so the offset is derived from Intl at the target
   date instead of being assumed fixed. */
function cairoOffsetMs(ts) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ts / 1000) * 1000;
}
function cairoStartOfTodayMs(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const y = g('year'), m = g('month'), d = g('day');
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const corrected = Date.UTC(y, m - 1, d) - cairoOffsetMs(guess);
    if (corrected === guess) break;
    guess = corrected;
  }
  return guess;
}

async function panelStats(c) {
  panelKey(c);
  const [players, wds] = await Promise.all([panelPlayersScan(), panelWithdrawalsScan()]);
  const startToday = cairoStartOfTodayMs();
  let verified = 0, banned = 0, newToday = 0, totalMined = 0;
  for (const p of players) {
    if (p.walletVerified === true) verified++;
    if (p.banned === true) banned++;
    if ((Number(p.createdAt) || 0) >= startToday) newToday++;
    totalMined += Number(p.mined) || 0;
  }
  let pending = 0, paidCount = 0, rejectedCount = 0;
  for (const w of wds) {
    const s = String(w.status || '');
    if (s.includes('Pending')) pending++;
    else if (s.includes('Paid')) paidCount++;
    else if (s.includes('Rejected')) rejectedCount++;
  }
  const h = await getVal(rtdb().ref('meta/verifyHealth'));
  const verify = h
    ? { openUnresolved: Number(h.openUnresolved) || 0, cursorLagSec: h.cursorUtime ? Math.max(0, Math.floor(Date.now() / 1000 - Number(h.cursorUtime))) : null, processedTotal: Number(h.processedTotal) || 0 }
    : { openUnresolved: 0, cursorLagSec: null, processedTotal: 0 };
  // Payout wallet balances: the same client calls initPayout makes.
  // Advisory only — any failure (or payouts disabled) reads null.
  let payout = null;
  if (payoutEnabled()) {
    try {
      const client = await getPayoutClient();
      const d = await jettonDecimals();
      payout = { ton: Number(await client.getTonBalance()) / 1e9, zom: Number(await client.getJettonBalance()) / Math.pow(10, d) };
    } catch (e) { payout = null; }
  }
  return {
    ok: true,
    players: { total: players.length, verified, banned, newToday, totalMined },
    withdrawals: { pending, paidCount, rejectedCount },
    verify, payout,
    serverTime: Date.now(), uptimeSec: Math.floor(process.uptime())
  };
}

function panelSlimPlayer(p) {
  return {
    id: String(p.id), userNo: Number(p.userNo) || 0, name: p.name || '', username: p.username || '',
    avatar: Number(p.avatar) || 0, mined: Number(p.mined) || 0, hold: Number(p.hold) || 0,
    walletAddr: p.walletAddr || '', walletVerified: p.walletVerified === true, banned: p.banned === true,
    createdAt: Number(p.createdAt) || 0, lastSeen: Number(p.lastSeen) || 0,
    invitedBy: p.invitedBy ? String(p.invitedBy) : null,
    refCount: Array.isArray(p.referrals) ? p.referrals.length : 0
  };
}

async function panelPlayers(c) {
  panelKey(c);
  const q = String(c.body.q ?? '').trim();
  let rows;
  if (q && /^\d+$/.test(q) && q.length >= 7) {
    // A long all-digits query is a Telegram id: one direct read.
    const p = await getVal(P(q));
    rows = p ? [{ ...p, id: String(p.id || q) }] : [];
  } else {
    const all = await panelPlayersScan();
    if (!q) rows = [...all].sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
    else if (/^\d+$/.test(q)) rows = all.filter((p) => Number(p.userNo) === Number(q)); // short digits: a userNo
    else {
      const needle = q.toLowerCase();
      rows = all.filter((p) => String(p.name || '').toLowerCase().includes(needle) || String(p.username || '').toLowerCase().includes(needle));
    }
  }
  const total = rows.length;
  const size = 50;
  const pages = Math.max(1, Math.ceil(total / size));
  let page = Math.floor(Number(c.body.page) || 0);
  if (!Number.isFinite(page) || page < 0) page = 0;
  if (page > pages - 1) page = pages - 1;
  return { ok: true, total, page, pages, rows: rows.slice(page * size, page * size + size).map(panelSlimPlayer) };
}

async function panelPlayer(c) {
  panelKey(c);
  if (!isId(c.body.id)) fail(400, 'Bad id');
  const id = String(c.body.id);
  const p = await getVal(P(id));
  if (!p) fail(404, 'User not found');
  const withdrawals = (await panelWithdrawalsScan())
    .filter((w) => String(w.userId) === id)
    .sort((a, b) => (Number(b.wdNum) || 0) - (Number(a.wdNum) || 0))
    .slice(0, 50);
  const vu = (await getVal(rtdb().ref('verifyUnresolved'))) || {};
  const verifyRecords = Object.entries(vu)
    .filter(([, e]) => e && Number(e.userNo) === Number(p.userNo))
    .map(([hash, e]) => ({ hash, ...e }))
    .sort((a, b) => (Number(b.utime) || Number(b.firstSeenAt) || 0) - (Number(a.utime) || Number(a.firstSeenAt) || 0))
    .slice(0, 50);
  let risk = null;
  try { risk = await riskOf(id); } catch (e) { risk = null; }
  let inviter = null;
  if (p.invitedBy) {
    const inv = await getVal(P(p.invitedBy));
    if (inv) inviter = { id: String(inv.id || p.invitedBy), userNo: Number(inv.userNo) || 0, name: inv.name || '', username: inv.username || '' };
  }
  return { ok: true, player: p, withdrawals, verifyRecords, risk, inviter };
}

async function panelBan(c) {
  panelKey(c);
  if (!isId(c.body.id)) fail(400, 'Bad id');
  const ref = P(c.body.id);
  if ((await getVal(ref)) === null) fail(404, 'User not found');
  const banned = c.body.banned === true;
  await ref.update({ banned });
  await panelAudit('panelBan', c.body.id, banned ? 'banned' : 'unbanned');
  return { ok: true, banned };
}

async function panelAdjust(c) {
  panelKey(c);
  const amt = Number(c.body.amount);
  // Same bounds as adminAdjust: an unbounded value would make
  // `mined` un-storable (Infinity) and fail writes later.
  if (!isId(c.body.id) || !Number.isFinite(amt) || Math.abs(amt) > 1e12) fail(400, 'Bad input');
  const ref = P(c.body.id);
  const before = await getVal(ref);
  if (before === null) fail(404, 'User not found');
  await ref.update({ mined: admin.database.ServerValue.increment(amt) });
  const after = await getVal(ref);
  const mined = Number(after && after.mined) || 0;
  await panelAudit('panelAdjust', c.body.id, 'amount ' + amt + ': mined ' + (Number(before.mined) || 0) + ' -> ' + mined);
  return { ok: true, mined };
}

async function panelResetPlayer(c) {
  panelKey(c);
  if (!isId(c.body.id)) fail(400, 'Bad id');
  const ref = P(c.body.id);
  const before = await getVal(ref);
  if (before === null) fail(404, 'User not found');
  // Full progress reset (owner order): zero every earnings/progress field.
  // Identity, wallet binding + verification, referral links, device data
  // and the ban state are kept exactly as they are — the account stays in
  // the game, it just starts over from zero.
  const patch = {
    mined: 0, hold: 0, lastCollectTime: Date.now(),
    refBonusPaid: false, refCommissionEarned: 0, pendingRefComm: 0, lastWithdrawTime: 0, adsWatched: 0,
    earnMining: 0, earnDaily: 0, earnTasks: 0, earnRef: 0,
    lastAdUtcDay: 0, adsDay: 0, adsDayCount: 0,
    task1Done: false, task2Done: false, task3Done: false, task1At: 0, task2At: 0, task3At: 0,
    taskXDone: false, taskXAt: 0, taskXVisitAt: 0,
    holdTaskAt: {}, refAchClaimed: {}, bioTaskDone: false, dailyStreak: 0, lastDailyCheckIn: 0,
    lastBountyAt: 0, holdCheckedAt: 0
  };
  await ref.update(patch);
  await panelAudit('panelResetPlayer', c.body.id, 'full reset: mined ' + (Number(before.mined) || 0) + ' -> 0, earnMining ' + (Number(before.earnMining) || 0) + ' -> 0, earnTasks ' + (Number(before.earnTasks) || 0) + ' -> 0');
  const after = await getVal(ref);
  return { ok: true, mined: Number(after && after.mined) || 0, earnMining: Number(after && after.earnMining) || 0 };
}

// --- Contest announcement broadcast (owner order 2026-11-24) ---
// Sends the owner-approved contest message to every player via DIRECT
// Telegram calls — deliberately NOT through tg()/tgPaced: the paced chain
// serializes all bot DMs, so 13k broadcast sends queued there would delay
// verification and payout DMs for hours. One-shot: the meta/contestBroadcast
// doc latches startedAt/finishedAt, so the panel action can never
// double-send. Progress is written to the same doc for panelBroadcastStatus.
const CONTEST_BROADCAST_TEXT = [
  '🏆 <b>$250 HOLDERS CONTEST IS LIVE!</b> 🏆',
  '',
  'The race for the biggest ZOM bags has begun, zombies! 🧟',
  '',
  '🥇 1st — $70',
  '🥈 2nd — $50',
  '🥉 3rd — $40',
  '🎖 Ranks 4–7 — $15 each',
  '🎖 Ranks 8–10 — $10 each',
  '💵 Ranks 11–50 — $1 each',
  '',
  "⚠️ Only ZOM you buy <b>after the contest start</b> counts toward your rank — your old bag doesn't.",
  '💰 Prizes are paid in <b>USDT</b> straight to your linked wallet.',
  '⏳ Ends <b>Sunday, Nov 29 at 20:28</b> (Cairo time).',
  '',
  'Verified wallets only. Open the app → <b>Contest</b> tab and start climbing! 🚀',
].join('\n');
const CONTEST_BROADCAST_MARKUP = { inline_keyboard: [[{ text: '🏆 Open the Contest', web_app: { url: 'https://zombie-mine.vercel.app/' } }]] };
let contestBroadcastRunning = false;
async function contestBroadcastSend(chatId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(TG_API_BASE + '/bot' + BOT_TOKEN + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: CONTEST_BROADCAST_TEXT, parse_mode: 'HTML', reply_markup: CONTEST_BROADCAST_MARKUP }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) return 'ok';
      if (r.status === 429 || (j.parameters && j.parameters.retry_after)) { await new Promise((res) => setTimeout(res, ((j.parameters && j.parameters.retry_after) || 5) * 1000)); continue; }
      if (r.status === 403) return 'blocked';
      return 'fail';
    } catch (e) { await new Promise((res) => setTimeout(res, 2000)); }
  }
  return 'fail';
}
async function runContestBroadcast() {
  contestBroadcastRunning = true;
  const metaRef = rtdb().ref('meta/contestBroadcast');
  try {
    const players = (await getVal(rtdb().ref('players'))) || {};
    const ids = Object.keys(players).filter((id) => /^\d{5,15}$/.test(id));
    await metaRef.update({ total: ids.length });
    let ok = 0, blocked = 0, failCount = 0, done = 0, idx = 0;
    async function worker() {
      while (idx < ids.length) {
        const id = ids[idx++];
        const res = await contestBroadcastSend(id);
        if (res === 'ok') ok++; else if (res === 'blocked') blocked++; else failCount++;
        done++;
        if (done % 500 === 0) { try { await metaRef.update({ done, ok, blocked, fail: failCount }); } catch (e) {} }
        await new Promise((res) => setTimeout(res, 40));
      }
    }
    await Promise.all(Array.from({ length: 10 }, worker));
    await metaRef.update({ done, ok, blocked, fail: failCount, finishedAt: Date.now() });
    console.log('[broadcast] contest announcement done: total=' + ids.length + ' ok=' + ok + ' blocked=' + blocked + ' fail=' + failCount);
  } catch (e) {
    try { await metaRef.update({ error: String(e && e.message || e), finishedAt: Date.now() }); } catch (e2) {}
    console.log('[broadcast] contest announcement FAILED: ' + (e && e.message));
  } finally { contestBroadcastRunning = false; }
}
async function panelBroadcastContest(c) {
  panelKey(c);
  const meta = (await getVal(rtdb().ref('meta/contestBroadcast'))) || {};
  if (contestBroadcastRunning || meta.startedAt) fail(409, 'Contest broadcast already ' + (meta.finishedAt ? 'sent' : 'running'));
  await rtdb().ref('meta/contestBroadcast').set({ startedAt: Date.now(), done: 0, ok: 0, blocked: 0, fail: 0 });
  await panelAudit('panelBroadcastContest', 'all players', 'contest announcement broadcast started');
  runContestBroadcast().catch(() => {});
  return { ok: true, started: true };
}
async function panelBroadcastStatus(c) {
  panelKey(c);
  const meta = (await getVal(rtdb().ref('meta/contestBroadcast'))) || {};
  return { ok: true, running: contestBroadcastRunning, startedAt: meta.startedAt || 0, finishedAt: meta.finishedAt || 0, total: meta.total || 0, done: meta.done || 0, okCount: meta.ok || 0, blocked: meta.blocked || 0, fail: meta.fail || 0 };
}

async function panelSetAvatar(c) {
  panelKey(c);
  if (!isId(c.body.id)) fail(400, 'Bad id');
  const avatar = Number(c.body.avatar);
  if (!Number.isInteger(avatar) || avatar < 0 || avatar > 8) fail(400, 'Bad avatar');
  const ref = P(c.body.id);
  if ((await getVal(ref)) === null) fail(404, 'User not found');
  await ref.update({ avatar });
  await panelAudit('panelSetAvatar', c.body.id, 'avatar -> ' + avatar);
  return { ok: true, avatar };
}

/* Shared panel verification: the panel's guards (exists / not
   banned / wallet bound / not already verified for the bound
   wallet), then the ONE shared completion path — completeVerification
   claims the hash, flips the player, updates the wallets registry,
   syncs the referral flags and sends the success DM exactly once.
   On a win the player's open verifyUnresolved records are closed
   out as resolved-by-panel. */
async function panelDoVerify(id, hash, cfg) {
  const p = await getVal(P(id));
  if (!p) fail(404, 'User not found');
  if (p.banned === true) fail(403, 'Account banned');
  const wallet = p.walletAddr || '';
  if (!wallet) fail(400, 'Connect wallet first');
  if (p.walletVerified === true && p.verifiedWallet === wallet) return { won: false, reason: 'already' };
  const res = await completeVerification(String(id), hash, cfg);
  if (res.won) {
    try {
      const vu = (await getVal(rtdb().ref('verifyUnresolved'))) || {};
      for (const [h, e] of Object.entries(vu)) {
        if (e && e.status === 'open' && Number(e.userNo) === Number(p.userNo)) {
          await rtdb().ref('verifyUnresolved/' + h).update({ status: 'resolved', resolvedAt: Date.now(), resolvedBy: 'panel' });
        }
      }
    } catch (e) { console.error('panel verify close-out', id, e.message); }
  }
  return res;
}

async function panelVerifyPlayer(c) {
  panelKey(c);
  if (!isId(c.body.id)) fail(400, 'Bad id');
  const id = String(c.body.id);
  const p = await getVal(P(id));
  if (!p) fail(404, 'User not found');
  let hash = String(c.body.hash || '').trim();
  if (hash && !/^[A-Za-z0-9_-]+$/.test(hash)) fail(400, 'Bad hash'); // the hash becomes a path segment — never let it traverse
  if (!hash) hash = String(p.lastVerifyTx || '') || ('manual-' + Date.now());
  const res = await panelDoVerify(id, hash, c.cfg);
  await panelAudit('panelVerifyPlayer', id, 'hash ' + hash + ' -> ' + (res.won ? 'verified' : 'not won (' + (res.reason || '?') + ')'));
  return { ok: true, won: !!res.won, ...(res.reason ? { reason: res.reason } : {}), tx: hash };
}

async function panelWithdrawals(c) {
  panelKey(c);
  const f = String(c.body.status ?? 'pending');
  if (!['pending', 'paid', 'rejected', 'all'].includes(f)) fail(400, 'Bad status');
  let rows = [...(await panelWithdrawalsScan())].sort((a, b) => (Number(b.wdNum) || 0) - (Number(a.wdNum) || 0));
  if (f !== 'all') {
    const want = f === 'pending' ? 'Pending' : f === 'paid' ? 'Paid' : 'Rejected';
    rows = rows.filter((w) => String(w.status || '').includes(want));
  }
  rows = rows.slice(0, 100);
  // Verified badges, adminState's pattern: one bounded lookup per
  // distinct user on the page (from the players scan where possible).
  const players = await panelPlayersScan();
  const byId = new Map(players.map((p) => [String(p.id), p]));
  const seen = new Map();
  await Promise.all([...new Set(rows.map((x) => String(x.userId)))].map(async (id) => {
    let src = byId.get(id);
    if (!src) { try { src = await getVal(P(id)); } catch (e) { src = null; } }
    seen.set(id, !!(src && src.walletVerified === true));
  }));
  rows.forEach((x) => { x.userVerified = seen.get(String(x.userId)) === true; });
  return { ok: true, rows };
}

function panelWdNum(c) {
  const num = Math.floor(Number(c.body.wdNum));
  if (!Number.isFinite(num) || num <= 0) fail(400, 'Bad wdNum');
  return num;
}

async function panelWdApprove(c) {
  panelKey(c);
  const num = panelWdNum(c);
  const ref = rtdb().ref('withdrawals/wd_' + num);
  const wd = await getVal(ref);
  if (!wd) fail(404, 'Not found');
  if (wd.status !== 'Pending ⏳') fail(400, 'Already processed');
  if (wd.payoutState === 'paying' || wd.payoutState === 'paid') fail(400, 'Already processed');
  // The payout state machine does the money movement — nothing
  // hand-rolled here. It never throws its failures: they land on
  // the record as payoutState 'failed' + payoutError, read back
  // below and reported as-is.
  await attemptPayout(num);
  const fin = (await getVal(ref)) || {};
  await panelAudit('panelWdApprove', 'wd_' + num, 'status ' + (fin.status || '?') + ', payoutState ' + (fin.payoutState || 'none') + (fin.payoutError ? ', error ' + fin.payoutError : ''));
  return { ok: true, status: fin.status || null, payoutState: fin.payoutState || null, payoutTx: fin.payoutTx || '', ...(fin.payoutError ? { payoutError: fin.payoutError } : {}) };
}

/* The bot-callback decision flip, shared by panel reject/ban:
   atomically Pending -> Rejected with decidedAt, NO refund ever
   (the owner's explicit order — the deducted coins stay deducted). */
async function panelFlipReject(num) {
  const ref = rtdb().ref('withdrawals/wd_' + num);
  const wd = await getVal(ref);
  if (!wd) fail(404, 'Not found');
  const flip = await txUpdate(ref, (x) => {
    if (x === null) return { skip: true, out: null };
    if (x.status !== 'Pending ⏳') return { skip: true, out: null };
    return { value: { ...x, status: 'Rejected ❌', decidedAt: Date.now() }, out: x };
  });
  if (!flip) fail(400, 'Already processed');
  return flip;
}

async function panelWdReject(c) {
  panelKey(c);
  const num = panelWdNum(c);
  const wd = await panelFlipReject(num);
  await panelAudit('panelWdReject', 'wd_' + num, 'rejected ' + (wd.amt ?? '') + ' for user ' + (wd.userId ?? '') + ' (no refund)');
  return { ok: true, status: 'Rejected ❌' };
}

async function panelWdBan(c) {
  panelKey(c);
  const num = panelWdNum(c);
  const wd = await panelFlipReject(num);
  // The flip is committed first; the ban follows it, exactly like
  // the bot flow (a ban-write failure is logged, never un-flips).
  try {
    const pref = P(wd.userId);
    if ((await getVal(pref)) !== null) await pref.update({ banned: true });
  } catch (e) { console.error('panel wd ban', num, e.message); }
  await panelAudit('panelWdBan', 'wd_' + num, 'rejected + banned user ' + (wd.userId ?? '') + ' (no refund)');
  return { ok: true, status: 'Rejected ❌', banned: true };
}

async function panelVerifyQueue(c) {
  panelKey(c);
  const vu = (await getVal(rtdb().ref('verifyUnresolved'))) || {};
  const players = await panelPlayersScan();
  const byId = new Map(players.map((p) => [String(p.id), p]));
  const byUserNo = new Map(players.map((p) => [Number(p.userNo) || 0, p]));
  const entries = Object.entries(vu)
    .filter(([, e]) => e && e.status === 'open')
    .sort((a, b) => (Number(b[1].utime) || Number(b[1].firstSeenAt) || 0) - (Number(a[1].utime) || Number(a[1].firstSeenAt) || 0))
    .slice(0, 200);
  const rows = [];
  for (const [hash, e] of entries) {
    let player = null;
    if (e.uid && byId.has(String(e.uid))) player = byId.get(String(e.uid));
    else if (e.uid) { try { const p = await getVal(P(e.uid)); if (p) player = { ...p, id: String(p.id || e.uid) }; } catch (err) { player = null; } }
    if (!player && byUserNo.has(Number(e.userNo))) player = byUserNo.get(Number(e.userNo));
    rows.push({
      hash, userNo: Number(e.userNo) || 0, uid: e.uid ? String(e.uid) : null,
      source: e.source || '', valueNano: e.valueNano ?? '', utime: Number(e.utime) || 0,
      reason: e.reason || '', checks: Number(e.checks) || 0,
      player: player ? { id: String(player.id), name: player.name || '', username: player.username || '', walletAddr: player.walletAddr || '', walletVerified: player.walletVerified === true } : null
    });
  }
  return { ok: true, rows };
}

async function panelVerifyResolve(c) {
  panelKey(c);
  const hash = String(c.body.hash || '').trim();
  if (!hash || !/^[A-Za-z0-9_-]+$/.test(hash)) fail(400, 'Bad hash');
  const rec = await getVal(rtdb().ref('verifyUnresolved/' + hash));
  if (!rec) fail(404, 'Not found');
  if (rec.status !== 'open') fail(400, 'Already resolved');
  let id = rec.uid ? String(rec.uid) : '';
  if (!id) {
    const rows = await panelPlayersScan();
    const p = rows.find((r) => Number(r.userNo) === Number(rec.userNo));
    if (p) id = String(p.id);
  }
  if (!id) fail(404, 'Player not found');
  const res = await panelDoVerify(id, hash, c.cfg);
  await panelAudit('panelVerifyResolve', id, 'hash ' + hash + ' -> ' + (res.won ? 'verified' : 'not won (' + (res.reason || '?') + ')'));
  return { ok: true, won: !!res.won, ...(res.reason ? { reason: res.reason } : {}), tx: hash };
}

async function panelConfigGet(c) {
  panelKey(c);
  const stored = (await getVal(rtdb().ref('settings/global'))) || {};
  return { ok: true, config: c.cfg, stored };
}

async function panelConfigSet(c) {
  panelKey(c);
  const s = c.body.settings;
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail(400, 'Bad settings');
  const out = {};
  // adminSettings' whitelist + validation, mirrored exactly...
  for (const k of NUM_KEYS) if (s[k] !== undefined) { const v = Number(s[k]); if (!Number.isFinite(v) || v < 0 || v > 1e12) fail(400, 'Bad ' + k); if ((k === 'withdrawFeePercent' || k === 'holdPercentReq') && v > 100) fail(400, 'Bad ' + k); out[k] = v; }
  for (const k of STR_KEYS) if (s[k] !== undefined) out[k] = clean(s[k], 300);
  // Contest window timestamps are epoch milliseconds (~1.8e12), above the
  // generic NUM_KEYS cap of 1e12 — they validate against their own cap.
  for (const k of ['contestStartsAt', 'contestEndsAt']) if (s[k] !== undefined) { const v = Number(s[k]); if (!Number.isFinite(v) || v < 0 || v > 1e14) fail(400, 'Bad ' + k); out[k] = v; }
  // ...plus the panel-only keys.
  if (s.holdTaskDefs !== undefined) {
    const defs = s.holdTaskDefs;
    if (!Array.isArray(defs) || defs.length < 1 || defs.length > 10) fail(400, 'Bad holdTaskDefs');
    let prev = 0;
    out.holdTaskDefs = defs.map((t) => {
      const hold = Number(t && t.hold), reward = Number(t && t.reward);
      if (!Number.isFinite(hold) || !Number.isFinite(reward) || hold <= 0 || reward <= 0) fail(400, 'Bad holdTaskDefs');
      if (hold <= prev) fail(400, 'Bad holdTaskDefs'); // holds must strictly increase tier over tier
      prev = hold;
      return { hold, reward };
    });
  }
  if (s.adminUsers !== undefined) {
    if (!Array.isArray(s.adminUsers) || s.adminUsers.length > 20) fail(400, 'Bad adminUsers');
    out.adminUsers = s.adminUsers.map((x) => {
      const v = String(x);
      if (!/^\d{5,15}$/.test(v)) fail(400, 'Bad adminUsers');
      return v;
    });
  }
  if (s.ownerOnly !== undefined) {
    if (typeof s.ownerOnly !== 'boolean') fail(400, 'Bad ownerOnly');
    out.ownerOnly = s.ownerOnly;
  }
  // ONLY the provided (and validated) keys are written — an unknown
  // key in the request is ignored, never stored.
  if (Object.keys(out).length) {
    await rtdb().ref('settings/global').update(out);
    cfgCache = null;
  }
  await panelAudit('panelConfigSet', 'settings/global', JSON.stringify(out));
  return { ok: true, applied: Object.keys(out) };
}

async function panelRequestAdd(c) {
  panelKey(c);
  const text = cleanText(c.body.text, 1000).trim();
  if (!text) fail(400, 'Empty text');
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await txUpdate(rtdb().ref('meta/panelRequests'), (cur) => {
    const doc = (cur && typeof cur === 'object') ? cur : {};
    const items = (doc.items && typeof doc.items === 'object') ? doc.items : {};
    return { value: { ...doc, items: { ...items, [id]: { text, at: Date.now(), status: 'new', reply: null, repliedAt: 0 } } }, out: id };
  });
  return { ok: true, id };
}

async function panelRequestList(c) {
  panelKey(c);
  const doc = (await getVal(rtdb().ref('meta/panelRequests'))) || {};
  const items = (doc.items && typeof doc.items === 'object') ? doc.items : {};
  const rows = Object.entries(items)
    .map(([id, e]) => ({ id, text: (e && e.text) || '', at: Number(e && e.at) || 0, status: (e && e.status) || 'new', reply: (e && e.reply) ?? null, repliedAt: Number(e && e.repliedAt) || 0 }))
    .sort((a, b) => b.at - a.at)
    .slice(0, 100);
  return { ok: true, rows };
}

async function panelRequestReply(c) {
  panelKey(c);
  const reply = cleanText(c.body.reply, 2000).trim();
  if (!reply) fail(400, 'Empty reply');
  const id = String(c.body.id || '');
  await txUpdate(rtdb().ref('meta/panelRequests'), (cur) => {
    const doc = (cur && typeof cur === 'object') ? cur : null;
    if (!doc || !doc.items || !doc.items[id]) return { error: new Fail(404, 'Not found') };
    return { value: { ...doc, items: { ...doc.items, [id]: { ...doc.items[id], status: 'done', reply, repliedAt: Date.now() } } }, out: true };
  });
  return { ok: true };
}

async function panelAuditList(c) {
  panelKey(c);
  const doc = (await getVal(rtdb().ref('meta/panelAudit'))) || {};
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  return { ok: true, rows: [...entries].reverse().slice(0, 200) };
}


// ZOMBIE (owner order 2026-11-21): fetch a custom-emoji pack's stickers
// (underlying emoji + custom_emoji_id + thumbnail) so the owner-chosen
// zombie packs can replace the old Viking premium packs in PREMIUM_EMOJI.
async function panelEmojiPack(c) {
  panelKey(c);
  const name = String(c.body.name || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) fail(400, 'Bad pack name');
  const r = await tg('getStickerSet', { name });
  const set = r && r.stickers ? r : (r && r.result ? r.result : null);
  if (!set || !Array.isArray(set.stickers)) fail(404, 'Pack not found');
  const out = [];
  for (const st of set.stickers) {
    let thumb = '';
    const fid = (st.thumbnail && st.thumbnail.file_id) || st.file_id;
    try {
      const fr = await tg('getFile', { file_id: fid });
      const fp = fr && fr.file_path ? fr.file_path : (fr && fr.result ? fr.result.file_path : null);
      if (fp && BOT_TOKEN) {
        const resp = await fetch('https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + fp);
        if (resp.ok) thumb = Buffer.from(await resp.arrayBuffer()).toString('base64');
      }
    } catch (e) { /* thumbnail is best-effort */ }
    out.push({ e: st.emoji || '', id: st.custom_emoji_id || '', thumb });
  }
  return { ok: true, title: set.title || '', stickerType: set.sticker_type || '', count: out.length, stickers: out };
}

// ZOMBIE (owner order 2026-11-21): send the owner ONE sample bot message
// using the mapped chars, so the zombie premium-emoji set can be eyeballed
// in a real chat before/after any mapping change.
async function panelEmojiTest(c) {
  panelKey(c);
  const text = '🧟 <b>ZOMBIE MINER</b> — premium emoji test\n'
    + '🪦 Digging: ✅ active ❌ paused\n'
    + '💀 King of the Dead 👑\n'
    + '⚰️ Verified 🛡️ 🦴 buried coins 💰\n'
    + '👇 Tap below 👍 🌙 🔥 👻 🎉';
  const rm = { inline_keyboard: [[
    { text: '🧟 Open ZOM', url: 'https://t.me/ZOMBIE_MINER_bot/app' },
    { text: '💀 Payouts', url: 'https://t.me/ZOMBI_PAYMENTS' },
    { text: '🦇 News', url: 'https://t.me/ZOMBI_UPDATE' },
  ]] };
  const r = await tg('sendMessage', { chat_id: OWNER_ID, text, reply_markup: rm });
  const ok = !!(r && (r.ok === true || r.message_id || (r.result && r.result.message_id)));
  return { ok: true, sent: ok };
}
/* ================= BOUNTY (owner order 2026-11-22) =================
   The Bounty page's server phase: players submit requests from the
   app (bountySubmit, one per 24 h, stamped on the player doc), the
   owner reviews them in the panel's Bounty tab (panelBountyList —
   each request carries the submitter's referral totals: how many
   referrals, how many verified, and the summed ZOM hold across the
   referrals' wallets), and approval pays the reward for real from
   the payout wallet (attemptBountyPayout — the same claim → balance
   gate → broadcast → resolve-tx state machine shape as
   attemptPayout) with the on-chain comment the owner fixed:
   «bounty from ZOMBIE_MINER_bot». A paid bounty celebrates exactly
   like a paid withdrawal — a DM to the player and a public post in
   the payouts channel — but with its own dedicated banner
   (BOUNTY_BANNER) and wording. Rejection moves no money. */
const BOUNTY_COMMENT = 'bounty from ZOMBIE_MINER_bot';
const BOUNTY_MIN = 500, BOUNTY_MAX = 20000, BOUNTY_CD_MS = 24 * 3600000;
const BOUNTY_BANNER = 'https://zombie-mine.vercel.app/bounty-payout-banner.webp?v=1';


/* Bounty post-age + duplicate gate (owner order 2026-11-22): a bounty post
   must be at least 12 hours old, and a post link that was submitted before
   can never be submitted again. Telegram public posts are dated from the
   channel's public web preview (t.me/s/<chan>/<id> carries a datetime per
   message; album items resolve to the first block at or after the id, which
   errs YOUNGER — the safe direction). X posts are dated exactly from the
   snowflake id. Private links and fetch failures resolve as unknown: the
   submit is allowed but flagged postAgeUnknown for manual review. */
const BOUNTY_MIN_AGE_MS = 12 * 3600000;
function bountyLinkKey(link) {
  const raw = String(link || '').trim();
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    if (host === 't.me' || host === 'telegram.me') {
      const pc = path.match(/^\/c\/(\d+)\/(\d+)$/);
      if (pc) return 'tg:c/' + pc[1] + '/' + pc[2];
      const m = path.match(/^\/([^/]+)\/(\d+)$/);
      if (m) return 'tg:' + m[1].toLowerCase() + '/' + m[2];
      return 'tg:' + path.toLowerCase();
    }
    if (host === 'x.com' || host === 'twitter.com') {
      const m = path.match(/^\/([^/]+)\/status\/(\d+)$/);
      if (m) return 'x:' + m[2];
      return 'x:' + path.toLowerCase();
    }
    if (host === 'youtu.be') { const id = path.slice(1).split('/')[0]; if (id) return 'yt:' + id; }
    if (host.endsWith('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return 'yt:' + v;
      const m = path.match(/^\/(?:shorts|live)\/([^/]+)$/);
      if (m) return 'yt:' + m[1];
    }
    return host + path;
  } catch (e) { return raw.toLowerCase(); }
}

async function bountyPostTime(link) {
  const raw = String(link || '').trim();
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' };
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'x.com' || host === 'twitter.com') {
      const m = u.pathname.match(/\/status\/(\d+)$/);
      if (m) { const ms = Number((BigInt(m[1]) >> 22n) + 1288834974657n); if (ms > 0) return { postedAt: ms }; }
      return { unknown: true };
    }
    if (host === 't.me' || host === 'telegram.me') {
      const m = u.pathname.match(/^\/([^/]+)\/(\d+)$/);
      if (!m || m[1] === 'c') return { unknown: true };
      const target = parseInt(m[2], 10);
      const res = await fetch('https://t.me/s/' + encodeURIComponent(m[1]) + '/' + target, { headers: UA, signal: AbortSignal.timeout(9000) });
      if (!res.ok) return { unknown: true };
      const html = await res.text();
      const re = /data-post="[^"/]+\/(\d+)"[\s\S]{0,8000}?datetime="([^"]+)"/g;
      let best = null, mm;
      while ((mm = re.exec(html))) {
        const id = parseInt(mm[1], 10), t = Date.parse(mm[2]);
        if (!t) continue;
        if (id === target) return { postedAt: t };
        if (id > target && (!best || id < best.id)) best = { id, t };
      }
      if (best) return { postedAt: best.t };
      return { unknown: true };
    }
    if (host === 'youtu.be' || host.endsWith('youtube.com')) {
      const res = await fetch(raw, { headers: UA, signal: AbortSignal.timeout(9000) });
      if (!res.ok) return { unknown: true };
      const html = await res.text();
      const m = html.match(/"publishDate":"([^"]+)"/) || html.match(/itemprop="datePublished" content="([^"]+)"/);
      if (m) { const t = Date.parse(m[1]); if (t) return { postedAt: t }; }
      return { unknown: true };
    }
  } catch (e) { /* fall through to unknown */ }
  return { unknown: true };
}

async function bountyCheck(link) {
  const key = bountyLinkKey(link);
  const all = await bountyScan();
  const dup = all.find((r) => (r.linkKey || bountyLinkKey(r.link)) === key);
  const pt = await bountyPostTime(link);
  const out = { ok: true, duplicate: !!dup, dupBn: dup ? dup.bnNum : 0, postedAt: pt.postedAt || 0, ageUnknown: !!pt.unknown, tooYoung: false, waitMs: 0, ageMs: 0 };
  if (pt.postedAt) {
    out.ageMs = Math.max(0, Date.now() - pt.postedAt);
    out.tooYoung = out.ageMs < BOUNTY_MIN_AGE_MS;
    out.waitMs = out.tooYoung ? BOUNTY_MIN_AGE_MS - out.ageMs : 0;
  }
  return out;
}

async function bountyCheckLink(c) {
  const link = String((c.body && c.body.link) || '').trim();
  if (!/^https?:\/\//i.test(link)) throw new Fail(400, 'Invalid link');
  return bountyCheck(link);
}

let bountyScanCache = { rows: null, at: 0 };
async function bountyScan() {
  if (bountyScanCache.rows && Date.now() - bountyScanCache.at < PANEL_SCAN_MS) return bountyScanCache.rows;
  const obj = (await getVal(rtdb().ref('bountyRequests'))) || {};
  const rows = Object.entries(obj).filter(([, v]) => v && typeof v === 'object').map(([docId, v]) => ({ docId, ...v }));
  bountyScanCache = { rows, at: Date.now() };
  return rows;
}
function bountyInvalidate() { bountyScanCache = { rows: null, at: 0 }; }

async function bountySubmit(c) {
  const ref = await ensurePlayer(c);
  const uid = String(c.user.id);
  const type = String(c.body.type || '') === 'Post' ? 'Post' : 'Video';
  const platform = ['Telegram', 'Twitter (X)', 'YouTube'].includes(String(c.body.platform || '')) ? String(c.body.platform) : 'Telegram';
  const link = String(c.body.link || '').trim().slice(0, 500);
  const channel = String(c.body.channel || '').trim().slice(0, 120);
  if (!/^https?:\/\/.+/i.test(link)) fail(400, 'Paste a valid post link first');
  const chk = await bountyCheck(link);
  if (chk.duplicate) fail(400, 'This post link was already submitted before');
  if (chk.tooYoung) fail(400, 'This post is too new — a bounty post must be at least 12 hours old. Wait for the 12 hours to pass and submit it again');
  const now = Date.now();
  // Banned gate + the 24 h cooldown, claimed atomically on the
  // player doc so two racing submits cannot both slip through.
  await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    if (d.banned === true) return { error: new Fail(403, 'Account banned') };
    if (d.lastBountyAt && now - Number(d.lastBountyAt) < BOUNTY_CD_MS) return { error: new Fail(400, 'One bounty request every 24 hours') };
    return { value: { ...d, lastBountyAt: now }, out: true };
  });
  const p = (await getVal(P(uid))) || {};
  const num = await txUpdate(rtdb().ref('meta/bountySeq'), (cur) => {
    const n = (Number(cur && cur.n) || 0) + 1;
    return { value: { n }, out: n };
  });
  const doc = {
    bnNum: num, userId: uid, userNo: Number(p.userNo) || 0,
    userName: p.name || '', username: p.username || '',
    type, platform, link, channel,
    linkKey: bountyLinkKey(link), postedAt: chk.postedAt || 0, postAgeUnknown: !!chk.ageUnknown,
    status: 'Pending ⏳', payState: 'none', reward: 0, payTx: '',
    createdAt: now, decidedAt: 0
  };
  await txUpdate(rtdb().ref('bountyRequests/bn_' + num), () => ({ value: doc, out: true }));
  bountyInvalidate();
  return { ok: true, bnNum: num, status: doc.status };
}

async function bountyMine(c) {
  await ensurePlayer(c);
  const uid = String(c.user.id);
  const p = (await getVal(P(uid))) || {};
  const rows = (await bountyScan())
    .filter((r) => String(r.userId) === uid)
    .sort((a, b) => (Number(b.bnNum) || 0) - (Number(a.bnNum) || 0))
    .slice(0, 20)
    .map((r) => ({ bnNum: r.bnNum, type: r.type, platform: r.platform, link: r.link, channel: r.channel || '', status: r.status, reward: Number(r.reward) || 0, payTx: r.payTx || '', createdAt: Number(r.createdAt) || 0 }));
  return { ok: true, rows, lastBountyAt: Number(p.lastBountyAt) || 0 };
}

/* One-time migration of pre-server bounty requests (owner order
   2026-11-22): before the server phase, submissions lived only in
   the app's local storage on each player's own device. The app now
   uploads those old entries once (bountyImport) so they land here
   as normal requests — original date kept, flagged imported, and
   deduped by link against everything the player already has on
   the server, so a re-run can never duplicate one. The channel is
   derived from the link the same way the app's confirm modal did,
   because the old local entries never stored it. */
function bountyDeriveChannel(link, platform) {
  const s = String(link || '');
  let m = s.match(/t\.me\/([A-Za-z0-9_]+)\/\d+/i);
  if (m) return '@' + m[1];
  if (/t\.me\/c\//i.test(s)) return 'Private channel';
  m = s.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)\/status\//i);
  if (m) return '@' + m[1];
  return platform === 'Telegram' ? '' : String(platform || '');
}

async function bountyImport(c) {
  const ref = await ensurePlayer(c);
  const uid = String(c.user.id);
  const p0 = (await getVal(P(uid))) || {};
  if (p0.banned === true) fail(403, 'Account banned');
  if (p0.bountyImportedAt) return { ok: true, imported: 0, skipped: 0, already: true };
  const items = Array.isArray(c.body.items) ? c.body.items.slice(0, 20) : [];
  const mine = (await bountyScan()).filter((r) => String(r.userId) === uid);
  const seen = new Set(mine.map((r) => r.linkKey || bountyLinkKey(r.link)));
  const now = Date.now();
  let imported = 0, skipped = 0;
  for (const it of items) {
    const link = String((it && it.link) || '').trim().slice(0, 500);
    const lk = bountyLinkKey(link);
    if (!/^https?:\/\/.+/i.test(link) || seen.has(lk)) { skipped++; continue; }
    seen.add(lk);
    const type = String(it.type || '') === 'Post' ? 'Post' : 'Video';
    const platform = ['Telegram', 'Twitter (X)', 'YouTube'].includes(String(it.platform || '')) ? String(it.platform) : 'Telegram';
    const ts = Number(it.ts) || 0;
    const createdAt = ts > now - 30 * 86400000 && ts <= now ? ts : now;
    const num = await txUpdate(rtdb().ref('meta/bountySeq'), (cur) => {
      const n = (Number(cur && cur.n) || 0) + 1;
      return { value: { n }, out: n };
    });
    const doc = {
      bnNum: num, userId: uid, userNo: Number(p0.userNo) || 0,
      userName: p0.name || '', username: p0.username || '',
      type, platform, link, linkKey: lk, channel: bountyDeriveChannel(link, platform),
      status: 'Pending \u23f3', payState: 'none', reward: 0, payTx: '',
      createdAt, decidedAt: 0, imported: true
    };
    await txUpdate(rtdb().ref('bountyRequests/bn_' + num), () => ({ value: doc, out: true }));
    imported++;
  }
  if (imported) bountyInvalidate();
  await txUpdate(ref, (d) => {
    if (d === null) return { error: new Fail(404, 'User not found') };
    return { value: { ...d, bountyImportedAt: now }, out: true };
  });
  return { ok: true, imported, skipped };
}

/* The submitter's referral totals for the panel: how many referrals
   in total, how many of them verified, and the summed stored hold
   across every referral's own player record (Zombie judges hold on
   current balance, and the stored hold is the last wallet sync). */
function bountyRefStats(p, byId) {
  const refs = (p && Array.isArray(p.referrals)) ? p.referrals : [];
  let verified = 0, hold = 0;
  for (const r of refs) {
    if (!r) continue;
    if (r.verified === true || String(r.status || '').trim() === ACTIVE_REF_STATUS) verified++;
    const rp = byId.get(String(r.id));
    if (rp) hold += Number(rp.hold) || 0;
  }
  return { refsTotal: refs.length, refsVerified: verified, refsHold: hold };
}

async function panelBountyList(c) {
  panelKey(c);
  const [reqs, players] = await Promise.all([bountyScan(), panelPlayersScan()]);
  // Backfill post ages for requests stored before the age gate existed:
  // resolve each missing postedAt once and persist it on the doc.
  for (const r of reqs) {
    if (r.postedAt || r.postAgeUnknown) continue;
    const pt = await bountyPostTime(r.link);
    if (pt.postedAt) {
      r.postedAt = pt.postedAt;
      await txUpdate(rtdb().ref('bountyRequests/bn_' + r.bnNum), (d) => d === null ? { skip: true } : { value: { ...d, postedAt: pt.postedAt }, out: true }).catch(() => {});
    } else {
      r.postAgeUnknown = true;
      await txUpdate(rtdb().ref('bountyRequests/bn_' + r.bnNum), (d) => d === null ? { skip: true } : { value: { ...d, postAgeUnknown: true }, out: true }).catch(() => {});
    }
  }
  const byId = new Map(players.map((p) => [String(p.id), p]));
  const rows = [...reqs]
    .sort((a, b) => (Number(b.bnNum) || 0) - (Number(a.bnNum) || 0))
    .map((r) => {
      const p = byId.get(String(r.userId)) || {};
      return {
        ...r,
        player: {
          id: String(r.userId), userNo: Number(p.userNo) || Number(r.userNo) || 0,
          name: p.name || r.userName || '', username: p.username || r.username || '',
          walletAddr: p.walletAddr || '', walletVerified: p.walletVerified === true, banned: p.banned === true
        },
        ...bountyRefStats(p, byId)
      };
    });
  return { ok: true, rows };
}

function bountyTxUrl(rec) {
  const h = String((rec && rec.payTx) || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(h)) return 'https://tonviewer.com/transaction/' + h;
  return String((rec && rec.payTxLink) || '').trim();
}

/* The bounty celebration (owner order 2026-11-22): the payouts
   channel gets its usual public post and the player gets a DM —
   both with the DEDICATED bounty banner, never the withdrawal art.
   Exactly-once via the payNotifiedAt claim on the record itself,
   same discipline as sendPayoutSuccess. */
async function sendBountySuccess(rec, player, cfg) {
  try {
    if (!rec || !rec.bnNum || !cfg) return;
    const num = rec.bnNum;
    const claimed = await txUpdate(rtdb().ref('bountyRequests/bn_' + num), (x) => {
      if (x === null) return { skip: true, out: false };
      if (x.payNotifiedAt) return { skip: true, out: false };
      return { value: { ...x, payNotifiedAt: Date.now() }, out: true };
    });
    if (!claimed) return;
    const amount = fmtCoins(rec.reward);
    const botUname = await resolveBotUsername(cfg);
    const appUrl = botUname ? `https://t.me/${botUname}/app` : '';
    const txUrl = bountyTxUrl(rec);
    /* ---- the player's DM ---- */
    try {
      const walletRaw = (player && player.walletAddr) || '';
      const rows = [];
      if (appUrl) rows.push([{ text: '🧟 Open ZOM', url: appUrl }]);
      if (txUrl) rows.push([{ text: '🔗 View Transaction', url: txUrl }]);
      const kb = rows.length ? { inline_keyboard: rows } : undefined;
      const caption = `🎉 <b>BOUNTY PAID!</b>\n💰 <b>+${amount} ${esc(cfg.coinSym)}</b> for your bounty post, straight to your wallet.\n👛 Wallet: <code>${esc(shortFriendlyAddress(walletRaw))}</code>\n📅 ${fmtDayMonYear(Date.now())}`;
      const photoRes = await tg('sendPhoto', { chat_id: String(rec.userId), photo: BOUNTY_BANNER, caption, reply_markup: kb });
      if (!photoRes || !photoRes.ok) {
        await tg('sendMessage', { chat_id: String(rec.userId), text: caption, reply_markup: kb });
      }
    } catch (e) { console.error('bounty success dm', num, e.message); }
    /* ---- the payouts-channel post (best-effort) ---- */
    try {
      const chanId = chatIdOf(cfg.channel2);
      if (chanId !== null && chanId !== '') {
        const pl = player || await getVal(P(rec.userId)).catch(() => null);
        const displayName = esc(String(((pl && pl.name) || rec.userName || '')).trim() || 'Zombie');
        const rows = [];
        if (appUrl) rows.push([{ text: '🧟 Start Digging Now', url: appUrl }]);
        if (txUrl) rows.push([{ text: '🔗 View Transaction', url: txUrl }]);
        const kb = rows.length ? { inline_keyboard: rows } : undefined;
        const caption = `🧟🎁 <b>NEW BOUNTY PAYOUT!</b>\n👤 <b>${displayName}</b>\n💰 <b>${amount} ${esc(cfg.coinSym)}</b>\n👛 <code>${esc(maskAddr(toFriendlyAddress((pl && pl.walletAddr) || '')))}</code>\n📣 Rewarded for spreading the word about ZOMBIE MINER!`;
        let ok = false;
        const photoRes = await tg('sendPhoto', { chat_id: chanId, photo: BOUNTY_BANNER, caption, reply_markup: kb });
        if (photoRes && photoRes.ok) ok = true;
        else {
          const msgRes = await tg('sendMessage', { chat_id: chanId, text: caption, reply_markup: kb });
          ok = !!(msgRes && msgRes.ok);
        }
        if (!ok) console.error('bounty channel post failed', num);
      }
    } catch (e) { console.error('bounty channel post failed', num, e.message); }
  } catch (e) {
    console.error('bounty success', rec && rec.bnNum, e.message);
  }
}

/* The bounty money movement: claim → balance gate → broadcast with
   the owner's fixed comment → resolve the real tx → flip Approved.
   Any failure lands as payState 'failed' + payError with the record
   still Pending, so the owner can fix the cause and approve again —
   the claim only ever lets ONE attempt broadcast at a time. */
async function attemptBountyPayout(num, amount) {
  const ref = rtdb().ref('bountyRequests/bn_' + num);
  let rec = null;
  try {
    rec = await txUpdate(ref, (x) => {
      if (x === null) return { skip: true, out: null };
      if (x.status !== 'Pending ⏳') return { skip: true, out: null };
      const ps = x.payState || 'none';
      if (ps !== 'none' && ps !== 'failed') return { skip: true, out: null };
      return { value: { ...x, payState: 'paying', payAttemptAt: Date.now(), payError: '' }, out: x };
    });
    if (!rec) return null; // claimed by someone else, or not payable
    const player = (await getVal(P(String(rec.userId)))) || {};
    const toRaw = String(player.walletAddr || '');
    if (!toRaw) {
      await ref.update({ payState: 'failed', payError: 'player has no wallet bound' });
      return await getVal(ref);
    }
    const decimals = await jettonDecimals();
    const amountBase = BigInt(amount) * (10n ** BigInt(decimals));
    const client = await getPayoutClient();
    const bal = await client.getJettonBalance();
    if (bal < amountBase) {
      await ref.update({ payState: 'failed', payError: 'insufficient jetton balance' });
      return await getVal(ref);
    }
    const broadcastAt = Date.now();
    const sent = await client.sendJetton({ toRaw, amount: amountBase, comment: BOUNTY_COMMENT });
    if (sent && sent.txHash) console.log('bounty payout', num, 'local external hash (not the on-chain tx id):', String(sent.txHash));
    let resolvedTx = '';
    if (typeof client.findTransferTx === 'function') {
      try {
        resolvedTx = String((await client.findTransferTx({ comment: BOUNTY_COMMENT, toRaw, amountBase, sinceMs: broadcastAt })) || '');
      } catch (e) { console.error('bounty tx resolve', num, e.message); }
    }
    if (!/^[0-9a-fA-F]{64}$/.test(resolvedTx)) resolvedTx = '';
    await ref.update({
      status: 'Approved ✅', payState: 'paid',
      reward: amount,
      payTx: resolvedTx,
      payTxLink: resolvedTx ? null : 'https://tonviewer.com/' + client.addressFriendly,
      paidAt: Date.now(), decidedAt: Date.now()
    });
    const fin = await getVal(ref);
    try {
      const cfg = await getConfig();
      await sendBountySuccess(fin, player, cfg);
    } catch (e) { console.error('bounty success notify', num, e.message); }
    return fin;
  } catch (e) {
    const reason = String((e && e.message) || e || 'unknown error').slice(0, 200);
    console.error('bounty payout', num, reason);
    try { await ref.update({ payState: 'failed', payError: reason }); } catch (e2) { console.error('bounty state write', num, e2.message); }
    return await getVal(ref).catch(() => null);
  }
}

async function panelBountyApprove(c) {
  panelKey(c);
  const num = Math.floor(Number(c.body.bnNum));
  if (!Number.isFinite(num) || num <= 0) fail(400, 'Bad bnNum');
  const amount = Math.floor(Number(c.body.amount));
  if (!Number.isFinite(amount) || amount < BOUNTY_MIN || amount > BOUNTY_MAX) fail(400, 'Amount must be ' + BOUNTY_MIN + '–' + BOUNTY_MAX);
  if (!payoutEnabled()) fail(400, 'Payouts are not configured');
  const ref = rtdb().ref('bountyRequests/bn_' + num);
  const doc = await getVal(ref);
  if (!doc) fail(404, 'Not found');
  if (doc.status !== 'Pending ⏳') fail(400, 'Already processed');
  if (doc.payState === 'paying' || doc.payState === 'paid') fail(400, 'Already processed');
  const fin = await attemptBountyPayout(num, amount);
  bountyInvalidate();
  const f = fin || (await getVal(ref)) || {};
  await panelAudit('panelBountyApprove', 'bn_' + num, 'status ' + (f.status || '?') + ', payState ' + (f.payState || 'none') + ', amount ' + amount + (f.payError ? ', error ' + f.payError : ''));
  return { ok: true, status: f.status || null, payState: f.payState || null, reward: Number(f.reward) || 0, payTx: f.payTx || '', ...(f.payError ? { payError: f.payError } : {}) };
}

async function panelBountyReject(c) {
  panelKey(c);
  const num = Math.floor(Number(c.body.bnNum));
  if (!Number.isFinite(num) || num <= 0) fail(400, 'Bad bnNum');
  const ref = rtdb().ref('bountyRequests/bn_' + num);
  const doc = await getVal(ref);
  if (!doc) fail(404, 'Not found');
  if (doc.status !== 'Pending ⏳') fail(400, 'Already processed');
  if (doc.payState === 'paying' || doc.payState === 'paid') fail(400, 'Already processed');
  await ref.update({ status: 'Rejected ❌', decidedAt: Date.now() });
  bountyInvalidate();
  await panelAudit('panelBountyReject', 'bn_' + num, 'rejected bounty for user ' + (doc.userId || ''));
  return { ok: true, status: 'Rejected ❌' };
}

/* Mass bounty rejection (owner order 2026-11-24): reject every Pending
   bounty whose submitter has ZERO verified referrals (same
   bountyRefStats definition the panel shows), and DM each affected
   player once, in English, with the reason. Grouped per user so a
   player with several requests gets a single message listing them. */
async function panelBountyRejectZeroRefs(c) {
  panelKey(c);
  const [reqs, players] = await Promise.all([bountyScan(), panelPlayersScan()]);
  const byId = new Map(players.map((p) => [String(p.id), p]));
  const pend = reqs.filter((r) => r && r.status === 'Pending ⏳' && r.payState !== 'paying' && r.payState !== 'paid');
  const byUser = new Map();
  for (const r of pend) {
    const p = byId.get(String(r.userId)) || {};
    if (bountyRefStats(p, byId).refsVerified > 0) continue;
    if (!byUser.has(String(r.userId))) byUser.set(String(r.userId), []);
    byUser.get(String(r.userId)).push(r);
  }
  let rejected = 0, dmSent = 0, dmFailed = 0;
  const bnNums = [];
  for (const [uid, list] of byUser) {
    const doneNums = [];
    for (const r of list) {
      const ref = rtdb().ref('bountyRequests/bn_' + r.bnNum);
      const cur = await getVal(ref);
      if (!cur || cur.status !== 'Pending ⏳') continue;
      await ref.update({ status: 'Rejected ❌', decidedAt: Date.now(), rejectReason: 'no-verified-referrals' });
      rejected++; bnNums.push(r.bnNum); doneNums.push(r.bnNum);
    }
    if (!doneNums.length) continue;
    const numsTxt = doneNums.map((n) => '#' + n).join(', ');
    const text = '❌ Bounty request' + (doneNums.length > 1 ? 's' : '') + ' ' + numsTxt + ' rejected\n\n' +
      'Your bounty submission' + (doneNums.length > 1 ? 's were' : ' was') + ' reviewed and rejected for the following reason:\n\n' +
      'Your account has no verified referrals (0). Bounty rewards require at least one verified referral.\n\n' +
      'Once you have at least one verified referral, you are welcome to submit a new bounty request.\n\n' +
      'Thank you for being part of ZOMBIE MINER 🧟';
    try { await tg('sendMessage', { chat_id: uid, text }); dmSent++; }
    catch (e) { dmFailed++; }
  }
  if (rejected) bountyInvalidate();
  await panelAudit('panelBountyRejectZeroRefs', '', 'rejected ' + rejected + ' zero-verified-ref bounties across ' + byUser.size + ' users; dm sent ' + dmSent + ', failed ' + dmFailed);
  return { ok: true, pendingScanned: pend.length, users: byUser.size, rejected, dmSent, dmFailed, bnNums };
}

/* Mass-reject every Pending bounty whose submitter's referrals hold
   0 ZOM in total (owner order 2026-11-24, the refsHold twin of
   panelBountyRejectZeroRefs): one DM per affected user explaining the
   reason, docs stamped rejectReason 'no-referral-hold'. */
async function panelBountyRejectZeroRefHold(c) {
  panelKey(c);
  const [reqs, players] = await Promise.all([bountyScan(), panelPlayersScan()]);
  const byId = new Map(players.map((p) => [String(p.id), p]));
  const pend = reqs.filter((r) => r && r.status === 'Pending ⏳' && r.payState !== 'paying' && r.payState !== 'paid');
  const byUser = new Map();
  for (const r of pend) {
    const p = byId.get(String(r.userId)) || {};
    if ((Number(bountyRefStats(p, byId).refsHold) || 0) > 0) continue;
    if (!byUser.has(String(r.userId))) byUser.set(String(r.userId), []);
    byUser.get(String(r.userId)).push(r);
  }
  let rejected = 0, dmSent = 0, dmFailed = 0;
  const bnNums = [];
  for (const [uid, list] of byUser) {
    const doneNums = [];
    for (const r of list) {
      const ref = rtdb().ref('bountyRequests/bn_' + r.bnNum);
      const cur = await getVal(ref);
      if (!cur || cur.status !== 'Pending ⏳') continue;
      await ref.update({ status: 'Rejected ❌', decidedAt: Date.now(), rejectReason: 'no-referral-hold' });
      rejected++; bnNums.push(r.bnNum); doneNums.push(r.bnNum);
    }
    if (!doneNums.length) continue;
    const numsTxt = doneNums.map((n) => '#' + n).join(', ');
    const text = '❌ Bounty request' + (doneNums.length > 1 ? 's' : '') + ' ' + numsTxt + ' rejected\n\n' +
      'Your bounty submission' + (doneNums.length > 1 ? 's were' : ' was') + ' reviewed and rejected for the following reason:\n\n' +
      'Your referrals hold 0 ZOM in total. Bounty rewards require referrals who hold ZOM.\n\n' +
      'Once your referrals hold ZOM, you are welcome to submit a new bounty request.\n\n' +
      'Thank you for being part of ZOMBIE MINER 🧟';
    try { await tg('sendMessage', { chat_id: uid, text }); dmSent++; }
    catch (e) { dmFailed++; }
  }
  if (rejected) bountyInvalidate();
  await panelAudit('panelBountyRejectZeroRefHold', '', 'rejected ' + rejected + ' zero-ref-hold bounties across ' + byUser.size + ' users; dm sent ' + dmSent + ', failed ' + dmFailed);
  return { ok: true, pendingScanned: pend.length, users: byUser.size, rejected, dmSent, dmFailed, bnNums };
}

const PANEL_ACTIONS = { panelStats, panelPlayers, panelPlayer, panelBan, panelAdjust, panelResetPlayer, panelSetAvatar, panelVerifyPlayer, panelWithdrawals, panelWdApprove, panelWdReject, panelWdBan, panelVerifyQueue, panelVerifyResolve, panelConfigGet, panelConfigSet, panelRequestAdd, panelRequestList, panelRequestReply, panelAuditList, panelEmojiPack, panelEmojiTest, panelBountyList, panelBountyApprove, panelBountyReject, panelBountyRejectZeroRefs, panelBountyRejectZeroRefHold, panelBroadcastContest, panelBroadcastStatus };

// ===== HOLDERS CONTEST (owner order 2026-11-24): leaderboard of the top 50
// VERIFIED holders by stored hold (the ref-hold watcher keeps `hold` fresh
// from the chain). Only verifiedWallet === bound wallet counts, so a
// cosmetic bind of a rich wallet never ranks. Prizes are informational
// here — the owner pays the top 5 in USDT manually after the snapshot. =====
// Telegram profile photos for the contest board (owner order 2026-11-24):
// the board shows each player's real Telegram photo. The file_id is cached
// on the player doc for 6h; the image itself is served through /photo/<uid>
// so the bot token (embedded in Telegram file URLs) never reaches clients.
async function ensurePlayerPhoto(p) {
  const now = Date.now();
  if (p.photoAt && now - Number(p.photoAt) < 6 * 3600 * 1000) return p.photoFileId ? '/photo/' + p.id : '';
  try {
    const r = await tg('getUserProfilePhotos', { user_id: Number(p.id), limit: 1 });
    const photos = (r && r.photos) || (r && r.result && r.result.photos) || [];
    let fid = '';
    if (Array.isArray(photos) && photos.length && Array.isArray(photos[0]) && photos[0].length) {
      const sizes = photos[0];
      fid = String((sizes[Math.min(1, sizes.length - 1)] || {}).file_id || '');
    }
    await P(p.id).update({ photoFileId: fid, photoAt: now });
    return fid ? '/photo/' + p.id : '';
  } catch (e) { return p.photoFileId ? '/photo/' + p.id : ''; }
}

async function servePlayerPhoto(req, res) {
  const uid = decodeURIComponent(String(req.url || '').slice(7).split('?')[0]);
  if (!/^\d+$/.test(uid)) { res.writeHead(404); return res.end(); }
  try {
    const p = (await getVal(P(uid))) || {};
    if (!p.photoFileId || !BOT_TOKEN) { res.writeHead(404); return res.end(); }
    const fr = await tg('getFile', { file_id: p.photoFileId });
    const fp = fr && fr.file_path ? fr.file_path : (fr && fr.result ? fr.result.file_path : null);
    if (!fp) { res.writeHead(404); return res.end(); }
    const resp = await fetch('https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + fp);
    if (!resp.ok) { res.writeHead(502); return res.end(); }
    const buf = Buffer.from(await resp.arrayBuffer());
    res.writeHead(200, { 'Content-Type': resp.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=21600', 'Access-Control-Allow-Origin': '*' });
    return res.end(buf);
  } catch (e) { res.writeHead(502); return res.end(); }
}

function contestPrizeFor(rank, cfg) {
  const top = (Array.isArray(cfg.contestPrizes) && cfg.contestPrizes.length === 10) ? cfg.contestPrizes.map(Number) : [70, 50, 40, 15, 15, 15, 15, 10, 10, 10];
  if (rank >= 1 && rank <= 10) return top[rank - 1] || 0;
  if (rank >= 11 && rank <= 50) return 1;
  return 0;
}

async function contest(c) {
  const uid = String(c.user.id);
  const rows = await panelPlayersScan();
  const startsAt = Number(c.cfg.contestStartsAt || 0);
  const elig = rows
    .filter((p) => p && !p.banned && p.walletVerified === true && p.verifiedWallet && p.walletAddr && String(p.verifiedWallet) === String(p.walletAddr))
    .map((p) => {
      const holdNow = Number(p.hold) || 0;
      const base = (startsAt > 0 && Number(p.contestBaseAt || 0) === startsAt) ? (Number(p.contestBase) || 0) : null;
      const score = base === null ? 0 : Math.max(0, holdNow - base);
      return { id: String(p.id), userNo: Number(p.userNo) || 0, name: String(p.name || ''), avatar: Number(p.avatar) || 0, hold: score, cur: holdNow, walletAddr: String(p.walletAddr), base, photoFileId: p.photoFileId || '', photoAt: Number(p.photoAt) || 0 };
    })
    // Owner order 2026-11-24 (evening): the board always shows a full
    // top 50 — after the positive scores, verified players who have a
    // baseline but have not bought yet fill the remaining rows at 0,
    // ordered by their current wallet hold.
    .filter((p) => p.base !== null)
    .sort((a, b) => (b.hold - a.hold) || (b.cur - a.cur) || (a.userNo - b.userNo));
  // Owner order 2026-11-24: the contest depends ONLY on the hold in the
  // player's WALLET (on-chain), never on his in-app (bot) balance. The
  // stored hold is the watcher's last sync of that wallet; for the
  // visible board we re-read the chain fresh and re-rank before answering.
  const cand = elig.slice(0, 50);
  await Promise.all(cand.map(async (p) => {
    try {
      const fresh = await jettonHold(p.walletAddr);
      if (Number.isFinite(fresh) && p.base !== null) { p.hold = Math.max(0, fresh - p.base); p.cur = fresh; }
    } catch (e) { /* chain error: keep the last synced wallet score */ }
  }));
  cand.sort((a, b) => (b.hold - a.hold) || (b.cur - a.cur) || (a.userNo - b.userNo));
  const top = cand.map((p, i) => ({ rank: i + 1, userNo: p.userNo, name: p.name, avatar: p.avatar, hold: Math.floor(p.hold), prize: contestPrizeFor(i + 1, c.cfg) }));
  let me = null;
  const mi = elig.findIndex((p) => p.id === uid);
  if (mi >= 0) me = { rank: mi + 1, hold: Math.floor(elig[mi].hold) };
  else {
    const mp = rows.find((p) => String(p.id) === uid);
    if (mp) me = { rank: 0, hold: 0 };
  }
  await Promise.all(top.map(async (r, i) => { r.photo = await ensurePlayerPhoto(cand[i]); }));
  const prizes = (Array.isArray(c.cfg.contestPrizes) && c.cfg.contestPrizes.length === 10) ? c.cfg.contestPrizes.map(Number) : [70, 50, 40, 15, 15, 15, 15, 10, 10, 10];
  return { ok: true, endsAt: Number(c.cfg.contestEndsAt || 0), prizes, top, me };
}

// Contest baseline snapshot (owner order 2026-11-24): the board ranks
// only the ZOM accumulated AFTER the contest starts, so the moment a
// contest starts we freeze every verified player's current hold as their
// baseline (contestBase). Runs once per contest, keyed by contestStartsAt
// in meta/contestSnap. Players who verify mid-contest get their baseline
// stamped inside completeVerification instead.
let contestSnapBusy = false;
async function contestSnapTick() {
  if (contestSnapBusy) return;
  contestSnapBusy = true;
  try {
    const cfg = await getConfig();
    const startsAt = Number(cfg.contestStartsAt || 0);
    if (!startsAt || Date.now() < startsAt) return;
    const doneFor = Number((await getVal(rtdb().ref('meta/contestSnap'))) || 0);
    if (doneFor === startsAt) return;
    const obj = (await getVal(rtdb().ref('players'))) || {};
    const rows = Object.entries(obj).filter(([, v]) => v && typeof v === 'object' && v.walletVerified === true);
    for (let i = 0; i < rows.length; i += 100) {
      await Promise.all(rows.slice(i, i + 100).map(([k, v]) => P(String(v.id || k)).update({ contestBase: Number(v.hold) || 0, contestBaseAt: startsAt })));
    }
    await rtdb().ref('meta/contestSnap').set(startsAt);
    console.log('[contestSnap] baselines frozen for', rows.length, 'verified players, contestStartsAt', startsAt);
  } catch (e) { console.error('contestSnap FAILED', e.message); }
  finally { contestSnapBusy = false; }
}
setInterval(() => { contestSnapTick(); }, 60000);

// Personal contest breakdown (owner order 2026-11-24): why is my contest
// balance what it is — starting baseline, current wallet balance, the
// counted difference, and the player's ZOM transactions in the window.
async function contestMe(c) {
  const uid = String(c.user.id);
  const p = (await getVal(P(uid))) || {};
  const startsAt = Number(c.cfg.contestStartsAt || 0);
  const endsAt = Number(c.cfg.contestEndsAt || 0);
  let holdNow = Number(p.hold) || 0;
  if (p.walletAddr) { try { holdNow = await jettonHold(p.walletAddr); } catch (e) { /* keep the stored hold */ } }
  const baseKnown = startsAt > 0 && Number(p.contestBaseAt || 0) === startsAt;
  const base = baseKnown ? (Number(p.contestBase) || 0) : 0;
  const score = baseKnown ? Math.max(0, holdNow - base) : 0;
  const txs = [];
  if (p.walletAddr && startsAt > 0) {
    try {
      const myRaw = toRawAddress(p.walletAddr);
      const ev = await ton('/accounts/' + myRaw + '/events?limit=100');
      const events = (ev && ev.events) || [];
      for (const e of events) {
        const ts = Number(e.timestamp || 0) * 1000;
        if (!ts || ts < startsAt || (endsAt > 0 && ts > endsAt)) continue;
        for (const a of (e.actions || [])) {
          if (a.type === 'JettonSwap' && a.JettonSwap) {
            const out = Number(a.JettonSwap.amount_out || 0) / 1e9;
            const inn = Number(a.JettonSwap.amount_in || 0) / 1e9;
            if (out > 0) txs.push({ ts, kind: 'buy', amount: out });
            else if (inn > 0) txs.push({ ts, kind: 'sell', amount: inn });
          } else if (a.type === 'JettonTransfer' && a.JettonTransfer) {
            const amt = Number(a.JettonTransfer.amount || 0) / 1e9;
            if (!(amt > 0)) continue;
            const snd = a.JettonTransfer.sender && a.JettonTransfer.sender.address;
            const rcp = a.JettonTransfer.recipient && a.JettonTransfer.recipient.address;
            if (rcp && toRawAddress(rcp) === myRaw) txs.push({ ts, kind: 'in', amount: amt });
            else if (snd && toRawAddress(snd) === myRaw) txs.push({ ts, kind: 'out', amount: amt });
          }
        }
      }
      txs.sort((x, y) => y.ts - x.ts);
    } catch (e) { /* the breakdown still answers without the tx list */ }
  }
  return { ok: true, startsAt, endsAt, verified: p.walletVerified === true, baseKnown, base, holdNow, score, txs: txs.slice(0, 50) };
}

const ACTIONS = { state, collect, daily, task, taskX, taskXVisit, holdTask, bioTask, refAch, adTicket, adClaim, adNoFill, wallet, unlink, verifyInfo, verifyCheck, refCollect, withdraw, setAvatar, adminState, adminBan, adminAdjust, adminWd, adminSettings, bountySubmit, bountyMine, bountyImport, bountyCheckLink, contest, contestMe };

ensureWebhook(); // self-register the Telegram webhook once per process (never blocks boot)
startVerifyWatcher(); // background deposit watcher (see verifyWatchTick; no-op when VERIFY_WATCH_MS=0)
startVerifySweeper(); // hourly reconciliation sweep (see verifySweepTick; no-op when VERIFY_SWEEP_MS=0)
startRefHoldWatcher(); // background referral-hold watcher (see refHoldWatchTick; no-op when REF_HOLD_WATCH_MS=0)
startRefRepairWatcher(); // background referral repair sweep (see refRepairTick; no-op when REF_REPAIR_MS=0)
initPayout(); // automatic-payout boot line (disabled line, or wallet + balances when PAYOUT_MNEMONIC is set)

functions.http('collectMining', async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).send('');
  }
  // Admin panel page (owner order 2026-11-17): GET /panel serves
  // the embedded panel HTML behind Basic Auth (password = the
  // panel key). It intercepts ONLY that exact path; every other
  // GET keeps the 405 below and all POST handling is unaffected.
  if (req.method === 'GET' && String(req.url || '').startsWith('/photo/')) return servePlayerPhoto(req, res);
  if (req.method === 'GET' && panelPagePath(req) === '/panel') return servePanelPage(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Telegram webhook updates arrive on this same endpoint: they carry
  // update_id + message (or callback_query, for the withdrawal-review
  // card buttons) instead of initData/action and are authenticated
  // by the webhook secret header, never by initData — handled BEFORE
  // the API path (and before its rate limiter: Telegram retries must
  // not be throttled into dropping a verification).
  const updBody = req.body || {};
  if (typeof updBody.update_id === 'number' && (updBody.message || updBody.callback_query)) {
    const given = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    const secret = webhookSecret();
    if (!BOT_TOKEN || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (markUpdateSeen(updBody.update_id)) {
      try {
        if (updBody.message) await handleBotMessage(updBody.message);
        else await handleBotCallback(updBody.callback_query); // withdrawal-review card buttons
      } catch (e) { console.error('bot update', e.message); }
    }
    return res.status(200).json({ ok: true });
  }
  try {
    const ip = clientIp(req);
    if (!hit('ip:' + ip, 1200, 60000)) return res.status(429).json({ error: 'Too many requests, slow down' });
    const body = req.body || {};
    // Admin PANEL API (owner order 2026-11-17): key-guarded web
    // panel actions authenticate by ADMIN_PANEL_KEY in the body,
    // NOT by Telegram initData, so they are dispatched here —
    // after body parsing and the global per-IP rate limiter above,
    // before the initData gate (and before the ownerOnly gate:
    // the panel must stay usable during maintenance). The context
    // is minimal ({ body, cfg, ip }); every panel action re-checks
    // the key itself via panelKey. All other actions keep the exact
    // existing flow below.
    if (typeof body.action === 'string' && body.action.startsWith('panel')) {
      if (!Object.prototype.hasOwnProperty.call(PANEL_ACTIONS, body.action)) return res.status(400).json({ error: 'Unknown action' });
      const cfg = await getConfig();
      const result = await PANEL_ACTIONS[body.action]({ body, cfg, ip });
      return res.status(200).json(result);
    }
    const auth = verifyInitData(body.initData);
    if (auth.error === 'config') { console.error('BOT_TOKEN env var is not set'); return res.status(500).json({ error: 'Server not configured' }); }
    if (auth.error === 'expired') return res.status(401).json({ error: 'Session expired, reopen the app' });
    if (auth.error) return res.status(401).json({ error: 'Unauthorized' });
    const name = typeof body.action === 'string' ? body.action : 'collect';
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) return res.status(400).json({ error: 'Unknown action' });
    const uid = String(auth.user.id);
    if (!/^\d+$/.test(uid)) return res.status(401).json({ error: 'Unauthorized' }); // Telegram user ids are numeric; anything else never reaches an RTDB path
    if (!hit('u:' + uid, 240, 60000) || !hit('a:' + uid + ':' + name, ACTION_LIMIT[name] || 60, 60000)) return res.status(429).json({ error: 'Too many requests, slow down' });
    const cfg = await getConfig();
    // Owner-only maintenance gate (owner order 2026-11-14): the app
    // renders its «update in progress» screen off the maintenance flag.
    // The switch itself is an emergency brake, so it is read FRESH on
    // every request (a single-value read — the cheapest there is)
    // instead of from the 60 s config cache: flipping ownerOnly in
    // Firebase must bite immediately, in both directions. Every other
    // setting may lag by the cache TTL; this one may not.
    const ownerOnlyLive = await getVal(rtdb().ref('settings/global/ownerOnly'));
    if (ownerOnlyLive === true && !isTesterUid(uid, cfg)) return res.status(403).json({ error: 'Update in progress', maintenance: true });
    const actx = { user: auth.user, startParam: auth.startParam, authDate: auth.authDate, body, cfg, ip };
    let result;
    try {
      result = await ACTIONS[name](actx);
    } catch (err) {
      // Self-heal (owner report 2026-11-14): the 'User not found'
      // hardening made this rare, not impossible — a NON-admin player
      // action that still surfaces it gets ONE ensurePlayer + retry
      // before the error reaches the user. Admin actions and every
      // other error pass straight through.
      if (!(err instanceof Fail) || err.message !== 'User not found' || name.startsWith('admin')) throw err;
      await ensurePlayer(actx);
      result = await ACTIONS[name](actx);
    }
    await noteSignals(uid, ip ? ['ip:' + hashIp(ip)] : []);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof Fail) return res.status(err.status).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { verifyInitData, clientKeys, riskOf, noteSignals, hit, publicConfig, chatIdOf, memberStatus, updateMultiLinks, completeVerification, verifyWatchTick, verifySweepTick, processVerifyCandidate, processVerifyDeposit, toFriendlyAddress, fmtDayMonYear, txUpdate, attemptPayout, derivePayoutAddress, payoutEnabled, sendPayoutSuccess, buildWdReviewCard, sendWdReviewCard, handleBotCallback, attributeReferral, syncReferralActive, refHoldWatchTick, refRepairTick };
