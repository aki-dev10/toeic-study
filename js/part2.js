// Part 2（応答問題）アプリ。教材: 『TOEIC L&R テスト Part 2 応答問題 でる200問』
// 学習記録は Part 5 と同じ attempts / qstate / exams（qid = "p2-<通し番号>"）に保存するので、端末間同期もそのまま効く
import { $, $$, esc, api, store, saveLocal, toast, fmtSec, pct, shuffle, tokenize, fmtDate } from './util.js?v=43a74e9663';
import { STATIC, fetchDec, resolveUrl, hydrateImages } from './static.js?v=43a74e9663';
import { stop as stopSpeech } from './audio.js?v=43a74e9663';
import { markRegistered } from './words.js?v=43a74e9663';

const L3 = ['A', 'B', 'C'];
const TYPES = ['WH疑問文', 'Yes/No疑問文', '平叙文', '否定・付加疑問文', '提案・依頼・勧誘・申し出', '選択疑問文'];
const P2 = { loaded: false, material: null, questions: [], byId: new Map() };
const SESSION_KEY = 'p2session', MOCK_KEY = 'p2mock';

// ================= Part の切り替え（ダッシュボード上部） =================
export function partSwitcher(active) {
  const p5n = store.questions.length, p5a = store.questions.filter((q) => store.stats[q.id]?.n).length;
  const p2a = Object.keys(store.stats).filter((k) => /^p2-\d+$/.test(k) && store.stats[k].n).length;
  const tile = (id, href, part, name, sub, prog) => `
    <a class="part-tile ${active === id ? 'on' : ''} ${href ? '' : 'soon'}" ${href ? `href="${href}"` : 'aria-disabled="true"'}>
      <span class="pt-part">${part}</span><span class="pt-name">${name}</span>
      <span class="pt-sub">${sub}</span>${prog != null ? `<span class="pt-bar"><i style="width:${prog}%"></i></span>` : ''}
    </a>`;
  injectCss();
  return `<nav class="part-switch" aria-label="Part の切り替え">
    ${tile('p2', '#/p2', 'Part 2', '応答問題', P2.loaded ? `${p2a} / ${P2.questions.length}問` : `${p2a}問 解答済み`, P2.loaded ? pct(p2a, P2.questions.length) : null)}
    ${tile('p34', '', 'Part 3・4', '会話・説明文', '準備中')}
    ${tile('p5', '#/', 'Part 5', '短文穴埋め', `${p5a} / ${p5n}問`, pct(p5a, p5n))}
    ${tile('p7', '', 'Part 7', '読解', '準備中')}
  </nav>`;
}

// ================= データ =================
async function load() {
  if (P2.loaded) return;
  if (!STATIC) throw new Error('Part 2 は Web 版（GitHub Pages）で使えます');
  const d = JSON.parse(new TextDecoder().decode(await fetchDec('part2/deru200p2.json')));
  P2.material = d.material;
  P2.questions = d.questions;
  P2.byId = new Map(d.questions.map((q) => [q.id, q]));
  // 単語登録の出典（words.js は store.byId から引く）。問い・選択肢ごとに例文が変わるよう別 ID も登録
  for (const q of d.questions) {
    const base = { material: d.material.id, part: 2, label: q.label, category: q.category, section: q.section };
    store.byId.set(q.id, { ...base, id: q.id, text: q.script, complete: q.script });
    q.choices.forEach((c, i) => store.byId.set(`${q.id}-${L3[i]}`, { ...base, id: `${q.id}-${L3[i]}`, text: c, complete: c }));
  }
  P2.loaded = true;
}
const st = (q) => store.stats[q.id] || {};
const audioUrl = (q) => '/media/' + q.audio;

function filter(f) {
  let qs = P2.questions.filter((q) => {
    if (f.type && q.category !== f.type) return false;
    if (f.section === 'training' && q.set) return false;
    if (f.section === 'mock' && !q.set) return false;
    const s = st(q);
    switch (f.status) {
      case 'unanswered': return !s.n;
      case 'wrong': return s.n && s.latest === 0;
      case 'everwrong': return s.n && s.ok < s.n;
      case 'bookmark': return !!s.bookmark;
      default: return true;
    }
  });
  if (f.order === 'random') qs = shuffle(qs);
  else if (f.order === 'weak') qs.sort((a, b) => weak(b) - weak(a));
  if (+f.count > 0) qs = qs.slice(0, +f.count);
  return qs;
}
const weak = (q) => { const s = st(q); return (s.n ? (s.n - s.ok) / s.n : 0.4) + (s.bookmark ? 0.3 : 0) + (s.latest === 0 ? 0.5 : 0); };

function startSession(qs, title, mode = 'p2') {
  if (!qs.length) return toast('条件に合う問題がありません');
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ids: qs.map((q) => q.id), i: 0, title, mode, id: 'p2' + Date.now().toString(36), results: {} }));
  if (location.hash === '#/p2/session') view(); else location.hash = '#/p2/session';
}
const getS = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; } };
const putS = (s) => sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));

// ================= 音声プレーヤー =================
const player = { a: null, q: null, stopAt: null, onState: null };
function playerState() { player.onState?.(!!player.a && !player.a.paused); }
async function playQ(q, from = 0, to = null) {
  stopSpeech();
  if (!player.a) {
    player.a = new Audio();
    player.a.addEventListener('timeupdate', () => {
      if (player.stopAt != null && player.a.currentTime >= player.stopAt) { player.a.pause(); player.stopAt = null; }
      player.onTime?.(player.a.currentTime, player.a.duration);
    });
    for (const ev of ['play', 'pause', 'ended']) player.a.addEventListener(ev, playerState);
    player.a.addEventListener('ended', () => player.onEnded?.());
  }
  if (player.q !== q.id) {
    try { player.a.src = await resolveUrl(audioUrl(q)); } catch (e) { toast('音声を読み込めませんでした'); return; }
    player.q = q.id;
  }
  player.a.playbackRate = store.local.p2rate || 1;
  player.a.currentTime = from;
  player.stopAt = to;
  try { await player.a.play(); } catch (e) { /* 自動再生が許可されていない端末ではボタンで再生 */ }
}
function pauseQ() { if (player.a) { player.a.pause(); player.stopAt = null; } }
const playingQ = () => player.a && !player.a.paused;
window.addEventListener('hashchange', () => { pauseQ(); clearInterval(mockTick); });

