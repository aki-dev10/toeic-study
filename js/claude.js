// 解説画面で Claude に問題を解説してもらう（ブラウザから直接 API を呼ぶ。PC 用）。
// API キーはこの端末の localStorage にだけ置く（同期・公開されるデータには入れない）。
import { esc } from './util.js?v=43a74e9663';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm';
const KEY = 'toeic.aiKey';
export const MODELS = { 'claude-haiku-5-5': 'Haiku 5.5（最速・安い）', 'claude-sonnet-5-5': 'Sonnet 5.5（より丁寧）' };
export const DEFAULT_MODEL = 'claude-haiku-5-5';

export const aiKey = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
export const setAiKey = (k) => { try { k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY); } catch (e) { /* */ } };

let sdk = null, client = null, clientKey = '';
const loadSdk = () => (sdk ||= import(SDK_URL).then((m) => m.default));
export const warm = () => { if (aiKey()) loadSdk().catch(() => { sdk = null; }); }; // 最初の解説を待たせないよう先に読み込む

const SYSTEM = 'あなたは TOEIC 講師です。Part 5 の問題を日本語で簡潔に解説します。' +
  '見出し・表・前置きは書かず、「・」で始まる短い箇条書きだけで、全体で 250 字程度までにしてください。' +
  '1行目で正解の決め手を一言で述べ、続けて学習者の選んだ選択肢が誤りの理由（正解なら他の選択肢の誤り）、最後に見抜くコツを書きます。' +
  '続けて質問されたら、同じく短く答えてください。';

export function questionPrompt(q, res, LETTERS) {
  const choices = q.choices.map((c, i) => `(${LETTERS[i]}) ${c}`).join('\n');
  const mine = res.choice != null ? `(${LETTERS[res.choice]}) ${q.choices[res.choice]}` : '未解答';
  return `問題: ${q.text.replace(/-{3,}|_{3,}|—+/, '-------')}\n${choices}\n\n私の解答: ${mine}\n正解: (${LETTERS[q.answer]}) ${q.choices[q.answer]}`;
}

// messages を送り、届いた文字を順に onText へ渡す。戻り値は回答全文
export async function ask(model, messages, onText) {
  const Anthropic = await loadSdk();
  if (!client || clientKey !== aiKey()) { clientKey = aiKey(); client = new Anthropic({ apiKey: clientKey, dangerouslyAllowBrowser: true }); }
  const base = { model, max_tokens: 2000, system: SYSTEM, messages, output_config: { effort: 'low' } };
  // 速さ優先: Haiku は思考なし。Sonnet 5.5 は思考を止められないので effort low。拒否時は別モデルで自動再試行（fallbacks）
  const stream = model.includes('haiku')
    ? client.messages.stream({ ...base, thinking: { type: 'disabled' } })
    : client.beta.messages.stream({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  let text = '';
  stream.on('text', (t) => { text += t; onText(text); });
  try {
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('この質問には回答できませんでした');
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('API キーが正しくありません（設定で入れ直してください）');
    if (err instanceof Anthropic.RateLimitError) throw new Error('混み合っています。少し待ってからもう一度押してください');
    throw err;
  }
  return text;
}

// 箇条書きの文を表示用 HTML に（**強調** だけ太字にする）
export const toHtml = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
