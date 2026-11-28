// 学習推移（Part 別の解いた問題数）。Part 5 / Part 2 のホームで共通
import { $, $$ } from './util.js?v=71945be40f';

// qid の接頭辞で Part を判定（static.js の dashboard() と対応）。Part 3・4 / 7 は解いた日があるときだけ表示
const PARTS = [
  { k: 'p2', label: 'Part 2', color: '#0f9d8a' },
  { k: 'p34', label: 'Part 3・4', color: '#8b5cf6', opt: true },
  { k: 'p5', label: 'Part 5', color: '#2563eb' },
  { k: 'p7', label: 'Part 7', color: '#f59e0b', opt: true },
];

export const trendCard = () => `<section class="card"><h2>学習推移</h2>
  <div class="seg" id="rangeSeg"><button data-r="7" class="on">7日</button><button data-r="30">30日</button></div>
  <div id="chart"></div><div class="legend small" id="chartLegend"></div></section>`;

export function bindTrend(root, allDays) {
  const draw = (n) => {
    const days = allDays.slice(-n);
    const parts = PARTS.filter((p) => !p.opt || days.some((x) => x.parts[p.k]));
    $('#chart', root).innerHTML = chart(days, parts);
    $('#chartLegend', root).innerHTML = parts.map((p) => `<span class="lg" style="background:${p.color}"></span>${p.label}`).join(' ') + ' <span class="muted">（解いた問題数）</span>';
  };
  draw(7);
  $('#rangeSeg', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $$('#rangeSeg button', root).forEach((x) => x.classList.toggle('on', x === b)); draw(+b.dataset.r); };
}

function chart(days, parts) {
  const W = 600, H = 160, pad = 22, bw = (W - pad * 2) / days.length;
  const tot = (d) => parts.reduce((a, p) => a + (d.parts[p.k] || 0), 0);
  const max = Math.max(5, ...days.map(tot));
  const h = (v) => (v / max) * (H - pad * 2);
  const bars = days.map((d, i) => {
    const x = pad + i * bw + bw * 0.2, w = bw * 0.6;
    let base = H - pad;
    const segs = parts.filter((p) => d.parts[p.k]).map((p) => {
      const v = d.parts[p.k], hh = h(v); base -= hh;
      return `<rect x="${x}" y="${base}" width="${w}" height="${hh}" style="fill:${p.color}"><title>${d.d} ${p.label}: ${v}問</title></rect>`;
    }).join('');
    const t = tot(d);
    return segs + (t && days.length <= 7 ? `<text x="${x + w / 2}" y="${base - 4}" text-anchor="middle" class="axis-t">${t}</text>` : '') +
      (days.length <= 7 || i % 5 === 0 ? `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${d.d.slice(5).replace('-', '/')}</text>` : '');
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="学習推移"><line x1="${pad}" x2="${W - pad}" y1="${H - pad}" y2="${H - pad}" class="axis"/>${bars}<text x="${pad}" y="12" class="axis-t">${max}</text></svg>`;
}

