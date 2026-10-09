// Отображение извлечённого текста документа с подсветкой цитаты.
// Используется и в боковой панели источника, и на странице документа.

import { esc } from './ui.js';
import { sentences, normalize } from './search.js';

function markLine(line, needles) {
  const norm = normalize(line);
  const hits = [];
  for (const n of needles) {
    const i = norm.toLowerCase().indexOf(n.toLowerCase());
    if (i >= 0) hits.push([i, i + n.length]);
  }
  if (!hits.length) return { html: esc(norm), hit: false };
  hits.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [a, b] of hits) {
    if (a < pos) continue;
    out += esc(norm.slice(pos, a)) + `<mark class="hl">${esc(norm.slice(a, b))}</mark>`;
    pos = b;
  }
  return { html: out + esc(norm.slice(pos)), hit: true };
}

// highlight: { blockIndex, quote } — подсвечиваем только в указанном блоке, чтобы не путать
// одинаковые фразы в разных местах документа.
export function docBody(d, highlight = null) {
  const needles = highlight?.quote ? sentences(normalize(highlight.quote)).map((s) => s.replace(/[.;]$/, '')).filter((s) => s.length > 3) : [];
  let html = '', page = null, section = undefined, found = false;
  d.blocks.forEach((b, bi) => {
    if (b.n && b.n !== page) { page = b.n; html += `<div class="page-sep" id="page-${page}"><span>Страница ${page}</span></div>`; }
    if (b.section !== section) { section = b.section; if (section) html += `<h3 class="doc-h">${esc(section)}</h3>`; }
    const active = highlight && bi === highlight.blockIndex;
    let table = [];
    const flushTable = () => {
      if (!table.length) return;
      const [head, ...rows] = table;
      html += `<div class="doc-table-wrap"><table class="doc-table"><thead><tr>${head.cells.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr class="${r.hit ? 'row-hit' : ''}">${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      table = [];
    };
    for (const line of b.text.split('\n').filter((l) => l.trim())) {
      const m = active ? markLine(line, needles) : { html: esc(normalize(line)), hit: false };
      if (m.hit) found = true;
      if (line.includes(' | ')) {
        // Строка таблицы подсвечивается целиком (фон строки), ячейки — без разметки.
        const cells = normalize(line).split(' | ').map(esc);
        table.push({ cells, hit: m.hit });
      } else {
        flushTable();
        html += `<p class="${m.hit ? 'p-hit' : ''}">${m.html}</p>`;
      }
    }
    flushTable();
  });
  return { html, found };
}

export function scrollToHit(container) {
  const el = container.querySelector('.hl, .row-hit');
  if (el) el.scrollIntoView({ block: 'center' });
}
