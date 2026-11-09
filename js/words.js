// 単語登録ポップアップ・単語帳・単語復習
import { $, $$, esc, api, store, reloadWords, wordKey, toast, fmtDate, shuffle, tokenize, questionLabel, BLANK_RE } from './util.js?v=5bea812d0a';
import { speak, stop } from './audio.js?v=5bea812d0a';

const LEVELS = ['新規', '学習中', '定着中', '定着', 'ほぼ習得', '習得済み'];

// ============ ポップアップ ============
let ctx = null; // {tokens:[span], index, sourceFn, glosses}

export function initPopup() {
  document.addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    const pop = $('#popup');
    if (pop.contains(e.target) || !e.target.isConnected) return; // ポップアップ内の再描画で外れた要素も内側扱い
    if (w && !window.getSelection().toString().trim()) { e.preventDefault(); openForToken(w); return; }
    if (!pop.hidden && !e.target.closest('.w')) closePopup();
  });
  // テキスト選択（PCのドラッグ・スマホの長押し選択）で熟語登録
  const onSel = () => {
    const sel = window.getSelection();
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text || !/[A-Za-z]/.test(text) || text.length > 60) return;
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const area = node && node.closest('[data-src]');
    if (!area) return;
    const clean = text.replace(/[^A-Za-z'’\- ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    open(clean, { area, rect });
  };
  document.addEventListener('mouseup', () => setTimeout(onSel, 10));
  document.addEventListener('touchend', () => setTimeout(onSel, 350));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });
}

export function closePopup() { $('#popup').hidden = true; ctx = null; }
export const popupOpen = () => !$('#popup').hidden;

function openForToken(span) {
  const area = span.closest('[data-src]');
  const tokens = area ? $$('.w', area) : [span];
  const index = tokens.indexOf(span);
  open(span.textContent, { area, rect: span.getBoundingClientRect(), tokens, start: index, end: index });
}

// 文脈：data-src="qid" の要素から出典情報を取る
function sourceFromArea(area) {
  if (!area) return null;
  const q = store.byId.get(area.dataset.src);
  if (!q) return null;
  return { qid: q.id, material: q.material, part: q.part, number: q.label, sentence: q.complete || q.text, q };
}

async function open(text, o) {
  const { res: _r, ai: _a, selSense: _s, custom: _c, cand: _k, ...rest } = o;
  ctx = { ...rest, text, src: sourceFromArea(o.area) };
  for (const t of $$('.w.sel')) t.classList.remove('sel');
  if (ctx.tokens) for (let i = ctx.start; i <= ctx.end; i++) ctx.tokens[i]?.classList.add('sel');
  const pop = $('#popup');
  pop.innerHTML = `<div class="pop-head"><b>${esc(text)}</b></div><div class="muted">辞書を検索中…</div>`;
  pop.hidden = false;
  ctx.rect = o.rect;
  place(o.rect);
  let res;
  try { res = await api('lookup?q=' + encodeURIComponent(text)); } catch (e) { res = { candidates: [] }; }
  if (!ctx || ctx.text !== text) return;
  ctx.res = res;
  ctx.cand = 0;
  render();
  place(o.rect);
}

function place(rect) {
  const pop = $('#popup');
  if (window.innerWidth < 640) { pop.classList.add('sheet'); pop.style.left = pop.style.top = ''; return; }
  pop.classList.remove('sheet');
  const w = 360;
  const left = Math.min(Math.max(8, rect.left + window.scrollX - 20), window.scrollX + window.innerWidth - w - 8);
  pop.style.left = left + 'px';
  // 下に収まらなければ単語の上に出す
  const h = pop.offsetHeight || 300;
  const below = rect.bottom + 8 + h <= window.innerHeight;
  pop.style.top = (below ? rect.bottom + window.scrollY + 8 : Math.max(window.scrollY + 8, rect.top + window.scrollY - h - 8)) + 'px';
}

