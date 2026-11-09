// 音声の共通基盤。Part 5/7/2 で共通利用する。
//  - speakSegments: [{text}|{pause:ms}] を順に読み上げ（空欄は無音区間）
//  - playFile: 教材音声などの音声ファイル
//  - playSequence: 上記を組み合わせた再生リスト（Part 2 の「問い→選択肢A〜C」等を想定）
import { store, BLANK_RE } from './util.js?v=5bea812d0a';
import { resolveUrl } from './static.js?v=5bea812d0a';

const synth = window.speechSynthesis;
let token = 0;           // 再生世代。stop() で無効化
let audioEl = null;
let playing = false;
const listeners = new Set();

export const onAudioState = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function setPlaying(v) { playing = v; listeners.forEach((f) => f(v)); }
export const isPlaying = () => playing;

export function voices() {
  if (!synth) return [];
  return synth.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
}
if (synth) synth.onvoiceschanged = () => listeners.forEach((f) => f(playing));

export function pickVoice(accent = store.local.accent, name = store.local.voice) {
  const vs = voices();
  if (name) { const v = vs.find((x) => x.name === name); if (v && v.lang.replace('_', '-').startsWith(accent)) return v; }
  const same = vs.filter((v) => v.lang.replace('_', '-') === accent);
  // 自然な声を優先（Edge/Chrome の Natural / Online / Google 音声）
  const rank = (v) => (/Natural|Online|Neural/i.test(v.name) ? 0 : /Google/i.test(v.name) ? 1 : v.localService ? 2 : 3);
  return same.sort((a, b) => rank(a) - rank(b))[0] || vs[0] || null;
}

export function stop() {
  token++;
  if (synth) synth.cancel();
  if (audioEl) { audioEl.pause(); audioEl.onended = null; }
  setPlaying(false);
}

const wait = (ms, t) => new Promise((res) => setTimeout(() => res(t === token), ms));

function speakOne(text, opts, t) {
  return new Promise((resolve) => {
    if (!synth || t !== token) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(opts.accent, opts.voice);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = opts.accent || 'en-US';
    u.rate = opts.rate || store.local.rate || 1;
    let done = false;
    const fin = (ok) => { if (!done) { done = true; resolve(ok && t === token); } };
    u.onend = () => fin(true);
    u.onerror = () => fin(false);
    synth.speak(u);
    // 一部ブラウザで onend が来ない場合の保険
    setTimeout(() => fin(true), 4000 + text.length * 180 / (u.rate || 1));
  });
}

// iPhone/iPad: 最初のタップで音声を有効化しておく（以後は自動再生できる）
const SILENT = 'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
function unlockAudio() {
  if (!audioEl) audioEl = new Audio();
  if (!playing) { audioEl.src = SILENT; audioEl.play().catch(() => {}); }
  try { if (synth && !synth.speaking) synth.speak(new SpeechSynthesisUtterance('')); } catch (e) { /* */ }
}
document.addEventListener('touchend', unlockAudio, { once: true, capture: true });
document.addEventListener('click', unlockAudio, { once: true, capture: true });

async function fileOne(url, opts, t) {
  let src;
  try { src = await resolveUrl(url); } catch (e) { return false; }
  return new Promise((resolve) => {
    if (t !== token) return resolve(false);
    if (!audioEl) audioEl = new Audio();
    audioEl.src = src;
    audioEl.playbackRate = opts.rate || store.local.rate || 1;
    audioEl.preservesPitch = true;
    audioEl.onended = () => resolve(t === token);
    audioEl.onerror = () => resolve(false);
    audioEl.play().catch(() => resolve(false));
  });
}

// items: [{text}|{pause}|{url}]
export async function playSequence(items, opts = {}) {
  stop();
  const t = token;
  const repeat = Math.max(1, opts.repeat || store.local.repeat || 1);
  setPlaying(true);
  for (let r = 0; r < repeat && t === token; r++) {
    for (const it of items) {
      if (t !== token) break;
      if (it.pause) await wait(it.pause, t);
      else if (it.url) {
        if (!(await fileOne(it.url, opts, t)) && t === token) {
          if (it.fallback) await speakOne(it.fallback, opts, t);
          for (const f of it.fallbackItems || []) { if (t !== token) break; if (f.pause) await wait(f.pause, t); else await speakOne(f.text, opts, t); }
        }
      }
      else if (it.text && it.text.trim()) await speakOne(it.text.trim(), opts, t);
    }
    if (r < repeat - 1) await wait(opts.gap ?? 900, t);
  }
  if (t === token) { setPlaying(false); opts.onend && opts.onend(); }
}

export const speak = (text, opts) => playSequence([{ text }], opts);

// 空欄を読まない：空欄の前後を別々に読み、間に無音を入れる
export function blankSegments(text, pauseMs = store.local.pauseMs || 700) {
  const parts = text.split(BLANK_RE).map((s) => s.replace(/\s+/g, ' ').trim());
  const items = [];
  parts.forEach((p, i) => {
    if (i > 0) items.push({ pause: pauseMs });
    if (p && /[A-Za-z0-9]/.test(p)) items.push({ text: p });
  });
  return items;
}

// 解答前：正解部分を無音にした教材音声（検証済みのものだけ）を優先、なければ合成音声で空所を無音に
export function questionItems(q) {
  const segs = blankSegments(q.text);
  if (store.local.preferBook && q.blankAudio) return [{ url: '/blank/' + q.blankAudio, fallbackItems: segs }];
  return segs;
}
export const usesBookBlank = (q) => !!(store.local.preferBook && q.blankAudio);

// 完成文：教材音声があれば優先、なければ合成音声
export function completeItems(q) {
  const useBook = store.local.preferBook && q.audio && store.audio[q.audio.split('/')[0]];
  return useBook ? [{ url: '/media/' + q.audio, fallback: q.complete }] : [{ text: q.complete }];
}

// 長文（Part 7）用：文単位に分割
export function sentences(text) {
  return text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) || [];
}

export async function audioDuration(url) {
  try { url = await resolveUrl(url); } catch (e) { return 3000; }
  return new Promise((res) => { const a = new Audio(url); a.onloadedmetadata = () => res(a.duration * 1000); a.onerror = () => res(3000); });
}
