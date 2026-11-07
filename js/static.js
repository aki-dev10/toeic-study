// GitHub Pages 版（サーバーなし）。
//  - 教材データ（問題・解説・画像・音声）は暗号化して置き、パスワードから作った鍵でブラウザ内で復号する
//  - 学習データは server/db.py と同じ SQL を sql.js（ブラウザ内 SQLite）で実行し、端末の IndexedDB に保存
//  - 辞書は server/dictionary.py の移植（dict.sqlite は CC0/パブリックドメインのデータなので暗号化しない）
export const STATIC = !!window.TOEIC_STATIC;

const enc = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------- 鍵・復号 ----------
let aesKey = null, hmacKey = null;
const KEY_LS = 'toeic.key';

async function setMaster(raw) {
  aesKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  hmacKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function tryPassword(pw) {
  const info = await (await fetch('keyinfo.json', { cache: 'no-cache' })).json();
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(info.salt), iterations: info.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const w = unb64(info.wrapped);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: w.slice(0, 12) }, kek, w.slice(12))); // 違えば例外
  await setMaster(raw);
  return raw;
}

// パスワード入力（端末ごとに初回だけ。以後は鍵を端末に記憶）
export async function unlock(app) {
  const saved = localStorage.getItem(KEY_LS);
  if (saved) {
    try { await setMaster(unb64(saved)); await fetchDec('content.json'); return; } catch (e) { localStorage.removeItem(KEY_LS); }
  }
  app.innerHTML = `<form class="card login" id="login">
      <h2>TOEIC Study</h2>
      <p class="small muted">パスワードを入力してください（この端末では次回から入力不要です）</p>
      <input type="password" id="pw" autocomplete="current-password" autofocus>
      <button class="btn primary" type="submit">開く</button>
      <p class="small ng" id="pwErr"></p></form>`;
  await new Promise((resolve) => {
    app.querySelector('#login').onsubmit = async (e) => {
      e.preventDefault();
      const err = app.querySelector('#pwErr'); err.textContent = '確認中…';
      try {
        const raw = await tryPassword(app.querySelector('#pw').value);
        localStorage.setItem(KEY_LS, b64(raw));
        resolve();
      } catch (x) { err.textContent = 'パスワードが違います'; }
    };
  });
  app.innerHTML = '<div class="loading">読み込み中…</div>';
}

async function encName(path) {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(path)));
  return 'e/' + [...sig.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('') + '.bin';
}

export async function fetchDec(path) {
  const r = await fetch(await encName(path));
  if (!r.ok) throw new Error('not found: ' + path);
  const buf = new Uint8Array(await r.arrayBuffer());
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, aesKey, buf.slice(12));
}