function bookGloss() {
  const q = ctx.src && ctx.src.q;
  if (!q || !q.glosses) return null;
  const keys = [wordKey(ctx.text), ...(ctx.res.candidates || []).map((c) => c.lemma)];
  for (const [en, ja] of q.glosses) {
    const k = wordKey(en);
    if (keys.includes(k) || keys.some((x) => k.startsWith(x + ' ') || x.startsWith(k))) return { en, ja };
  }
  return null;
}

function render() {
  const pop = $('#popup');
  const res = ctx.res;
  const c = res.candidates[ctx.cand];
  const lemma = c ? c.lemma : wordKey(ctx.text);
  const existing = store.wordKeys.get(wordKey(lemma));
  const gloss = bookGloss();
  const senses = c ? c.senses : [];
  if (ctx.selSense == null) ctx.selSense = gloss ? 'gloss' : ctx.ai ? 'ai' : senses.length ? 0 : 'custom';
  const opt = (val, pos, meaning, label = '') => `
    <label class="sense ${ctx.selSense === val ? 'on' : ''}"><input type="radio" name="sense" value="${val}" ${ctx.selSense === val ? 'checked' : ''}>
    ${pos ? `<span class="pos">${esc(pos)}</span>` : ''}<span>${esc(meaning)}</span>${label ? `<span class="tag">${label}</span>` : ''}</label>`;
  const canExtend = ctx.tokens && ctx.tokens.length;
  pop.innerHTML = `
    <div class="pop-head">
      <b class="hw">${esc(lemma)}</b>
      <button class="icon-btn" data-act="say" title="発音">🔊</button>
      <span class="ph">${esc(c ? c.phonetic : '')}</span>
      <button class="icon-btn close" data-act="close" aria-label="閉じる">×</button>
    </div>
    ${res.candidates.length > 1 ? `<div class="cands">${res.candidates.map((x, i) => `<button class="chip ${i === ctx.cand ? 'on' : ''}" data-cand="${i}">${esc(x.lemma)}<small>${esc(x.why)}</small></button>`).join('')}</div>` : ''}
    ${ctx.text.toLowerCase() !== lemma ? `<div class="muted small">本文: ${esc(ctx.text)}</div>` : ''}
    ${c && c.pos.length ? `<div class="small">品詞: ${c.pos.map((p) => `<span class="pos">${esc(p)}</span>`).join(' ')}</div>` : ''}
    <div class="senses">
      ${gloss ? opt('gloss', '', gloss.ja, 'この問題の解説') : ''}
      ${ctx.ai ? opt('ai', ctx.ai.pos, ctx.ai.context_meaning, 'AI・文脈') : ''}
      ${senses.map((s, i) => opt(i, s.pos, s.meaning)).join('')}
      ${!senses.length && !gloss ? '<div class="muted small">辞書に見つかりませんでした。意味を入力して仮登録できます。</div>' : ''}
      <label class="sense ${ctx.selSense === 'custom' ? 'on' : ''}"><input type="radio" name="sense" value="custom" ${ctx.selSense === 'custom' ? 'checked' : ''}>
        <input class="custom" placeholder="自分で意味を入力" value="${esc(ctx.custom || '')}"></label>
    </div>
    ${ctx.ai && ctx.ai.note ? `<div class="ai-note small"><span class="tag">AI</span> ${esc(ctx.ai.note)}</div>` : ''}
    <div class="pop-actions">
      ${canExtend ? `<button class="btn ghost sm" data-act="ext-l" title="前の語を含める">＋前の語</button><button class="btn ghost sm" data-act="ext-r" title="次の語を含める">＋次の語</button>` : ''}
      ${store.ai && ctx.src && !ctx.ai ? `<button class="btn ghost sm" data-act="ai">AIで文脈の意味</button>` : ''}
    </div>
    <div class="pop-foot">
      ${existing ? `<span class="small ok">登録済み（出典 ${existing.sources.length}件）</span>` : ''}
      <button class="btn primary" data-act="save">${existing ? 'この出典・意味を追加' : '単語帳に登録'}</button>
    </div>`;
  pop.onclick = onPopClick;
  pop.onchange = (e) => {
    if (e.target.name === 'sense') { ctx.selSense = e.target.value === 'custom' || e.target.value === 'gloss' || e.target.value === 'ai' ? e.target.value : +e.target.value; render(); }
  };
  const ci = $('.custom', pop);
  ci.oninput = () => { ctx.custom = ci.value; if (ctx.selSense !== 'custom') { ctx.selSense = 'custom'; $$('.sense', pop).forEach((l) => l.classList.toggle('on', l.contains(ci))); ci.closest('label').querySelector('input[type=radio]').checked = true; } };
}

