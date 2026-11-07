import { $, $$, esc, api, store, loadAll, saveLocal, toast, fmtSec, pct, shuffle, tokenize, completeHtml, questionLabel, LETTERS, fmtDate } from './util.js';
import { STATIC, unlock, hydrateImages, pull } from './static.js';
import { playSequence, stop, blankSegments, completeItems, questionItems, usesBookBlank, onAudioState, isPlaying, voices, pickVoice, speak, audioDuration } from './audio.js';
import { initPopup, closePopup, popupOpen, markRegistered, wordsView, wordDetailView, wordReviewView } from './words.js';

const app = $('#app');
let keyHandler = null;   // 画面ごとのキーボード操作
let cleanup = null;

// ================= ルーター =================
const routes = [
  [/^#?\/?$/, home], [/^#\/practice$/, practiceSetup], [/^#\/session$/, session], [/^#\/q\/(.+)$/, questionDetail],
  [/^#\/exam$/, examSetup], [/^#\/exam\/run$/, examRun], [/^#\/exam\/result\/(.+)$/, examResult],
  [/^#\/review$/, reviewSetup], [/^#\/listen$/, listenSetup], [/^#\/listen\/run$/, listenRun],
  [/^#\/words$/, wordsView], [/^#\/words\/review$/, wordReviewView], [/^#\/words\/(\d+)$/, (r, p, id) => wordDetailView(r, id)],
  [/^#\/settings$/, settings], [/^#\/more$/, more],
];

async function route() {
  stop(); closePopup();
  if (cleanup) { cleanup(); cleanup = null; }
  keyHandler = null; app.onclick = app.onchange = app.oninput = null; app._keys = null;
  const [path, query] = location.hash.split('?');
  const params = new URLSearchParams(query || '');
  const nav = (path.split('/')[1] || 'home').replace(/^$/, 'home');
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav || (nav === 'q' && a.dataset.nav === 'practice') || (nav === 'session' && a.dataset.nav === 'practice')));
  for (const [re, fn] of routes) {
    const m = (path || '#/').match(re);
    if (m) { window.scrollTo(0, 0); await fn(app, params, ...m.slice(1)); markRegistered(app); return; }
  }
  app.innerHTML = '<div class="card">ページが見つかりません</div>';
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (popupOpen() && e.key !== 'Escape') return;
  if (keyHandler) keyHandler(e);
  else if (app._keys) app._keys(e);
});

// ================= 出題条件 =================
function chapters() {
  const m = new Map();
  for (const q of store.questions) if (q.category) m.set(q.category, (m.get(q.category) || 0) + 1);
  return [...m.entries()];
}

function filterQuestions(f) {
  const st = store.stats;
  let qs = store.questions.filter((q) => {
    if (f.material && q.material !== f.material) return false;
    if (f.part && String(q.part) !== String(f.part)) return false;
    if (f.categories && f.categories.length && !f.categories.includes(q.category)) return false;
    if (f.section && !(q.section || '').includes(f.section)) return false;
    if (f.from && q.no < +f.from) return false;
    if (f.to && q.no > +f.to) return false;
    const s = st[q.id] || {};
    switch (f.status) {
      case 'unanswered': return !s.n;
      case 'wrong': return s.n && s.latest === 0;
      case 'everwrong': return s.n && s.ok < s.n;
      case 'bookmark': return !!s.bookmark;
      case 'review': return !!s.review;
      case 'slow': return s.lastMs > (f.slowSec || 30) * 1000;
      default: return true;
    }
  });
  if (f.order === 'random') qs = shuffle(qs);
  else if (f.order === 'weak') qs.sort((a, b) => weakScore(b) - weakScore(a));
  else qs.sort((a, b) => a.no - b.no);
  if (f.count && +f.count > 0) qs = qs.slice(0, +f.count);
  return qs;
}
const weakScore = (q) => { const s = store.stats[q.id] || {}; return (s.n ? (s.n - s.ok) / s.n : 0.5) + (s.review ? 0.5 : 0) + (s.bookmark ? 0.3 : 0) + Math.min(1, (s.lastMs || 0) / 60000); };

function startSession(qs, mode = 'practice', title = '演習') {
  if (!qs.length) return toast('条件に合う問題がありません');
  sessionStorage.setItem('session', JSON.stringify({ ids: qs.map((q) => q.id), i: 0, mode, title, id: Date.now().toString(36), results: {} }));
  location.hash = mode === 'listen' ? '#/listen/run' : '#/session';
}

function filterForm(f, { withCount = true } = {}) {
  return `
  <div class="form-grid">
    <label>教材<select name="material"><option value="">すべて</option>${store.materials.map((m) => `<option value="${m.id}" ${f.material === m.id ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select></label>
    <label>Part<select name="part"><option value="">すべて</option>${[...new Set(store.questions.map((q) => q.part))].map((p) => `<option ${String(f.part) === String(p) ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>状態<select name="status">${[['', 'すべて'], ['unanswered', '未回答'], ['wrong', '直近で間違えた'], ['everwrong', '一度でも間違えた'], ['bookmark', 'ブックマーク'], ['review', '要復習'], ['slow', '時間がかかった（30秒超）']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>順序<select name="order">${[['seq', '番号順'], ['random', 'ランダム'], ['weak', '苦手な順']].map(([v, l]) => `<option value="${v}" ${f.order === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>番号（から）<input name="from" type="number" min="1" value="${esc(f.from || '')}" placeholder="1"></label>
    <label>番号（まで）<input name="to" type="number" min="1" value="${esc(f.to || '')}" placeholder="1019"></label>
    ${withCount ? `<label>出題数<input name="count" type="number" min="0" value="${esc(f.count ?? 20)}" placeholder="0=すべて"></label>` : ''}
    <label>セクション<select name="section"><option value="">すべて</option>${['例題', 'トレーニング', '実戦問題', '基礎編', '応用編', '発展編', '文法模試'].map((s) => `<option ${f.section === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
  </div>
  <div class="cat-pick"><div class="small muted">文法カテゴリ（未選択＝すべて）</div>
    ${chapters().map(([c, n]) => `<label class="chip-check"><input type="checkbox" name="cat" value="${esc(c)}" ${(f.categories || []).includes(c) ? 'checked' : ''}><span>${esc(c)} <small>${n}</small></span></label>`).join('')}
  </div>`;
}
function readForm(root) {
  const f = {};
  for (const el of $$('select[name], input[name]:not([type=checkbox])', root)) f[el.name] = el.value;
  f.categories = $$('input[name=cat]:checked', root).map((x) => x.value);
  return f;
}

// ================= ホーム（ダッシュボード） =================
async function home(root) {
  const d = await api('dashboard');
  const qs = store.questions;
  const answered = qs.filter((q) => store.stats[q.id]?.n).length;
  // カテゴリ別正答率
  const cat = new Map();
  for (const q of qs) {
    const s = store.stats[q.id]; if (!s || !s.n) continue;
    const c = cat.get(q.category) || { n: 0, ok: 0, q: 0, ms: 0 };
    c.n += s.n; c.ok += s.ok; c.q++; c.ms += s.ms || 0; cat.set(q.category, c);
  }
  const cats = [...cat.entries()].map(([k, v]) => ({ k, ...v, rate: pct(v.ok, v.n) })).sort((a, b) => a.rate - b.rate);
  const weak = cats.filter((c) => c.n >= 5 && c.rate < 80).slice(0, 3);
  const next = qs.find((q) => !store.stats[q.id]?.n);
  const exams = await api('exams');
  root.innerHTML = `
    <section class="hero card">
      <div><h1>今日も1問から。</h1><p class="muted">解く → 聞く → 分からない単語を登録 → 復習</p></div>
      <div class="hero-actions">
        ${next ? `<a class="btn primary" href="#/practice?resume=1" id="goNext">続きから演習（No.${next.label}〜）</a>` : ''}
        <a class="btn ${d.words.due ? 'accent' : ''}" href="#/words/review">単語の復習 ${d.words.due ? `<b>${d.words.due}語</b>` : ''}</a>
        <a class="btn" href="#/review">苦手問題を復習</a>
      </div>
    </section>
    <div class="stats-grid">
      ${stat('今日の学習', `${d.today.questions}<small>問</small>`, `正解 ${d.today.correct} / 解答 ${d.today.attempts}`)}
      ${stat('累計', `${d.total.questions}<small>/ ${qs.length}問</small>`, `解答 ${d.total.attempts}回`)}
      ${stat('初回正答率', `${pct(d.firstRate[1], d.firstRate[0])}<small>%</small>`, `${d.firstRate[0]}問`)}
      ${stat('復習後の正答率', `${pct(d.laterRate[1], d.laterRate[0])}<small>%</small>`, `2回目以降 ${d.laterRate[0]}回`)}
      ${stat('平均解答時間', fmtSec(d.total.avgMs), '目標 20〜30秒')}
      ${stat('単語帳', `${d.words.total}<small>語</small>`, `今週の新規 ${d.words.week} ・ 未習得 ${d.words.unmastered}`)}
      ${stat('今日の単語復習', `${d.today.wordReviews}<small>回</small>`, `復習待ち ${d.words.due}語 ・ 今日登録 ${d.today.newWords}`)}
      ${stat('習得済み単語', `${d.words.mastered}<small>語</small>`, '復習間隔60日以上')}
    </div>
    <div class="two-col">
      <section class="card"><h2>学習推移</h2>
        <div class="seg" id="rangeSeg"><button data-r="7" class="on">7日</button><button data-r="30">30日</button></div>
        <div id="chart"></div>
        <div class="legend small"><span class="lg q"></span>解いた問題 <span class="lg ok"></span>正解 <span class="lg w"></span>単語復習</div>
      </section>
      <section class="card"><h2>文法カテゴリ別 正答率</h2>
        ${cats.length ? `<table class="tbl"><tr><th>カテゴリ</th><th>問題</th><th>正答率</th><th>平均</th></tr>${cats.map((c) => `<tr><td>${esc(c.k)}</td><td>${c.q}</td><td><div class="bar"><span style="width:${c.rate}%" class="${c.rate < 70 ? 'low' : ''}"></span><em>${c.rate}%</em></div></td><td>${fmtSec(c.ms / c.q)}</td></tr>`).join('')}</table>` : '<p class="muted">まだデータがありません。</p>'}
        ${weak.length ? `<div class="weak"><b>苦手分野:</b> ${weak.map((w) => `<a href="#/practice?cat=${encodeURIComponent(w.k)}">${esc(w.k)}（${w.rate}%）</a>`).join('、')}</div>` : ''}
      </section>
    </div>
    <section class="card"><h2>進捗</h2>
      <div class="progress big"><div style="width:${pct(answered, qs.length)}%"></div></div>
      <div class="small muted">${answered} / ${qs.length} 問に解答済み</div>
      ${exams.length ? `<h3>最近の模試</h3><table class="tbl">${exams.slice(0, 5).map((e) => `<tr><td>${fmtDate(e.finished)}</td><td>${esc(e.title)}</td><td><b>${e.score}/${e.total}</b></td><td><a href="#/exam/result/${e.id}">結果</a></td></tr>`).join('')}</table>` : ''}
    </section>`;
  const drawChart = (n) => { $('#chart', root).innerHTML = chart(d.days.slice(-n)); };
  drawChart(7);
  $('#rangeSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('#rangeSeg button', root).forEach((x) => x.classList.toggle('on', x === b)); drawChart(+b.dataset.r); };
}
const stat = (label, val, sub) => `<div class="card stat"><div class="label">${label}</div><div class="val">${val}</div><div class="sub small muted">${sub}</div></div>`;

function chart(days) {
  const W = 600, H = 160, pad = 22, bw = (W - pad * 2) / days.length;
  const max = Math.max(5, ...days.map((d) => Math.max(d.n, d.wr)));
  const y = (v) => H - pad - (v / max) * (H - pad * 2);
  const bars = days.map((d, i) => {
    const x = pad + i * bw;
    return `<rect class="q" x="${x + bw * 0.12}" y="${y(d.n)}" width="${bw * 0.38}" height="${H - pad - y(d.n)}"><title>${d.d} 解答${d.n} 正解${d.ok}</title></rect>
      <rect class="ok" x="${x + bw * 0.12}" y="${y(d.ok)}" width="${bw * 0.38}" height="${H - pad - y(d.ok)}"></rect>
      <rect class="w" x="${x + bw * 0.52}" y="${y(d.wr)}" width="${bw * 0.34}" height="${H - pad - y(d.wr)}"><title>${d.d} 単語復習${d.wr}</title></rect>
      ${days.length <= 7 || i % 5 === 0 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.d.slice(5).replace('-', '/')}</text>` : ''}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="学習推移"><line x1="${pad}" x2="${W - pad}" y1="${H - pad}" y2="${H - pad}" class="axis"/>${bars}<text x="${pad}" y="12" class="axis-t">${max}</text></svg>`;
}

// ================= 演習：条件設定 =================
function practiceSetup(root, params) {
  const f = { order: 'seq', count: 20, ...(store.local.practice || {}) };
  if (params.get('cat')) { f.categories = [params.get('cat')]; f.status = ''; }
  if (params.get('resume')) { f.status = 'unanswered'; f.order = 'seq'; f.categories = []; f.from = ''; f.to = ''; f.section = ''; }
  root.innerHTML = `
    <div class="page-head"><h1>通常学習</h1></div>
    <form class="card" id="pf">${filterForm(f)}
      <div class="row gap"><button class="btn primary" type="submit">開始</button><span class="muted small" id="cnt"></span></div>
    </form>
    <div class="card small muted">操作: <kbd>1</kbd>〜<kbd>4</kbd> 選択 ・ <kbd>Enter</kbd> 解答/次へ ・ <kbd>→</kbd><kbd>←</kbd> 次/前 ・ <kbd>Space</kbd> 音声 ・ <kbd>B</kbd> ブックマーク ・ 単語クリックで辞書と登録</div>`;
  const form = $('#pf', root);
  const upd = () => { const x = readForm(form); $('#cnt', root).textContent = `該当 ${filterQuestions({ ...x, count: 0 }).length} 問`; };
  form.oninput = upd; upd();
  form.onsubmit = (e) => { e.preventDefault(); const x = readForm(form); store.local.practice = x; saveLocal(); startSession(filterQuestions(x), 'practice', '通常学習'); };
  if (params.get('resume')) form.requestSubmit();
}

// ================= 演習セッション =================
function getSession() { try { return JSON.parse(sessionStorage.getItem('session')); } catch (e) { return null; } }
function putSession(s) { sessionStorage.setItem('session', JSON.stringify(s)); }

function session(root) {
  const s = getSession();
  if (!s || !s.ids.length) { location.hash = '#/practice'; return; }
  renderQuestion(root, s);
}

function questionDetail(root, params, id) {
  const q = store.byId.get(decodeURIComponent(id));
  if (!q) { root.innerHTML = '<div class="card">問題が見つかりません</div>'; return; }
  const s = { ids: [q.id], i: 0, mode: 'practice', title: '問題', id: 'q' + Date.now().toString(36), results: {} };
  if (params.get('show')) s.results[q.id] = { choice: null, correct: null, review: true };
  renderQuestion(root, s, { single: true });
}

function renderQuestion(root, s, opt = {}) {
  const justAnswered = opt.justAnswered;
  opt = { ...opt, justAnswered: false };
  const q = store.byId.get(s.ids[s.i]);
  if (!q) { s.i = 0; putSession(s); return renderQuestion(root, s, opt); }
  const res = s.results[q.id];         // 解答済みならその結果
  const answered = !!res;
  let selected = res ? res.choice : null;
  const t0 = Date.now();
  const st = store.stats[q.id] || {};
  root.innerHTML = `
    <div class="qbar">
      <span class="qpos">${opt.single ? '' : `${s.i + 1} / ${s.ids.length}`}</span>
      <span class="qmeta">${esc(questionLabel(q))} ・ ${esc(q.category || '')}${q.section ? ' ・ ' + esc(q.section) : ''}</span>
      <span class="timer" id="timer">0:00</span>
      <button class="icon-btn star ${st.bookmark ? 'on' : ''}" id="bm" title="ブックマーク (B)">${st.bookmark ? '★' : '☆'}</button>
    </div>
    ${opt.single ? '' : `<div class="progress"><div style="width:${((s.i + (answered ? 1 : 0)) / s.ids.length) * 100}%"></div></div>`}
    <article class="card qcard">
      <div class="en question" data-src="${esc(q.id)}">${tokenize(q.text)}</div>
      <div class="audio-row">
        <button class="btn round" id="play" title="音声 (Space)">▶</button>
        <span class="small muted" id="playLabel">${answered ? '完成文' : `空欄は無音・${usesBookBlank(q) ? '教材音声' : '合成音声'}`}</span>
        ${rateSelect()}
        <label class="small"><input type="checkbox" id="rep" ${store.local.repeat > 1 ? 'checked' : ''}> 繰り返し</label>
        <span class="spacer"></span>
        ${answered || store.local.oneClick ? '' : `<button class="btn primary" id="submit" disabled>解答</button>`}
        ${opt.single ? '' : `<button class="btn ghost qnav" id="prev" ${s.i === 0 ? 'disabled' : ''}>←<span class="nt"> 前</span></button><button class="btn ${answered ? 'primary' : 'ghost'} qnav" id="next">${s.i === s.ids.length - 1 ? '終了' : '<span class="nt">次へ </span>→'}</button>`}
      </div>
      <div class="choices ${answered ? 'answered' : ''}" data-src="${esc(q.id)}">
        ${q.choices.map((c, i) => `<button class="choice" data-i="${i}"><span class="key">${i + 1}</span><span class="letter">(${LETTERS[i]})</span><span class="ctext">${tokenize(c)}</span></button>`).join('')}
      </div>
    </article>
    <div id="explain"></div>`;

  const timerEl = $('#timer', root);
  const tick = setInterval(() => { const sec = Math.floor((Date.now() - t0) / 1000); timerEl.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; timerEl.classList.toggle('slow', sec >= 30 && !s.results[q.id]); }, 500);
  if (answered) { clearInterval(tick); timerEl.textContent = res.ms ? fmtSec(res.ms) : ''; }
  const offAudio = onAudioState((p) => { const b = $('#play', root); if (b) b.textContent = p ? '■' : '▶'; });
  cleanup = () => { clearInterval(tick); offAudio(); };

  const choiceBtns = $$('.choice', root);
  const paint = () => {
    choiceBtns.forEach((b, i) => {
      b.classList.toggle('sel', i === selected);
      const r = s.results[q.id];
      if (r) { b.classList.toggle('correct', i === q.answer); b.classList.toggle('wrong', i === r.choice && i !== q.answer); b.disabled = false; }
    });
    const sub = $('#submit', root); if (sub) sub.disabled = selected == null;
  };
  const play = () => {
    if (isPlaying()) return stop();
    const items = s.results[q.id] ? completeItems(q) : questionItems(q);
    playSequence(items, { repeat: $('#rep', root).checked ? 3 : 1 });
  };
  // 自動再生: 画面切替直後に開始。素早く次へ進んだ場合に前の問題を鳴らさないよう、表示中の問題か確認する
  const myRender = (renderGen = (renderGen || 0) + 1);
  const autoPlay = () => setTimeout(() => {
    if (myRender !== renderGen || !store.local.autoPlay) return;
    const items = s.results[q.id] ? completeItems(q) : questionItems(q);
    playSequence(items, { repeat: $('#rep', root)?.checked ? 3 : 1 });
  }, 150);
  const submit = async () => {
    if (s.results[q.id] || selected == null) return;
    const ms = Date.now() - t0;
    clearInterval(tick);
    timerEl.textContent = fmtSec(ms);
    const correct = selected === q.answer;
    s.results[q.id] = { choice: selected, correct, ms };
    putSession(s);
    stop();
    try {
      await api('attempt', { body: { qid: q.id, choice: selected, correct, ms, mode: s.mode, session: s.id } });
      const x = store.stats[q.id] || { n: 0, ok: 0 };
      store.stats[q.id] = { ...x, n: x.n + 1, ok: x.ok + (correct ? 1 : 0), latest: correct ? 1 : 0, first: x.n ? x.first : correct ? 1 : 0, lastMs: ms, last: new Date().toISOString() };
    } catch (e) { toast('記録の保存に失敗しました: ' + e.message); }
    if (correct && store.local.skipCorrect && !opt.single) { toast('○ 正解', 900); return go(1); } // 正解なら解説を飛ばして次へ
    renderQuestion(root, s, { ...opt, justAnswered: true }); // 解答後の完成文は新しい描画側で自動再生
  };
  const go = (d) => {
    const n = s.i + d;
    if (n < 0) return;
    if (n >= s.ids.length) return finish(root, s);
    s.i = n; putSession(s); renderQuestion(root, s, opt); window.scrollTo(0, 0);
  };

  root.onclick = async (e) => {
    const c = e.target.closest('.choice');
    if (c && !e.target.closest('.w')) {
      if (s.results[q.id]) return;
      selected = +c.dataset.i; paint();
      if (store.local.oneClick) submit();
      return;
    }
    const id = e.target.closest('button')?.id;
    if (id === 'play') play();
    if (id === 'submit') submit();
    if (id === 'next') go(1);
    if (id === 'prev') go(-1);
    if (id === 'bm') toggleBookmark(q, root);
  };
  root.onchange = (e) => { if (e.target.id === 'rate') { store.local.rate = +e.target.value; saveLocal(); } if (e.target.id === 'rep') { store.local.repeat = e.target.checked ? 3 : 1; saveLocal(); } };
  keyHandler = (e) => {
    if (['1', '2', '3', '4'].includes(e.key) && !s.results[q.id]) { selected = +e.key - 1; paint(); submit(); } // テンキー含め押した時点で解答
    else if (e.key === 'Enter') { e.preventDefault(); s.results[q.id] ? (!opt.single && go(1)) : submit(); }
    else if (e.key === 'ArrowRight' && !opt.single) go(1);
    else if (e.key === 'ArrowLeft' && !opt.single) go(-1);
    else if (e.key === ' ') { e.preventDefault(); play(); }
    else if (e.key === 'b' || e.key === 'B') toggleBookmark(q, root);
  };
  paint();
  if (s.results[q.id]) renderExplanation($('#explain', root), q, s.results[q.id]);
  if (!s.results[q.id]) autoPlay();
  else stop();
  // 解答直後は解説欄が画面の中心に来るよう自動スクロール
  if (justAnswered) requestAnimationFrame(() => $('#explain', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
let renderGen = 0;

function rateSelect() {
  return `<select id="rate" title="再生速度">${[0.75, 0.85, 1, 1.1, 1.25].map((r) => `<option value="${r}" ${+store.local.rate === r ? 'selected' : ''}>${r}x</option>`).join('')}</select>`;
}

async function toggleBookmark(q, root) {
  const cur = store.stats[q.id]?.bookmark ? 1 : 0;
  await api('qstate', { body: { qid: q.id, bookmark: cur ? 0 : 1 } });
  store.stats[q.id] = { n: 0, ok: 0, ...store.stats[q.id], bookmark: cur ? 0 : 1 };
  const b = $('#bm', root); if (b) { b.textContent = cur ? '☆' : '★'; b.classList.toggle('on', !cur); }
  toast(cur ? 'ブックマークを外しました' : 'ブックマークしました');
}

function renderExplanation(el, q, res) {
  const st = store.stats[q.id] || {};
  const v = q.verify || {};
  el.innerHTML = `
    <section class="card explain ${res.correct === false ? 'is-wrong' : res.correct ? 'is-right' : ''}">
      <div class="verdict">${res.correct == null ? '' : res.correct ? '<span class="ok">○ 正解</span>' : '<span class="ng">× 不正解</span>'}
        <span>正解 <b>(${LETTERS[q.answer]}) ${esc(q.choices[q.answer])}</b></span>
        ${st.n ? `<span class="small muted">これまで ${st.ok}/${st.n} 正解</span>` : ''}</div>
      <h3>完成文</h3>
      <div class="en complete" data-src="${esc(q.id)}">${completeHtml(q)}</div>
      <div class="audio-row">
        <button class="btn round" id="play2" title="完成文を再生 (Space)">▶</button>
        <span class="small muted">${q.audio && store.audio[q.audio.split('/')[0]] && store.local.preferBook ? '教材音声' : '合成音声'}</span>
        <button class="btn ghost sm" id="shadow">シャドーイング（3回）</button>
        <button class="btn ghost sm" id="tts">合成音声で再生</button>
      </div>
      ${q.translation ? `<h3>日本語訳</h3><p class="ja">${esc(q.translation)}</p>` : ''}
      <h3>解説 <span class="tag">教材</span> <button class="btn ghost sm" id="orig">原本の画像</button></h3>
      <div class="ja expl" data-src="${esc(q.id)}">${tokenize(q.explanation || '（解説テキストなし）', { blank: false }).replace(/\n/g, '<br>')}</div>
      ${q.notes ? `<div class="notes"><b>TEX's notes</b><div class="ja" data-src="${esc(q.id)}">${tokenize(q.notes, { blank: false })}</div></div>` : ''}
      <div id="origImg" hidden>${(q.crops || []).map((c) => (STATIC ? `<img data-enc="/${esc(c)}" alt="原本の解説">` : `<img src="/${esc(c)}" alt="原本の解説" loading="lazy">`)).join('')}</div>
      ${q.glosses && q.glosses.length ? `<h3>重要語句（解説より）</h3><div class="gloss" data-src="${esc(q.id)}">${q.glosses.map(([en, ja]) => `<span class="g"><span class="en">${tokenize(en)}</span> <span class="ja">${esc(ja)}</span></span>`).join('')}</div>` : ''}
      <div id="aiBox">${store.ai ? '<button class="btn ghost sm" id="aiExplain">AIの補足説明を見る</button>' : ''}</div>
      <div class="small muted foot">出典: ${esc(questionLabel(q))}（本体p.${q.page?.a ?? '-'}）${v.status && v.status !== 'verified' ? ` ・ <span class="warn">データ検証: ${esc(v.status)}${v.issues?.length ? '（' + esc(v.issues.join('、')) + '）' : ''}</span>` : ''}
        ・ <label><input type="checkbox" id="rv" ${st.review ? 'checked' : ''}> 要復習に追加</label></div>
      <p class="small muted">※解説・訳はスキャン画像のOCRです。誤字があれば「原本の画像」で確認できます。</p>
    </section>`;
  el.onclick = async (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'play2') isPlaying() ? stop() : playSequence(completeItems(q));
    if (id === 'shadow') {
      const items = completeItems(q);
      const dur = items[0].url ? await audioDuration(items[0].url) : q.complete.split(' ').length * 400;
      playSequence(items, { repeat: 3, gap: Math.round(dur * 1.1) });
      toast('再生の後の無音の間に、続けて音読しましょう');
    }
    if (id === 'tts') speak(q.complete);
    if (id === 'orig') { const im = $('#origImg', el); im.hidden = !im.hidden; hydrateImages(im); }
    if (id === 'aiExplain') {
      e.target.disabled = true; e.target.textContent = 'AIに問い合わせ中…';
      try {
        const r = await api('ai/explain', { body: q });
        $('#aiBox', el).innerHTML = `<div class="ai-box"><b>AIによる補足</b> <span class="small muted">（教材の解説が優先。AIは誤ることがあります）</span><ul>${r.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
      } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = 'AIの補足説明を見る'; }
    }
  };
  el.onchange = async (e) => {
    if (e.target.id === 'rv') {
      await api('qstate', { body: { qid: q.id, review: e.target.checked ? 1 : 0 } });
      store.stats[q.id] = { n: 0, ok: 0, ...store.stats[q.id], review: e.target.checked ? 1 : 0 };
    }
  };
  markRegistered(el);
}

function finish(root, s) {
  stop();
  const rs = s.ids.map((id) => s.results[id]).filter(Boolean);
  const ok = rs.filter((r) => r.correct).length;
  const ms = rs.reduce((a, r) => a + (r.ms || 0), 0);
  const wrong = s.ids.filter((id) => s.results[id] && !s.results[id].correct);
  root.innerHTML = `<div class="card center">
    <h2>${esc(s.title)} 終了</h2>
    <div class="score">${ok}<small> / ${rs.length}</small></div>
    <p class="muted">正答率 ${pct(ok, rs.length)}% ・ 平均 ${fmtSec(rs.length ? ms / rs.length : 0)}</p>
    <div class="row gap center">
      ${wrong.length ? `<button class="btn primary" id="retry">間違えた ${wrong.length}問を解き直す</button>` : ''}
      <a class="btn" href="#/practice">条件を変えて演習</a><a class="btn" href="#/words/review">単語の復習へ</a>
    </div></div>
    <div class="card"><table class="tbl">${s.ids.map((id, i) => { const q = store.byId.get(id); const r = s.results[id]; return `<tr><td>${i + 1}</td><td><a href="#/q/${id}?show=1">No.${q.label}</a></td><td>${r ? (r.correct ? '<span class="ok">○</span>' : '<span class="ng">×</span>') : '-'}</td><td>${r ? fmtSec(r.ms) : ''}</td><td class="small">${esc(q.category)}</td></tr>`; }).join('')}</table></div>`;
  root.onclick = (e) => { if (e.target.id === 'retry') startSession(wrong.map((id) => store.byId.get(id)), 'practice', '解き直し'); };
}

// ================= 模試 =================
function examSetup(root) {
  const sets = store.materials.flatMap((m) => (m.sets || []).map((x) => ({ ...x, material: m.short })));
  const e = store.settings.exam || { count: 30, minutes: 10 };
  root.innerHTML = `
    <div class="page-head"><h1>本番模擬試験</h1></div>
    <div class="card">
      <h2>ランダム模試（Part 5 形式）</h2>
      <div class="form-grid">
        <label>問題数<input id="ec" type="number" min="5" max="100" value="${e.count}"></label>
        <label>制限時間（分）<input id="em" type="number" min="1" max="60" value="${e.minutes}"></label>
        <label>出題範囲<select id="es"><option value="">全問題</option><option value="unanswered">未回答</option><option value="everwrong">間違えたことがある</option></select></label>
      </div>
      <button class="btn primary" id="startRandom">開始</button>
      <p class="small muted">解答中は正誤を表示しません。音声もありません。終了後に採点し、1問ごとの解答時間を分析します。</p>
    </div>
    ${sets.length ? `<div class="card"><h2>教材の文法模試</h2><div class="set-grid">${sets.map((x) => `<button class="btn set" data-set="${x.id}">${esc(x.title)}<small>${x.qids.length}問・${Math.round(x.qids.length / 3)}分</small></button>`).join('')}</div></div>` : ''}`;
  root.onclick = (ev) => {
    if (ev.target.id === 'startRandom') {
      const n = +$('#ec', root).value || 30, min = +$('#em', root).value || 10;
      api('settings', { body: { exam: { count: n, minutes: min } } }).then((r) => (store.settings = r.settings));
      const qs = filterQuestions({ status: $('#es', root).value, order: 'random', count: n });
      beginExam(qs, `ランダム模試 ${qs.length}問`, min * 60);
    }
    const b = ev.target.closest('[data-set]');
    if (b) { const x = sets.find((y) => y.id === b.dataset.set); beginExam(x.qids.map((id) => store.byId.get(id)).filter(Boolean), x.title, Math.round(x.qids.length / 3) * 60); }
  };
}
function beginExam(qs, title, limitSec) {
  if (!qs.length) return toast('問題がありません');
  sessionStorage.setItem('exam', JSON.stringify({ id: 'ex' + Date.now().toString(36), title, limitSec, qids: qs.map((q) => q.id), answers: qs.map(() => null), times: qs.map(() => 0), i: 0, started: new Date().toISOString(), startMs: Date.now() }));
  location.hash = '#/exam/run';
}
function examRun(root) {
  let ex; try { ex = JSON.parse(sessionStorage.getItem('exam')); } catch (e) { /* */ }
  if (!ex) { location.hash = '#/exam'; return; }
  let qStart = Date.now();
  const save = () => sessionStorage.setItem('exam', JSON.stringify(ex));
  const left = () => ex.limitSec - Math.floor((Date.now() - ex.startMs) / 1000);
  const draw = () => {
    const q = store.byId.get(ex.qids[ex.i]);
    root.innerHTML = `
      <div class="qbar exam"><span class="qpos">${esc(ex.title)} ${ex.i + 1} / ${ex.qids.length}</span><span class="timer big" id="cd"></span><button class="btn sm" id="end">提出して採点</button></div>
      <article class="card qcard">
        <div class="small muted">${ex.i + 1}.</div>
        <div class="en question">${esc(q.text).replace(/-{3,}|_{3,}|—+/, '<span class="blank">&nbsp;</span>')}</div>
        <div class="choices">${q.choices.map((c, i) => `<button class="choice ${ex.answers[ex.i] === i ? 'sel' : ''}" data-i="${i}"><span class="key">${i + 1}</span><span class="letter">(${LETTERS[i]})</span><span class="ctext">${esc(c)}</span></button>`).join('')}</div>
        <div class="row gap"><button class="btn ghost" id="prev" ${ex.i === 0 ? 'disabled' : ''}>← 前</button><span class="spacer"></span><button class="btn primary" id="next">${ex.i === ex.qids.length - 1 ? '確認' : '次へ →'}</button></div>
      </article>
      <div class="card"><div class="qgrid">${ex.qids.map((id, i) => `<button class="${ex.answers[i] != null ? 'done' : ''} ${i === ex.i ? 'cur' : ''}" data-go="${i}">${i + 1}</button>`).join('')}</div></div>`;
    tickFn();
  };
  const leave = () => { ex.times[ex.i] += Date.now() - qStart; qStart = Date.now(); save(); };
  const go = (i) => { leave(); ex.i = Math.max(0, Math.min(ex.qids.length - 1, i)); save(); draw(); };
  const submit = async (auto) => {
    if (!auto && ex.answers.some((a) => a == null) && !confirm(`未解答が ${ex.answers.filter((a) => a == null).length} 問あります。提出しますか？`)) return;
    leave();
    let score = 0;
    const finished = new Date().toISOString();
    for (let i = 0; i < ex.qids.length; i++) {
      const q = store.byId.get(ex.qids[i]);
      const correct = ex.answers[i] === q.answer;
      if (correct) score++;
      if (ex.answers[i] != null) {
        await api('attempt', { body: { qid: q.id, choice: ex.answers[i], correct, ms: ex.times[i], mode: 'exam', session: ex.id } });
        const x = store.stats[q.id] || { n: 0, ok: 0 };
        store.stats[q.id] = { ...x, n: x.n + 1, ok: x.ok + (correct ? 1 : 0), latest: correct ? 1 : 0, lastMs: ex.times[i] };
      }
    }
    await api('exams', { body: { id: ex.id, title: ex.title, started: ex.started, finished, limitSec: ex.limitSec, qids: ex.qids, answers: ex.answers, times: ex.times, score, total: ex.qids.length } });
    sessionStorage.removeItem('exam');
    location.hash = '#/exam/result/' + ex.id;
  };
  let tickFn = () => { const el = $('#cd', root); if (!el) return; const l = left(); el.textContent = `残り ${Math.floor(Math.max(0, l) / 60)}:${String(Math.max(0, l) % 60).padStart(2, '0')}`; el.classList.toggle('slow', l < 60); if (l <= 0) { clearInterval(iv); toast('時間切れです。採点します'); submit(true); } };
  const iv = setInterval(() => tickFn(), 1000);
  cleanup = () => { clearInterval(iv); leave(); };
  root.onclick = (e) => {
    const c = e.target.closest('.choice');
    if (c) { ex.answers[ex.i] = +c.dataset.i; save(); draw(); return; }
    const g = e.target.closest('[data-go]'); if (g) return go(+g.dataset.go);
    const id = e.target.closest('button')?.id;
    if (id === 'next') ex.i === ex.qids.length - 1 ? submit() : go(ex.i + 1);
    if (id === 'prev') go(ex.i - 1);
    if (id === 'end') submit();
  };
  keyHandler = (e) => {
    if (['1', '2', '3', '4'].includes(e.key)) { ex.answers[ex.i] = +e.key - 1; save(); draw(); }
    else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); if (ex.i < ex.qids.length - 1) go(ex.i + 1); }
    else if (e.key === 'ArrowLeft') go(ex.i - 1);
  };
  draw();
}
async function examResult(root, params, id) {
  const ex = (await api('exams')).find((e) => e.id === id);
  if (!ex) { root.innerHTML = '<div class="card">結果が見つかりません</div>'; return; }
  const total = ex.times.reduce((a, b) => a + b, 0);
  const rows = ex.qids.map((qid, i) => ({ q: store.byId.get(qid), a: ex.answers[i], t: ex.times[i], i }));
  const slow = [...rows].sort((a, b) => b.t - a.t).slice(0, 5);
  const byCat = new Map();
  for (const r of rows) { const c = byCat.get(r.q.category) || { n: 0, ok: 0, t: 0 }; c.n++; c.ok += r.a === r.q.answer ? 1 : 0; c.t += r.t; byCat.set(r.q.category, c); }
  const wrong = rows.filter((r) => r.a !== r.q.answer);
  root.innerHTML = `
    <div class="card center"><h2>${esc(ex.title)}</h2><div class="score">${ex.score}<small> / ${ex.total}</small></div>
      <p class="muted">正答率 ${pct(ex.score, ex.total)}% ・ 所要 ${fmtSec(total)}（制限 ${fmtSec((ex.limit_sec ?? ex.limitSec) * 1000)}） ・ 1問平均 ${fmtSec(total / ex.total)}</p>
      <div class="row gap center">${wrong.length ? `<button class="btn primary" id="retry">間違えた ${wrong.length}問を解説付きで復習</button>` : ''}<a class="btn" href="#/exam">模試トップ</a></div></div>
    <div class="two-col">
      <div class="card"><h3>カテゴリ別</h3><table class="tbl">${[...byCat].map(([k, c]) => `<tr><td>${esc(k)}</td><td>${c.ok}/${c.n}</td><td>${fmtSec(c.t / c.n)}</td></tr>`).join('')}</table></div>
      <div class="card"><h3>時間がかかった問題</h3><table class="tbl">${slow.map((r) => `<tr><td>${r.i + 1}</td><td><a href="#/q/${r.q.id}?show=1">No.${r.q.label}</a></td><td>${fmtSec(r.t)}</td><td>${r.a === r.q.answer ? '<span class="ok">○</span>' : '<span class="ng">×</span>'}</td></tr>`).join('')}</table></div>
    </div>
    <div class="card"><h3>全問の結果</h3><table class="tbl"><tr><th>#</th><th>問題</th><th>あなた</th><th>正解</th><th>時間</th></tr>${rows.map((r) => `<tr class="${r.a === r.q.answer ? '' : 'row-ng'}"><td>${r.i + 1}</td><td><a href="#/q/${r.q.id}?show=1">No.${r.q.label}</a> <span class="small muted">${esc(r.q.category)}</span></td><td>${r.a == null ? '未' : LETTERS[r.a]}</td><td>${LETTERS[r.q.answer]}</td><td class="${r.t > 30000 ? 'warn' : ''}">${fmtSec(r.t)}</td></tr>`).join('')}</table></div>`;
  root.onclick = (e) => {
    if (e.target.id === 'retry') {
      const s = { ids: wrong.map((r) => r.q.id), i: 0, mode: 'review', title: '模試の復習', id: Date.now().toString(36), results: {} };
      wrong.forEach((r) => (s.results[r.q.id] = { choice: r.a, correct: false, ms: r.t }));
      putSession(s); location.hash = '#/session';
    }
  };
}

// ================= 苦手問題復習 =================
function reviewSetup(root) {
  const c = (status) => filterQuestions({ status, count: 0 }).length;
  const presets = [['wrong', '直近で間違えた問題', '最後の解答が不正解'], ['everwrong', '一度でも間違えた問題', '正解できても要注意'],
    ['slow', '時間がかかった問題', '直近の解答が30秒超'], ['bookmark', 'ブックマークした問題', '★を付けた問題'], ['review', '要復習の問題', '解説で「要復習」にチェック']];
  root.innerHTML = `<div class="page-head"><h1>苦手問題の復習</h1></div>
    <div class="preset-grid">${presets.map(([k, t, d]) => `<button class="card preset" data-k="${k}"><b>${t}</b><span class="num">${c(k)}<small>問</small></span><span class="small muted">${d}</span></button>`).join('')}
    <button class="card preset" data-k="weak"><b>苦手度が高い順</b><span class="num">20<small>問</small></span><span class="small muted">誤答率・時間・印から自動選択</span></button></div>`;
  root.onclick = (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = b.dataset.k;
    const qs = k === 'weak' ? filterQuestions({ order: 'weak', status: 'everwrong', count: 20 }).concat(filterQuestions({ status: 'bookmark', count: 0 })).slice(0, 20) : filterQuestions({ status: k, order: 'random', count: 0 });
    startSession(qs, 'review', b.querySelector('b').textContent);
  };
}

// ================= リスニング練習 =================
function listenSetup(root) {
  const f = { order: 'seq', count: 20, ...(store.local.listen || {}) };
  root.innerHTML = `<div class="page-head"><h1>リスニング・シャドーイング</h1></div>
    <form class="card" id="lf">${filterForm(f)}<button class="btn primary">開始</button></form>
    <div class="card small muted">完成文の音声を聞き、英文を隠して聞き取り→表示して確認→訳と解説→シャドーイング、の順で使えます。解答済みの問題から始めるのがおすすめです。</div>`;
  $('#lf', root).onsubmit = (e) => { e.preventDefault(); const x = readForm(e.target); store.local.listen = x; saveLocal(); startSession(filterQuestions(x), 'listen', 'リスニング'); };
}
function listenRun(root) {
  const s = getSession(); if (!s) { location.hash = '#/listen'; return; }
  let hide = store.local.hideText !== false;
  const offAudio = onAudioState((p) => { const b = $('#lp', root); if (b) b.textContent = p ? '■' : '▶'; });
  cleanup = offAudio;
  const draw = () => {
    const q = store.byId.get(s.ids[s.i]);
    root.innerHTML = `
      <div class="qbar"><span class="qpos">${s.i + 1} / ${s.ids.length}</span><span class="qmeta">${esc(questionLabel(q))}</span></div>
      <article class="card listen">
        <div class="audio-row center"><button class="btn round xl" id="lp">▶</button>${rateSelect()}
          <button class="btn ghost sm" id="sh">シャドーイング ×3</button><button class="btn ghost sm" id="ab">反復 ×5</button></div>
        <div class="en complete ${hide ? 'masked' : ''}" id="txt" data-src="${esc(q.id)}">${completeHtml(q)}</div>
        <div class="row gap center"><button class="btn" id="tg">${hide ? '英文を表示 (H)' : '英文を隠す (H)'}</button><button class="btn ghost" id="tr">訳・解説</button></div>
        <div id="more" hidden><p class="ja">${esc(q.translation || '')}</p><div class="ja expl small" data-src="${esc(q.id)}">${tokenize(q.explanation || '', { blank: false })}</div></div>
        <div class="row gap"><button class="btn ghost" id="pv" ${s.i === 0 ? 'disabled' : ''}>← 前</button><span class="spacer"></span><button class="btn primary" id="nx">${s.i === s.ids.length - 1 ? '終了' : '次へ →'}</button></div>
      </article>`;
    markRegistered(root);
    root.onclick = async (e) => {
      const id = e.target.closest('button')?.id;
      if (id === 'lp') isPlaying() ? stop() : playSequence(completeItems(q));
      if (id === 'sh' || id === 'ab') {
        const items = completeItems(q);
        const dur = items[0].url ? await audioDuration(items[0].url) : q.complete.split(' ').length * 400;
        playSequence(items, { repeat: id === 'sh' ? 3 : 5, gap: Math.round(dur * (id === 'sh' ? 1.1 : 0.4)) });
      }
      if (id === 'tg') { hide = !hide; store.local.hideText = hide; saveLocal(); draw(); }
      if (id === 'tr') $('#more', root).hidden = !$('#more', root).hidden;
      if (id === 'nx') { if (s.i < s.ids.length - 1) { s.i++; putSession(s); stop(); draw(); } else { location.hash = '#/listen'; } }
      if (id === 'pv' && s.i > 0) { s.i--; putSession(s); stop(); draw(); }
    };
    root.onchange = (e) => { if (e.target.id === 'rate') { store.local.rate = +e.target.value; saveLocal(); } };
  };
  keyHandler = (e) => {
    if (e.key === ' ') { e.preventDefault(); $('#lp', root)?.click(); }
    else if (e.key === 'h' || e.key === 'H') $('#tg', root)?.click();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') $('#nx', root)?.click();
    else if (e.key === 'ArrowLeft') $('#pv', root)?.click();
  };
  draw();
}

// ================= 設定 =================
async function settings(root) {
  const S = store.settings, L = store.local;
  const vs = voices();
  root.innerHTML = `
    <div class="page-head"><h1>設定</h1></div>
    <section class="card"><h2>音声</h2>
      <div class="form-grid">
        <label>発音<select id="accent"><option value="en-US" ${L.accent === 'en-US' ? 'selected' : ''}>アメリカ英語</option><option value="en-GB" ${L.accent === 'en-GB' ? 'selected' : ''}>イギリス英語</option><option value="en-AU" ${L.accent === 'en-AU' ? 'selected' : ''}>オーストラリア英語</option></select></label>
        <label>声<select id="voice"><option value="">自動（自然な声を優先）</option>${vs.filter((v) => v.lang.replace('_', '-') === L.accent).map((v) => `<option ${v.name === L.voice ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <label>速度<select id="rate2">${[0.75, 0.85, 1, 1.1, 1.25].map((r) => `<option value="${r}" ${+L.rate === r ? 'selected' : ''}>${r}x</option>`).join('')}</select></label>
        <label>空欄の無音（ミリ秒）<input id="pause" type="number" min="200" max="2000" step="100" value="${L.pauseMs}"></label>
      </div>
      <label class="check"><input type="checkbox" id="preferBook" ${L.preferBook ? 'checked' : ''}> 教材のネイティブ音声を優先（解答前は正解部分を無音にした教材音声、解答後は完成文の教材音声。無い問題は合成音声）</label>
      <label class="check"><input type="checkbox" id="autoPlay" ${L.autoPlay ? 'checked' : ''}> 問題表示時に自動再生する</label>
      <label class="check"><input type="checkbox" id="skipCorrect" ${L.skipCorrect ? 'checked' : ''}> 正解したら解説を表示せず、すぐ次の問題へ進む（不正解のときだけ解説を表示）</label>
      <div class="row gap"><button class="btn" id="testVoice">試聴</button><span class="small muted">使用中: ${esc(pickVoice()?.name || '（音声なし）')}</span></div>
      <p class="small muted">合成音声はブラウザ（Windows / Chrome / Edge）の音声を使います。Edge の「Natural」音声が最も自然です。</p>
    </section>
    <section class="card"><h2>演習</h2>
      <label class="check"><input type="checkbox" id="oneClick" ${L.oneClick ? 'checked' : ''}> 選択肢をクリック／タップしたら即解答（キーボードは 1〜4 で選択して Enter）</label>
      <div class="form-grid"><label>模試の問題数<input id="exCount" type="number" value="${S.exam.count}"></label><label>模試の制限時間（分）<input id="exMin" type="number" value="${S.exam.minutes}"></label></div>
    </section>
    <section class="card"><h2>AI 補足（任意）</h2>
      <p class="small">状態: ${store.ai ? '<b class="ok">利用可能</b>' : '未設定（辞書・教材の解説だけで全機能が使えます）'}</p>
      <div class="form-grid"><label>Anthropic API キー<input id="aiKey" type="password" placeholder="${store.ai ? '設定済み（変更する場合のみ入力）' : 'sk-ant-...'}" autocomplete="off"></label>
        <label>モデル<input id="aiModel" value="${esc(S.ai.model)}"></label>
        <label>思考の深さ<select id="aiEffort">${['low', 'medium', 'high'].map((x) => `<option ${S.ai.effort === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
      <p class="small muted">キーはこのPCの data/secrets.json にのみ保存され、バックアップには含まれません。</p>
    </section>
    <section class="card"><h2>単語メール配信（将来機能・現在は送信しません）</h2>
      <label class="check"><input type="checkbox" id="emEnabled" ${S.email.enabled ? 'checked' : ''}> 週1回の自動送信を有効にする <span class="tag">送信処理は未実装</span></label>
      <div class="form-grid"><label>送信先<input id="emTo" type="email" value="${esc(S.email.recipient)}"></label>
        <label>曜日<select id="emDay">${['月', '火', '水', '木', '金', '土', '日'].map((d, i) => `<option value="${i}" ${S.email.weekday === i ? 'selected' : ''}>${d}曜</option>`).join('')}</select></label>
        <label>時刻<input id="emHour" type="number" min="0" max="23" value="${S.email.hour}"></label></div>
      <button class="btn" id="emPreview">今週のメール内容をプレビュー</button>
      <pre id="emBox" class="mail" hidden></pre>
    </section>
    ${STATIC ? `<section class="card"><h2>端末間の同期</h2>
      <p class="small" id="syncInfo">確認中…</p>
      <div class="row gap"><button class="btn" id="syncNow">今すぐ同期</button></div>
      <p class="small muted">解いた問題・単語帳・復習の記録を GitHub の非公開リポジトリ経由で PC・iPhone・iPad と自動で共有します（起動時・アプリに戻った時に取り込み、変更の数秒後に保存）。</p>
    </section>` : ''}
    <section class="card"><h2>データ</h2>
      <div class="row gap"><button class="btn" id="dlBackup">バックアップをダウンロード</button>
        <label class="btn">バックアップから復元<input type="file" id="restore" accept=".json" hidden></label></div>
      <p class="small muted">学習履歴・単語帳・設定を JSON で保存します。${STATIC ? 'Web 版の学習データはこの端末のブラウザ内に保存されます。別の端末へ移すときは、ここでダウンロードしたファイルを移す先で「復元」してください。' : 'サーバー起動時にも data/backups に毎日自動保存（14日分）されます。'}</p>
    </section>
    <div class="row gap"><button class="btn primary" id="save">設定を保存</button></div>`;
  root.onchange = (e) => {
    if (e.target.id === 'accent') { L.accent = e.target.value; L.voice = ''; saveLocal(); settings(root); }
  };
  root.onclick = async (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'testVoice') { readLocal(); speak('The manager asked all employees to submit their reports by Friday.'); }
    if (id === 'syncNow') {
      e.target.disabled = true; $('#syncInfo', root).textContent = '同期中…';
      const st = await api('sync', { body: {} });
      if (st.merged) { await loadAll(); }
      showSync(st); e.target.disabled = false;
    }
    if (id === 'dlBackup') {
      const blob = new Blob([JSON.stringify(await api('backup'))], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `toeic-backup-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    if (id === 'emPreview') { const p = await api('email/preview'); const b = $('#emBox', root); b.hidden = false; b.textContent = `宛先: ${p.recipient}\n件名: ${p.subject}\n\n${p.body}`; }
    if (id === 'save') {
      readLocal();
      const body = { exam: { count: +$('#exCount', root).value, minutes: +$('#exMin', root).value },
        ai: { model: $('#aiModel', root).value.trim() || 'claude-opus-5-5', effort: $('#aiEffort', root).value },
        email: { ...S.email, enabled: $('#emEnabled', root).checked, recipient: $('#emTo', root).value.trim(), weekday: +$('#emDay', root).value, hour: +$('#emHour', root).value } };
      if ($('#aiKey', root).value.trim()) body.aiKey = $('#aiKey', root).value.trim();
      const r = await api('settings', { body });
      store.settings = r.settings; store.ai = r.ai;
      toast('保存しました'); settings(root);
    }
  };
  const showSync = (st) => {
    const el = $('#syncInfo', root); if (!el) return;
    el.innerHTML = !st.enabled ? '<span class="warn">未設定です（PC で tools/set_sync_token.py を実行して publish_web.bat）</span>'
      : st.error ? `<span class="ng">同期できませんでした: ${esc(st.error)}</span>`
      : `同期済み ・ 最終 ${esc(fmtDate(st.last) || '-')}${st.merged ? `（${st.merged}台分を取り込み）` : ''}`;
  };
  if (STATIC) api('sync').then(showSync);
  const readLocal = () => {
    L.voice = $('#voice', root).value; L.rate = +$('#rate2', root).value; L.pauseMs = +$('#pause', root).value || 700;
    L.preferBook = $('#preferBook', root).checked; L.autoPlay = $('#autoPlay', root).checked; L.oneClick = $('#oneClick', root).checked; L.skipCorrect = $('#skipCorrect', root).checked; saveLocal();
  };
  $('#restore', root).onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('現在の学習データをバックアップの内容で置き換えます。よろしいですか？')) return;
    try { const data = JSON.parse(await file.text()); const r = await api('restore', { body: { data, mode: 'replace' } }); toast(`復元しました（単語 ${r.restored.words}・解答 ${r.restored.attempts}）`); await loadAll(); }
    catch (err) { toast('復元に失敗: ' + err.message); }
  };
}

function more(root) {
  root.innerHTML = `<div class="page-head"><h1>その他</h1></div><div class="preset-grid">
    <a class="card preset" href="#/exam"><b>本番模擬試験</b><span class="small muted">30問10分・文法模試</span></a>
    <a class="card preset" href="#/listen"><b>リスニング</b><span class="small muted">完成文・シャドーイング</span></a>
    <a class="card preset" href="#/words/review"><b>単語の復習</b><span class="small muted">間隔反復</span></a>
    <a class="card preset" href="#/settings"><b>設定・バックアップ</b><span class="small muted">音声・AI・データ</span></a></div>`;
}

// ================= 起動 =================
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) { /* */ }
};
initPopup();
window.addEventListener('hashchange', route);
// Web 版: 他の端末で増えたデータを取り込んでから表示（通信が遅いときは 6 秒で先に進む）。表示中に届いたら画面を更新
if (STATIC) window.addEventListener('toeic-synced', async () => {
  await loadAll();
  if (!/^#\/(session|exam)/.test(location.hash)) route();
  toast('他の端末の学習データを取り込みました');
});
(STATIC ? unlock(app).then(() => Promise.race([pull(), new Promise((r) => setTimeout(r, 6000))])) : Promise.resolve()).then(loadAll).then(route).catch((e) => { app.innerHTML = `<div class="card">読み込みに失敗しました: ${esc(e.message)}${STATIC ? '' : '<br>サーバー（start.bat）が起動しているか確認してください。'}</div>`; });