// ================= ルーター（#/p2/...） =================
export async function part2View(root, params, sub = '') {
  injectCss();
  const app = root;
  if (!P2.loaded) {
    root.innerHTML = '<div class="loading">Part 2 を読み込み中…</div>';
    try { await load(); } catch (e) { root.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  }
  view.root = app; view.params = params; view.sub = sub || '';
  return view();
}
function view() {
  const root = view.root, sub = view.sub, params = view.params;
  pauseQ(); player.onState = player.onTime = player.onEnded = null; clearInterval(mockTick);
  root._keys = null;
  if (!sub) return home(root);
  if (sub === 'practice') return practice(root, params);
  if (sub === 'session') return session(root);
  if (sub === 'mock') return mockList(root);
  if (sub === 'mock/run') return mockRun(root);
  let m;
  if ((m = sub.match(/^mock\/result\/(.+)$/))) return mockResult(root, decodeURIComponent(m[1]));
  if ((m = sub.match(/^q\/(p2-\d+)/))) return single(root, m[1]);
  root.innerHTML = '<div class="card">ページが見つかりません</div>';
}

const subnav = (on) => `<div class="p2-sub">
  ${[['', 'ホーム'], ['practice', '演習'], ['mock', '模試'], ['practice?status=wrong', '苦手復習']].map(([h, l]) => `<a href="#/p2${h ? '/' + h : ''}" class="${on === h ? 'on' : ''}">${l}</a>`).join('')}
</div>`;

// ================= ホーム（Part 2 ダッシュボード） =================
async function home(root) {
  const qs = P2.questions;
  const done = qs.filter((q) => st(q).n);
  const firstOk = done.filter((q) => st(q).first === 1).length;
  const tot = done.reduce((a, q) => a + st(q).n, 0), ok = done.reduce((a, q) => a + st(q).ok, 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayN = done.filter((q) => (st(q).last || '').slice(0, 10) === today).length;
  const wrongNow = qs.filter((q) => st(q).n && st(q).latest === 0).length;
  const nextQ = qs.find((q) => !st(q).n && !q.set);
  const byType = TYPES.map((t) => {
    const xs = qs.filter((q) => q.category === t), d = xs.filter((q) => st(q).n);
    const n = d.reduce((a, q) => a + st(q).n, 0), o = d.reduce((a, q) => a + st(q).ok, 0);
    return { t, total: xs.length, done: d.length, rate: pct(o, n), n };
  });
  const exams = (await api('exams').catch(() => [])).filter((e) => String(e.id).startsWith('p2'));
  root.innerHTML = `
    ${partSwitcher('p2')}
    ${subnav('')}
    <section class="p2-hero">
      <div class="p2-hero-text">
        <div class="p2-kicker">PART 2 ・ QUESTION-RESPONSE</div>
        <h1>最初の一語を聞き逃さない。</h1>
        <p>問いかけに対する最も自然な応答を (A)(B)(C) から。音声のみ・スクリプトは解答後に表示します。</p>
        <div class="row gap">
          ${nextQ ? `<button class="btn p2-go" id="goNext">▶ 続きから（No.${nextQ.label}〜 10問）</button>` : ''}
          ${wrongNow ? `<button class="btn p2-ghost" id="goWrong">間違えた ${wrongNow}問を復習</button>` : ''}
          <a class="btn p2-ghost" href="#/p2/mock">模試 25問</a>
        </div>
      </div>
      <div class="p2-wave" aria-hidden="true">${Array.from({ length: 28 }, (_, i) => `<i style="--h:${18 + Math.round(Math.abs(Math.sin(i * 1.7)) * 62)}%;--d:${(i % 7) * 0.12}s"></i>`).join('')}</div>
    </section>
    <div class="stats-grid">
      ${stat('解答済み', `${done.length}<small>/ ${qs.length}問</small>`, `今日 ${todayN}問`)}
      ${stat('初回正答率', `${pct(firstOk, done.length)}<small>%</small>`, `${done.length}問`)}
      ${stat('全体の正答率', `${pct(ok, tot)}<small>%</small>`, `解答 ${tot}回`)}
      ${stat('要復習', `${wrongNow}<small>問</small>`, '直近で間違えた問題')}
    </div>
    <div class="two-col">
      <section class="card"><h2>問題タイプ別</h2>
        <table class="tbl">${byType.map((b) => `<tr><td><a href="#/p2/practice?type=${encodeURIComponent(b.t)}">${esc(b.t)}</a></td><td class="small muted">${b.done}/${b.total}</td>
          <td><div class="bar"><span style="width:${b.rate}%" class="${b.n && b.rate < 70 ? 'low' : ''}"></span><em>${b.n ? b.rate + '%' : '-'}</em></div></td></tr>`).join('')}</table>
      </section>
      <section class="card"><h2>模試</h2>
        ${exams.length ? `<table class="tbl">${exams.slice(0, 6).map((e) => `<tr><td class="small">${fmtDate(e.finished)}</td><td>${esc(e.title.replace('Part 2 ', ''))}</td><td><b>${e.score}/${e.total}</b></td><td><a href="#/p2/mock/result/${encodeURIComponent(e.id)}">結果</a></td></tr>`).join('')}</table>`
          : '<p class="muted small">本番と同じ 25問・連続再生の模試が 10 セットあります。</p>'}
        <a class="btn sm" href="#/p2/mock">模試を選ぶ</a>
      </section>
    </div>
    <section class="card"><h2>全 ${qs.length} 問マップ</h2>
      <div class="legend small"><span class="lg2 none"></span>未回答 <span class="lg2 good"></span>正解 <span class="lg2 bad"></span>直近で不正解 <span class="lg2 bm"></span>ブックマーク</div>
      ${mapGrid(qs)}
    </section>`;
  $('#goNext', root)?.addEventListener('click', () => startSession(qs.filter((q) => !st(q).n && !q.set).slice(0, 10), '続きから'));
  $('#goWrong', root)?.addEventListener('click', () => startSession(qs.filter((q) => st(q).n && st(q).latest === 0), '間違えた問題'));
}
const stat = (label, val, sub) => `<div class="card stat"><div class="label">${label}</div><div class="val">${val}</div><div class="sub small muted">${sub}</div></div>`;
function mapGrid(qs) {
  const groups = [];
  for (const q of qs) {
    const g = q.set ? `模試 セット${q.set}` : q.category;
    if (!groups.length || groups[groups.length - 1].g !== g) groups.push({ g, qs: [] });
    groups[groups.length - 1].qs.push(q);
  }
  return groups.map(({ g, qs: xs }) => `<div class="p2-map-row"><div class="small muted">${esc(g)}</div><div class="p2-map">${xs.map((q) => {
    const s = st(q); const c = !s.n ? 'none' : s.latest === 0 ? 'bad' : 'good';
    return `<a href="#/p2/q/${q.id}" class="${c} ${s.bookmark ? 'bm' : ''}" title="No.${q.label} ${esc(q.script)}"></a>`;
  }).join('')}</div></div>`).join('');
}

// ================= 演習の条件 =================
function practice(root, params) {
  const f = { order: 'seq', count: 10, section: 'training', status: 'unanswered', ...(store.local.p2practice || {}) };
  if (params.get('type')) { f.type = params.get('type'); f.status = ''; f.section = ''; }
  if (params.get('status')) { f.status = params.get('status'); f.section = ''; f.type = ''; f.order = 'seq'; f.count = 0; }
  const sel = (name, opts, v) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${k}" ${String(v ?? '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  root.innerHTML = `
    ${subnav(params.get('status') === 'wrong' ? 'practice?status=wrong' : 'practice')}
    <div class="page-head"><h1>Part 2 演習</h1></div>
    <form class="card" id="pf"><div class="form-grid">
      <label>範囲${sel('section', [['', 'すべて'], ['training', 'トレーニング（第1〜6章）'], ['mock', '模試の問題']], f.section)}</label>
      <label>問題タイプ${sel('type', [['', 'すべて'], ...TYPES.map((t) => [t, t])], f.type)}</label>
      <label>状態${sel('status', [['', 'すべて'], ['unanswered', '未回答'], ['wrong', '直近で間違えた'], ['everwrong', '一度でも間違えた'], ['bookmark', 'ブックマーク']], f.status)}</label>
      <label>順序${sel('order', [['seq', '番号順'], ['random', 'ランダム'], ['weak', '苦手な順']], f.order)}</label>
      <label>出題数<input name="count" type="number" min="0" value="${esc(f.count)}" placeholder="0=すべて"></label>
    </div>
    <div class="row gap"><button class="btn primary" type="submit">開始</button><span class="muted small" id="cnt"></span></div></form>
    <div class="card small muted">操作: <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd>（または <kbd>A</kbd><kbd>B</kbd><kbd>C</kbd>）解答 ・ <kbd>Space</kbd> 再生/停止 ・ <kbd>R</kbd> 最初から ・ <kbd>Enter</kbd> 次へ ・ <kbd>←</kbd> 前 ・ <kbd>S</kbd> スクリプト表示 ・ 英単語クリックで辞書と単語帳登録</div>`;
  const form = $('#pf', root);
  const read = () => Object.fromEntries($$('select, input', form).map((e) => [e.name, e.value]));
  const upd = () => { $('#cnt', root).textContent = `該当 ${filter({ ...read(), count: 0 }).length} 問`; };
  form.oninput = upd; upd();
  form.onsubmit = (e) => { e.preventDefault(); const x = read(); store.local.p2practice = x; saveLocal(); startSession(filter(x), 'Part 2 演習'); };
}

// ================= 1 問の画面（演習・復習・単独表示） =================
function session(root) {
  const s = getS();
  if (!s || !s.ids.length) { location.hash = '#/p2/practice'; return; }
  renderQ(root, s);
}
function single(root, id) {
  const q = P2.byId.get(id);
  if (!q) { root.innerHTML = '<div class="card">問題が見つかりません</div>'; return; }
  renderQ(root, { ids: [id], i: 0, title: '問題', id: 'p2v' + Date.now().toString(36), results: { [id]: { choice: null, view: true } } }, { single: true });
}

function renderQ(root, s, opt = {}) {
  const q = P2.byId.get(s.ids[s.i]);
  if (!q) { s.i = 0; putS(s); return renderQ(root, s, opt); }
  const res = s.results[q.id];
  const answered = !!res;
  const t0 = Date.now();
  const showScript = !!store.local.p2script;
  root.innerHTML = `
    ${opt.single ? subnav('-') : ''}
    <div class="qbar">
      <span class="qpos">${opt.single ? '' : `${s.i + 1} / ${s.ids.length}`}</span>
      <span class="qmeta">No.${q.label} ・ ${esc(q.category)}${q.set ? ` ・ 模試 セット${q.set}-${q.local}` : ''}</span>
      <span class="timer" id="timer"></span>
      <button class="icon-btn star ${st(q).bookmark ? 'on' : ''}" id="bm" title="ブックマーク (B)">${st(q).bookmark ? '★' : '☆'}</button>
    </div>
    ${opt.single ? '' : `<div class="progress"><div style="width:${((s.i + (answered ? 1 : 0)) / s.ids.length) * 100}%"></div></div>`}
    <article class="card p2-card ${answered ? 'answered' : ''}">
      <div class="p2-player">
        <button class="p2-play" id="play" title="再生/停止 (Space)" aria-label="再生"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" class="ring-bg"/><circle cx="24" cy="24" r="21" class="ring" id="ring"/></svg><span id="playIcon">▶</span></button>
        <div class="p2-pmain">
          <div class="p2-track"><div id="trackFill"></div></div>
          <div class="row gap small">
            <button class="btn sm" id="replay" title="最初から (R)">↺ 最初から</button>
            <label class="muted">速度 <select id="rate">${[0.8, 0.9, 1, 1.1, 1.2, 1.35].map((r) => `<option value="${r}" ${(store.local.p2rate || 1) == r ? 'selected' : ''}>${r}x</option>`).join('')}</select></label>
            <label class="muted"><input type="checkbox" id="auto" ${store.local.p2auto !== false ? 'checked' : ''}> 自動再生</label>
            ${answered ? '' : `<label class="muted"><input type="checkbox" id="scr" ${showScript ? 'checked' : ''}> 解答前もスクリプト</label>`}
          </div>
        </div>
      </div>
      ${answered ? '' : `<div class="p2-prompt">${showScript ? `<div class="en p2-script-pre">${esc(q.script)}</div><ol class="p2-pre-ch">${q.choices.map((c, i) => `<li><b>(${L3[i]})</b> ${esc(c)}</li>`).join('')}</ol>` : `<div class="p2-mark">Mark your answer on your answer sheet.</div>`}</div>`}
      <div class="p2-sheet ${answered ? 'done' : ''}" role="group" aria-label="解答">
        ${L3.map((l, i) => `<button class="p2-bubble ${answered && i === q.answer ? 'correct' : ''} ${answered && res.choice === i && i !== q.answer ? 'wrong' : ''} ${answered && res.choice === i ? 'sel' : ''}" data-i="${i}" ${answered ? 'tabindex="-1"' : ''}><span>${l}</span><small>${i + 1}</small></button>`).join('')}
      </div>
      ${answered ? '' : '<div class="small muted center">問いと3つの応答を聞いて、最も適切なものを選んでください</div>'}
      ${opt.single ? '' : `<div class="row gap p2-nav"><button class="btn ghost" id="prev" ${s.i === 0 ? 'disabled' : ''}>← 前</button><span class="spacer"></span>
        <button class="btn ${answered ? 'primary' : 'ghost'}" id="next">${s.i === s.ids.length - 1 ? '終了' : answered ? '次の問題 →' : 'スキップ →'}</button></div>`}
    </article>
    <div id="explain">${answered ? explainHtml(q, res) : ''}</div>`;
  hydrateImages(root);
  markRegistered(root);

  // 音声
  const ring = $('#ring', root), fill = $('#trackFill', root), icon = $('#playIcon', root);
  const C = 2 * Math.PI * 21;
  ring.style.strokeDasharray = C; ring.style.strokeDashoffset = C;
  player.onTime = (t, d) => { const r = d ? Math.min(1, t / d) : 0; ring.style.strokeDashoffset = C * (1 - r); fill.style.width = r * 100 + '%'; };
  player.onState = (p) => { icon.textContent = p ? '❚❚' : '▶'; $('#play', root)?.classList.toggle('on', p); };
  player.onEnded = null;
  const toggle = () => (playingQ() && player.q === q.id ? pauseQ() : player.q === q.id && player.a.currentTime > 0 && player.a.currentTime < player.a.duration - 0.05 ? player.a.play() : playQ(q));
  $('#play', root).onclick = toggle;
  $('#replay', root).onclick = () => playQ(q, 0);
  $('#rate', root).onchange = (e) => { store.local.p2rate = +e.target.value; saveLocal(); if (player.a) player.a.playbackRate = store.local.p2rate; };
  $('#auto', root).onchange = (e) => { store.local.p2auto = e.target.checked; saveLocal(); };
  $('#scr', root)?.addEventListener('change', (e) => { store.local.p2script = e.target.checked; saveLocal(); renderQ(root, s, opt); });
  if (!answered && store.local.p2auto !== false) setTimeout(() => { if (location.hash.startsWith('#/p2') && $('#play', root)) playQ(q); }, 250);
  $$('[data-seg]', root).forEach((b) => (b.onclick = () => { const [a, z] = b.dataset.seg.split(',').map(Number); playQ(q, a, z || null); }));
  $$('[data-playall]', root).forEach((b) => (b.onclick = () => playQ(q, 0)));

  // 解答
  const timer = $('#timer', root);
  if (answered && res.ms) timer.textContent = fmtSec(res.ms);
  const answer = async (i) => {
    if (s.results[q.id]) return;
    const ms = Date.now() - t0;
    const correct = i === q.answer;
    s.results[q.id] = { choice: i, correct, ms };
    putS(s);
    try {
      const r = await api('attempt', { body: { qid: q.id, choice: i, correct, ms, mode: s.mode || 'p2', session: s.id } });
      const x = store.stats[q.id] || { n: 0, ok: 0 };
      store.stats[q.id] = { ...x, n: x.n + 1, ok: x.ok + (correct ? 1 : 0), latest: correct ? 1 : 0, first: x.n ? x.first : correct ? 1 : 0, lastMs: ms, last: new Date().toISOString() };
      if (r?.id) { s.results[q.id].attemptId = r.id; putS(s); }
    } catch (e) { toast('記録の保存に失敗しました: ' + e.message); }
    const keepPlaying = playingQ();
    renderQ(root, s, opt);
    if (!keepPlaying) pauseQ();
    $('#explain', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $$('.p2-bubble', root).forEach((b) => (b.onclick = () => answer(+b.dataset.i)));
  // 押し間違いの取り消し
  $('#undo', root)?.addEventListener('click', async () => {
    const r = s.results[q.id];
    if (!r?.attemptId) return;
    try { const out = await api('attempt/' + r.attemptId, { method: 'DELETE' }); if (out?.stats) store.stats = out.stats; } catch (e) { return toast(e.message); }
    delete s.results[q.id]; putS(s); renderQ(root, s, opt);
  });
  const go = (d) => {
    if (d > 0 && s.i === s.ids.length - 1) return finish(root, s);
    s.i = Math.max(0, Math.min(s.ids.length - 1, s.i + d)); putS(s); renderQ(root, s, opt); window.scrollTo(0, 0);
  };
  $('#prev', root)?.addEventListener('click', () => go(-1));
  $('#next', root)?.addEventListener('click', () => go(1));
  $('#bm', root).onclick = () => bookmark(q, root);
  root._keys = (e) => {
    const k = e.key.toLowerCase();
    if (!answered && ['1', '2', '3', 'a', 'b', 'c'].includes(k) && !(k === 'b' && e.shiftKey)) {
      e.preventDefault(); return answer(['1', 'a'].includes(k) ? 0 : ['2', 'b'].includes(k) ? 1 : 2);
    }
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (k === 'r') playQ(q, 0);
    else if (k === 's' && !answered) $('#scr', root)?.click();
    else if (k === 'b' && answered) bookmark(q, root);
    else if (e.key === 'Enter' && !opt.single) { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowRight' && !opt.single) go(1);
    else if (e.key === 'ArrowLeft' && !opt.single) go(-1);
  };
}

async function bookmark(q, root) {
  const on = !st(q).bookmark;
  try { await api('qstate', { body: { qid: q.id, bookmark: on ? 1 : 0 } }); } catch (e) { return toast(e.message); }
  store.stats[q.id] = { ...(store.stats[q.id] || { n: 0, ok: 0 }), bookmark: on ? 1 : 0 };
  const b = $('#bm', root); if (b) { b.textContent = on ? '★' : '☆'; b.classList.toggle('on', on); }
  toast(on ? 'ブックマークしました' : 'ブックマークを外しました');
}

function explainHtml(q, res) {
  const view = res.view;
  const ok = res.correct;
  const seg = q.seg || {};
  const segBtn = (k, label) => (seg[k] ? `<button class="icon-btn" data-seg="${seg[k][0]},${seg[k][1]}" title="${label}を再生">🔊</button>` : '');
  return `
    <section class="card p2-explain">
      ${view ? '' : `<div class="p2-verdict ${ok ? 'ok' : 'ng'}"><b>${ok ? '○ 正解' : '× 不正解'}</b>
        <span>正解は <b>(${L3[q.answer]})</b>${ok ? '' : `・あなたの解答 (${L3[res.choice]})`}${res.ms ? ` ・ ${fmtSec(res.ms)}` : ''}</span>
        ${res.attemptId ? '<button class="btn sm ghost" id="undo" title="押し間違いを取り消して解き直す">取り消し</button>' : ''}</div>`}
      <div class="p2-script">
        <div class="p2-label">Script ${segBtn('q', '問い')}<button class="btn sm ghost" data-playall="1">▶ 全体</button></div>
        <div class="en p2-qline" data-src="${q.id}">${tokenize(q.script)}</div>
        <div class="ja muted">${esc(q.script_ja)}</div>
      </div>
      <ol class="p2-choices">
        ${q.choices.map((c, i) => `<li class="${i === q.answer ? 'correct' : ''} ${!view && res.choice === i && i !== q.answer ? 'wrong' : ''}">
          <span class="p2-letter">${L3[i]}</span>
          <div><div class="en" data-src="${q.id}-${L3[i]}">${tokenize(c)} ${segBtn(L3[i], `(${L3[i]})`)}</div><div class="ja small muted">${esc(q.choices_ja[i] || '')}</div></div>
          ${i === q.answer ? '<span class="p2-ans">正解</span>' : ''}</li>`).join('')}
      </ol>
      ${q.explanation ? `<h3>解説</h3><div class="p2-expl">${explHtml(q.explanation)}</div>` : ''}
      ${q.vocab?.length ? `<h3>語句</h3><div class="p2-vocab" data-src="${q.id}">${q.vocab.map((v) => `<span>${tokenize(v)}</span>`).join('')}</div>` : ''}
      <details class="p2-orig" ${store.local.p2orig ? 'open' : ''}><summary>原本の解説ページ（No.${q.label}・p.${q.page}）</summary><img data-enc="/crops/${q.crop}" alt="原本の解説" loading="lazy"></details>
    </section>`;
}
// 解説: (A)(B)(C) と英単語を見やすく
function explHtml(t) {
  return tokenize(t).replace(/\(\s*(<span class="w">)?([ABC])(<\/span>)?\s*\)/g, '<b class="p2-ref">($2)</b>');
}

function finish(root, s) {
  pauseQ();
  const ids = s.ids, r = s.results;
  const done = ids.filter((id) => r[id] && !r[id].view);
  const okN = done.filter((id) => r[id].correct).length;
  const wrong = done.filter((id) => !r[id].correct);
  root.innerHTML = `
    ${subnav('-')}
    <section class="card p2-finish">
      <div class="p2-kicker">${esc(s.title || 'Part 2 演習')}</div>
      <div class="p2-score">${okN}<small> / ${done.length}</small></div>
      <div class="muted">正答率 ${pct(okN, done.length)}%</div>
      <div class="row gap center" style="margin-top:14px">
        ${wrong.length ? '<button class="btn primary" id="again">間違えた問題をもう一度</button>' : ''}
        <a class="btn" href="#/p2">Part 2 ホーム</a><a class="btn" href="#/p2/practice">続けて演習</a>
      </div>
    </section>
    <section class="card"><table class="tbl">${ids.map((id) => { const q = P2.byId.get(id), x = r[id];
      return `<tr><td>${x ? (x.correct ? '<b class="ok">○</b>' : '<b class="ng">×</b>') : '-'}</td><td><a href="#/p2/q/${id}">No.${q.label}</a></td><td class="en small">${esc(q.script)}</td><td class="small muted">${esc(q.category)}</td></tr>`; }).join('')}</table></section>`;
  $('#again', root)?.addEventListener('click', () => startSession(wrong.map((id) => P2.byId.get(id)), '間違えた問題'));
}

// ================= 模試（25問・連続再生） =================
let mockTick = null;
async function mockList(root) {
  const exams = (await api('exams').catch(() => [])).filter((e) => String(e.id).startsWith('p2'));
  const sets = [...new Set(P2.questions.filter((q) => q.set).map((q) => q.set))];
  root.innerHTML = `
    ${subnav('mock')}
    <div class="page-head"><h1>Part 2 模試</h1></div>
    <div class="card small muted">本番と同じ 25 問。音声は止められず、問いと応答が終わると 5 秒で次の問題へ進みます（本番は約 5 秒）。採点後に解説を確認できます。</div>
    <div class="p2-sets">${sets.map((n) => {
      const hist = exams.filter((e) => e.title.endsWith(`セット${n}`));
      const best = hist.length ? Math.max(...hist.map((e) => e.score)) : null;
      return `<button class="card p2-set" data-set="${n}"><span class="p2-set-n">SET ${n}</span><span class="small muted">No.${P2.questions.find((q) => q.set === n).label}〜 ・ 25問</span>
        <span class="p2-set-best">${best != null ? `最高 <b>${best}</b>/25 ・ ${hist.length}回` : '未受験'}</span></button>`;
    }).join('')}</div>
    <div class="card row gap"><b>ランダム模試</b><span class="small muted">全問からタイプのバランスを保って 25 問</span><span class="spacer"></span><button class="btn" id="rand">開始</button></div>`;
  $$('.p2-set', root).forEach((b) => (b.onclick = () => beginMock(P2.questions.filter((q) => q.set === +b.dataset.set), `Part 2 模試 セット${b.dataset.set}`)));
  $('#rand', root).onclick = () => {
    const by = TYPES.map((t) => shuffle(P2.questions.filter((q) => q.category === t)));
    const out = []; let k = 0;
    while (out.length < 25) { const g = by[k++ % by.length]; if (g.length) out.push(g.pop()); }
    beginMock(shuffle(out), 'Part 2 ランダム模試');
  };
}
function beginMock(qs, title) {
  sessionStorage.setItem(MOCK_KEY, JSON.stringify({ id: 'p2m' + Date.now().toString(36), title, ids: qs.map((q) => q.id), i: 0, answers: qs.map(() => null), times: qs.map(() => 0), started: new Date().toISOString() }));
  location.hash = '#/p2/mock/run';
}
function mockRun(root) {
  let ex; try { ex = JSON.parse(sessionStorage.getItem(MOCK_KEY)); } catch (e) { ex = null; }
  if (!ex) { location.hash = '#/p2/mock'; return; }
  const save = () => sessionStorage.setItem(MOCK_KEY, JSON.stringify(ex));
  let shownAt = Date.now(), wait = null;
  const draw = () => {
    clearInterval(mockTick);
    const q = P2.byId.get(ex.ids[ex.i]);
    shownAt = Date.now(); wait = null;
    root.innerHTML = `
      <div class="qbar"><span class="qpos">${esc(ex.title)}</span><span class="qmeta">${ex.i + 1} / ${ex.ids.length}</span><span class="spacer"></span><button class="btn sm ghost" id="quit">中断</button></div>
      <div class="progress"><div style="width:${(ex.i / ex.ids.length) * 100}%"></div></div>
      <article class="card p2-card p2-mockcard">
        <div class="p2-mock-no">${ex.i + 1}.</div>
        <div class="p2-mark">Mark your answer on your answer sheet.</div>
        <div class="p2-sheet">${L3.map((l, i) => `<button class="p2-bubble ${ex.answers[ex.i] === i ? 'sel' : ''}" data-i="${i}"><span>${l}</span><small>${i + 1}</small></button>`).join('')}</div>
        <div class="p2-track"><div id="trackFill"></div></div>
        <div class="small muted center" id="st">再生中…</div>
        <div class="row gap center"><button class="btn sm" id="start" hidden>▶ 再生</button><button class="btn sm ghost" id="skip">次へ →</button></div>
      </article>`;
    const fill = $('#trackFill', root);
    player.onTime = (t, d) => { fill.style.width = (d ? (t / d) * 100 : 0) + '%'; };
    player.onState = null;
    player.onEnded = () => {
      let left = 5;
      $('#st', root).textContent = `解答時間 ${left} 秒`;
      wait = setInterval(() => { left--; if ($('#st', root)) $('#st', root).textContent = `解答時間 ${left} 秒`; if (left <= 0) { clearInterval(wait); next(); } }, 1000);
      mockTick = wait;
    };
    const pick = (i) => { ex.answers[ex.i] = i; ex.times[ex.i] = Date.now() - shownAt; save(); $$('.p2-bubble', root).forEach((b, k) => b.classList.toggle('sel', k === i)); };
    $$('.p2-bubble', root).forEach((b) => (b.onclick = () => pick(+b.dataset.i)));
    $('#skip', root).onclick = next;
    $('#quit', root).onclick = () => { if (confirm('模試を中断しますか？（ここまでの解答は保存されません）')) { pauseQ(); sessionStorage.removeItem(MOCK_KEY); location.hash = '#/p2/mock'; } };
    $('#start', root).onclick = () => { $('#start', root).hidden = true; playQ(q, 0); };
    playQ(q, 0).then(() => { if (!playingQ()) { $('#start', root).hidden = false; $('#st', root).textContent = '▶ を押して開始'; } });
    root._keys = (e) => {
      const k = e.key.toLowerCase();
      if (['1', '2', '3', 'a', 'b', 'c'].includes(k)) { e.preventDefault(); pick(['1', 'a'].includes(k) ? 0 : ['2', 'b'].includes(k) ? 1 : 2); }
    };
  };
  const next = async () => {
    clearInterval(wait); clearInterval(mockTick); pauseQ();
    if (ex.i < ex.ids.length - 1) { ex.i++; save(); return draw(); }
    // 採点・記録
    const qs = ex.ids.map((id) => P2.byId.get(id));
    const score = qs.filter((q, i) => ex.answers[i] === q.answer).length;
    root.innerHTML = '<div class="loading">採点中…</div>';
    for (let i = 0; i < qs.length; i++) {
      if (ex.answers[i] == null) continue;
      const correct = ex.answers[i] === qs[i].answer;
      try {
        await api('attempt', { body: { qid: qs[i].id, choice: ex.answers[i], correct, ms: ex.times[i], mode: 'p2mock', session: ex.id } });
        const x = store.stats[qs[i].id] || { n: 0, ok: 0 };
        store.stats[qs[i].id] = { ...x, n: x.n + 1, ok: x.ok + (correct ? 1 : 0), latest: correct ? 1 : 0, first: x.n ? x.first : correct ? 1 : 0, lastMs: ex.times[i], last: new Date().toISOString() };
      } catch (e) { /* 続行 */ }
    }
    try { await api('exams', { body: { id: ex.id, title: ex.title, started: ex.started, limitSec: 0, qids: ex.ids, answers: ex.answers, times: ex.times, score, total: qs.length } }); } catch (e) { toast(e.message); }
    sessionStorage.removeItem(MOCK_KEY);
    location.hash = '#/p2/mock/result/' + ex.id;
  };
  draw();
}
async function mockResult(root, id) {
  const e = (await api('exams').catch(() => [])).find((x) => x.id === id);
  if (!e) { root.innerHTML = '<div class="card">結果が見つかりません</div>'; return; }
  const qs = e.qids.map((x) => P2.byId.get(x)).filter(Boolean);
  const wrong = qs.filter((q, i) => e.answers[i] !== q.answer);
  const byType = TYPES.map((t) => { const xs = qs.map((q, i) => [q, i]).filter(([q]) => q.category === t); return { t, n: xs.length, ok: xs.filter(([q, i]) => e.answers[i] === q.answer).length }; }).filter((x) => x.n);
  root.innerHTML = `
    ${subnav('mock')}
    <section class="card p2-finish">
      <div class="p2-kicker">${esc(e.title)} ・ ${fmtDate(e.finished)}</div>
      <div class="p2-score">${e.score}<small> / ${e.total}</small></div>
      <div class="muted">正答率 ${pct(e.score, e.total)}%</div>
      <div class="row gap center" style="margin-top:14px">${wrong.length ? '<button class="btn primary" id="rev">間違えた問題を解説付きで復習</button>' : ''}<a class="btn" href="#/p2/mock">模試一覧</a></div>
    </section>
    <div class="two-col">
      <section class="card"><h2>タイプ別</h2><table class="tbl">${byType.map((b) => `<tr><td>${esc(b.t)}</td><td>${b.ok}/${b.n}</td><td><div class="bar"><span style="width:${pct(b.ok, b.n)}%" class="${pct(b.ok, b.n) < 70 ? 'low' : ''}"></span><em>${pct(b.ok, b.n)}%</em></div></td></tr>`).join('')}</table></section>
      <section class="card"><h2>全問の結果</h2><table class="tbl">${qs.map((q, i) => `<tr><td>${i + 1}</td><td>${e.answers[i] === q.answer ? '<b class="ok">○</b>' : '<b class="ng">×</b>'}</td>
        <td class="small">${e.answers[i] == null ? '無回答' : `(${L3[e.answers[i]]})`} → (${L3[q.answer]})</td><td><a href="#/p2/q/${q.id}">解説</a></td></tr>`).join('')}</table></section>
    </div>`;
  $('#rev', root)?.addEventListener('click', () => {
    const s = { ids: wrong.map((q) => q.id), i: 0, title: e.title + ' の復習', mode: 'p2', id: 'p2r' + Date.now().toString(36), results: {} };
    wrong.forEach((q) => { const i = qs.indexOf(q); s.results[q.id] = { choice: e.answers[i], correct: false, ms: e.times[i] }; });
    putS(s); location.hash = '#/p2/session';
  });
}

// ================= 見た目 =================
function injectCss() {
  if (document.getElementById('p2css')) return;
  const el = document.createElement('style');
  el.id = 'p2css';
  el.textContent = `
.part-switch { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 0 0 14px; }
.part-tile { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: 14px; background: var(--card); border: 1px solid var(--line); color: var(--text); box-shadow: var(--shadow); position: relative; overflow: hidden; }
.part-tile:hover { border-color: var(--primary); }
.part-tile.on { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-soft) inset, var(--shadow); }
.part-tile.on::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--primary); }
.part-tile.soon { opacity: .55; cursor: default; }
.pt-part { font: 800 12px var(--en); letter-spacing: .08em; color: var(--primary); text-transform: uppercase; }
.part-tile.soon .pt-part { color: var(--muted); }
.pt-name { font-weight: 700; font-size: 15px; } .pt-sub { font-size: 12px; color: var(--muted); }
.pt-bar { height: 4px; border-radius: 2px; background: var(--soft); margin-top: 6px; overflow: hidden; } .pt-bar i { display: block; height: 100%; background: var(--primary); }
.p2-sub { display: flex; gap: 4px; margin: -4px 0 14px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.p2-sub a { padding: 8px 14px; color: var(--muted); border-bottom: 2px solid transparent; white-space: nowrap; font-size: 14px; }
.p2-sub a.on { color: var(--text); border-bottom-color: #0f9d8a; font-weight: 600; }
.p2-hero { display: grid; grid-template-columns: 1fr 220px; gap: 18px; align-items: center; padding: 26px 28px; border-radius: 18px; margin-bottom: 14px; color: #eafffb;
  background: radial-gradient(120% 140% at 100% 0%, #1c7a8c 0%, #0f4c5c 45%, #0b2e3b 100%); box-shadow: var(--shadow); }
.p2-hero h1 { font-size: 26px; margin: 4px 0 6px; color: #fff; } .p2-hero p { margin: 0 0 16px; color: #bfe7e1; font-size: 14px; }
.p2-kicker { font: 700 11px var(--en); letter-spacing: .16em; color: #7fe0cf; }
.p2-card .p2-kicker, .p2-finish .p2-kicker { color: #0f9d8a; }
.btn.p2-go { background: #2dd4bf; border-color: #2dd4bf; color: #062a2b; }
.btn.p2-ghost { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.25); color: #eafffb; }
.p2-wave { display: flex; align-items: center; gap: 4px; height: 110px; }
.p2-wave i { flex: 1; height: var(--h); border-radius: 3px; background: linear-gradient(#5eead4, #0ea5a0); opacity: .85; animation: p2w 1.6s ease-in-out var(--d) infinite alternate; transform-origin: center; }
@keyframes p2w { from { transform: scaleY(.55); } to { transform: scaleY(1); } }
@media (prefers-reduced-motion: reduce) { .p2-wave i { animation: none; } }
.legend .lg2 { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin: 0 4px 0 10px; vertical-align: -1px; }
.lg2.none, .p2-map a.none { background: var(--soft); border: 1px solid var(--line); } .lg2.good, .p2-map a.good { background: #34c08a; } .lg2.bad, .p2-map a.bad { background: var(--ng); }
.lg2.bm { background: var(--card); box-shadow: inset 0 0 0 2px #f5b300; }
.p2-map-row { margin-top: 10px; } .p2-map { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
.p2-map a { width: 12px; height: 12px; border-radius: 3px; } .p2-map a.bm { box-shadow: inset 0 0 0 2px #f5b300; } .p2-map a:hover { transform: scale(1.4); }
.p2-card { padding: 22px 22px 16px; }
.p2-player { display: flex; gap: 16px; align-items: center; }
.p2-play { position: relative; width: 64px; height: 64px; flex: none; border: none; border-radius: 50%; background: #0f9d8a; color: #fff; font-size: 20px; cursor: pointer; box-shadow: 0 4px 14px rgba(15,157,138,.35); }
.p2-play.on { background: #0b7f70; } .p2-play svg { position: absolute; inset: -6px; width: 76px; height: 76px; transform: rotate(-90deg); pointer-events: none; }
.p2-play .ring-bg { fill: none; stroke: var(--line); stroke-width: 3; } .p2-play .ring { fill: none; stroke: #2dd4bf; stroke-width: 3; stroke-linecap: round; transition: stroke-dashoffset .2s linear; }
.p2-play span { position: relative; }
.p2-pmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.p2-track { height: 6px; border-radius: 3px; background: var(--soft); overflow: hidden; } .p2-track div { height: 100%; width: 0; background: linear-gradient(90deg, #0f9d8a, #2dd4bf); }
.p2-prompt { margin: 22px 0 6px; text-align: center; }
.p2-mark { font: italic 500 17px var(--en); color: var(--muted); margin: 18px 0 10px; text-align: center; }
.p2-script-pre { font-size: 17px; text-align: left; } .p2-pre-ch { text-align: left; font-family: var(--en); color: var(--muted); padding-left: 0; list-style: none; }
.p2-sheet { display: flex; justify-content: center; gap: 22px; margin: 16px 0 14px; }
.p2-bubble { width: 78px; height: 78px; border-radius: 50%; border: 2px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; font: 700 28px var(--en); transition: transform .08s, border-color .12s, background .12s; }
.p2-bubble small { font: 500 11px var(--en); color: var(--muted); }
.p2-bubble:hover { border-color: #0f9d8a; transform: translateY(-2px); }
.p2-bubble.sel { background: #0f9d8a; border-color: #0f9d8a; color: #fff; } .p2-bubble.sel small { color: #d5fff6; }
.p2-sheet.done .p2-bubble { cursor: default; transform: none; }
.p2-bubble.correct { border-color: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); } .p2-bubble.correct:not(.sel) { color: var(--ok); }
.p2-bubble.correct.sel { background: var(--ok); border-color: var(--ok); }
.p2-bubble.wrong { background: var(--ng); border-color: var(--ng); color: #fff; }
.p2-nav { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 6px; }
.p2-explain h3 { margin-top: 16px; }
.p2-verdict { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; }
.p2-verdict.ok { background: var(--ok-soft); color: var(--ok); } .p2-verdict.ng { background: var(--ng-soft); color: var(--ng); }
.p2-verdict b:first-child { font-size: 17px; } .p2-verdict span { color: var(--text); } .p2-verdict .btn { margin-left: auto; }
.p2-label { font: 700 11px var(--en); letter-spacing: .12em; color: #0f9d8a; display: flex; align-items: center; gap: 6px; }
.p2-qline { font-size: 19px; font-weight: 600; margin: 4px 0 2px; }
.p2-choices { list-style: none; padding: 0; margin: 14px 0 0; display: flex; flex-direction: column; gap: 8px; }
.p2-choices li { display: grid; grid-template-columns: 34px 1fr auto; gap: 10px; align-items: start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
.p2-choices li .en { font-size: 16px; }
.p2-choices li.correct { border-color: var(--ok); background: var(--ok-soft); } .p2-choices li.wrong { border-color: var(--ng); background: var(--ng-soft); }
.p2-letter { width: 30px; height: 30px; border-radius: 50%; border: 2px solid var(--line); display: flex; align-items: center; justify-content: center; font: 700 14px var(--en); }
.p2-choices li.correct .p2-letter { background: var(--ok); border-color: var(--ok); color: #fff; } .p2-choices li.wrong .p2-letter { border-color: var(--ng); color: var(--ng); }
.p2-ans { font-size: 12px; font-weight: 700; color: var(--ok); }
.p2-expl { line-height: 1.9; } .p2-ref { color: #0f9d8a; font-family: var(--en); }
.p2-vocab { display: flex; flex-wrap: wrap; gap: 6px; } .p2-vocab span { padding: 2px 10px; border-radius: 999px; background: var(--soft); font-size: 13px; }
.p2-orig { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 10px; } .p2-orig summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.p2-orig img { display: block; width: 100%; max-width: 720px; margin-top: 10px; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
:root[data-theme="dark"] .p2-orig img { filter: invert(.9) hue-rotate(180deg); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .p2-orig img { filter: invert(.9) hue-rotate(180deg); } }
.p2-finish { text-align: center; } .p2-score { font: 800 56px var(--en); line-height: 1.1; margin: 6px 0; } .p2-score small { font-size: 22px; color: var(--muted); }
.p2-sets { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
.p2-set { display: flex; flex-direction: column; gap: 2px; text-align: left; cursor: pointer; font: inherit; color: inherit; margin: 0; }
.p2-set:hover { border-color: #0f9d8a; } .p2-set-n { font: 800 18px var(--en); color: #0f9d8a; } .p2-set-best { font-size: 13px; margin-top: 6px; }
.p2-mockcard { text-align: center; } .p2-mock-no { font: 800 40px var(--en); color: #0f9d8a; } .p2-mockcard .p2-track { margin: 10px 0 8px; }
@media (max-width: 720px) {
  .part-switch { grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .part-tile { padding: 10px 12px; } .pt-name { font-size: 14px; }
  .p2-hero { grid-template-columns: 1fr; padding: 20px; } .p2-wave { height: 48px; order: -1; } .p2-hero h1 { font-size: 22px; }
  .p2-hero .row .btn { width: 100%; }
  .p2-sheet { gap: 14px; } .p2-bubble { width: 72px; height: 72px; }
  .p2-card { padding: 16px 14px 12px; } .p2-qline { font-size: 17px; }
}`;
  document.head.appendChild(el);
}