async function onPopClick(e) {
  const b = e.target.closest('[data-act],[data-cand]');
  if (!b) return;
  if (b.dataset.cand) { ctx.cand = +b.dataset.cand; ctx.selSense = null; return render(); }
  const act = b.dataset.act;
  const c = ctx.res.candidates[ctx.cand];
  if (act === 'close') return closePopup();
  if (act === 'say') return speak(c ? c.lemma : ctx.text);
  if (act === 'ext-l' || act === 'ext-r') {
    if (act === 'ext-l' && ctx.start > 0) ctx.start--;
    if (act === 'ext-r' && ctx.end < ctx.tokens.length - 1) ctx.end++;
    const phrase = ctx.tokens.slice(ctx.start, ctx.end + 1).map((t) => t.textContent).join(' ');
    return open(phrase, { ...ctx, rect: ctx.tokens[ctx.start].getBoundingClientRect() });
  }
  if (act === 'ai') {
    b.disabled = true; b.textContent = 'AIに問い合わせ中…';
    try { ctx.ai = await api('ai/word', { body: { text: ctx.text, sentence: ctx.src.sentence } }); ctx.selSense = 'ai'; render(); } catch (err) { toast(err.message); b.disabled = false; b.textContent = 'AIで文脈の意味'; }
    return;
  }
  if (act === 'save') {
    const gloss = bookGloss();
    let pos = '', meaning = '', origin = 'dict';
    if (ctx.selSense === 'gloss') { meaning = gloss.ja; origin = 'book'; pos = c && c.pos.length === 1 ? c.pos[0] : ''; }
    else if (ctx.selSense === 'ai') { meaning = ctx.ai.context_meaning; pos = ctx.ai.pos; origin = 'ai'; }
    else if (ctx.selSense === 'custom') { meaning = ctx.custom || ''; origin = 'user'; pos = c && c.pos.length === 1 ? c.pos[0] : ''; }
    else { const s = c.senses[ctx.selSense]; meaning = s.meaning; pos = s.pos; }
    const src = ctx.src ? { qid: ctx.src.qid, material: ctx.src.material, part: ctx.src.part, number: ctx.src.number, sentence: ctx.src.sentence } : null;
    const r = await api('words', { body: { text: ctx.text, lemma: c ? c.lemma : wordKey(ctx.text), surface: ctx.text, pos, meaning, origin, phonetic: c ? c.phonetic : '', source: src } });
    await reloadWords();
    toast(r.created ? `「${r.word.text}」を登録しました` : r.addedSource ? `「${r.word.text}」に出典を追加しました` : `「${r.word.text}」は登録済みです（意味を更新）`);
    markRegistered();
    closePopup();
  }
}

// 登録済み単語に下線
export function markRegistered(root = document) {
  for (const s of $$('.w', root)) {
    const k = wordKey(s.textContent);
    s.classList.toggle('known', store.wordKeys.has(k) || !!store.lemmaHit?.(k));
  }
}
store.lemmaHit = (k) => store.words.some((w) => w.sources.some((s) => wordKey(s.surface || '') === k));