// '/media/…' '/blank/…' '/crops/…' → 復号した Blob URL
const urlCache = new Map();
export async function resolveUrl(url) {
  if (!STATIC || !/^\/(media|blank|crops)\//.test(url)) return url;
  if (urlCache.has(url)) return urlCache.get(url);
  const path = url.slice(1);
  const type = path.endsWith('.png') ? 'image/png' : 'audio/mpeg';
  const u = URL.createObjectURL(new Blob([await fetchDec(path)], { type }));
  urlCache.set(url, u);
  if (urlCache.size > 80) { const [k, v] = urlCache.entries().next().value; URL.revokeObjectURL(v); urlCache.delete(k); }
  return u;
}
export async function hydrateImages(el) {
  if (!STATIC) return;
  for (const img of el.querySelectorAll('img[data-enc]')) {
    resolveUrl(img.dataset.enc).then((u) => { img.src = u; }).catch(() => {});
  }
}

// ---------- ブラウザ内 SQLite ----------
let SQL = null, db = null, dict = null;
const IDB = 'toeic-study', STORE = 'kv';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { const d = await idb(); return new Promise((res) => { const r = d.transaction(STORE).objectStore(STORE).get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); }
async function idbPut(k, v) { const d = await idb(); return new Promise((res) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = res; t.onerror = res; }); }

async function sqljs() {
  if (!SQL) SQL = await window.initSqlJs({ locateFile: (f) => 'vendor/' + f });
  return SQL;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts(id INTEGER PRIMARY KEY, qid TEXT NOT NULL, choice INTEGER, correct INTEGER NOT NULL, ms INTEGER, mode TEXT, session TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_q ON attempts(qid);
CREATE TABLE IF NOT EXISTS qstate(qid TEXT PRIMARY KEY, bookmark INTEGER DEFAULT 0, review INTEGER DEFAULT 0, note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS exams(id TEXT PRIMARY KEY, title TEXT, started TEXT, finished TEXT, limit_sec INTEGER, qids TEXT, answers TEXT, times TEXT, score INTEGER, total INTEGER);
CREATE TABLE IF NOT EXISTS words(id INTEGER PRIMARY KEY, text TEXT NOT NULL, key TEXT NOT NULL UNIQUE, lemma TEXT, is_phrase INTEGER DEFAULT 0, phonetic TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, ease REAL DEFAULT 2.5, interval REAL DEFAULT 0, due_at TEXT, last_reviewed_at TEXT, level INTEGER DEFAULT 0, email_sent_at TEXT, email_exclude INTEGER DEFAULT 0, memo TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS senses(id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, pos TEXT DEFAULT '', meaning TEXT NOT NULL, origin TEXT DEFAULT 'dict', created_at TEXT, UNIQUE(word_id, pos, meaning));
CREATE TABLE IF NOT EXISTS sources(id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, sense_id INTEGER, qid TEXT, material TEXT, part INTEGER, number TEXT, surface TEXT, sentence TEXT, created_at TEXT, UNIQUE(word_id, qid));
CREATE TABLE IF NOT EXISTS word_reviews(id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE, mode TEXT, grade INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS email_log(id INTEGER PRIMARY KEY, created_at TEXT, period_from TEXT, period_to TEXT, recipient TEXT, subject TEXT, word_ids TEXT, status TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`;
const USER_TABLES = ['attempts', 'qstate', 'exams', 'words', 'senses', 'sources', 'word_reviews', 'email_log', 'settings'];

async function userDb() {
  if (db) return db;
  const S = await sqljs();
  const saved = await idbGet('user.db');
  db = saved ? new S.Database(new Uint8Array(saved)) : new S.Database();
  db.exec('PRAGMA foreign_keys=ON;' + SCHEMA);
  try { navigator.storage?.persist?.(); } catch (e) { /* */ }
  return db;
}
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => idbPut('user.db', db.export()), 200); }
document.addEventListener('visibilitychange', () => { if (document.hidden && db && saveT) { clearTimeout(saveT); idbPut('user.db', db.export()); } });

const nul = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
function qd(d, sql, args = []) { const st = d.prepare(sql); st.bind(nul(args)); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; }
const q = (sql, args) => qd(db, sql, args);
function x(sql, args = []) { db.run(sql, nul(args)); save(); return db.exec('SELECT last_insert_rowid()')[0].values[0][0]; }
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); save(); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const now = () => iso(new Date());

// ---------- server/db.py の移植 ----------
const DEFAULT_SETTINGS = { email: { enabled: false, recipient: 'ah0864@sel.co.jp', weekday: 6, hour: 20, include: ['meaning', 'pos', 'example', 'source'] },
  ai: { model: 'claude-opus-5-5', effort: 'low' }, exam: { count: 30, minutes: 10 } };
function getSettings() {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of q('SELECT key, value FROM settings')) { try { s[r.key] = JSON.parse(r.value); } catch (e) { /* */ } }
  return s;
}
function setSettings(d) {
  for (const [k, v] of Object.entries(d)) x('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, JSON.stringify(v)]);
  return getSettings();
}
function questionStats() {
  const stats = {};
  for (const r of q(`SELECT qid, count(*) n, sum(correct) ok, avg(ms) ms, max(at) last,
      (SELECT correct FROM attempts b WHERE b.qid=a.qid ORDER BY id LIMIT 1) first,
      (SELECT correct FROM attempts b WHERE b.qid=a.qid ORDER BY id DESC LIMIT 1) latest,
      (SELECT ms FROM attempts b WHERE b.qid=a.qid ORDER BY id DESC LIMIT 1) last_ms
      FROM attempts a GROUP BY qid`)) {
    stats[r.qid] = { n: r.n, ok: r.ok, ms: Math.round(r.ms || 0), last: r.last, first: r.first, latest: r.latest, lastMs: r.last_ms };
  }
  for (const r of q('SELECT * FROM qstate')) {
    const s = (stats[r.qid] ||= { n: 0, ok: 0 });
    Object.assign(s, { bookmark: r.bookmark, review: r.review, note: r.note });
  }
  return stats;
}
function setQstate(d) {
  x('INSERT OR IGNORE INTO qstate(qid) VALUES(?)', [d.qid]);
  for (const k of ['bookmark', 'review', 'note']) if (k in d) x(`UPDATE qstate SET ${k}=? WHERE qid=?`, [d[k], d.qid]);
  return q('SELECT * FROM qstate WHERE qid=?', [d.qid])[0];
}
function exams() {
  return q('SELECT * FROM exams ORDER BY finished DESC LIMIT 50').map((r) => {
    for (const k of ['qids', 'answers', 'times']) r[k] = JSON.parse(r[k] || '[]');
    return r;
  });
}
const wordKey = (t) => t.toLowerCase().replace(/’/g, "'").split(/\s+/).filter(Boolean).join(' ');
function wordFull(wid) {
  const w = q('SELECT * FROM words WHERE id=?', [wid])[0];
  if (!w) return null;
  w.senses = q('SELECT * FROM senses WHERE word_id=? ORDER BY id', [wid]);
  w.sources = q('SELECT * FROM sources WHERE word_id=? ORDER BY id', [wid]);
  w.reviews = q('SELECT mode, grade, at FROM word_reviews WHERE word_id=? ORDER BY id DESC LIMIT 20', [wid]);
  return w;
}
function listWords() {
  const words = q('SELECT * FROM words ORDER BY created_at DESC, id DESC');
  const senses = {}, sources = {}, stats = {};
  for (const s of q('SELECT * FROM senses ORDER BY id')) (senses[s.word_id] ||= []).push(s);
  for (const s of q('SELECT * FROM sources ORDER BY id')) (sources[s.word_id] ||= []).push(s);
  for (const s of q('SELECT word_id, count(*) n, sum(grade>=2) ok FROM word_reviews GROUP BY word_id')) stats[s.word_id] = s;
  for (const w of words) {
    w.senses = senses[w.id] || []; w.sources = sources[w.id] || [];
    w.reviewCount = stats[w.id]?.n || 0; w.reviewOk = stats[w.id]?.ok || 0;
  }
  return words;
}
function registerWord(d) {
  const text = d.text.split(/\s+/).filter(Boolean).join(' ');
  const key = wordKey(d.lemma || text);
  const r = tx(() => {
    const t = now();
    const row = q('SELECT id FROM words WHERE key=?', [key]);
    const created = !row.length;
    let wid;
    if (row.length) { wid = row[0].id; x('UPDATE words SET updated_at=? WHERE id=?', [t, wid]); }
    else wid = x('INSERT INTO words(text,key,lemma,is_phrase,phonetic,created_at,updated_at,due_at) VALUES(?,?,?,?,?,?,?,?)',
      [d.lemma || text, key, d.lemma || text, key.includes(' ') ? 1 : 0, d.phonetic || '', t, t, t]);
    const meaning = (d.meaning || '').trim() || '（意味未登録）';
    const pos = d.pos || '';
    x('INSERT OR IGNORE INTO senses(word_id,pos,meaning,origin,created_at) VALUES(?,?,?,?,?)', [wid, pos, meaning, d.origin || 'dict', t]);
    const senseId = q('SELECT id FROM senses WHERE word_id=? AND pos=? AND meaning=?', [wid, pos, meaning])[0].id;
    const src = d.source || {};
    let addedSource = false;
    if (src.qid || src.sentence) {
      const before = q('SELECT count(*) n FROM sources WHERE word_id=?', [wid])[0].n;
      x('INSERT OR IGNORE INTO sources(word_id,sense_id,qid,material,part,number,surface,sentence,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [wid, senseId, src.qid, src.material, src.part, src.number, d.surface || text, src.sentence, t]);
      addedSource = q('SELECT count(*) n FROM sources WHERE word_id=?', [wid])[0].n > before;
    }
    return { id: wid, created, addedSource };
  });
  r.word = wordFull(r.id);
  return r;
}
function updateWord(wid, d) {
  for (const k of ['text', 'phonetic', 'memo', 'email_exclude']) if (k in d) x(`UPDATE words SET ${k}=?, updated_at=? WHERE id=?`, [d[k], now(), wid]);
  if (d.senses) {
    tx(() => {
      const keep = [];
      for (const s of d.senses) {
        if (s.id) { x('UPDATE senses SET pos=?, meaning=? WHERE id=? AND word_id=?', [s.pos || '', s.meaning, s.id, wid]); keep.push(s.id); }
        else if (s.meaning) keep.push(x('INSERT OR IGNORE INTO senses(word_id,pos,meaning,origin,created_at) VALUES(?,?,?,?,?)', [wid, s.pos || '', s.meaning, 'user', now()]));
      }
      if (keep.length) x(`DELETE FROM senses WHERE word_id=? AND id NOT IN (${keep.map(() => '?').join(',')})`, [wid, ...keep]);
    });
  }
  return wordFull(wid);
}
function reviewWord(wid, mode, grade) {
  const w = q('SELECT * FROM words WHERE id=?', [wid])[0];
  let { ease, interval, reps, lapses } = w;
  if (grade === 0) { lapses += 1; reps = 0; ease = Math.max(1.3, ease - 0.2); interval = 0; }
  else {
    ease = Math.max(1.3, Math.min(3.0, ease + { 1: -0.15, 2: 0, 3: 0.15 }[grade]));
    if (reps === 0) interval = { 1: 1, 2: 1, 3: 3 }[grade];
    else if (reps === 1) interval = { 1: 2, 2: 3, 3: 6 }[grade];
    else interval = Math.max(1, interval * { 1: 1.2, 2: ease, 3: ease * 1.3 }[grade]);
    reps += 1;
  }
  const due = new Date(Date.now() + (interval === 0 ? 10 * 60000 : interval * 86400000));
  const level = reps === 0 ? 0 : interval < 3 ? 1 : interval < 7 ? 2 : interval < 21 ? 3 : interval < 60 ? 4 : 5;
  const t = now();
  x('UPDATE words SET ease=?, interval=?, reps=?, lapses=?, due_at=?, last_reviewed_at=?, level=? WHERE id=?', [ease, interval, reps, lapses, iso(due), t, level, wid]);
  x('INSERT INTO word_reviews(word_id,mode,grade,at) VALUES(?,?,?,?)', [wid, mode, grade, t]);
  return wordFull(wid);
}
function dueWords(limit = 30) {
  return q(`SELECT id FROM words WHERE due_at IS NULL OR due_at<=?
            ORDER BY (reps=0) ASC, lapses*1.0/(reps+lapses+1) DESC, ease ASC, due_at ASC LIMIT ?`, [now(), limit]).map((r) => wordFull(r.id));
}
function dashboard() {
  const today = now().slice(0, 10);
  const one = (sql, a) => q(sql, a)[0];
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(iso(new Date(Date.now() - i * 86400000)).slice(0, 10));
  const byDay = Object.fromEntries(q('SELECT substr(at,1,10) d, count(*) n, sum(correct) ok, count(distinct qid) q FROM attempts WHERE at>=? GROUP BY d', [days[0]]).map((r) => [r.d, r]));
  const wrDay = Object.fromEntries(q('SELECT substr(at,1,10) d, count(*) n FROM word_reviews WHERE at>=? GROUP BY d', [days[0]]).map((r) => [r.d, r.n]));
  const waDay = Object.fromEntries(q('SELECT substr(created_at,1,10) d, count(*) n FROM words WHERE created_at>=? GROUP BY d', [days[0]]).map((r) => [r.d, r.n]));
  const first = one('SELECT count(*) n, sum(correct) ok FROM attempts a WHERE id=(SELECT min(id) FROM attempts b WHERE b.qid=a.qid)');
  const later = one('SELECT count(*) n, sum(correct) ok FROM attempts a WHERE id<>(SELECT min(id) FROM attempts b WHERE b.qid=a.qid)');
  return {
    today: {
      attempts: one('SELECT count(*) n FROM attempts WHERE at>=?', [today]).n,
      questions: one('SELECT count(distinct qid) n FROM attempts WHERE at>=?', [today]).n,
      correct: one('SELECT coalesce(sum(correct),0) n FROM attempts WHERE at>=?', [today]).n,
      wordReviews: one('SELECT count(*) n FROM word_reviews WHERE at>=?', [today]).n,
      newWords: one('SELECT count(*) n FROM words WHERE created_at>=?', [today]).n,
    },
    total: {
      attempts: one('SELECT count(*) n FROM attempts').n,
      questions: one('SELECT count(distinct qid) n FROM attempts').n,
      avgMs: Math.round(one('SELECT avg(ms) v FROM attempts WHERE ms>0 AND ms<600000').v || 0),
    },
    firstRate: [first.n, first.ok || 0], laterRate: [later.n, later.ok || 0],
    words: {
      total: one('SELECT count(*) n FROM words').n,
      mastered: one('SELECT count(*) n FROM words WHERE level>=5').n,
      unmastered: one('SELECT count(*) n FROM words WHERE level<5').n,
      due: one('SELECT count(*) n FROM words WHERE due_at IS NULL OR due_at<=?', [now()]).n,
      week: one('SELECT count(*) n FROM words WHERE created_at>=?', [iso(new Date(Date.now() - 7 * 86400000))]).n,
    },
    days: days.map((d) => ({ d, n: byDay[d]?.n || 0, ok: byDay[d]?.ok || 0, wr: wrDay[d] || 0, wa: waDay[d] || 0 })),
  };
}
function backup() {
  const data = { app: 'toeic-study', version: 1, exported_at: now(), tables: {} };
  for (const t of USER_TABLES) data.tables[t] = q(`SELECT * FROM ${t}`);
  return data;
}
function restore(data, mode = 'replace') {
  if (data.app !== 'toeic-study') throw new Error('このアプリのバックアップファイルではありません');
  tx(() => {
    if (mode === 'replace') for (const t of [...USER_TABLES].reverse()) x(`DELETE FROM ${t}`);
    for (const t of USER_TABLES) {
      const cols = new Set(q(`PRAGMA table_info(${t})`).map((r) => r.name));
      for (const row of data.tables[t] || []) {
        const r = Object.fromEntries(Object.entries(row).filter(([k]) => cols.has(k)));
        const ks = Object.keys(r);
        if (ks.length) x(`INSERT OR REPLACE INTO ${t}(${ks.join(',')}) VALUES(${ks.map(() => '?').join(',')})`, Object.values(r));
      }
    }
  });
  return Object.fromEntries(USER_TABLES.map((t) => [t, (data.tables[t] || []).length]));
}
function emailDigest(days = 7) {
  const end = new Date(), start = new Date(Date.now() - days * 86400000);
  const words = listWords().filter((w) => w.created_at >= iso(start) && !w.email_exclude).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const subject = `TOEIC新規登録単語まとめ（${start.getMonth() + 1}/${start.getDate()}〜${end.getMonth() + 1}/${end.getDate()}）`;
  const lines = [`今週登録した単語：${words.length}語`, ''];
  words.forEach((w, i) => {
    const s = w.senses[0] || { meaning: '', pos: '' };
    lines.push(`${i + 1}. ${w.text}`, `意味：${w.senses.map((x) => x.meaning).join(' / ')}`);
    if (s.pos) lines.push(`品詞：${s.pos}`);
    if (w.sources.length) { const so = w.sources[0]; lines.push(`例文：${so.sentence}`, `出典：${so.material} Part${so.part} No.${so.number}`); }
    lines.push('');
  });
  return { subject, recipient: getSettings().email.recipient, from: iso(start), to: iso(end), count: words.length, wordIds: words.map((w) => w.id), body: lines.join('\n') };
}

// ---------- server/dictionary.py の移植 ----------
const POS_JA = { n: '名詞', v: '動詞', a: '形容詞', r: '副詞' };
const CLOSED = {
  前置詞: 'about above across after against along among around as at before behind below beneath beside besides between beyond by despite down during except for from in inside into like near of off on onto opposite out outside over past per regarding since through throughout till to toward towards under underneath unlike until up upon via with within without',
  接続詞: 'and but or nor so yet because although though unless whereas whether while if once lest',
  代名詞: 'i me my mine myself you your yours yourself yourselves he him his himself she her hers herself it its itself we us our ours ourselves they them their theirs themselves who whom whose which what that this these those whoever whatever whichever anyone anybody anything someone somebody something everyone everybody everything nobody nothing none each either neither both all',
  冠詞: 'a an the',
  助動詞: 'can could may might must shall should will would',
};
const CLOSED_POS = {};
for (const [p, ws] of Object.entries(CLOSED)) for (const w of ws.split(' ')) CLOSED_POS[w] = p;
const RULES = {
  n: [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y']],
  v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']],
  a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e'], ['ier', 'y'], ['iest', 'y']],
};
const ARPA = { AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', B: 'b', CH: 'tʃ', D: 'd', DH: 'ð', EH: 'e', ER: 'ɚ', EY: 'eɪ', F: 'f', G: 'ɡ', HH: 'h', IH: 'ɪ', IY: 'i', JH: 'dʒ', K: 'k',
  L: 'l', M: 'm', N: 'n', NG: 'ŋ', OW: 'oʊ', OY: 'ɔɪ', P: 'p', R: 'r', S: 's', SH: 'ʃ', T: 't', TH: 'θ', UH: 'ʊ', UW: 'u', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ' };

async function dictDb() {
  if (!dict) { const S = await sqljs(); dict = new S.Database(new Uint8Array(await (await fetch('dict.sqlite')).arrayBuffer())); }
  return dict;
}
const dq = (sql, a) => qd(dict, sql, a);
const wnPos = (w) => dq('SELECT pos FROM wn WHERE lemma=?', [w]).map((r) => r.pos);
const hasEj = (w) => dq('SELECT 1 x FROM ej WHERE word=? LIMIT 1', [w]).length > 0;
function lemmas(word) {
  const w = word.toLowerCase(), out = [], irregular = new Set();
  for (const r of dq('SELECT lemma, pos FROM exc WHERE form=?', [w])) { out.push(r.lemma); irregular.add(r.lemma); }
  for (const [pos, rules] of Object.entries(RULES)) {
    for (const [suf, rep] of rules) {
      if (w.endsWith(suf) && w.length > suf.length + 1) {
        const cand = w.slice(0, -suf.length) + rep;
        if (wnPos(cand).includes(pos) || (!out.includes(cand) && hasEj(cand) && pos !== 'a')) out.push(cand);
      }
    }
    if (w.endsWith('ing') || w.endsWith('ed')) {
      const stem = w.endsWith('ing') ? w.slice(0, -3) : w.slice(0, -2);
      if (stem.length > 2 && stem.at(-1) === stem.at(-2)) out.push(stem.slice(0, -1));
    }
  }
  const res = [];
  for (const c of out) if (c !== w && !res.includes(c) && (c.length > 2 || irregular.has(c)) && (wnPos(c).length || hasEj(c))) res.push(c);
  return res;
}
function ipa(word) {
  const prons = [];
  for (const part of word.toLowerCase().split(/\s+/)) {
    const r = dq('SELECT pron FROM cmu WHERE word=?', [part.replace(/^[.,']+|[.,']+$/g, '')]);
    if (!r.length) return '';
    prons.push(r[0].pron.split(' ').map((ph) => {
      const [, base, stress] = ph.match(/([A-Z]+)(\d?)/);
      let sym = ARPA[base] || '';
      if (base === 'AH' && stress === '0') sym = 'ə';
      if (stress === '1') sym = 'ˈ' + sym;
      return sym;
    }).join(''));
  }
  return '/' + prons.join(' ') + '/';
}
const clean = (m) => m.replace(/[『』]/g, '');
function guessPos(meaning, wn) {
  let m = clean(meaning).replace(/[〈《（(][^〉》）)]*[〉》）)]/g, '').trim();
  m = m.split(',')[0].split(';')[0].split('；')[0].trim();
  const cand = [];
  if (/(…を|…に|する|させる|れる|ある|いる|なる|[うくぐすつぬぶむる])$/.test(m) || m.startsWith('…を') || meaning.slice(0, 8).includes('(…を)') || /[をに][^,、]{0,6}[うくぐすつぬぶむる]$/.test(m)) cand.push('v');
  if (/(な|の|い|的な|らしい)$/.test(m)) cand.push('a');
  if (/(に|く|て|ほど|で)$/.test(m)) cand.push('r');
  cand.push('n');
  for (const c of cand) if (!wn.length || wn.includes(c)) return POS_JA[c];
  return wn.length ? POS_JA[wn[0]] : '';
}
function entries(word) {
  const w = word.toLowerCase(), wn = wnPos(w), senses = [];
  for (const { meaning } of dq('SELECT meaning FROM ej WHERE word=?', [w])) {
    for (let part of meaning.split(' / ')) {
      part = part.trim();
      if (part) senses.push({ pos: !wn.length && CLOSED_POS[w] ? CLOSED_POS[w] : guessPos(part, wn), meaning: clean(part) });
    }
  }
  return senses;
}
async function lookup(text) {
  await dictDb();
  text = text.trim().split(/\s+/).join(' ');
  const surface = text.replace(/^[.,;:!?"“”()[\]]+|[.,;:!?"“”()[\]]+$/g, '');
  const lower = surface.toLowerCase().replace(/’/g, "'");
  const result = { query: surface, isPhrase: lower.includes(' '), candidates: [] };
  const seen = new Set();
  const add = (word, why) => {
    if (seen.has(word)) return;
    seen.add(word);
    let senses = entries(word);
    const head = lower.split(' ')[0];
    if (word !== head || why === '原形') {
      const pref = /(ed|ing)$/.test(head) ? '動詞' : lower.endsWith('s') ? '名詞' : null;
      if (pref) senses = [...senses.filter((s) => s.pos === pref), ...senses.filter((s) => s.pos !== pref)];
    }
    const wn = wnPos(word);
    if (senses.length || wn.length || CLOSED_POS[word]) {
      result.candidates.push({ lemma: word, why, senses: senses.slice(0, 8), pos: wn.length ? wn.map((p) => POS_JA[p]) : CLOSED_POS[word] ? [CLOSED_POS[word]] : [], phonetic: ipa(word) });
    }
  };
  if (result.isPhrase) {
    add(lower, '熟語');
    const [head, ...rest] = lower.split(' ');
    for (const l of lemmas(head)) add(l + ' ' + rest.join(' '), '熟語（原形）');
  } else {
    if (entries(lower).length >= 2) add(lower, 'そのまま');
    for (const l of lemmas(lower)) add(l, '原形');
    add(lower, 'そのまま');
  }
  result.phonetic = result.isPhrase ? '' : ipa(lower);
  return result;
}

// ---------- /api/* の代わり ----------
export async function localApi(path, opts = {}) {
  await userDb();
  const [p, query] = path.split('?');
  const qs = Object.fromEntries(new URLSearchParams(query || ''));
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
  const body = opts.body !== undefined ? JSON.parse(JSON.stringify(opts.body)) : {};
  const parts = p.replace(/^\/+|\/+$/g, '').split('/');
  const [name, arg] = parts;
  if (name === 'content') return JSON.parse(new TextDecoder().decode(await fetchDec('content.json')));
  if (name === 'state') return { stats: questionStats(), settings: getSettings(), ai: false, audio: { deru1000_audio_2: true } };
  if (name === 'attempt') return { id: x('INSERT INTO attempts(qid,choice,correct,ms,mode,session,at) VALUES(?,?,?,?,?,?,?)', [body.qid, body.choice, body.correct ? 1 : 0, body.ms, body.mode || 'practice', body.session, body.at || now()]) };
  if (name === 'qstate') return setQstate(body);
  if (name === 'exams') {
    if (method === 'POST') {
      x('INSERT OR REPLACE INTO exams(id,title,started,finished,limit_sec,qids,answers,times,score,total) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [body.id, body.title, body.started, body.finished || now(), body.limitSec, JSON.stringify(body.qids), JSON.stringify(body.answers), JSON.stringify(body.times || []), body.score, body.total]);
      return { ok: true };
    }
    return exams();
  }
  if (name === 'dashboard') return dashboard();
  if (name === 'lookup') return lookup(qs.q || '');
  if (name === 'words') {
    if (method === 'GET' && arg === 'due') return dueWords(+(qs.limit || 30));
    if (method === 'GET' && arg) return wordFull(+arg);
    if (method === 'GET') return listWords();
    if (method === 'POST' && arg && parts[2] === 'review') return reviewWord(+arg, body.mode, +body.grade);
    if (method === 'POST') return registerWord(body);
    if (method === 'PUT' && arg) return updateWord(+arg, body);
    if (method === 'DELETE' && arg) { x('DELETE FROM words WHERE id=?', [+arg]); return { ok: true }; }
  }
  if (name === 'settings') {
    if (method === 'POST') { delete body.aiKey; return { settings: setSettings(body), ai: false }; }
    return getSettings();
  }
  if (name === 'backup') return backup();
  if (name === 'restore') return { restored: restore(body.data, body.mode || 'replace') };
  if (name === 'email' && arg === 'preview') return emailDigest(+(qs.days || 7));
  if (name === 'ai') throw new Error('AI 補足は Web 版では使えません（PC 版で API キーを設定すると使えます）');
  throw new Error('not found');
}
