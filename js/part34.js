// Part 3・4（会話問題・説明文問題）アプリ。教材: 『解きまくれ！リスニングドリル TOEIC L&R TEST PART 3&4』（TEST 1〜8）
// 1 セット = 音声 1 本（会話・トーク）＋設問 3 問。学習記録は共通の attempts / qstate / exams に
// qid = "p3-<TEST>-<設問番号3桁>" / "p4-…"、模試の id = "p34…" で保存（端末間同期もそのまま）
import { $, $$, esc, api, store, saveLocal, toast, fmtSec, pct, shuffle, tokenize, fmtDate } from './util.js?v=d3a346ff49';
import { STATIC, fetchDec, resolveUrl, hydrateImages } from './static.js?v=d3a346ff49';
import { stop as stopSpeech } from './audio.js?v=d3a346ff49';
import { markRegistered } from './words.js?v=d3a346ff49';
import { trendCard, bindTrend } from './trend.js?v=d3a346ff49';
import { partSwitcher } from './part2.js?v=d3a346ff49';

const L4 = ['A', 'B', 'C', 'D'];
export const P34_TOTAL = 552;
const P = { loaded: false, sets: [], byId: new Map(), qs: new Map() };
const SESSION_KEY = 'p34session', MOCK_KEY = 'p34mock';
const C1 = '#6d4bd8';

// ================= データ =================
async function load() {
  if (P.loaded) return;
  if (!STATIC) throw new Error('Part 3・4 は Web 版（GitHub Pages）で使えます');
  const d = JSON.parse(new TextDecoder().decode(await fetchDec('part34/tokimakure34.json')));
  P.sets = d.sets;
  P.byId = new Map(d.sets.map((s) => [s.id, s]));
  P.qs = new Map(d.questions.map((q) => [q.id, q]));
  // 単語登録の出典（words.js は store.byId から引く）
  const mat = '解きまくれ P3&4';
  for (const s of d.sets) {
    const base = { material: mat, part: s.part, category: `Part ${s.part}`, section: `TEST ${s.test}` };
    s.script.forEach((t, k) => store.byId.set(`${s.id}-t${k}`, { ...base, id: `${s.id}-t${k}`, label: `T${s.test}-${s.nos[0]}〜${s.nos[2]}`, text: t.en, complete: t.en }));
    for (const id of s.questions) {
      const q = P.qs.get(id);
      store.byId.set(id, { ...base, id, label: `T${s.test}-${q.no}`, text: q.text, complete: q.text });
      q.choices.forEach((c, i) => store.byId.set(`${id}-${L4[i]}`, { ...base, id: `${id}-${L4[i]}`, label: `T${s.test}-${q.no}`, text: c, complete: c }));
    }
  }
  P.loaded = true;
}
const st = (id) => store.stats[id] || {};
const setQs = (s) => s.questions.map((id) => P.qs.get(id));
const setDone = (s) => s.questions.every((id) => st(id).n);
const setWrong = (s) => s.questions.some((id) => st(id).n && st(id).latest === 0);
const setLabel = (s) => `Part ${s.part} ・ TEST ${s.test} ・ Q${s.nos[0]}-${s.nos[2]}`;
const KIND = (s) => (s.kind || (s.part === 3 ? 'conversation' : 'talk')).replace(/^an? /, '');

function filter(f) {
  let ss = P.sets.filter((s) => {
    if (f.part && String(s.part) !== String(f.part)) return false;
    if (f.test && String(s.test) !== String(f.test)) return false;
    if (f.graphic === 'only' && !s.graphic) return false;
    switch (f.status) {
      case 'unanswered': return !s.questions.some((id) => st(id).n);
      case 'wrong': return setWrong(s);
      case 'everwrong': return s.questions.some((id) => st(id).n && st(id).ok < st(id).n);
      case 'bookmark': return s.questions.some((id) => st(id).bookmark);
      default: return true;
    }
  });
  if (f.order === 'random') ss = shuffle(ss);
  else if (f.order === 'weak') ss.sort((a, b) => weak(b) - weak(a));
  if (+f.count > 0) ss = ss.slice(0, +f.count);
  return ss;
}
const weak = (s) => s.questions.reduce((a, id) => { const x = st(id); return a + (x.n ? (x.n - x.ok) / x.n : 0.4) + (x.latest === 0 ? 0.5 : 0) + (x.bookmark ? 0.3 : 0); }, 0);

function startSession(ss, title, mode = 'p34') {
  if (!ss.length) return toast('条件に合うセットがありません');
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ids: ss.map((s) => s.id), i: 0, title, mode, id: 'p34' + Date.now().toString(36), results: {} }));
  if (location.hash === '#/p34/session') view(); else location.hash = '#/p34/session';
}
const getS = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; } };
const putS = (s) => sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));

// ================= 音声（会話・トーク → 設問の読み上げ） =================
const player = { a: null, key: null, stopAt: null, onState: null, onTime: null, onEnded: null };
async function play(url, from = 0, to = null) {
  stopSpeech();
  if (!player.a) {
    player.a = new Audio();
    player.a.addEventListener('timeupdate', () => {
      if (player.stopAt != null && player.a.currentTime >= player.stopAt) { player.a.pause(); player.stopAt = null; }
      player.onTime?.(player.a.currentTime, player.a.duration);
    });
    for (const ev of ['play', 'pause', 'ended']) player.a.addEventListener(ev, () => player.onState?.(!player.a.paused));
    player.a.addEventListener('ended', () => player.onEnded?.());
  }
  if (player.key !== url) {
    try { player.a.src = await resolveUrl('/media/' + url); } catch (e) { toast('音声を読み込めませんでした'); return false; }
    player.key = url;
  }
  player.a.playbackRate = store.local.p34rate || 1;
  player.a.currentTime = from;
  player.stopAt = to;
  try { await player.a.play(); return true; } catch (e) { return false; }
}
const pause = () => { if (player.a) { player.a.pause(); player.stopAt = null; } };
const playing = () => player.a && !player.a.paused;
let tick = null;
const clearTimers = () => { clearInterval(tick); tick = null; };
window.addEventListener('hashchange', () => { pause(); clearTimers(); });