// ============ 単語帳 ============
const POS_LIST = ['名詞', '動詞', '形容詞', '副詞', '前置詞', '接続詞', '代名詞', '熟語'];

export function wordsView(root, params) {
  const f = { q: '', status: params.get('status') || 'all', pos: '', material: '', part: '', sort: 'new', ...(store.local.wordFilter || {}) };
  if (params.get('status')) f.status = params.get('status');
  const now = new Date().toISOString().slice(0, 19);
  root.innerHTML = `
    <div class="page-head"><h1>単語帳</h1>
      <div class="actions"><a class="btn primary" href="#/words/review">復習する</a></div></div>
    <div class="filters card">
      <input type="search" id="wq" placeholder="検索（英語・日本語）" value="${esc(f.q)}">
      <select id="wst">${[['all', 'すべて'], ['new', '新しく登録（7日）'], ['due', '復習が必要'], ['unmastered', '未習得'], ['mastered', '習得済み'], ['weak', '苦手']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="wpos"><option value="">品詞すべて</option>${POS_LIST.map((p) => `<option ${f.pos === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <select id="wmat"><option value="">教材すべて</option>${store.materials.map((m) => `<option value="${m.id}" ${f.material === m.id ? 'selected' : ''}>${esc(m.short)}</option>`).join('')}</select>
      <select id="wpart"><option value="">Partすべて</option>${[5, 7, 2].map((p) => `<option value="${p}" ${String(f.part) === String(p) ? 'selected' : ''}>Part ${p}</option>`).join('')}</select>
      <select id="wsort">${[['new', '登録が新しい順'], ['old', '登録が古い順'], ['weak', '苦手度順'], ['due', '復習予定順'], ['abc', 'ABC順']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div id="wlist"></div>`;
  const draw = () => {
    store.local.wordFilter = { ...f, q: '' }; // 検索語以外を記憶
    let ws = store.words.filter((w) => {
      if (f.q) { const s = (w.text + ' ' + w.senses.map((x) => x.meaning).join(' ')).toLowerCase(); if (!s.includes(f.q.toLowerCase())) return false; }
      if (f.status === 'new' && Date.now() - new Date(w.created_at) > 7 * 864e5) return false;
      if (f.status === 'due' && w.due_at && w.due_at > now) return false;
      if (f.status === 'unmastered' && w.level >= 5) return false;
      if (f.status === 'mastered' && w.level < 5) return false;
      if (f.status === 'weak' && !(w.lapses > 0)) return false;
      if (f.pos && !w.senses.some((s) => s.pos === f.pos) && !(f.pos === '熟語' && w.is_phrase)) return false;
      if (f.material && !w.sources.some((s) => s.material === f.material)) return false;
      if (f.part && !w.sources.some((s) => String(s.part) === String(f.part))) return false;
      return true;
    });
    const weak = (w) => (w.lapses + 1) / (w.reps + w.lapses + 2) + (w.ease < 2.3 ? 0.2 : 0);
    const sorters = { new: (a, b) => b.created_at.localeCompare(a.created_at), old: (a, b) => a.created_at.localeCompare(b.created_at),
      weak: (a, b) => weak(b) - weak(a), due: (a, b) => (a.due_at || '').localeCompare(b.due_at || ''), abc: (a, b) => a.text.localeCompare(b.text) };
    ws.sort(sorters[f.sort]);
    $('#wlist', root).innerHTML = ws.length ? `<div class="muted small">${ws.length}語</div><div class="word-list">${ws.map((w) => `
      <button class="word-row" data-id="${w.id}">
        <span class="wt">${esc(w.text)}</span>
        <span class="wm">${esc(w.senses.map((s) => (s.pos ? `[${s.pos}] ` : '') + s.meaning).join(' / '))}</span>
        <span class="wmeta"><span class="lv lv${w.level}">${LEVELS[w.level]}</span>${w.sources.length > 1 ? `<span class="tag">出典${w.sources.length}</span>` : ''}${w.lapses ? `<span class="tag warn">×${w.lapses}</span>` : ''}</span>
      </button>`).join('')}</div>` : `<div class="empty card">該当する単語はありません。<br>問題文の単語をクリックすると、ここに登録できます。</div>`;
  };
  const bind = (id, key) => { const el = $(id, root); el.oninput = el.onchange = () => { f[key] = el.value; draw(); }; };
  bind('#wq', 'q'); bind('#wst', 'status'); bind('#wpos', 'pos'); bind('#wmat', 'material'); bind('#wpart', 'part'); bind('#wsort', 'sort');
  $('#wlist', root).onclick = (e) => { const r = e.target.closest('.word-row'); if (r) location.hash = '#/words/' + r.dataset.id; };
  draw();
}

export async function wordDetailView(root, id) {
  const w = await api('words/' + id);
  if (!w) { root.innerHTML = '<div class="card">見つかりません</div>'; return; }
  root.innerHTML = `
    <div class="page-head"><a href="#/words" class="back">← 単語帳</a></div>
    <div class="card word-detail">
      <div class="wd-head"><h1>${esc(w.text)}</h1><button class="icon-btn big" data-act="say" title="発音">🔊</button><span class="ph">${esc(w.phonetic)}</span></div>
      <div class="small muted">登録 ${fmtDate(w.created_at)} ・ 習得レベル <span class="lv lv${w.level}">${LEVELS[w.level]}</span> ・ 復習 ${w.reps + w.lapses}回（忘れ ${w.lapses}回） ・ 次回 ${fmtDate(w.due_at) || '-'}</div>
      <h3>意味・用法</h3>
      <div id="senses">${w.senses.map((s) => `<div class="sense-edit" data-id="${s.id}"><select>${['', ...POS_LIST].map((p) => `<option ${p === s.pos ? 'selected' : ''}>${p}</option>`).join('')}</select><input value="${esc(s.meaning)}"><span class="tag">${{ book: '教材', ai: 'AI', user: '自分', dict: '辞書' }[s.origin] || s.origin}</span><button class="icon-btn" data-act="rm-sense" title="削除">−</button></div>`).join('')}</div>
      <button class="btn ghost sm" data-act="add-sense">＋意味を追加</button>
      <h3>出典・例文（${w.sources.length}）</h3>
      ${w.sources.map((s) => { const q = store.byId.get(s.qid); return `<div class="src">
        <div class="en" data-src="${esc(s.qid || '')}">${highlight(s.sentence || '', s.surface || w.text)}</div>
        <div class="small muted">${q ? `<a href="#/q/${esc(q.id)}">${esc(questionLabel(q))}</a> ・ ${esc(q.category || '')}` : esc(`${s.material || ''} ${s.number || ''}`)} ・ 本文の形: ${esc(s.surface || '')}
        <button class="icon-btn" data-say="${esc(s.sentence || '')}" title="例文を再生">🔊</button></div></div>`; }).join('') || '<div class="muted">出典なし</div>'}
      <h3>メモ</h3><textarea id="memo" rows="2" placeholder="コロケーション・覚え方など">${esc(w.memo)}</textarea>
      <div class="row gap">
        <button class="btn primary" data-act="save">保存</button>
        <label class="small"><input type="checkbox" id="exclude" ${w.email_exclude ? 'checked' : ''}> メール配信の対象外</label>
        <span class="spacer"></span>
        <button class="btn danger ghost" data-act="del">削除</button>
      </div>
      ${w.reviews.length ? `<h3>復習履歴</h3><div class="small muted">${w.reviews.map((r) => `${fmtDate(r.at)} ${modeName(r.mode)} ${['×もう一度', '△難しい', '○正解', '◎簡単'][r.grade]}`).join('<br>')}</div>` : ''}
    </div>`;
  root.onclick = async (e) => {
    const b = e.target.closest('[data-act],[data-say]');
    if (!b) return;
    if (b.dataset.say) return speak(b.dataset.say);
    const act = b.dataset.act;
    if (act === 'say') speak(w.text);
    if (act === 'add-sense') $('#senses', root).insertAdjacentHTML('beforeend', `<div class="sense-edit"><select>${['', ...POS_LIST].map((p) => `<option>${p}</option>`).join('')}</select><input placeholder="意味"><span class="tag">自分</span><button class="icon-btn" data-act="rm-sense">−</button></div>`);
    if (act === 'rm-sense') b.closest('.sense-edit').remove();
    if (act === 'save') {
      const senses = $$('.sense-edit', root).map((d) => ({ id: d.dataset.id ? +d.dataset.id : undefined, pos: $('select', d).value, meaning: $('input', d).value.trim() })).filter((s) => s.meaning);
      await api('words/' + id, { method: 'PUT', body: { senses, memo: $('#memo', root).value, email_exclude: $('#exclude', root).checked ? 1 : 0 } });
      await reloadWords(); toast('保存しました');
    }
    if (act === 'del' && confirm(`「${w.text}」を単語帳から削除しますか？`)) {
      await api('words/' + id, { method: 'DELETE' }); await reloadWords(); toast('削除しました'); location.hash = '#/words';
    }
  };
}

function highlight(sentence, surface) {
  const html = tokenize(sentence, { blank: false });
  const re = new RegExp(`(<span class="w">)(${surface.split(/\s+/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('</span>\\s*<span class="w">')})(</span>)`, 'i');
  return html.replace(re, '<mark>$1$2$3</mark>');
}

// ============ 単語復習（間隔反復） ============
const MODES = [['mix', 'ミックス'], ['e2j', '英語→日本語'], ['j2e', '日本語→英語'], ['audio', '音声→意味'], ['cloze', '例文穴埋め']];
const modeName = (m) => (MODES.find((x) => x[0] === m) || [m, m])[1];

export async function wordReviewView(root, params) {
  const mode = params.get('mode') || store.local.wordMode || 'mix';
  const extra = params.get('all') === '1';
  let cards = await api('words/due?limit=' + (extra ? 200 : 40));
  if (extra && !cards.length) cards = shuffle(store.words).slice(0, 20);
  let i = 0, shown = false, done = 0;
  const pickMode = (w) => {
    if (mode !== 'mix') return mode === 'cloze' && !w.sources.length ? 'e2j' : mode;
    const opts = ['e2j', 'e2j', 'j2e', 'audio'];
    if (w.sources.some((s) => s.sentence)) opts.push('cloze', 'cloze');
    return opts[Math.floor(Math.random() * opts.length)];
  };
  const meaning = (w) => w.senses.map((s) => (s.pos ? `<span class="pos">${esc(s.pos)}</span>` : '') + esc(s.meaning)).join('<br>');
  const cloze = (w) => {
    const s = w.sources.find((x) => x.sentence);
    const surf = s.surface || w.text;
    const re = new RegExp(surf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return { text: s.sentence.replace(re, '_____'), full: s.sentence, answer: s.sentence.match(re)?.[0] || w.text };
  };
  const draw = () => {
    stop();
    if (i >= cards.length) {
      root.innerHTML = `<div class="card center"><h2>${cards.length ? 'おつかれさまでした！' : '今日の復習はありません'}</h2>
        <p>${cards.length ? `${done}語を復習しました。` : '新しく単語を登録するか、追加で練習できます。'}</p>
        <div class="row gap center"><a class="btn" href="#/words">単語帳へ</a>${store.words.length ? `<a class="btn primary" href="#/words/review?all=1&mode=${mode}&t=${Date.now()}">追加で練習</a>` : ''}</div></div>`;
      return;
    }
    const w = cards[i];
    const m = w._mode || (w._mode = pickMode(w));
    const c = m === 'cloze' ? (w._cloze || (w._cloze = cloze(w))) : null;
    const prompt = {
      e2j: `<div class="big-word">${esc(w.text)}</div><div class="ph">${esc(w.phonetic)}</div>`,
      j2e: `<div class="big-meaning">${meaning(w)}</div><div class="muted small">英語で言うと？</div>`,
      audio: `<button class="btn round xl" data-act="say">🔊</button><div class="muted small">音声を聞いて意味を思い出す</div>`,
      cloze: c && `<div class="en cloze">${esc(c.text)}</div><div class="muted small">空所に入る語句は？（意味: ${esc(w.senses[0]?.meaning || '')}）</div>`,
    }[m];
    const answer = {
      e2j: `<div class="big-meaning">${meaning(w)}</div>`,
      j2e: `<div class="big-word">${esc(w.text)}</div><div class="ph">${esc(w.phonetic)}</div>`,
      audio: `<div class="big-word">${esc(w.text)}</div><div class="big-meaning">${meaning(w)}</div>`,
      cloze: c && `<div class="big-word">${esc(c.answer)}</div><div class="en">${esc(c.full)}</div><div class="big-meaning">${meaning(w)}</div>`,
    }[m];
    const ex = w.sources.find((s) => s.sentence);
    root.innerHTML = `
      <div class="page-head"><h1>単語復習</h1><div class="actions">
        <select id="mode">${MODES.map(([v, l]) => `<option value="${v}" ${v === mode ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="progress"><div style="width:${(i / cards.length) * 100}%"></div></div>
      <div class="card flash">
        <div class="small muted">${i + 1} / ${cards.length} ・ ${modeName(m)} ・ <span class="lv lv${w.level}">${LEVELS[w.level]}</span></div>
        <div class="flash-q">${prompt}</div>
        ${shown ? `<div class="flash-a">${answer}${ex && m !== 'cloze' ? `<div class="en small" data-src="${esc(ex.qid || '')}">${esc(ex.sentence)}</div>` : ''}
          <div class="row gap center"><button class="icon-btn" data-act="say">🔊</button>${ex ? `<button class="icon-btn" data-act="say-ex" title="例文">🔊例文</button>` : ''}</div></div>
          <div class="grades">${['もう一度', '難しい', '正解', '簡単'].map((g, k) => `<button class="btn g${k}" data-grade="${k}"><kbd>${k + 1}</kbd>${g}</button>`).join('')}</div>`
        : `<button class="btn primary wide" data-act="show">答えを見る <kbd>Space</kbd></button>`}
      </div>`;
    if (m === 'audio' && !shown) speak(w.text);
  };
  const grade = async (g) => {
    const w = cards[i];
    await api(`words/${w.id}/review`, { body: { mode: w._mode, grade: g } });
    done++;
    if (g === 0) cards.push({ ...w, _mode: undefined, _cloze: undefined }); // 当日中にもう一度
    i++; shown = false; draw();
  };
  root.onclick = (e) => {
    const b = e.target.closest('[data-act],[data-grade]');
    if (!b) return;
    if (b.dataset.grade) return grade(+b.dataset.grade);
    const w = cards[i];
    if (b.dataset.act === 'show') { shown = true; draw(); }
    if (b.dataset.act === 'say') speak(w.text);
    if (b.dataset.act === 'say-ex') speak(w.sources.find((s) => s.sentence).sentence);
  };
  root.onchange = (e) => { if (e.target.id === 'mode') { store.local.wordMode = e.target.value; location.hash = '#/words/review?mode=' + e.target.value; } };
  root._keys = (e) => {
    if (i >= cards.length) return;
    if (e.key === ' ' && !shown) { e.preventDefault(); shown = true; draw(); }
    else if (shown && ['1', '2', '3', '4'].includes(e.key)) grade(+e.key - 1);
  };
  draw();
}
