// Part 7（読解）アプリ。教材: 『極めろ！リーディング解答力 TOEIC L&R TEST PART 7』（data/part7/kiwamero7.json）
// 1 画面 = 1 セット（文書 + 設問 2〜5 問）。学習記録は Part 5 と同じ attempts / qstate / exams に qid = "p7-<章><セクション>-<番号>" で保存
import { $, $$, esc, api, store, saveLocal, toast, fmtSec, pct, shuffle, tokenize, fmtDate } from './util.js?v=2abfc6a55f';
import { STATIC, fetchDec, hydrateImages } from './static.js?v=2abfc6a55f';
import { stop as stopSpeech, speak, playSequence } from './audio.js?v=2abfc6a55f';
import { markRegistered } from './words.js?v=2abfc6a55f';
import { trendCard, bindTrend } from './trend.js?v=2abfc6a55f';

export const P7_TOTAL = 125; // Chapter 1〜3（データを増やしたら更新）
const L = ['A', 'B', 'C', 'D'];
const CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵';
const TYPES = ['目的・テーマ', '詳細', '正しい情報', 'NOT問題', '推測', '同義語', '発言の意図', '文挿入位置'];
const SECS = { c1: 'チャレンジ', c2: 'チャレンジ', r: '練習問題', m: 'まとめ問題', f: '総まとめ' };
const P7 = { loaded: false, material: null, sets: [], questions: [], setById: new Map(), qById: new Map() };
const SESSION_KEY = 'p7session', MOCK_KEY = 'p7mock';
let tick = null;

// ================= データ =================
async function load() {
  if (P7.loaded) return;
  if (!STATIC) throw new Error('Part 7 は Web 版（GitHub Pages）で使えます');
  const d = JSON.parse(new TextDecoder().decode(await fetchDec('part7/kiwamero7.json')));
  P7.material = d.material;
  P7.sets = d.sets;
  P7.questions = d.questions;
  P7.qById = new Map(d.questions.map((q) => [q.id, q]));
  P7.setById = new Map(d.sets.map((s) => [s.id, s]));
  for (const s of d.sets) {
    s.qs = s.questions.map((id) => P7.qById.get(id));
    const base = { material: d.material.id, part: 7, category: `Ch${s.chapter} ${SECS[s.section]}` };
    for (const x of s.sentences) store.byId.set(`${s.id}#${x.n}`, { ...base, id: `${s.id}#${x.n}`, label: `${s.id.slice(3)} ${circ(x.n)}`, text: x.en, complete: x.en });
    for (const q of s.qs) {
      q.setId = s.id;
      store.byId.set(q.id, { ...base, id: q.id, label: q.id.slice(3), text: q.text, complete: q.text });
      q.choices.forEach((c, i) => store.byId.set(`${q.id}-${L[i]}`, { ...base, id: `${q.id}-${L[i]}`, label: q.id.slice(3), text: c, complete: c }));
    }
  }
  P7.loaded = true;
}
const circ = (n) => CIRC[n - 1] || `(${n})`;
const st = (q) => store.stats[q.id] || {};
const setTimes = () => (store.local.p7time ||= {});
const setDone = (s) => s.qs.every((q) => st(q).n);
const setWrong = (s) => s.qs.some((q) => st(q).n && st(q).latest === 0);
const setUnsure = (s) => s.qs.some((q) => st(q).review);
const setOver = (s) => (setTimes()[s.id] || 0) > s.time;
const secLabel = (s) => `Ch${s.chapter} ${s.sectionTitle}`;
const qRange = (s) => (s.qs.length > 1 ? `Q${s.qs[0].num}-${s.qs[s.qs.length - 1].num}` : `Q${s.qs[0].num}`);

function filter(f) {
  let ss = P7.sets.filter((s) => {
    if (f.chapter && String(s.chapter) !== String(f.chapter)) return false;
    if (f.section && !(f.section === 'c' ? s.section.startsWith('c') : s.section === f.section)) return false;
    if (f.type && !s.qs.some((q) => q.type === f.type)) return false;
    switch (f.status) {
      case 'unanswered': return !setDone(s);
      case 'wrong': return setWrong(s);
      case 'everwrong': return s.qs.some((q) => st(q).n && st(q).ok < st(q).n);
      case 'unsure': return setUnsure(s);
      case 'over': return setOver(s);
      case 'bookmark': return s.qs.some((q) => st(q).bookmark);
      default: return true;
    }
  });
  if (f.order === 'random') ss = shuffle(ss);
  else if (f.order === 'weak') ss.sort((a, b) => weak(b) - weak(a));
  if (+f.count > 0) ss = ss.slice(0, +f.count);
  return ss;
}
const weak = (s) => s.qs.reduce((a, q) => { const x = st(q); return a + (x.n ? (x.n - x.ok) / x.n : 0.4) + (x.review ? 0.4 : 0) + (x.latest === 0 ? 0.5 : 0); }, 0) / s.qs.length + (setOver(s) ? 0.2 : 0);

function startSession(ss, title) {
  if (!ss.length) return toast('条件に合うセットがありません');
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ sids: ss.map((s) => s.id), i: 0, title, id: 'p7' + Date.now().toString(36), results: {} }));
  if (location.hash === '#/p7/session') view(); else location.hash = '#/p7/session';
}
const getS = (k = SESSION_KEY) => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } };
const putS = (s, k = SESSION_KEY) => sessionStorage.setItem(k, JSON.stringify(s));
window.addEventListener('hashchange', () => { clearInterval(tick); stopSpeech(); });

