// 共通ユーティリティ・API・状態
import { STATIC, localApi } from './static.js';
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const LETTERS = ['A', 'B', 'C', 'D'];
export const BLANK_RE = /-{3,}|_{3,}|—+/;

export async function api(path, opts = {}) {
  if (STATIC) return localApi(path, opts); // GitHub Pages 版はブラウザ内で処理
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.method = opts.method || 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch('/api/' + path, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// アプリ全体の状態（教材・学習記録・設定・単語）
export const store = {
  materials: [], questions: [], byId: new Map(), stats: {}, settings: {}, ai: false, audio: {},
  words: [], wordKeys: new Map(),
  local: loadLocal(),
};

function loadLocal() {
  const def = { rate: 1, accent: 'en-US', voice: '', repeat: 1, preferBook: true, oneClick: true, autoPlay: true,
    pauseMs: 700, hideText: true, practice: {}, theme: '', v: 2 };
  try {
    const saved = JSON.parse(localStorage.getItem('toeic.local') || '{}');
    if (!saved.v) delete saved.autoPlay; // v2 で自動再生を既定オンに変更
    return { ...def, ...saved, v: 2 };
  } catch (e) { return def; }
}
export function saveLocal() {
  try { localStorage.setItem('toeic.local', JSON.stringify(store.local)); } catch (e) { /* 保存不可でも動作は続ける */ }
}

export async function loadAll() {
  const [content, state] = await Promise.all([api('content'), api('state')]);
  store.materials = content.materials;
  store.questions = content.questions;
  store.byId = new Map(content.questions.map((q) => [q.id, q]));
  store.stats = state.stats; store.settings = state.settings; store.ai = state.ai; store.audio = state.audio;
  await reloadWords();
}

export async function reloadWords() {
  store.words = await api('words');
  store.wordKeys = new Map(store.words.map((w) => [w.key, w]));
}

export const wordKey = (t) => t.toLowerCase().replace(/’/g, "'").split(/\s+/).filter(Boolean).join(' ');

export function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

export function fmtSec(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`;
}
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const today = () => new Date().toISOString().slice(0, 10);
export function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export const fmtDate = (s) => (s ? s.replace('T', ' ').slice(0, 16) : '');

// 英文をクリック可能な単語 span に分解（空欄は ------- 表示）
export function tokenize(text, { blank = true } = {}) {
  let out = '', i = 0;
  const re = /([A-Za-z][A-Za-z'’\-]*[A-Za-z]|[A-Za-z])|(-{3,}|_{3,}|—+)/g;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(i, m.index));
    if (m[1]) out += `<span class="w">${esc(m[1])}</span>`;
    else out += blank ? '<span class="blank" aria-label="空所">&nbsp;</span>' : esc(m[2]);
    i = re.lastIndex;
  }
  return out + esc(text.slice(i));
}

// 完成文の中で正解部分を強調
export function completeHtml(q) {
  const parts = q.text.split(BLANK_RE);
  if (parts.length !== 2) return tokenize(q.complete || '');
  const ans = q.choices[q.answer];
  return `${tokenize(parts[0])}<mark class="ans">${tokenize(ans)}</mark>${tokenize(parts[1])}`;
}

export function questionLabel(q) {
  const m = store.materials.find((x) => x.id === q.material);
  return `${m ? m.short : q.material} No.${q.label}`;
}

export function sourceOf(q) {
  return { qid: q.id, material: q.material, part: q.part, number: q.label, sentence: q.complete || q.text };
}