// ================= ルーター（#/p34/...） =================
export async function part34View(root, params, sub = '') {
  injectCss();
  if (!P.loaded) {
    root.innerHTML = '<div class="loading">Part 3・4 を読み込み中…</div>';
    try { await load(); } catch (e) { root.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  }
  view.root = root; view.params = params; view.sub = sub || '';
  return view();
}
function view() {
  const root = view.root, sub = view.sub, params = view.params;
  pause(); clearTimers(); player.onState = player.onTime = player.onEnded = null;
  root._keys = null;
  if (!sub) return home(root);
  if (sub === 'practice') return practice(root, params);
  if (sub === 'session') return session(root);
  if (sub === 'mock') return mockList(root);
  if (sub === 'mock/run') return mockRun(root);
  let m;
  if ((m = sub.match(/^mock\/result\/(.+)$/))) return mockResult(root, decodeURIComponent(m[1]));
  if ((m = sub.match(/^q\/(p[34]-\d-\d+)/))) return single(root, m[1]);
  root.innerHTML = '<div class="card">ページが見つかりません</div>';
}
const subnav = (on) => `<div class="p34-sub">
  ${[['', 'ホーム'], ['practice', '演習'], ['mock', 'TEST（模試）'], ['practice?status=wrong', '苦手復習']].map(([h, l]) => `<a href="#/p34${h ? '/' + h : ''}" class="${on === h ? 'on' : ''}">${l}</a>`).join('')}
</div>`;

// ================= ホーム =================
async function home(root) {
  const qs = [...P.qs.values()];
  const done = qs.filter((q) => st(q.id).n);
  const today = new Date().toISOString().slice(0, 10);
  const todayN = done.filter((q) => (st(q.id).last || '').slice(0, 10) === today).length;
  const rate = (part) => { const d = done.filter((q) => q.part === part); return d.length ? pct(d.filter((q) => st(q.id).latest === 1).length, d.length) + '%' : '-'; };
  const nextSet = P.sets.find((s) => !s.questions.some((id) => st(id).n));
  const wrongSets = P.sets.filter(setWrong);
  const exams = (await api('exams').catch(() => [])).filter((e) => String(e.id).startsWith('p34'));
  const dash = await api('dashboard').catch(() => null);
  const tests = [1, 2, 3, 4, 5, 6, 7, 8].map((t) => {
    const cell = (part) => {
      const xs = qs.filter((q) => q.test === t && q.part === part), d = xs.filter((q) => st(q.id).n);
      const ok = d.filter((q) => st(q.id).latest === 1).length;
      return { n: xs.length, d: d.length, rate: d.length ? pct(ok, d.length) : null };
    };
    return { t, p3: cell(3), p4: cell(4) };
  });
  const cellHtml = (t, part, c) => `<a class="p34-cell" href="#/p34/practice?test=${t}&part=${part}"><div class="bar"><span style="width:${pct(c.d, c.n)}%"></span><em>${c.d}/${c.n}</em></div><b class="${c.rate != null && c.rate < 70 ? 'low' : ''}">${c.rate != null ? c.rate + '%' : '-'}</b></a>`;
  root.innerHTML = `
    ${partSwitcher('p34')}
    ${subnav('')}
    <section class="p34-hero">
      <div>
        <div class="p34-kicker">PART 3・4 ・ CONVERSATIONS & TALKS</div>
        <h1>先に読んで、聞く前に構える。</h1>
        <p>音声 1 本につき設問 3 問。設問と選択肢を先読みしてから聞き、解答後はスクリプトの 1 文ごとに聞き直せます。</p>
        <div class="row gap">
          ${nextSet ? `<button class="btn p34-go" id="goNext">▶ 続きから（${esc(setLabel(nextSet))}〜 3セット）</button>` : ''}
          ${wrongSets.length ? `<button class="btn p34-ghost" id="goWrong">間違えた ${wrongSets.length}セットを復習</button>` : ''}
          <a class="btn p34-ghost" href="#/p34/mock">TEST に挑戦</a>
        </div>
      </div>
      <div class="p34-bubbles" aria-hidden="true"><i class="b1">W</i><i class="b2">M</i><i class="b3">▶</i></div>
    </section>
    <div class="summary-line small muted">今日 <b>${todayN}</b>問 ・ 解答済み <b>${done.length}</b> / ${qs.length}問 ・ 正答率（直近） Part 3 <b>${rate(3)}</b> ・ Part 4 <b>${rate(4)}</b></div>
    <div class="two-col">
      ${trendCard()}
      <section class="card"><h2>TEST 別</h2>
        <table class="tbl p34-tests"><tr><th></th><th>Part 3（会話）</th><th>Part 4（トーク）</th></tr>
        ${tests.map((x) => `<tr><td><b>TEST ${x.t}</b></td><td>${cellHtml(x.t, 3, x.p3)}</td><td>${cellHtml(x.t, 4, x.p4)}</td></tr>`).join('')}</table>
      </section>
    </div>
    <section class="card"><h2>TEST（模試）の結果</h2>
      ${exams.length ? `<table class="tbl">${exams.slice(0, 6).map((e) => `<tr><td class="small">${fmtDate(e.finished)}</td><td>${esc(e.title)}</td><td><b>${e.score}/${e.total}</b></td><td><a href="#/p34/mock/result/${encodeURIComponent(e.id)}">結果</a></td></tr>`).join('')}</table>`
        : '<p class="muted small">本番と同じく、会話・トークのあとに設問が読み上げられ、続けて次のセットへ進みます。</p>'}
      <a class="btn sm" href="#/p34/mock">TEST を選ぶ</a>
    </section>
    <section class="card"><h2>全 ${qs.length} 問マップ</h2>
      <div class="legend small"><span class="lg2 none"></span>未回答 <span class="lg2 good"></span>正解 <span class="lg2 bad"></span>直近で不正解 <span class="lg2 bm"></span>ブックマーク</div>
      ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => `<div class="p34-map-row"><div class="small muted">TEST ${t}</div><div class="p34-map">${P.sets.filter((s) => s.test === t).map((s) => `<a href="#/p34/q/${s.id}" class="p34-mset p${s.part}" title="${esc(setLabel(s))}">${s.questions.map((id) => { const x = st(id); return `<i class="${!x.n ? 'none' : x.latest === 0 ? 'bad' : 'good'} ${x.bookmark ? 'bm' : ''}"></i>`; }).join('')}</a>`).join('')}</div></div>`).join('')}
    </section>`;
  if (dash) bindTrend(root, dash.days); else $('#chart', root).closest('.card').remove();
  $('#goNext', root)?.addEventListener('click', () => startSession(P.sets.filter((s) => !s.questions.some((id) => st(id).n)).slice(0, 3), '続きから'));
  $('#goWrong', root)?.addEventListener('click', () => startSession(wrongSets, '間違えたセット'));
}

// ================= 演習の条件 =================
function practice(root, params) {
  const f = { part: '', test: '', order: 'seq', count: 3, status: 'unanswered', graphic: '', ...(store.local.p34practice || {}) };
  if (params.get('test')) { f.test = params.get('test'); f.part = params.get('part') || ''; f.status = ''; f.count = 0; }
  if (params.get('status')) { f.status = params.get('status'); f.test = ''; f.part = ''; f.order = 'seq'; f.count = 0; }
  const sel = (name, opts, v) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${k}" ${String(v ?? '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const pre = store.local.p34pre ?? 10;
  root.innerHTML = `
    ${subnav(params.get('status') === 'wrong' ? 'practice?status=wrong' : 'practice')}
    <div class="page-head"><h1>Part 3・4 演習</h1></div>
    <form class="card" id="pf"><div class="form-grid">
      <label>Part${sel('part', [['', 'Part 3・4'], ['3', 'Part 3（会話）'], ['4', 'Part 4（トーク）']], f.part)}</label>
      <label>TEST${sel('test', [['', 'すべて'], ...[1, 2, 3, 4, 5, 6, 7, 8].map((t) => [String(t), `TEST ${t}`])], f.test)}</label>
      <label>状態${sel('status', [['', 'すべて'], ['unanswered', '未回答'], ['wrong', '直近で間違えた'], ['everwrong', '一度でも間違えた'], ['bookmark', 'ブックマーク']], f.status)}</label>
      <label>図表問題${sel('graphic', [['', '含める'], ['only', '図表問題だけ']], f.graphic)}</label>
      <label>順序${sel('order', [['seq', '番号順'], ['random', 'ランダム'], ['weak', '苦手な順']], f.order)}</label>
      <label>セット数<input name="count" type="number" min="0" value="${esc(f.count)}" placeholder="0=すべて"></label>
    </div>
    <div class="row gap"><button class="btn primary" type="submit">開始</button><span class="muted small" id="cnt"></span></div></form>
    <section class="card"><h2>聞き方</h2><div class="form-grid">
      <label>先読みの時間${`<select id="pre">${[[0, 'なし（すぐ再生）'], [10, '10 秒'], [20, '20 秒'], [30, '30 秒'], [-1, '自分で ▶ を押す']].map(([k, l]) => `<option value="${k}" ${pre == k ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</label>
      <label class="chk"><input type="checkbox" id="qread" ${store.local.p34qread ? 'checked' : ''}> 会話・トークのあと設問の読み上げも流す（本番どおり。各問 8 秒の間あり）</label>
    </div></section>
    <div class="card small muted">操作: <kbd>1</kbd>〜<kbd>4</kbd>（または <kbd>A</kbd>〜<kbd>D</kbd>）選択中の設問に解答 ・ <kbd>↑</kbd><kbd>↓</kbd> 設問を移動 ・ <kbd>Space</kbd> 再生/停止 ・ <kbd>S</kbd> 最初から ・ <kbd>Enter</kbd> 答え合わせ / 次へ ・ <kbd>←</kbd><kbd>→</kbd> 前後のセット ・ <kbd>T</kbd> スクリプト表示 ・ 英単語クリックで単語帳登録</div>`;
  const form = $('#pf', root);
  const read = () => Object.fromEntries($$('select, input', form).map((e) => [e.name, e.value]));
  const upd = () => { const n = filter({ ...read(), count: 0 }).length; $('#cnt', root).textContent = `該当 ${n} セット（${n * 3} 問）`; };
  form.oninput = upd; upd();
  $('#pre', root).onchange = (e) => { store.local.p34pre = +e.target.value; saveLocal(); };
  $('#qread', root).onchange = (e) => { store.local.p34qread = e.target.checked; saveLocal(); };
  form.onsubmit = (e) => { e.preventDefault(); const x = read(); store.local.p34practice = x; saveLocal(); startSession(filter(x), 'Part 3・4 演習'); };
}

// ================= 1 セットの画面 =================
function session(root) {
  const s = getS();
  if (!s || !s.ids.length) { location.hash = '#/p34/practice'; return; }
  renderSet(root, s);
}
function single(root, id) {
  const set = P.byId.get(id) || P.byId.get(P.qs.get(id)?.set);
  if (!set) { root.innerHTML = '<div class="card">問題が見つかりません</div>'; return; }
  const results = {}; set.questions.forEach((q) => (results[q] = { choice: null, view: true }));
  renderSet(root, { ids: [set.id], i: 0, title: setLabel(set), id: 'p34v' + Date.now().toString(36), results, graded: { [set.id]: true } }, { single: true, focus: id });
}

function renderSet(root, s, opt = {}) {
  const set = P.byId.get(s.ids[s.i]);
  if (!set) { s.i = 0; putS(s); return renderSet(root, s, opt); }
  s.graded ||= {}; s.picks ||= {};
  const graded = !!s.graded[set.id];
  const qs = setQs(set);
  const picks = s.picks[set.id] || (s.picks[set.id] = {});
  const showScript = !!store.local.p34script;
  const t0 = Date.now();
  let focus = qs.findIndex((q) => picks[q.id] == null); if (focus < 0) focus = 0;
  const qread = !!store.local.p34qread;
  const bmOn = qs.some((q) => st(q.id).bookmark);
  root.innerHTML = `
    ${opt.single ? subnav('-') : ''}
    <div class="qbar">
      ${opt.single ? '' : `<span class="qpos">${s.i + 1} / ${s.ids.length} セット</span>`}
      <span class="qmeta">${esc(setLabel(set))}</span>
      <span class="spacer"></span><span class="timer" id="timer"></span>
      <button class="icon-btn star ${bmOn ? 'on' : ''}" id="bm" title="ブックマーク (B)">${bmOn ? '★' : '☆'}</button>
    </div>
    ${opt.single ? '' : `<div class="progress"><div style="width:${((s.i + (graded ? 1 : 0)) / s.ids.length) * 100}%"></div></div>`}
    <article class="card p34-card ${graded ? 'graded' : ''}">
      <div class="p34-player">
        <button class="p34-play" id="play" title="再生/停止 (Space)" aria-label="再生"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" class="ring-bg"/><circle cx="24" cy="24" r="21" class="ring" id="ring"/></svg><span id="playIcon">▶</span></button>
        <div class="p34-pmain">
          <div class="p34-now small" id="now">${esc(set.intro || '')}</div>
          <div class="p34-seekrow"><div class="p34-track seek" id="seek" title="クリック・ドラッグでその位置から再生"><div id="trackFill"><i></i></div></div><span class="small muted p34-time" id="ptime">0:00</span></div>
          <div class="row gap small">
            <button class="btn sm" id="replay" title="最初から (S)">↺ 最初から <kbd>S</kbd></button>
            <button class="btn sm ghost" id="playQ" title="設問の読み上げを再生">設問の読み上げ</button>
            <label class="muted">速度 <select id="rate">${[0.8, 0.9, 1, 1.1, 1.2, 1.35].map((r) => `<option value="${r}" ${(store.local.p34rate || 1) == r ? 'selected' : ''}>${r}x</option>`).join('')}</select></label>
            <label class="muted"><input type="checkbox" id="qread" ${qread ? 'checked' : ''}> 設問の読み上げも続けて</label>
            ${graded ? '' : `<label class="muted"><input type="checkbox" id="scr" ${showScript ? 'checked' : ''}> スクリプト (T)</label>`}
          </div>
        </div>
      </div>
      ${!graded && showScript ? `<div class="p34-prescript">${scriptHtml(set, false)}</div>` : ''}
      ${set.graphic ? `<figure class="p34-graphic"><img data-enc="/crops/${set.graphic}" alt="図表"></figure>` : ''}
      <div class="p34-qs">
        ${qs.map((q, k) => {
          const r = s.results[q.id];
          const pick = graded ? r?.choice : picks[q.id];
          return `<section class="p34-q ${!graded && k === focus ? 'focus' : ''} ${graded && r && !r.view ? (r.correct ? 'ok' : 'ng') : ''}" data-k="${k}">
            <div class="p34-qhead"><span class="p34-no">${q.no}.</span>
              <div class="en p34-qtext" data-src="${q.id}">${tokenize(q.text)}</div>
              ${graded && r && !r.view ? `<span class="p34-mark ${r.correct ? 'ok' : 'ng'}">${r.correct ? '○' : '×'}</span>` : ''}</div>
            ${graded ? `<div class="small muted p34-qja">${esc(q.text_ja || '')}</div>` : ''}
            <ol class="p34-ch">${q.choices.map((c, i) => `<li><button class="p34-opt ${pick === i ? 'sel' : ''} ${graded && i === q.answer ? 'correct' : ''} ${graded && pick === i && i !== q.answer ? 'wrong' : ''}" data-q="${k}" data-i="${i}" ${graded ? 'tabindex="-1"' : ''}>
              <span class="p34-l">${L4[i]}</span><span class="en" ${graded ? `data-src="${q.id}-${L4[i]}"` : ''}>${graded ? tokenize(c) : esc(c)}</span>
              ${graded && q.choices_ja?.[i] ? `<span class="ja small muted">${esc(q.choices_ja[i])}</span>` : ''}</button></li>`).join('')}</ol>
          </section>`;
        }).join('')}
      </div>
      <div class="row gap p34-nav">
        ${opt.single ? '' : `<button class="btn ghost" id="prev" ${s.i === 0 ? 'disabled' : ''}>← 前</button>`}<span class="spacer"></span>
        <span class="small muted" id="st"></span>
        ${graded ? (opt.single ? '' : `<button class="btn primary" id="next">${s.i === s.ids.length - 1 ? '終了' : '次のセット →'}</button>`)
          : `<button class="btn primary" id="grade">答え合わせ <kbd>Enter</kbd></button>`}
      </div>
    </article>
    <div id="explain">${graded ? explainHtml(set, s) : ''}</div>`;
  hydrateImages(root);
  markRegistered(root);

  // ---- 音声
  const ring = $('#ring', root), fill = $('#trackFill', root), icon = $('#playIcon', root), now = $('#now', root), ptime = $('#ptime', root);
  const tt = turnTimes(set);
  let seeking = false;
  const CC = 2 * Math.PI * 21;
  ring.style.strokeDasharray = CC; ring.style.strokeDashoffset = CC;
  player.onTime = (t, d) => {
    if (seeking) return;
    const r = d ? Math.min(1, t / d) : 0; ring.style.strokeDashoffset = CC * (1 - r); fill.style.width = r * 100 + '%';
    ptime.textContent = d ? `${mmss(t)} / ${mmss(d)}` : mmss(t);
    if (player.key === set.audio.talk) {
      let cur = -1; tt.forEach((x, k) => { if (x != null && t >= x) cur = k; });
      $$('.p34-turn', root).forEach((el) => el.classList.toggle('now', +el.dataset.k === cur));
    }
  };
  player.onState = (p) => { icon.textContent = p ? '❚❚' : '▶'; $('#play', root)?.classList.toggle('on', p); };
  const playTalk = (from = 0, to = null) => {
    clearTimers(); now.textContent = set.intro || '';
    player.onEnded = () => { if (store.local.p34qread && !graded) playQs(); };
    return play(set.audio.talk, from, to);
  };
  const playQs = (from = 0, to = null) => { now.textContent = '設問の読み上げ'; player.onEnded = null; return play(set.audio.q, from, to); };
  const toggle = () => {
    clearTimers(); $('#st', root).textContent = '';
    if (playing()) return pause();
    if (player.key && player.a.currentTime > 0 && player.a.currentTime < player.a.duration - 0.05) return player.a.play();
    return playTalk(0);
  };
  $('#play', root).onclick = toggle;
  $('#replay', root).onclick = () => playTalk(0);
  $('#playQ', root).onclick = () => playQs(0);
  $('#rate', root).onchange = (e) => { store.local.p34rate = +e.target.value; saveLocal(); if (player.a) player.a.playbackRate = store.local.p34rate; };
  $('#qread', root).onchange = (e) => { store.local.p34qread = e.target.checked; saveLocal(); };
  $('#scr', root)?.addEventListener('change', (e) => { store.local.p34script = e.target.checked; saveLocal(); renderSet(root, s, opt); });
  $$('[data-turn]', root).forEach((b) => (b.onclick = () => { const k = +b.dataset.turn; playTalk(Math.max(0, tt[k] - 0.15), store.local.p34one ? tt[k + 1] ?? null : null); }));
  // シークバー: クリック・ドラッグした位置から再生（表示中の音声。未再生なら会話・トーク）
  const seek = $('#seek', root);
  const ratio = (e) => { const b = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)); };
  const show = (r) => { fill.style.width = r * 100 + '%'; const d = player.a?.duration; if (d && ownKey()) ptime.textContent = `${mmss(r * d)} / ${mmss(d)}`; };
  const ownKey = () => player.key === set.audio.talk || player.key === set.audio.q;
  seek.onpointerdown = (e) => { e.preventDefault(); seeking = true; seek.setPointerCapture(e.pointerId); show(ratio(e)); };
  seek.onpointermove = (e) => { if (seeking) show(ratio(e)); };
  seek.onpointerup = async (e) => {
    if (!seeking) return; seeking = false;
    const r = ratio(e);
    clearTimers(); $('#st', root).textContent = '';
    if (!ownKey() || !player.a.duration) { if (!(await playTalk(0))) return; await new Promise((ok) => (player.a.duration ? ok() : player.a.addEventListener('loadedmetadata', ok, { once: true }))); }
    else if (player.key === set.audio.talk) player.onEnded = () => { if (store.local.p34qread && !graded) playQs(); };
    player.stopAt = null;
    player.a.currentTime = r * player.a.duration;
    player.a.play().catch(() => {});
  };
  seek.onpointercancel = () => { seeking = false; };
  $$('[data-qread]', root).forEach((b) => (b.onclick = () => { const q = P.qs.get(b.dataset.qread); const nx = qs[qs.indexOf(q) + 1]; playQs(q.t || 0, nx?.t ?? null); }));
  $('#one', root)?.addEventListener('change', (e) => { store.local.p34one = e.target.checked; saveLocal(); });

  // 先読み → 自動再生
  if (!graded && !opt.single) {
    const pre = store.local.p34pre ?? 10;
    if (pre === 0) setTimeout(() => { if (location.hash.startsWith('#/p34') && $('#play', root)) playTalk(0); }, 250);
    else if (pre > 0) {
      let left = pre;
      const stEl = $('#st', root);
      stEl.innerHTML = `先読み <b>${left}</b> 秒`;
      tick = setInterval(() => { left--; if (!$('#st', root)) return clearTimers(); stEl.innerHTML = `先読み <b>${left}</b> 秒`; if (left <= 0) { clearTimers(); stEl.textContent = ''; playTalk(0); } }, 1000);
    }
  }

  // ---- 解答
  const setFocus = (k) => { focus = Math.max(0, Math.min(2, k)); $$('.p34-q', root).forEach((el) => el.classList.toggle('focus', +el.dataset.k === focus)); };
  const pick = (k, i) => {
    if (graded) return;
    picks[qs[k].id] = i; putS(s);
    $$(`.p34-opt[data-q="${k}"]`, root).forEach((b) => b.classList.toggle('sel', +b.dataset.i === i));
    const nxt = qs.findIndex((q, j) => j > k && picks[q.id] == null);
    setFocus(nxt >= 0 ? nxt : k);
  };
  $$('.p34-opt', root).forEach((b) => (b.onclick = () => pick(+b.dataset.q, +b.dataset.i)));
  $$('.p34-q', root).forEach((el) => el.addEventListener('mousedown', () => !graded && setFocus(+el.dataset.k)));
  const grade = async () => {
    if (graded) return;
    if (!qs.some((q) => picks[q.id] != null)) return toast('選択肢を選んでください');
    clearTimers();
    const ms = Date.now() - t0;
    for (const q of qs) {
      const choice = picks[q.id];
      if (choice == null) { s.results[q.id] = { choice: null, correct: false, ms }; continue; }
      const correct = choice === q.answer;
      s.results[q.id] = { choice, correct, ms };
      try {
        await api('attempt', { body: { qid: q.id, choice, correct, ms, mode: s.mode || 'p34', session: s.id } });
        const x = store.stats[q.id] || { n: 0, ok: 0 };
        store.stats[q.id] = { ...x, n: x.n + 1, ok: x.ok + (correct ? 1 : 0), latest: correct ? 1 : 0, first: x.n ? x.first : correct ? 1 : 0, lastMs: ms, last: new Date().toISOString() };
      } catch (e) { toast('記録の保存に失敗しました: ' + e.message); }
    }
    s.graded[set.id] = true; putS(s);
    const keep = playing();
    renderSet(root, s, opt);
    if (!keep) pause();
    $('#explain', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#grade', root)?.addEventListener('click', grade);
  const go = (d) => {
    if (d > 0 && s.i === s.ids.length - 1) return finish(root, s);
    s.i = Math.max(0, Math.min(s.ids.length - 1, s.i + d)); putS(s); renderSet(root, s, opt); window.scrollTo(0, 0);
  };
  $('#prev', root)?.addEventListener('click', () => go(-1));
  $('#next', root)?.addEventListener('click', () => go(1));
  $('#bm', root).onclick = () => bookmark(set, root);
  // 解答時間
  const timer = $('#timer', root);
  if (graded) { const r = s.results[qs[0].id]; if (r?.ms) timer.textContent = fmtSec(r.ms); }
  root._keys = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const map = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
    if (!graded && k in map && !(k === 'b' && e.shiftKey)) { e.preventDefault(); return pick(focus, map[k]); }
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (k === 's' || k === 'r') { e.preventDefault(); playTalk(0); }
    else if (k === 't' && !graded) $('#scr', root)?.click();
    else if (k === 'b' && graded) bookmark(set, root);
    else if (e.key === 'ArrowDown' && !graded) { e.preventDefault(); setFocus(focus + 1); }
    else if (e.key === 'ArrowUp' && !graded) { e.preventDefault(); setFocus(focus - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!graded) grade(); else if (!opt.single) go(1); }
    else if (e.key === 'ArrowRight' && !opt.single) go(1);
    else if (e.key === 'ArrowLeft' && !opt.single) go(-1);
  };
  if (opt.focus && P.qs.has(opt.focus)) setTimeout(() => root.querySelector(`.p34-x[data-q="${opt.focus}"]`)?.scrollIntoView({ block: 'start' }), 50);
}

async function bookmark(set, root) {
  const on = !set.questions.some((id) => st(id).bookmark);
  try { for (const id of set.questions) await api('qstate', { body: { qid: id, bookmark: on ? 1 : 0 } }); } catch (e) { return toast(e.message); }
  for (const id of set.questions) store.stats[id] = { ...(store.stats[id] || { n: 0, ok: 0 }), bookmark: on ? 1 : 0 };
  const b = $('#bm', root); if (b) { b.textContent = on ? '★' : '☆'; b.classList.toggle('on', on); }
  toast(on ? 'ブックマークしました' : 'ブックマークを外しました');
}

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
// 各発話の開始秒。書き起こしと合わず時刻が無い発話は、前後の時刻を文字数の割合で補う
function turnTimes(set) {
  const sc = set.script, out = sc.map((x) => x.t ?? null);
  for (let k = 0; k < sc.length; k++) {
    if (out[k] != null) continue;
    let a = k - 1; while (a >= 0 && sc[a].t == null) a--;
    let b = k + 1; while (b < sc.length && sc[b].t == null) b++;
    const ta = a >= 0 ? sc[a].t : 0;
    if (b >= sc.length) { out[k] = ta; continue; }
    const len = (i) => (sc[i].en || '').length;
    let tot = 0, part = 0; for (let i = Math.max(a, 0); i < b; i++) { if (i < k) part += len(i); tot += len(i); }
    out[k] = ta + (sc[b].t - ta) * (tot ? part / tot : 0);
  }
  return out;
}
const SPK_NAME = { W: '女性', M: '男性', W1: '女性1', W2: '女性2', M1: '男性1', M2: '男性2' };
function scriptHtml(set, withJa = true) {
  return `<div class="p34-script">${set.script.map((t, k) => `<div class="p34-turn" data-k="${k}">
    <div class="p34-side">${t.sp ? `<span class="p34-sp sp-${esc(t.sp[0])}" title="${esc(SPK_NAME[t.sp] || t.sp)}">${esc(t.sp)}</span>` : '<span class="p34-sp sp-N">♪</span>'}
      ${withJa ? `<button class="p34-tplay" data-turn="${k}" title="ここから再生" aria-label="ここから再生">▶</button>` : ''}</div>
    <div><div class="en" data-src="${set.id}-t${k}">${tokenize(t.en)}</div>
    ${withJa && t.ja ? `<div class="ja small muted">${esc(t.ja)}</div>` : ''}</div></div>`).join('')}</div>`;
}

function explainHtml(set, s) {
  const qs = setQs(set);
  const view = qs.every((q) => s.results[q.id]?.view);
  const okN = qs.filter((q) => s.results[q.id]?.correct).length;
  return `
    <section class="card p34-explain">
      ${view ? '' : `<div class="p34-verdict ${okN === 3 ? 'ok' : okN === 0 ? 'ng' : 'mid'}"><b>${okN} / 3 問正解</b><span>${qs.map((q) => `${q.no}. <b>(${L4[q.answer]})</b>`).join('　')}</span></div>`}
      <div class="p34-label">SCRIPT <span class="muted">${esc(set.intro || '')}</span>
        <label class="small muted" style="margin-left:auto"><input type="checkbox" id="one" ${store.local.p34one ? 'checked' : ''}> 🔊 は 1 人分だけ再生</label></div>
      ${set.intro_ja ? `<div class="small muted">${esc(set.intro_ja)}</div>` : ''}
      ${scriptHtml(set)}
      ${set.vocab?.length ? `<h3>語句（スクリプト）</h3><div class="p34-vocab" data-src="${set.id}-t0">${set.vocab.map((v) => `<span>${tokenize(v)}</span>`).join('')}</div>` : ''}
      ${qs.map((q) => {
        const r = s.results[q.id] || {};
        return `<div class="p34-x" data-q="${q.id}">
          <h3>${q.no}. ${!r.view ? (r.correct ? '<span class="ok">○ 正解</span>' : `<span class="ng">× 不正解</span> <small class="muted">あなたの解答 ${r.choice != null ? `(${L4[r.choice]})` : '無回答'}</small>`) : ''}
            <button class="icon-btn" data-qread="${q.id}" title="設問の読み上げを再生">🔊</button></h3>
          <div class="en" data-src="${q.id}">${tokenize(q.text)}</div><div class="small muted">${esc(q.text_ja || '')}</div>
          <div class="p34-ans">正解 <b>(${L4[q.answer]})</b> ${tokenize(q.choices[q.answer] || '')} <span class="small muted">${esc(q.choices_ja?.[q.answer] || '')}</span></div>
          ${q.explanation ? `<div class="p34-expl">${explHtml(q.explanation)}</div>` : ''}
          ${q.vocab?.length ? `<div class="p34-vocab" data-src="${q.id}">${q.vocab.map((v) => `<span>${tokenize(v)}</span>`).join('')}</div>` : ''}
        </div>`;
      }).join('')}
      <details class="p34-orig" ${store.local.p34orig ? 'open' : ''}><summary>原本の解説ページ（${set.page_imgs.length} ページ）</summary>${set.page_imgs.map((p) => `<img data-enc="/crops/${p}" alt="原本の解説" loading="lazy">`).join('')}</details>
    </section>`;
}
function explHtml(t) {
  return tokenize(t).replace(/\(\s*(<span class="w">)?([ABCD])(<\/span>)?\s*\)/g, '<b class="p34-ref">($2)</b>');
}

function finish(root, s) {
  pause();
  const ids = s.ids.flatMap((id) => P.byId.get(id).questions);
  const r = s.results;
  const done = ids.filter((id) => r[id] && !r[id].view);
  const okN = done.filter((id) => r[id].correct).length;
  const wrongSets = s.ids.map((id) => P.byId.get(id)).filter((set) => set.questions.some((id) => r[id] && !r[id].correct && !r[id].view));
  root.innerHTML = `
    ${subnav('-')}
    <section class="card p34-finish">
      <div class="p34-kicker">${esc(s.title || 'Part 3・4 演習')}</div>
      <div class="p34-score">${okN}<small> / ${done.length}</small></div>
      <div class="muted">正答率 ${pct(okN, done.length)}%</div>
      <div class="row gap center" style="margin-top:14px">
        ${wrongSets.length ? '<button class="btn primary" id="again">間違えたセットをもう一度</button>' : ''}
        <a class="btn" href="#/p34">Part 3・4 ホーム</a><a class="btn" href="#/p34/practice">続けて演習</a>
      </div>
    </section>
    <section class="card"><table class="tbl">${s.ids.map((id) => { const set = P.byId.get(id);
      return `<tr><td><a href="#/p34/q/${id}">${esc(setLabel(set))}</a></td><td>${set.questions.map((q) => r[q] && !r[q].view ? (r[q].correct ? '<b class="ok">○</b>' : '<b class="ng">×</b>') : '-').join(' ')}</td><td class="small muted">${esc(KIND(set))}</td></tr>`; }).join('')}</table></section>`;
  $('#again', root)?.addEventListener('click', () => startSession(wrongSets, '間違えたセット'));
}

// ================= TEST（模試） =================
async function mockList(root) {
  const exams = (await api('exams').catch(() => [])).filter((e) => String(e.id).startsWith('p34'));
  const best = (title) => { const h = exams.filter((e) => e.title === title); return h.length ? `最高 <b>${Math.max(...h.map((e) => e.score))}</b>/${h[0].total} ・ ${h.length}回` : '未受験'; };
  root.innerHTML = `
    ${subnav('mock')}
    <div class="page-head"><h1>TEST（模試）</h1></div>
    <div class="card small muted">本番と同じ流れです。設問と選択肢が表示され、会話・トーク → 設問の読み上げ（各問 8 秒）と進み、自動で次のセットへ移ります。音声は止められません。全セットが終わると採点し、解説付きで復習できます。</div>
    <div class="p34-tgrid">${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => `<div class="card p34-tcard">
      <div class="p34-tn">TEST ${t}</div>
      <button class="btn sm" data-t="${t}" data-p="3">Part 3 <small>39問</small></button><div class="small muted">${best(`TEST ${t} Part 3`)}</div>
      <button class="btn sm" data-t="${t}" data-p="4">Part 4 <small>30問</small></button><div class="small muted">${best(`TEST ${t} Part 4`)}</div>
      <button class="btn sm primary" data-t="${t}" data-p="34">Part 3 → 4 通し <small>69問・約 35 分</small></button><div class="small muted">${best(`TEST ${t} Part 3・4`)}</div>
    </div>`).join('')}</div>`;
  $$('[data-t]', root).forEach((b) => (b.onclick = () => {
    const t = +b.dataset.t, p = b.dataset.p;
    const ss = P.sets.filter((s) => s.test === t && (p === '34' || String(s.part) === p)).sort((a, b) => a.part - b.part || a.nos[0] - b.nos[0]);
    beginMock(ss, `TEST ${t} ${p === '34' ? 'Part 3・4' : 'Part ' + p}`);
  }));
}
function beginMock(ss, title) {
  const qids = ss.flatMap((s) => s.questions);
  sessionStorage.setItem(MOCK_KEY, JSON.stringify({ id: 'p34m' + Date.now().toString(36), title, sets: ss.map((s) => s.id), qids, i: 0, answers: qids.map(() => null), times: qids.map(() => 0), started: new Date().toISOString() }));
  location.hash = '#/p34/mock/run';
}
function mockRun(root) {
  let ex; try { ex = JSON.parse(sessionStorage.getItem(MOCK_KEY)); } catch (e) { ex = null; }
  if (!ex) { location.hash = '#/p34/mock'; return; }
  const save = () => sessionStorage.setItem(MOCK_KEY, JSON.stringify(ex));
  let shownAt = Date.now(), focus = 0;
  const draw = () => {
    clearTimers();
    const set = P.byId.get(ex.sets[ex.i]);
    const qs = setQs(set);
    shownAt = Date.now(); focus = 0;
    root.innerHTML = `
      <div class="qbar"><span class="qpos">${esc(ex.title)}</span><span class="qmeta">${ex.i + 1} / ${ex.sets.length} セット ・ Part ${set.part}</span><span class="spacer"></span><button class="btn sm ghost" id="quit">中断</button></div>
      <div class="progress"><div style="width:${(ex.i / ex.sets.length) * 100}%"></div></div>
      <article class="card p34-card p34-mockcard">
        <div class="p34-now small" id="now">${esc(set.intro || '')}</div>
        <div class="p34-track"><div id="trackFill"></div></div>
        ${set.graphic ? `<figure class="p34-graphic"><img data-enc="/crops/${set.graphic}" alt="図表"></figure>` : ''}
        <div class="p34-qs">${qs.map((q, k) => { const gi = ex.qids.indexOf(q.id); return `<section class="p34-q ${k === 0 ? 'focus' : ''}" data-k="${k}">
          <div class="p34-qhead"><span class="p34-no">${q.no}.</span><div class="en p34-qtext">${esc(q.text)}</div></div>
          <ol class="p34-ch">${q.choices.map((c, i) => `<li><button class="p34-opt ${ex.answers[gi] === i ? 'sel' : ''}" data-q="${k}" data-i="${i}"><span class="p34-l">${L4[i]}</span><span class="en">${esc(c)}</span></button></li>`).join('')}</ol></section>`; }).join('')}</div>
        <div class="row gap p34-nav"><span class="small muted" id="st">再生中…</span><span class="spacer"></span><button class="btn sm" id="start" hidden>▶ 再生</button><button class="btn sm ghost" id="skip">次のセットへ →</button></div>
      </article>`;
    hydrateImages(root);
    const fill = $('#trackFill', root), now = $('#now', root);
    player.onTime = (t, d) => { fill.style.width = (d ? (t / d) * 100 : 0) + '%'; };
    player.onState = null;
    const startTalk = () => { now.textContent = set.intro || ''; $('#st', root).textContent = '会話・トーク'; player.onEnded = () => { now.textContent = '設問の読み上げ'; $('#st', root).textContent = '設問の読み上げ'; player.onEnded = () => { $('#st', root).textContent = '次のセットへ…'; tick = setTimeout(next, 1500); }; play(set.audio.q, 0); }; return play(set.audio.talk, 0); };
    const setFocus = (k) => { focus = Math.max(0, Math.min(2, k)); $$('.p34-q', root).forEach((el) => el.classList.toggle('focus', +el.dataset.k === focus)); };
    const pick = (k, i) => {
      const gi = ex.qids.indexOf(qs[k].id);
      ex.answers[gi] = i; ex.times[gi] = Date.now() - shownAt; save();
      $$(`.p34-opt[data-q="${k}"]`, root).forEach((b) => b.classList.toggle('sel', +b.dataset.i === i));
      if (k < 2) setFocus(k + 1);
    };
    $$('.p34-opt', root).forEach((b) => (b.onclick = () => pick(+b.dataset.q, +b.dataset.i)));
    $$('.p34-q', root).forEach((el) => el.addEventListener('mousedown', () => setFocus(+el.dataset.k)));
    $('#skip', root).onclick = next;
    $('#quit', root).onclick = () => { if (confirm('模試を中断しますか？（ここまでの解答は保存されません）')) { pause(); clearTimeout(tick); sessionStorage.removeItem(MOCK_KEY); location.hash = '#/p34/mock'; } };
    $('#start', root).onclick = () => { $('#start', root).hidden = true; startTalk(); };
    startTalk().then((ok) => { if (!ok) { $('#start', root).hidden = false; $('#st', root).textContent = '▶ を押して開始'; } });
    root._keys = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase(), map = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
      if (k in map) { e.preventDefault(); pick(focus, map[k]); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(focus + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(focus - 1); }
    };
  };
  const next = async () => {
    clearTimeout(tick); clearTimers(); pause();
    if (ex.i < ex.sets.length - 1) { ex.i++; save(); return draw(); }
    const qs = ex.qids.map((id) => P.qs.get(id));
    const score = qs.filter((q, i) => ex.answers[i] === q.answer).length;
    root.innerHTML = '<div class="loading">採点中…</div>';
    for (let i = 0; i < qs.length; i++) {
      if (ex.answers[i] == null) continue;
      const correct = ex.answers[i] === qs[i].answer;
      try {
        await api('attempt', { body: { qid: qs[i].id, choice: ex.answers[i], correct, ms: ex.times[i], mode: 'p34mock', session: ex.id } });
        const x = store.stats[qs[i].id] || { n: 0, ok: 0 };
        store.stats[qs[i].id] = { ...x, n: x.n + 1, ok: x.ok + (correct ? 1 : 0), latest: correct ? 1 : 0, first: x.n ? x.first : correct ? 1 : 0, lastMs: ex.times[i], last: new Date().toISOString() };
      } catch (e) { /* 続行 */ }
    }
    try { await api('exams', { body: { id: ex.id, title: ex.title, started: ex.started, limitSec: 0, qids: ex.qids, answers: ex.answers, times: ex.times, score, total: qs.length } }); } catch (e) { toast(e.message); }
    sessionStorage.removeItem(MOCK_KEY);
    location.hash = '#/p34/mock/result/' + ex.id;
  };
  draw();
}
async function mockResult(root, id) {
  const e = (await api('exams').catch(() => [])).find((x) => x.id === id);
  if (!e) { root.innerHTML = '<div class="card">結果が見つかりません</div>'; return; }
  const qs = e.qids.map((x) => P.qs.get(x)).filter(Boolean);
  const ok = (q) => e.answers[e.qids.indexOf(q.id)] === q.answer;
  const parts = [3, 4].map((p) => { const xs = qs.filter((q) => q.part === p); return { p, n: xs.length, ok: xs.filter(ok).length }; }).filter((x) => x.n);
  const graphic = qs.filter((q) => q.graphic), gOk = graphic.filter(ok).length;
  const sets = [...new Set(qs.map((q) => q.set))].map((sid) => P.byId.get(sid));
  const wrongSets = sets.filter((s) => setQs(s).some((q) => !ok(q)));
  root.innerHTML = `
    ${subnav('mock')}
    <section class="card p34-finish">
      <div class="p34-kicker">${esc(e.title)} ・ ${fmtDate(e.finished)}</div>
      <div class="p34-score">${e.score}<small> / ${e.total}</small></div>
      <div class="muted">正答率 ${pct(e.score, e.total)}%</div>
      <div class="row gap center" style="margin-top:14px">${wrongSets.length ? '<button class="btn primary" id="rev">間違えたセットを解説付きで復習</button>' : ''}<a class="btn" href="#/p34/mock">TEST 一覧</a></div>
    </section>
    <div class="two-col">
      <section class="card"><h2>内訳</h2><table class="tbl">
        ${parts.map((x) => `<tr><td>Part ${x.p}</td><td>${x.ok}/${x.n}</td><td><div class="bar"><span style="width:${pct(x.ok, x.n)}%" class="${pct(x.ok, x.n) < 70 ? 'low' : ''}"></span><em>${pct(x.ok, x.n)}%</em></div></td></tr>`).join('')}
        ${graphic.length ? `<tr><td>図表問題</td><td>${gOk}/${graphic.length}</td><td><div class="bar"><span style="width:${pct(gOk, graphic.length)}%"></span><em>${pct(gOk, graphic.length)}%</em></div></td></tr>` : ''}
      </table></section>
      <section class="card"><h2>セットごとの結果</h2><table class="tbl">${sets.map((s) => `<tr><td class="small">${esc(setLabel(s))}</td>
        <td>${setQs(s).map((q) => { const a = e.answers[e.qids.indexOf(q.id)]; return ok(q) ? '<b class="ok">○</b>' : `<b class="ng" title="${a == null ? '無回答' : `(${L4[a]})`} → (${L4[q.answer]})">×</b>`; }).join(' ')}</td>
        <td><a href="#/p34/q/${s.id}">解説</a></td></tr>`).join('')}</table></section>
    </div>`;
  $('#rev', root)?.addEventListener('click', () => {
    const s = { ids: wrongSets.map((x) => x.id), i: 0, title: e.title + ' の復習', mode: 'p34', id: 'p34r' + Date.now().toString(36), results: {}, graded: {} };
    for (const set of wrongSets) { s.graded[set.id] = true; for (const q of setQs(set)) { const i = e.qids.indexOf(q.id); s.results[q.id] = { choice: e.answers[i], correct: ok(q), ms: e.times[i] }; } }
    putS(s); location.hash = '#/p34/session';
  });
}

// ================= 見た目 =================
function injectCss() {
  if (document.getElementById('p34css')) return;
  const el = document.createElement('style');
  el.id = 'p34css';
  el.textContent = `
.p34-sub { display: flex; gap: 4px; margin: -4px 0 14px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.p34-sub a { padding: 8px 14px; color: var(--muted); border-bottom: 2px solid transparent; white-space: nowrap; font-size: 14px; }
.p34-sub a.on { color: var(--text); border-bottom-color: ${C1}; font-weight: 600; }
.p34-hero { display: grid; grid-template-columns: 1fr 200px; gap: 18px; align-items: center; padding: 26px 28px; border-radius: 18px; margin-bottom: 14px; color: #f1edff;
  background: radial-gradient(120% 140% at 100% 0%, #6a4fd6 0%, #3b2a8c 45%, #1f1650 100%); box-shadow: var(--shadow); }
.p34-hero h1 { font-size: 26px; margin: 4px 0 6px; color: #fff; } .p34-hero p { margin: 0 0 16px; color: #d6ccff; font-size: 14px; }
.p34-kicker { font: 700 11px var(--en); letter-spacing: .16em; color: #b9a8ff; }
.p34-finish .p34-kicker { color: ${C1}; }
.btn.p34-go { background: #b49cff; border-color: #b49cff; color: #1c1240; }
.btn.p34-ghost { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.25); color: #f1edff; }
.p34-bubbles { position: relative; height: 110px; }
.p34-bubbles i { position: absolute; display: flex; align-items: center; justify-content: center; font: 800 18px var(--en); font-style: normal; border-radius: 18px; color: #1f1650; animation: p34b 3s ease-in-out infinite alternate; }
.p34-bubbles .b1 { left: 0; top: 6px; width: 92px; height: 46px; background: #ffd6e8; border-bottom-left-radius: 4px; }
.p34-bubbles .b2 { right: 0; top: 44px; width: 92px; height: 46px; background: #c8f3e6; border-bottom-right-radius: 4px; animation-delay: .8s; }
.p34-bubbles .b3 { left: 70px; bottom: -6px; width: 46px; height: 46px; border-radius: 50%; background: #b49cff; animation-delay: 1.4s; }
@keyframes p34b { from { transform: translateY(0); } to { transform: translateY(-8px); } }
@media (prefers-reduced-motion: reduce) { .p34-bubbles i { animation: none; } }
.p34-tests td { vertical-align: middle; } .p34-cell { display: grid; grid-template-columns: 1fr 44px; gap: 8px; align-items: center; color: inherit; }
.p34-cell b { font: 700 13px var(--en); text-align: right; } .p34-cell b.low { color: var(--ng); } .p34-cell .bar span { background: ${C1}; }
.p34-map-row { margin-top: 10px; } .p34-map { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.p34-mset { display: inline-flex; gap: 2px; padding: 2px; border-radius: 4px; border: 1px solid var(--line); }
.p34-mset.p4 { border-style: dashed; } .p34-mset i { width: 10px; height: 12px; border-radius: 2px; }
.p34-mset i.none { background: var(--soft); } .p34-mset i.good { background: #34c08a; } .p34-mset i.bad { background: var(--ng); } .p34-mset i.bm { box-shadow: inset 0 0 0 2px #f5b300; }
.p34-mset:hover { border-color: ${C1}; }
.p34-card { padding: 20px 22px 14px; }
.p34-player { display: flex; gap: 16px; align-items: center; }
.p34-play { position: relative; width: 60px; height: 60px; flex: none; border: none; border-radius: 50%; background: ${C1}; color: #fff; font-size: 19px; cursor: pointer; box-shadow: 0 4px 14px rgba(109,75,216,.35); }
.p34-play.on { background: #5233b8; } .p34-play svg { position: absolute; inset: -6px; width: 72px; height: 72px; transform: rotate(-90deg); pointer-events: none; }
.p34-play .ring-bg { fill: none; stroke: var(--line); stroke-width: 3; } .p34-play .ring { fill: none; stroke: #b49cff; stroke-width: 3; stroke-linecap: round; transition: stroke-dashoffset .2s linear; }
.p34-play span { position: relative; }
.p34-pmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.p34-now { color: var(--muted); font-family: var(--en); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.p34-track { height: 6px; border-radius: 3px; background: var(--soft); overflow: hidden; } .p34-track div { height: 100%; width: 0; background: linear-gradient(90deg, ${C1}, #b49cff); }
.p34-graphic { margin: 16px auto 4px; text-align: center; } .p34-graphic img { max-width: min(100%, 520px); border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 6px; }
.p34-prescript { margin-top: 14px; padding: 12px; border-radius: 10px; background: var(--soft); }
.p34-qs { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
.p34-q { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; transition: border-color .12s, box-shadow .12s; }
.p34-q.focus { border-color: ${C1}; box-shadow: 0 0 0 3px rgba(109,75,216,.14); }
.p34-q.ok { border-color: var(--ok); } .p34-q.ng { border-color: var(--ng); }
.p34-qhead { display: flex; gap: 8px; align-items: baseline; } .p34-no { font: 800 17px var(--en); color: ${C1}; }
.p34-qtext { font-size: 16px; font-weight: 600; flex: 1; } .p34-qja { margin: 2px 0 0 30px; }
.p34-mark { font: 800 20px var(--en); } .p34-mark.ok { color: var(--ok); } .p34-mark.ng { color: var(--ng); }
.p34-ch { list-style: none; padding: 0; margin: 8px 0 0; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.p34-opt { width: 100%; display: grid; grid-template-columns: 28px 1fr; gap: 2px 8px; align-items: center; text-align: left; padding: 7px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit; cursor: pointer; }
.p34-opt .ja { grid-column: 2; }
.p34-opt:hover { border-color: ${C1}; }
.p34-l { width: 26px; height: 26px; border-radius: 50%; border: 2px solid var(--line); display: flex; align-items: center; justify-content: center; font: 700 13px var(--en); }
.p34-opt.sel { border-color: ${C1}; background: rgba(109,75,216,.08); } .p34-opt.sel .p34-l { background: ${C1}; border-color: ${C1}; color: #fff; }
.graded .p34-opt { cursor: default; } .graded .p34-opt:hover { border-color: var(--line); }
.p34-opt.correct { border-color: var(--ok); background: var(--ok-soft); } .p34-opt.correct .p34-l { background: var(--ok); border-color: var(--ok); color: #fff; }
.p34-opt.wrong { border-color: var(--ng); background: var(--ng-soft); } .p34-opt.wrong .p34-l { background: var(--ng); border-color: var(--ng); color: #fff; }
.p34-nav { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 12px; }
.p34-verdict { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; }
.p34-verdict.ok { background: var(--ok-soft); color: var(--ok); } .p34-verdict.ng { background: var(--ng-soft); color: var(--ng); } .p34-verdict.mid { background: rgba(245,179,0,.14); color: #a86b00; }
.p34-verdict b:first-child { font-size: 17px; } .p34-verdict span { color: var(--text); font-family: var(--en); }
.p34-label { font: 700 11px var(--en); letter-spacing: .12em; color: ${C1}; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.p34-label .muted { letter-spacing: 0; font-weight: 500; }
.p34-script { display: flex; flex-direction: column; gap: 10px; margin: 10px 0 4px; }
.p34-turn { display: grid; grid-template-columns: 34px 1fr; gap: 8px; padding: 6px; border-radius: 10px; transition: background .2s; }
.p34-turn.now { background: rgba(109,75,216,.10); }
.p34-turn .en { font-size: 16px; line-height: 1.7; }
.p34-side { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.p34-tplay { width: 30px; height: 30px; border-radius: 50%; border: 1px solid ${C1}; background: var(--card); color: ${C1}; font-size: 11px; cursor: pointer; padding: 0 0 0 2px; }
.p34-tplay:hover, .p34-turn.now .p34-tplay { background: ${C1}; color: #fff; }
.p34-seekrow { display: flex; align-items: center; gap: 10px; } .p34-time { font-family: var(--en); white-space: nowrap; min-width: 76px; text-align: right; }
.p34-track.seek { flex: 1; height: 8px; overflow: visible; cursor: pointer; position: relative; touch-action: none; }
.p34-track.seek::before { content: ''; position: absolute; inset: -9px 0; }
.p34-track.seek div { border-radius: 4px; position: relative; pointer-events: none; }
.p34-track.seek i { position: absolute; right: -7px; top: 50%; width: 14px; height: 14px; margin-top: -7px; border-radius: 50%; background: #fff; border: 3px solid ${C1}; box-sizing: border-box; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
.p34-sp { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font: 800 12px var(--en); color: #1f1650; }
.p34-sp.sp-W { background: #ffd6e8; } .p34-sp.sp-M { background: #c8f3e6; } .p34-sp.sp-N { background: var(--soft); color: ${C1}; }
.p34-explain h3 { margin-top: 18px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.p34-x { border-top: 1px solid var(--line); margin-top: 14px; }
.p34-ans { margin: 8px 0; padding: 8px 12px; border-radius: 8px; background: var(--ok-soft); }
.p34-expl { line-height: 1.9; } .p34-ref { color: ${C1}; font-family: var(--en); }
.p34-vocab { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; } .p34-vocab span { padding: 2px 10px; border-radius: 999px; background: var(--soft); font-size: 13px; }
.p34-orig { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 10px; } .p34-orig summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.p34-orig img { display: block; width: 100%; max-width: 760px; margin-top: 10px; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
:root[data-theme="dark"] .p34-orig img, :root[data-theme="dark"] .p34-graphic img { filter: invert(.9) hue-rotate(180deg); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .p34-orig img, :root:not([data-theme="light"]) .p34-graphic img { filter: invert(.9) hue-rotate(180deg); } }
.p34-finish { text-align: center; } .p34-score { font: 800 56px var(--en); line-height: 1.1; margin: 6px 0; } .p34-score small { font-size: 22px; color: var(--muted); }
.p34-tgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
.p34-tcard { display: flex; flex-direction: column; gap: 4px; margin: 0; } .p34-tcard .btn { justify-content: space-between; margin-top: 6px; }
.p34-tn { font: 800 20px var(--en); color: ${C1}; }
.p34-mockcard .p34-now { text-align: center; }
label.chk { display: flex; gap: 8px; align-items: center; }
@media (max-width: 720px) {
  .p34-hero { grid-template-columns: 1fr; padding: 20px; } .p34-bubbles { display: none; } .p34-hero h1 { font-size: 22px; }
  .p34-hero .row .btn { width: 100%; }
  .p34-card { padding: 14px 12px 10px; } .p34-ch { grid-template-columns: 1fr; } .p34-qja { margin-left: 0; }
}`;
  document.head.appendChild(el);
}