// ================= ルーター（#/p7/...） =================
export async function part7View(root, params, sub = '') {
  injectCss();
  if (!P7.loaded) {
    root.innerHTML = '<div class="loading">Part 7 を読み込み中…</div>';
    try { await load(); } catch (e) { root.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  }
  view.root = root; view.params = params; view.sub = sub || '';
  return view();
}
function view() {
  const root = view.root, sub = view.sub, params = view.params;
  clearInterval(tick); stopSpeech(); root._keys = null;
  let m;
  if (!sub) return home(root);
  if (sub === 'practice') return practice(root, params);
  if (sub === 'session') return session(root);
  if (sub === 'mock') return mockList(root);
  if (sub === 'mock/run') return mockRun(root);
  if ((m = sub.match(/^mock\/result\/(.+)$/))) return mockResult(root, decodeURIComponent(m[1]));
  if ((m = sub.match(/^read\/(p7-[\w-]+)/))) return reader(root, m[1]);
  if ((m = sub.match(/^(?:q|set)\/(p7-[\w-]+)/))) return single(root, m[1], params);
  root.innerHTML = '<div class="card">ページが見つかりません</div>';
}
const subnav = (on) => `<div class="p7-sub">
  ${[['', 'ホーム'], ['practice', '演習'], ['mock', '模試'], ['practice?status=wrong', '苦手復習']].map(([h, l]) => `<a href="#/p7${h ? '/' + h : ''}" class="${on === h ? 'on' : ''}">${l}</a>`).join('')}
</div>`;

// ================= ホーム =================
async function home(root) {
  const qs = P7.questions;
  const done = qs.filter((q) => st(q).n);
  const firstOk = done.filter((q) => st(q).first === 1).length;
  const today = new Date().toISOString().slice(0, 10);
  const todayN = done.filter((q) => (st(q).last || '').slice(0, 10) === today).length;
  const wrongSets = P7.sets.filter(setWrong), unsureSets = P7.sets.filter(setUnsure);
  const next = P7.sets.find((s) => !setDone(s));
  const timed = P7.sets.filter((s) => setTimes()[s.id]);
  const usedT = timed.reduce((a, s) => a + setTimes()[s.id], 0), targetT = timed.reduce((a, s) => a + s.time, 0);
  const pace = done.length ? Math.round(timed.reduce((a, s) => a + setTimes()[s.id], 0) / Math.max(1, timed.reduce((a, s) => a + s.qs.length, 0))) : 0;
  const rate = (xs) => { const d = xs.filter((q) => st(q).n); const n = d.reduce((a, q) => a + st(q).n, 0), o = d.reduce((a, q) => a + st(q).ok, 0); return { done: d.length, rate: pct(o, n), n }; };
  const chRows = [];
  for (const ch of [...new Set(P7.sets.map((s) => s.chapter))]) {
    const secs = [...new Set(P7.sets.filter((s) => s.chapter === ch).map((s) => s.section))];
    secs.forEach((sec, i) => {
      const ss = P7.sets.filter((s) => s.chapter === ch && s.section === sec), xs = ss.flatMap((s) => s.qs), r = rate(xs);
      chRows.push(`<tr>${i === 0 ? `<td rowspan="${secs.length}" class="p7-ch"><b>Ch${ch}</b><br><span class="small muted">${esc(P7.material.chapters[ch] || '')}</span></td>` : ''}
        <td><a href="#/p7/practice?chapter=${ch}&section=${sec}">${esc(ss[0].sectionTitle)}</a></td><td class="small muted">${r.done}/${xs.length}問</td>
        <td><div class="bar"><span style="width:${r.rate}%" class="${r.n && r.rate < 70 ? 'low' : ''}"></span><em>${r.n ? r.rate + '%' : '-'}</em></div></td></tr>`);
    });
  }
  const byType = TYPES.map((t) => ({ t, xs: qs.filter((q) => q.type === t) })).filter((x) => x.xs.length).map((x) => ({ ...x, ...rate(x.xs) }));
  const exams = (await api('exams').catch(() => [])).filter((e) => String(e.id).startsWith('p7'));
  const dash = await api('dashboard').catch(() => null);
  root.innerHTML = `
    ${(await import('./part2.js')).partSwitcher('p7')}
    ${subnav('')}
    <section class="p7-hero">
      <div>
        <div class="p7-kicker">PART 7 ・ READING COMPREHENSION</div>
        <h1>全文を読んで、根拠で解く。</h1>
        <p>『極めろ！リーディング解答力』Chapter 1〜3（${P7.sets.length}セット・${qs.length}問）。目安時間つきで解き、根拠の文・1文ずつの和訳・語句まで確認します。</p>
        <div class="row gap">
          ${next ? `<button class="btn p7-go" id="goNext">▶ 続きから（${esc(secLabel(next))} ${qRange(next)}〜 3セット）</button>` : ''}
          ${wrongSets.length || unsureSets.length ? `<button class="btn p7-ghost" id="goWeak">間違い・自信なし ${new Set([...wrongSets, ...unsureSets]).size}セット</button>` : ''}
          <a class="btn p7-ghost" href="#/p7/mock">まとめ模試</a>
        </div>
      </div>
      <div class="p7-doc-art" aria-hidden="true"><i></i><i></i><i class="hl"></i><i></i><i class="s"></i><i></i><i class="hl2"></i><i class="s"></i></div>
    </section>
    <div class="summary-line small muted">今日 <b>${todayN}</b>問 ・ 解答済み <b>${done.length}</b> / ${qs.length}問 ・ 初回正答率 <b>${pct(firstOk, done.length)}%</b> ・ 自信なし <b>${qs.filter((q) => st(q).review).length}</b>問 ・ ペース <b>${pace ? fmtSec(pace * 1000) : '-'}</b>/問（目安 1:00）${targetT ? ` ・ 目安時間内 <b>${pct(timed.filter((s) => !setOver(s)).length, timed.length)}%</b>` : ''}</div>
    <div class="two-col">
      ${trendCard()}
      <section class="card"><h2>設問タイプ別</h2>
        <table class="tbl">${byType.map((b) => `<tr><td><a href="#/p7/practice?type=${encodeURIComponent(b.t)}">${esc(b.t)}</a></td><td class="small muted">${b.done}/${b.xs.length}</td>
          <td><div class="bar"><span style="width:${b.rate}%" class="${b.n && b.rate < 70 ? 'low' : ''}"></span><em>${b.n ? b.rate + '%' : '-'}</em></div></td></tr>`).join('')}</table>
      </section>
    </div>
    <section class="card"><h2>章・セクション別</h2><table class="tbl p7-chtbl">${chRows.join('')}</table></section>
    <section class="card"><h2>模試</h2>
      ${exams.length ? `<table class="tbl">${exams.slice(0, 6).map((e) => `<tr><td class="small">${fmtDate(e.finished)}</td><td>${esc(e.title)}</td><td><b>${e.score}/${e.total}</b></td><td><a href="#/p7/mock/result/${encodeURIComponent(e.id)}">結果</a></td></tr>`).join('')}</table>`
        : '<p class="muted small">各章の「まとめ問題」を、目安時間の合計で通して解けます（解答中は正誤非表示）。</p>'}
      <a class="btn sm" href="#/p7/mock">模試を選ぶ</a>
    </section>
    <section class="card"><h2>全 ${P7.sets.length} セット</h2>
      <div class="legend small"><span class="lg7 none"></span>未回答 <span class="lg7 good"></span>全問正解 <span class="lg7 bad"></span>直近で不正解あり <span class="lg7 uns"></span>自信なし</div>
      ${mapGrid()}
    </section>`;
  if (dash) bindTrend(root, dash.days); else $('#chart', root)?.closest('.card')?.remove();
  $('#goNext', root)?.addEventListener('click', () => { const i = P7.sets.indexOf(next); startSession(P7.sets.slice(i).filter((s) => !setDone(s)).slice(0, 3), '続きから'); });
  $('#goWeak', root)?.addEventListener('click', () => startSession(P7.sets.filter((s) => setWrong(s) || setUnsure(s)), '間違い・自信なし'));
}
function mapGrid() {
  const groups = [];
  for (const s of P7.sets) {
    const g = secLabel(s);
    if (!groups.length || groups[groups.length - 1].g !== g) groups.push({ g, ss: [] });
    groups[groups.length - 1].ss.push(s);
  }
  return groups.map(({ g, ss }) => `<div class="p7-map-row"><div class="small muted">${esc(g)}</div><div class="p7-map">${ss.map((s) => {
    const c = !s.qs.some((q) => st(q).n) ? 'none' : setWrong(s) ? 'bad' : setDone(s) ? 'good' : 'part';
    return `<a href="#/p7/set/${s.id}" class="${c} ${setUnsure(s) ? 'uns' : ''}" title="${esc(secLabel(s))} ${qRange(s)}">${s.qs.length}</a>`;
  }).join('')}</div></div>`).join('');
}

// ================= 演習の条件 =================
function practice(root, params) {
  const f = { order: 'seq', count: 3, status: 'unanswered', ...(store.local.p7practice || {}) };
  for (const k of ['chapter', 'section', 'type']) if (params.get(k)) { f[k] = params.get(k); f.status = ''; f.count = 0; }
  if (params.get('status')) Object.assign(f, { status: params.get('status'), chapter: '', section: '', type: '', order: 'seq', count: 0 });
  const sel = (name, opts, v) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${k}" ${String(v ?? '') === String(k) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const chs = [...new Set(P7.sets.map((s) => s.chapter))];
  root.innerHTML = `
    ${subnav(params.get('status') === 'wrong' ? 'practice?status=wrong' : 'practice')}
    <div class="page-head"><h1>Part 7 演習</h1></div>
    <form class="card" id="pf"><div class="form-grid">
      <label>章${sel('chapter', [['', 'すべて'], ...chs.map((c) => [c, `Chapter ${c} ${P7.material.chapters[c] || ''}`])], f.chapter)}</label>
      <label>セクション${sel('section', [['', 'すべて'], ['c', 'チャレンジ'], ['r', '練習問題'], ['m', 'まとめ問題']], f.section)}</label>
      <label>設問タイプ${sel('type', [['', 'すべて'], ...TYPES.filter((t) => P7.questions.some((q) => q.type === t)).map((t) => [t, t])], f.type)}</label>
      <label>状態${sel('status', [['', 'すべて'], ['unanswered', '未回答'], ['wrong', '直近で間違えた'], ['everwrong', '一度でも間違えた'], ['unsure', '自信なし（?）'], ['over', '目安時間オーバー'], ['bookmark', 'ブックマーク']], f.status)}</label>
      <label>順序${sel('order', [['seq', '本の順'], ['random', 'ランダム'], ['weak', '苦手な順']], f.order)}</label>
      <label>セット数<input name="count" type="number" min="0" value="${esc(f.count)}" placeholder="0=すべて"></label>
    </div>
    <label class="small"><input type="checkbox" name="ev" ${store.local.p7ev ? 'checked' : ''}> 根拠タップ練習（解答前に、根拠だと思う文をタップしてから選ぶ）</label>
    <div class="row gap" style="margin-top:10px"><button class="btn primary" type="submit">開始</button><span class="muted small" id="cnt"></span></div></form>
    <div class="card small muted">操作: <kbd>1</kbd>〜<kbd>4</kbd>（<kbd>A</kbd>〜<kbd>D</kbd>）選択 ・ <kbd>↑</kbd><kbd>↓</kbd> 設問の移動 ・ <kbd>?</kbd> 自信なし ・ <kbd>Enter</kbd> 解答する／次のセット ・ <kbd>J</kbd> 和訳の表示 ・ <kbd>O</kbd> 原本 ・ 解答後は英単語クリックで辞書と単語帳登録</div>`;
  const form = $('#pf', root);
  const read = () => Object.fromEntries($$('select, input:not([type=checkbox])', form).map((e) => [e.name, e.value]));
  const upd = () => { const ss = filter({ ...read(), count: 0 }); $('#cnt', root).textContent = `該当 ${ss.length} セット・${ss.reduce((a, s) => a + s.qs.length, 0)} 問`; };
  form.oninput = upd; upd();
  form.onsubmit = (e) => {
    e.preventDefault(); const x = read(); store.local.p7practice = x; store.local.p7ev = form.ev.checked; saveLocal();
    startSession(filter(x), 'Part 7 演習');
  };
}

// ================= 1 セットの画面 =================
function session(root) {
  const s = getS();
  if (!s || !s.sids.length) { location.hash = '#/p7/practice'; return; }
  renderSet(root, s);
}
function single(root, id, params) {
  const set = P7.setById.get(id) || P7.setById.get(P7.qById.get(id)?.setId);
  if (!set) { root.innerHTML = '<div class="card">問題が見つかりません</div>'; return; }
  const s = { sids: [set.id], i: 0, title: secLabel(set), id: 'p7v' + Date.now().toString(36), results: {} };
  if (params?.get('view') || set.qs.every((q) => st(q).n)) s.results[set.id] = { view: true, choices: [], unsure: [] };
  renderSet(root, s, { single: true, focusQ: P7.qById.has(id) ? id : null });
}

function passageHtml(set, o) {
  // o.answered: 番号・根拠・単語登録あり / o.ev: 根拠タップで選んだ文 / o.ja: 和訳
  const evid = new Map();
  if (o.answered) set.qs.forEach((q) => (q.evidence || []).forEach((n) => { if (!evid.has(n)) evid.set(n, []); evid.get(n).push(q); }));
  const paras = [];
  set.sentences.forEach((x, i) => { if (i === 0 || x.para || !paras.length) paras.push([]); paras[paras.length - 1].push(x); });
  return paras.map((p) => `<p>${p.map((x) => {
    const tags = evid.get(x.n) || [];
    const picked = o.ev && Object.values(o.ev).some((a) => a.includes(x.n));
    const en = o.answered ? `<span data-src="${set.id}#${x.n}">${tokenize(x.en, { blank: false })}</span>` : esc(x.en);
    return `<span class="p7-s ${tags.length ? 'ev' : ''} ${picked ? 'picked' : ''}" data-n="${x.n}">${o.answered ? `<b class="p7-n">${circ(x.n)}</b>` : ''}${tags.map((q) => `<em class="p7-tag" data-q="${q.id}">${q.num}(${L[q.answer]})</em>`).join('')}${en}${o.ja && x.ja ? `<span class="p7-ja">${esc(x.ja)}</span>` : ''}</span> `;
  }).join('')}</p>`).join('');
}

function renderSet(root, s, opt = {}) {
  const mock = opt.mock;
  const set = P7.setById.get(s.sids[s.i]);
  if (!set) { s.i = 0; putS(s, mock ? MOCK_KEY : SESSION_KEY); return renderSet(root, s, opt); }
  const res = s.results[set.id] || (s.results[set.id] = { choices: set.qs.map(() => null), unsure: set.qs.map(() => false), ev: {}, ms: 0 });
  const answered = !mock && !!(res.done || res.view);
  const t0 = Date.now() - (res.ms || 0);
  let focus = Math.max(0, set.qs.findIndex((q) => q.id === opt.focusQ));
  if (!answered) { const k = res.choices.findIndex((c) => c == null); if (k >= 0 && !opt.focusQ) focus = k; }
  const evMode = !answered && !mock && store.local.p7ev;
  const showJa = answered && store.local.p7ja;
  const orig = !!store.local.p7orig;
  const save = () => putS(s, mock ? MOCK_KEY : SESSION_KEY);
  root.innerHTML = `
    ${opt.single ? subnav('-') : ''}
    <div class="qbar">
      <span class="qpos">${opt.single ? '' : `${s.i + 1} / ${s.sids.length} セット`}</span>
      <span class="qmeta">${esc(secLabel(set))} ・ ${qRange(set)}</span>
      ${mock || res.view ? `<span class="small muted">目安 ${fmtSec(set.time * 1000)}</span>` : `<span class="p7-timer ${answered ? 'done' : ''}" id="timer" title="経過時間 / 目安"></span>`}
    </div>
    ${opt.single || mock ? '' : `<div class="progress"><div style="width:${((s.i + (answered ? 1 : 0)) / s.sids.length) * 100}%"></div></div>`}
    <div class="p7-split">
      <section class="card p7-doc">
        <div class="p7-doc-head">
          <span class="small muted">${esc(set.intro || '')}</span><span class="spacer"></span>
          ${answered ? `<button class="chip ${showJa ? 'on' : ''}" id="ja" title="和訳 (J)">和訳</button><a class="chip" href="#/p7/read/${set.id}">精読モード</a>` : ''}
          <button class="chip ${orig ? 'on' : ''}" id="orig" title="原本の問題ページ (O)">原本</button>
        </div>
        ${evMode ? '<div class="p7-evhint small">根拠タップ: 設問を選んでから、根拠だと思う文をタップ</div>' : ''}
        ${orig ? set.problemPages.map((p) => `<img class="p7-page" data-enc="/crops/part7/${p}" alt="原本の問題ページ">`).join('')
          : `<div class="p7-text en ${evMode ? 'tap' : ''}" id="doc">${passageHtml(set, { answered, ev: evMode || answered ? res.ev : null, ja: showJa })}</div>`}
      </section>
      <section class="p7-qs">
        ${set.qs.map((q, i) => qCard(q, i, res, answered, focus, mock, evMode)).join('')}
        ${mock ? '' : answered ? '' : `<div class="row gap"><button class="btn primary" id="grade">解答する <kbd>Enter</kbd></button><span class="small muted" id="left"></span></div>`}
        ${answered ? explainBlock(set) : ''}
        <div class="row gap p7-nav">
          ${opt.single ? `<a class="btn ghost" href="#/p7/practice">演習へ</a>` : `<button class="btn ghost" id="prev" ${s.i === 0 ? 'disabled' : ''}>← 前</button>`}
          <span class="spacer"></span>
          ${opt.single ? (answered ? `<button class="btn" id="retry">解き直す</button>` : '') : mock ? `<button class="btn ${s.i === s.sids.length - 1 ? 'primary' : ''}" id="next">${s.i === s.sids.length - 1 ? '提出して採点' : '次のセット →'}</button>`
            : `<button class="btn ${answered ? 'primary' : 'ghost'}" id="next">${s.i === s.sids.length - 1 ? '終了' : answered ? '次のセット →' : 'スキップ →'}</button>`}
        </div>
      </section>
    </div>`;
  hydrateImages(root);
  markRegistered(root);

  // タイマー（目安時間との比較）
  const timer = $('#timer', root);
  const drawT = () => {
    const ms = answered ? res.ms : Date.now() - t0;
    if (!answered) res.ms = ms;
    if (timer) { timer.textContent = `${fmtSec(ms)} / 目安 ${fmtSec(set.time * 1000)}`; timer.classList.toggle('over', ms > set.time * 1000); }
  };
  if (timer) { drawT(); if (!answered) tick = setInterval(() => { drawT(); }, 500); }
  if (mock) opt.onTick?.();

  const choose = (qi, ci) => {
    if (answered) return;
    res.choices[qi] = ci; save();
    $$(`.p7-q[data-i="${qi}"] .p7-ch`, root).forEach((b) => b.classList.toggle('sel', +b.dataset.c === ci));
    $(`.p7-q[data-i="${qi}"]`, root).classList.add('chosen');
    const left = res.choices.filter((c) => c == null).length;
    if ($('#left', root)) $('#left', root).textContent = left ? `未選択 ${left}問` : '';
    if (qi < set.qs.length - 1 && res.choices[qi + 1] == null) setFocus(qi + 1);
  };
  const setFocus = (qi) => { focus = qi; $$('.p7-q', root).forEach((el) => el.classList.toggle('focus', +el.dataset.i === qi)); };
  $$('.p7-ch', root).forEach((b) => (b.onclick = () => { setFocus(+b.closest('.p7-q').dataset.i); choose(+b.closest('.p7-q').dataset.i, +b.dataset.c); }));
  $$('.p7-q', root).forEach((el) => el.addEventListener('click', () => setFocus(+el.dataset.i)));
  const toggleUnsure = (qi) => { res.unsure[qi] = !res.unsure[qi]; save(); $(`.p7-q[data-i="${qi}"] .p7-uns`, root)?.classList.toggle('on', res.unsure[qi]); };
  $$('.p7-uns', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleUnsure(+b.closest('.p7-q').dataset.i); }));
  // 根拠タップ
  if (evMode) $('#doc', root)?.addEventListener('click', (e) => {
    const sp = e.target.closest('.p7-s'); if (!sp) return;
    const q = set.qs[focus], n = +sp.dataset.n, a = (res.ev[q.id] ||= []);
    const k = a.indexOf(n); if (k >= 0) a.splice(k, 1); else a.push(n);
    save(); sp.classList.toggle('picked', Object.values(res.ev).some((x) => x.includes(n)));
    $(`.p7-q[data-i="${focus}"] .p7-evsel`, root).textContent = a.length ? '根拠: ' + a.sort((x, y) => x - y).map(circ).join('') : '';
  });
  // 解答後: 設問の根拠を本文で強調
  const flash = (q) => {
    $$('.p7-s', root).forEach((el) => el.classList.toggle('flash', (q.evidence || []).includes(+el.dataset.n)));
    const el = $(`.p7-s[data-n="${(q.evidence || [])[0]}"]`, root);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $$('[data-flash]', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); flash(P7.qById.get(b.dataset.flash)); }));
  $$('.p7-tag', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); $(`.p7-q[data-q="${b.dataset.q}"]`, root)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }));
  $('#ja', root)?.addEventListener('click', () => { store.local.p7ja = !store.local.p7ja; saveLocal(); renderSet(root, s, opt); });
  $('#orig', root)?.addEventListener('click', () => { store.local.p7orig = !store.local.p7orig; saveLocal(); renderSet(root, s, opt); });
  $$('[data-bm]', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); bookmark(P7.qById.get(b.dataset.bm), b); }));
  $$('[data-speak]', root).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const x = set.sentences.find((y) => y.n === +b.dataset.speak); if (x) speak(x.en); }));

  const grade = async () => {
    if (answered || mock) return;
    const left = res.choices.filter((c) => c == null).length;
    if (left && !confirm(`未選択が ${left} 問あります。解答しますか？`)) return;
    clearInterval(tick);
    res.ms = Date.now() - t0; res.done = true; save();
    setTimes()[set.id] = Math.round(res.ms / 1000); saveLocal();
    await record(set, res.choices, res.ms, 'p7', s.id, res.unsure);
    renderSet(root, s, opt);
    $('.p7-explain', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#grade', root)?.addEventListener('click', grade);
  const go = (d) => {
    clearInterval(tick);
    if (mock) { save(); return opt.go(d); }
    if (d > 0 && s.i === s.sids.length - 1) return finish(root, s);
    s.i = Math.max(0, Math.min(s.sids.length - 1, s.i + d)); save(); renderSet(root, s, opt); window.scrollTo(0, 0);
  };
  $('#prev', root)?.addEventListener('click', () => go(-1));
  $('#next', root)?.addEventListener('click', () => go(1));
  $('#retry', root)?.addEventListener('click', () => { delete s.results[set.id]; renderSet(root, s, { ...opt, focusQ: null }); });
  root._keys = (e) => {
    const k = e.key.toLowerCase();
    if (!answered && /^[1-4]$/.test(k)) { e.preventDefault(); const ci = +k - 1; if (ci < set.qs[focus].choices.length) choose(focus, ci); return; }
    if (!answered && /^[a-d]$/.test(k) && !e.shiftKey) { e.preventDefault(); const ci = 'abcd'.indexOf(k); if (ci < set.qs[focus].choices.length) choose(focus, ci); return; }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey && !answered)) { e.preventDefault(); setFocus(Math.min(set.qs.length - 1, focus + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(Math.max(0, focus - 1)); }
    else if (e.key === '?' && !answered) { e.preventDefault(); toggleUnsure(focus); }
    else if (k === 'j' && answered) $('#ja', root)?.click();
    else if (k === 'o') $('#orig', root)?.click();
    else if (e.key === 'Enter') { e.preventDefault(); if (!answered && !mock) grade(); else go(1); }
    else if (e.key === 'ArrowRight' && (answered || mock)) go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  };
}

function qCard(q, i, res, answered, focus, mock, evMode) {
  const ch = res.choices?.[i];
  const ok = answered && !res.view && ch === q.answer;
  const ja = answered && q.choices_ja?.length === q.choices.length;
  const yourEv = res.ev?.[q.id];
  return `<article class="card p7-q ${i === focus ? 'focus' : ''} ${ch != null ? 'chosen' : ''} ${answered ? (res.view ? 'viewed' : ok ? 'is-ok' : 'is-ng') : ''}" data-i="${i}" data-q="${q.id}">
    <div class="p7-qhead"><b class="p7-qn">${q.num}.</b><span class="tag">${esc(q.type)}</span>
      ${answered && !res.view ? `<b class="p7-verdict">${ok ? '○ 正解' : ch == null ? '− 無回答' : '× 不正解'}</b>` : ''}
      <span class="spacer"></span>
      ${!answered && !mock ? `<span class="p7-evsel small">${yourEv?.length ? '根拠: ' + yourEv.map(circ).join('') : ''}</span>` : ''}
      ${!answered ? `<button class="chip p7-uns ${res.unsure?.[i] ? 'on' : ''}" title="自信なし (?)">? 自信なし</button>` : ''}
      ${answered ? `<button class="icon-btn star ${st(q).bookmark ? 'on' : ''}" data-bm="${q.id}" title="ブックマーク">${st(q).bookmark ? '★' : '☆'}</button>` : ''}
    </div>
    <div class="p7-qtext en" ${answered ? `data-src="${q.id}"` : ''}>${answered ? tokenize(q.text, { blank: false }) : esc(q.text)}</div>
    ${answered && q.ja ? `<div class="small muted">${esc(q.ja)}</div>` : ''}
    <div class="p7-choices">${q.choices.map((c, k) => `<button class="p7-ch ${ch === k ? 'sel' : ''} ${answered && k === q.answer ? 'correct' : ''} ${answered && !res.view && ch === k && k !== q.answer ? 'wrong' : ''}" data-c="${k}" ${answered ? 'tabindex="-1"' : ''}>
      <span class="p7-l">${L[k]}</span><span><span class="en" ${answered ? `data-src="${q.id}-${L[k]}"` : ''}>${answered ? tokenize(c, { blank: false }) : esc(c)}</span>${ja ? `<span class="p7-cja">${esc(q.choices_ja[k])}</span>` : ''}</span></button>`).join('')}</div>
    ${answered ? `<div class="p7-ex">
      ${q.evidence?.length ? `<button class="chip" data-flash="${q.id}">根拠 ${q.evidence.map(circ).join('')} を本文で見る</button>` : ''}
      ${yourEv?.length && q.evidence?.length ? `<span class="small ${yourEv.some((n) => q.evidence.includes(n)) ? 'ok' : 'ng'}">あなたの根拠 ${yourEv.map(circ).join('')} ${yourEv.some((n) => q.evidence.includes(n)) ? '○ 一致' : '× ずれ'}</span>` : ''}
      ${q.expl ? `<div class="p7-expl">${exHtml(q.expl)}</div>` : `<div class="small muted">解説は下の「原本の解説ページ」をご覧ください。</div>`}
      ${q.wrong ? `<details class="p7-wrong"><summary>誤りの選択肢</summary><div class="p7-expl">${exHtml(q.wrong.replace(/^【誤りの選択肢[^】]*】\s*/, ''))}</div></details>` : ''}
    </div>` : ''}
  </article>`;
}
const exHtml = (t) => esc(t).replace(new RegExp(`[${CIRC}]`, 'g'), (c) => `<b class="p7-ref">${c}</b>`).replace(/\(([A-D])\)/g, '<b class="p7-refc">($1)</b>').replace(/\n/g, '<br>');

function explainBlock(set) {
  return `<section class="card p7-explain">
    ${set.vocab?.length ? `<h3>語句</h3><div class="p7-vocab">${set.vocab.map((v) => `<div>${esc(v.replace(/[ロ口□]/g, ' □'))}</div>`).join('')}</div>` : ''}
    <div class="row gap"><a class="btn sm" href="#/p7/read/${set.id}">精読モード（1文ずつ英→和・読み上げ）</a></div>
    <details class="p7-orig" ${store.local.p7origEx ? 'open' : ''}><summary>原本の解説ページ（${set.explPages.length}ページ）</summary>
      ${set.explPages.map((p) => `<img class="p7-page" data-enc="/crops/part7/${p}" alt="原本の解説ページ" loading="lazy">`).join('')}</details>
  </section>`;
}

async function record(set, choices, ms, mode, session, unsure = []) {
  const per = Math.round(ms / set.qs.length);
  for (let i = 0; i < set.qs.length; i++) {
    const q = set.qs[i], c = choices[i];
    if (c == null) continue;
    const correct = c === q.answer;
    try {
      await api('attempt', { body: { qid: q.id, choice: c, correct, ms: per, mode, session } });
      const x = store.stats[q.id] || { n: 0, ok: 0 };
      store.stats[q.id] = { ...x, n: x.n + 1, ok: x.ok + (correct ? 1 : 0), latest: correct ? 1 : 0, first: x.n ? x.first : correct ? 1 : 0, lastMs: per, last: new Date().toISOString() };
      const review = unsure[i] || !correct ? 1 : 0;
      if ((x.review || 0) !== review) { await api('qstate', { body: { qid: q.id, review } }); store.stats[q.id].review = review; }
    } catch (e) { toast('記録の保存に失敗しました: ' + e.message); }
  }
}
async function bookmark(q, b) {
  const on = !st(q).bookmark;
  try { await api('qstate', { body: { qid: q.id, bookmark: on ? 1 : 0 } }); } catch (e) { return toast(e.message); }
  store.stats[q.id] = { ...(store.stats[q.id] || { n: 0, ok: 0 }), bookmark: on ? 1 : 0 };
  b.textContent = on ? '★' : '☆'; b.classList.toggle('on', on);
}

function finish(root, s) {
  const sets = s.sids.map((id) => P7.setById.get(id));
  const rows = sets.flatMap((set) => set.qs.map((q, i) => ({ set, q, r: s.results[set.id], i })));
  const done = rows.filter((x) => x.r?.done && x.r.choices[x.i] != null);
  const okN = done.filter((x) => x.r.choices[x.i] === x.q.answer).length;
  const wrongSets = sets.filter((set) => set.qs.some((q, i) => s.results[set.id]?.done && s.results[set.id].choices[i] !== q.answer));
  const used = sets.reduce((a, set) => a + (s.results[set.id]?.done ? s.results[set.id].ms : 0), 0), target = sets.reduce((a, set) => a + (s.results[set.id]?.done ? set.time : 0), 0);
  root.innerHTML = `
    ${subnav('-')}
    <section class="card p7-finish">
      <div class="p7-kicker">${esc(s.title || 'Part 7 演習')}</div>
      <div class="p7-score">${okN}<small> / ${done.length}</small></div>
      <div class="muted">正答率 ${pct(okN, done.length)}% ・ 時間 ${fmtSec(used)}（目安 ${fmtSec(target * 1000)}）</div>
      <div class="row gap center" style="margin-top:14px">
        ${wrongSets.length ? '<button class="btn primary" id="again">間違えたセットをもう一度</button>' : ''}
        <a class="btn" href="#/p7">Part 7 ホーム</a><a class="btn" href="#/p7/practice">続けて演習</a>
      </div>
    </section>
    <section class="card"><table class="tbl">${rows.map(({ set, q, r, i }) => `<tr><td>${r?.done ? (r.choices[i] === q.answer ? '<b class="ok">○</b>' : '<b class="ng">×</b>') : '-'}</td>
      <td>${r?.unsure?.[i] ? '<span class="tag">?</span>' : ''}</td><td><a href="#/p7/q/${q.id}">${esc(secLabel(set))} Q${q.num}</a></td><td class="en small">${esc(q.text)}</td><td class="small muted">${esc(q.type)}</td></tr>`).join('')}</table></section>`;
  $('#again', root)?.addEventListener('click', () => startSession(wrongSets, '間違えたセット'));
}

// ================= 精読モード =================
function reader(root, sid) {
  const set = P7.setById.get(sid);
  if (!set) { root.innerHTML = '<div class="card">セットが見つかりません</div>'; return; }
  let i = 0;
  const shown = new Set();
  const draw = () => {
    const x = set.sentences[i];
    root.innerHTML = `
      ${subnav('-')}
      <div class="qbar"><span class="qpos">${i + 1} / ${set.sentences.length} 文</span><span class="qmeta">精読 ・ ${esc(secLabel(set))} ${qRange(set)}</span><span class="spacer"></span><a class="btn sm ghost" href="#/p7/set/${set.id}?view=1">問題に戻る</a></div>
      <div class="progress"><div style="width:${((i + 1) / set.sentences.length) * 100}%"></div></div>
      <section class="card p7-reader">
        <div class="p7-rn">${circ(x.n)}</div>
        <div class="p7-ren en" data-src="${set.id}#${x.n}">${tokenize(x.en, { blank: false })}</div>
        <div class="p7-rja ${shown.has(i) ? '' : 'hide'}" id="rja">${esc(x.ja || '（和訳なし）')}</div>
        <div class="row gap center">
          <button class="btn" id="play">▶ 読み上げ <kbd>P</kbd></button>
          <button class="btn" id="tog">${shown.has(i) ? '和訳を隠す' : '和訳を見る'} <kbd>Space</kbd></button>
          <button class="btn ghost" id="all">全文を通して聞く</button>
        </div>
        <div class="row gap p7-nav"><button class="btn ghost" id="prev" ${i === 0 ? 'disabled' : ''}>← 前の文</button><span class="spacer"></span><button class="btn primary" id="next">${i === set.sentences.length - 1 ? '終わる' : '次の文 →'}</button></div>
      </section>
      <section class="card"><h3>全文（タップでその文へ）</h3><div class="p7-text en p7-mini">${set.sentences.map((y, k) => `<span class="p7-s ${k === i ? 'flash' : ''}" data-k="${k}"><b class="p7-n">${circ(y.n)}</b>${esc(y.en)}</span> `).join('')}</div></section>`;
    markRegistered(root);
    $('#play', root).onclick = () => speak(x.en);
    $('#tog', root).onclick = () => { shown.has(i) ? shown.delete(i) : shown.add(i); draw(); };
    $('#all', root).onclick = () => playSequence(set.sentences.flatMap((y) => [{ text: y.en }, { pause: 500 }]));
    $('#prev', root).onclick = () => { if (i > 0) { i--; stopSpeech(); draw(); } };
    $('#next', root).onclick = () => { if (i < set.sentences.length - 1) { i++; stopSpeech(); draw(); } else location.hash = `#/p7/set/${set.id}?view=1`; };
    $$('[data-k]', root).forEach((el) => (el.onclick = () => { i = +el.dataset.k; stopSpeech(); draw(); }));
  };
  draw();
  root._keys = (e) => {
    if (e.code === 'Space') { e.preventDefault(); $('#tog', root)?.click(); }
    else if (e.key.toLowerCase() === 'p') speak(set.sentences[i].en);
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); $('#next', root)?.click(); }
    else if (e.key === 'ArrowLeft') $('#prev', root)?.click();
  };
}

// ================= 模試（まとめ問題を通しで） =================
async function mockList(root) {
  const exams = (await api('exams').catch(() => [])).filter((e) => String(e.id).startsWith('p7'));
  const chs = [...new Set(P7.sets.map((s) => s.chapter))];
  const opts = chs.map((c) => { const ss = P7.sets.filter((s) => s.chapter === c && s.section === 'm'); return { key: `ch${c}`, title: `Chapter ${c} まとめ問題`, sub: P7.material.chapters[c], ss }; }).filter((o) => o.ss.length);
  root.innerHTML = `
    ${subnav('mock')}
    <div class="page-head"><h1>Part 7 模試</h1></div>
    <p class="muted small">本番と同じく、解答中は正誤を表示しません。制限時間は本の目安時間の合計です。途中のセットにも戻れます。</p>
    <div class="p7-mocks">
      ${opts.map((o) => { const n = o.ss.reduce((a, s) => a + s.qs.length, 0), t = o.ss.reduce((a, s) => a + s.time, 0); const last = exams.find((e) => e.title === o.title);
        return `<button class="card p7-mock" data-key="${o.key}"><b>${esc(o.title)}</b><span class="small muted">${esc(o.sub || '')}</span><span>${o.ss.length}セット・${n}問・${Math.round(t / 60)}分</span>${last ? `<span class="small">前回 ${last.score}/${last.total}</span>` : ''}</button>`; }).join('')}
      <button class="card p7-mock" data-key="rand"><b>ランダム 5セット</b><span class="small muted">全章のまとめ問題から</span><span>約 12〜15問</span></button>
    </div>
    ${exams.length ? `<section class="card"><h2>履歴</h2><table class="tbl">${exams.map((e) => `<tr><td class="small">${fmtDate(e.finished)}</td><td>${esc(e.title)}</td><td><b>${e.score}/${e.total}</b></td><td><a href="#/p7/mock/result/${encodeURIComponent(e.id)}">結果</a></td></tr>`).join('')}</table></section>` : ''}`;
  $$('.p7-mock', root).forEach((b) => (b.onclick = () => {
    const o = opts.find((x) => x.key === b.dataset.key);
    const ss = o ? o.ss : shuffle(P7.sets.filter((s) => s.section === 'm')).slice(0, 5);
    const title = o ? o.title : 'ランダム 5セット';
    putS({ sids: ss.map((s) => s.id), i: 0, title, id: 'p7m' + Date.now().toString(36), started: new Date().toISOString(), t0: Date.now(), limit: ss.reduce((a, s) => a + s.time, 0), results: {} }, MOCK_KEY);
    location.hash = '#/p7/mock/run';
  }));
}
function mockRun(root) {
  const ex = getS(MOCK_KEY);
  if (!ex) { location.hash = '#/p7/mock'; return; }
  const draw = () => {
    renderSet(root, ex, {
      mock: true,
      go: (d) => { if (d > 0 && ex.i === ex.sids.length - 1) return submit(); ex.i = Math.max(0, Math.min(ex.sids.length - 1, ex.i + d)); putS(ex, MOCK_KEY); draw(); window.scrollTo(0, 0); },
    });
    const bar = document.createElement('div');
    bar.className = 'p7-mockbar';
    bar.innerHTML = `<b>${esc(ex.title)}</b><span id="mt"></span><span class="spacer"></span>${ex.sids.map((id, k) => `<button class="p7-dot ${k === ex.i ? 'on' : ''} ${P7.setById.get(id).qs.every((q, i) => ex.results[id]?.choices?.[i] != null) ? 'done' : ''}" data-k="${k}">${k + 1}</button>`).join('')}<button class="btn sm" id="sub">提出</button>`;
    root.prepend(bar);
    $$('.p7-dot', bar).forEach((b) => (b.onclick = () => { ex.i = +b.dataset.k; putS(ex, MOCK_KEY); draw(); }));
    $('#sub', bar).onclick = () => { if (confirm('提出して採点しますか？')) submit(); };
    const upd = () => {
      const left = ex.limit * 1000 - (Date.now() - ex.t0);
      const el = $('#mt', bar); if (!el) return;
      el.textContent = `残り ${fmtSec(Math.max(0, left))}`; el.classList.toggle('over', left < 0);
    };
    clearInterval(tick); upd(); tick = setInterval(upd, 500);
  };
  const submit = async () => {
    clearInterval(tick);
    const ms = Date.now() - ex.t0;
    const qids = [], answers = [], times = [];
    let score = 0;
    for (const id of ex.sids) {
      const set = P7.setById.get(id), r = ex.results[id] || { choices: [] };
      const per = Math.round(ms / ex.sids.reduce((a, x) => a + P7.setById.get(x).qs.length, 0));
      await record(set, r.choices || [], per * set.qs.length, 'p7mock', ex.id, r.unsure || []);
      set.qs.forEach((q, i) => { qids.push(q.id); answers.push(r.choices?.[i] ?? null); times.push(per); if (r.choices?.[i] === q.answer) score++; });
    }
    try { await api('exams', { body: { id: ex.id, title: ex.title, started: ex.started, limitSec: ex.limit, qids, answers, times, score, total: qids.length } }); } catch (e) { toast(e.message); }
    sessionStorage.removeItem(MOCK_KEY);
    location.hash = '#/p7/mock/result/' + ex.id;
  };
  draw();
}
async function mockResult(root, id) {
  const e = (await api('exams').catch(() => [])).find((x) => x.id === id);
  if (!e) { root.innerHTML = '<div class="card">結果が見つかりません</div>'; return; }
  const qs = e.qids.map((x) => P7.qById.get(x)).filter(Boolean);
  const byType = TYPES.map((t) => { const xs = qs.map((q, i) => [q, i]).filter(([q]) => q.type === t); return { t, n: xs.length, ok: xs.filter(([q, i]) => e.answers[i] === q.answer).length }; }).filter((x) => x.n);
  const wrongSets = [...new Set(qs.filter((q, i) => e.answers[i] !== q.answer).map((q) => q.setId))];
  const used = (e.times || []).reduce((a, b) => a + (b || 0), 0);
  root.innerHTML = `
    ${subnav('mock')}
    <section class="card p7-finish">
      <div class="p7-kicker">${esc(e.title)} ・ ${fmtDate(e.finished)}</div>
      <div class="p7-score">${e.score}<small> / ${e.total}</small></div>
      <div class="muted">正答率 ${pct(e.score, e.total)}% ・ 時間 ${fmtSec(used)}${e.limitSec ? `（制限 ${fmtSec(e.limitSec * 1000)}）` : ''}</div>
      <div class="row gap center" style="margin-top:14px">${wrongSets.length ? '<button class="btn primary" id="rev">間違えたセットを解説付きで復習</button>' : ''}<a class="btn" href="#/p7/mock">模試一覧</a></div>
    </section>
    <div class="two-col">
      <section class="card"><h2>タイプ別</h2><table class="tbl">${byType.map((b) => `<tr><td>${esc(b.t)}</td><td>${b.ok}/${b.n}</td><td><div class="bar"><span style="width:${pct(b.ok, b.n)}%" class="${pct(b.ok, b.n) < 70 ? 'low' : ''}"></span><em>${pct(b.ok, b.n)}%</em></div></td></tr>`).join('')}</table></section>
      <section class="card"><h2>全問の結果</h2><table class="tbl">${qs.map((q, i) => `<tr><td>${e.answers[i] === q.answer ? '<b class="ok">○</b>' : '<b class="ng">×</b>'}</td>
        <td class="small">${e.answers[i] == null ? '無回答' : `(${L[e.answers[i]]})`} → (${L[q.answer]})</td><td class="small">${esc(q.type)}</td><td><a href="#/p7/q/${q.id}">Q${q.num} 解説</a></td></tr>`).join('')}</table></section>
    </div>`;
  $('#rev', root)?.addEventListener('click', () => {
    const s = { sids: wrongSets, i: 0, title: e.title + ' の復習', id: 'p7r' + Date.now().toString(36), results: {} };
    for (const sid of wrongSets) {
      const set = P7.setById.get(sid);
      s.results[sid] = { done: true, choices: set.qs.map((q) => { const k = e.qids.indexOf(q.id); return k >= 0 ? e.answers[k] : null; }), unsure: set.qs.map(() => false), ev: {}, ms: 0 };
    }
    putS(s); location.hash = '#/p7/session';
  });
}

// ================= 見た目 =================
function injectCss() {
  if (document.getElementById('p7css')) return;
  const el = document.createElement('style');
  el.id = 'p7css';
  el.textContent = `
.p7-sub { display: flex; gap: 4px; margin: -4px 0 14px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.p7-sub a { padding: 8px 14px; color: var(--muted); border-bottom: 2px solid transparent; white-space: nowrap; font-size: 14px; }
.p7-sub a.on { color: var(--text); border-bottom-color: #d97706; font-weight: 600; }
.p7-hero { display: grid; grid-template-columns: 1fr 190px; gap: 18px; align-items: center; padding: 26px 28px; border-radius: 18px; margin-bottom: 14px; color: #fff7ed;
  background: radial-gradient(120% 140% at 100% 0%, #b45309 0%, #7c2d12 50%, #431407 100%); box-shadow: var(--shadow); }
.p7-hero h1 { font-size: 26px; margin: 4px 0 6px; color: #fff; } .p7-hero p { margin: 0 0 16px; color: #fed7aa; font-size: 14px; }
.p7-kicker { font: 700 11px var(--en); letter-spacing: .16em; color: #fdba74; }
.p7-finish .p7-kicker { color: #d97706; }
.btn.p7-go { background: #fbbf24; border-color: #fbbf24; color: #3b1d06; }
.btn.p7-ghost { background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.25); color: #fff7ed; }
.p7-doc-art { background: #fffbeb; border-radius: 10px; padding: 16px 14px; display: grid; gap: 8px; transform: rotate(2deg); box-shadow: 0 10px 24px rgba(0,0,0,.25); }
.p7-doc-art i { display: block; height: 7px; border-radius: 4px; background: #e7d7c1; } .p7-doc-art i.s { width: 62%; }
.p7-doc-art i.hl { background: linear-gradient(90deg, #e7d7c1 30%, #fbbf24 30%, #fbbf24 85%, #e7d7c1 85%); } .p7-doc-art i.hl2 { background: linear-gradient(90deg, #fbbf24 0 45%, #e7d7c1 45%); }
.lg7 { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin: 0 4px 0 10px; vertical-align: -1px; }
.lg7.none, .p7-map a.none { background: var(--soft); border: 1px solid var(--line); } .lg7.good, .p7-map a.good { background: #34c08a; color: #fff; } .lg7.bad, .p7-map a.bad { background: var(--ng); color: #fff; } .p7-map a.part { background: #fcd34d; }
.lg7.uns { background: transparent; border: 2px dashed #d97706; } .p7-map a.uns { outline: 2px dashed #d97706; outline-offset: 1px; }
.p7-map-row { display: grid; grid-template-columns: 210px 1fr; gap: 10px; align-items: center; margin: 6px 0; }
.p7-map { display: flex; flex-wrap: wrap; gap: 5px; } .p7-map a { width: 26px; height: 26px; border-radius: 6px; display: grid; place-items: center; font-size: 11px; color: var(--muted); }
.p7-chtbl td { vertical-align: middle; } .p7-ch { width: 150px; }
.p7-split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.p7-doc { position: sticky; top: 64px; max-height: calc(100vh - 80px); overflow: auto; }
.p7-doc-head { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.chip.on { background: #fde68a; border-color: #d97706; color: #3b1d06; }
.p7-text { font-size: 16px; line-height: 1.8; } .p7-text p { margin: 0 0 12px; }
.p7-text.tap .p7-s { cursor: pointer; } .p7-text.tap .p7-s:hover { background: var(--soft); }
.p7-s { border-radius: 4px; transition: background .2s; } .p7-s.picked { background: #dbeafe; box-shadow: 0 0 0 1px #60a5fa inset; }
.p7-s.ev { background: linear-gradient(transparent 62%, #fde68a 62%); } .p7-s.flash { background: #fde68a; }
.p7-n { color: #b45309; font-weight: 700; margin-right: 2px; font-family: var(--ja); }
.p7-tag { font-style: normal; font: 700 11px var(--en); background: #7c2d12; color: #fff; border-radius: 4px; padding: 0 4px; margin-right: 3px; cursor: pointer; vertical-align: 1px; }
.p7-ja { display: block; font: 13px/1.6 var(--ja); color: var(--muted); margin: 0 0 6px 18px; }
.p7-page { width: 100%; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; background: #fff; }
.p7-evhint { background: #eff6ff; color: #1e40af; padding: 6px 10px; border-radius: 8px; margin-bottom: 8px; }
.p7-q { padding: 14px 16px; border-left: 4px solid transparent; cursor: default; }
.p7-q.focus { border-left-color: #d97706; } .p7-q.is-ok { border-left-color: var(--ok); } .p7-q.is-ng { border-left-color: var(--ng); }
.p7-qhead { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; } .p7-qn { font: 800 16px var(--en); }
.p7-verdict { font-size: 14px; } .p7-q.is-ok .p7-verdict { color: var(--ok); } .p7-q.is-ng .p7-verdict { color: var(--ng); }
.p7-qtext { font-weight: 600; margin-bottom: 8px; }
.p7-choices { display: grid; gap: 6px; }
.p7-ch { width: 100%; display: grid; grid-template-columns: 30px 1fr; gap: 8px; align-items: start; text-align: left; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--text); font: inherit; cursor: pointer; }
.p7-ch:hover { border-color: #d97706; } .p7-ch.sel { border-color: #d97706; background: #fffbeb; box-shadow: 0 0 0 1px #d97706 inset; }
.p7-l { width: 26px; height: 26px; border-radius: 50%; border: 1.5px solid var(--muted); display: grid; place-items: center; font: 700 12px var(--en); }
.p7-ch.sel .p7-l { background: #d97706; border-color: #d97706; color: #fff; }
.p7-ch.correct { border-color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, var(--card)); } .p7-ch.correct .p7-l { background: var(--ok); border-color: var(--ok); color: #fff; }
.p7-ch.wrong { border-color: var(--ng); background: color-mix(in srgb, var(--ng) 10%, var(--card)); } .p7-ch.wrong .p7-l { background: var(--ng); border-color: var(--ng); color: #fff; }
.p7-cja { display: block; font-size: 12px; color: var(--muted); }
.p7-uns.on { background: #fef3c7; border-color: #d97706; color: #92400e; font-weight: 700; }
.p7-ex { margin-top: 10px; display: grid; gap: 8px; } .p7-expl { font-size: 14px; line-height: 1.75; }
.p7-ref { color: #b45309; } .p7-refc { color: var(--primary); }
.p7-wrong summary, .p7-orig summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.p7-vocab { columns: 2 280px; font-size: 13px; line-height: 1.7; } .p7-vocab div { break-inside: avoid; }
.p7-nav { margin: 10px 0 20px; }
.p7-timer { font: 600 13px var(--en); padding: 2px 10px; border-radius: 999px; background: var(--soft); } .p7-timer.over, #mt.over { background: #fee2e2; color: #b91c1c; }
.p7-finish { text-align: center; } .p7-score { font: 800 54px var(--en); } .p7-score small { font-size: 22px; color: var(--muted); }
.p7-reader { text-align: center; padding: 28px; } .p7-rn { font-size: 28px; color: #b45309; }
.p7-ren { font-size: 22px; line-height: 1.7; margin: 10px auto 16px; max-width: 760px; }
.p7-rja { font-size: 16px; color: var(--muted); min-height: 2em; margin-bottom: 16px; } .p7-rja.hide { filter: blur(6px); user-select: none; }
.p7-mini { font-size: 14px; } .p7-mini .p7-s { cursor: pointer; }
.p7-mocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-bottom: 14px; }
.p7-mock { display: flex; flex-direction: column; gap: 4px; text-align: left; cursor: pointer; font: inherit; color: var(--text); margin: 0; }
.p7-mock:hover { border-color: #d97706; }
.p7-mockbar { position: sticky; top: 54px; z-index: 5; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; margin-bottom: 10px; box-shadow: var(--shadow); }
.p7-mockbar #mt { font: 600 13px var(--en); padding: 2px 10px; border-radius: 999px; background: var(--soft); }
.p7-dot { width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; font-size: 12px; }
.p7-dot.done { background: #fde68a; } .p7-dot.on { border-color: #d97706; box-shadow: 0 0 0 2px #d97706 inset; }
@media (max-width: 860px) {
  .p7-split { grid-template-columns: 1fr; } .p7-doc { position: static; max-height: none; }
  .p7-hero { grid-template-columns: 1fr; padding: 20px; } .p7-doc-art { display: none; }
  .p7-map-row { grid-template-columns: 1fr; } .p7-ren { font-size: 18px; }
}
`;
  document.head.appendChild(el);
}
