// Отображение извлечённого текста документа с подсветкой цитаты.
// Используется и в боковой панели источника, и на странице документа.

import { esc } from './ui.js';
import { sentences, normalize } from './search.js';

const find = (text, needles) => needles.map((n) => { const i = text.toLowerCase().indexOf(n.toLowerCase()); return i >= 0 ? [i, i + n.length] : null; }).filter(Boolean);

// Подсветка по строкам блока. Цитата может переходить через перенос строки (абзацы PDF, цитата модели) —
// тогда ищем её в тексте блока целиком и подсвечиваем куски строк, на которые она пришлась.
function markLines(lines, needles) {
  const norm = lines.map(normalize);
  let hits = norm.map((l) => find(l, needles));
  if (!hits.some((h) => h.length)) {
    hits = norm.map(() => []);
    for (const [a, b] of find(norm.join(' '), needles)) {
      let off = 0;
      norm.forEach((l, i) => { const x = Math.max(a, off), y = Math.min(b, off + l.length); if (x < y) hits[i].push([x - off, y - off]); off += l.length + 1; });
    }
  }
  return norm.map((l, i) => render(l, hits[i]));
}

function render(norm, hits) {
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
    const lines = b.text.split('\n').filter((l) => l.trim());
    const marks = active ? markLines(lines, needles) : null;
    lines.forEach((line, li) => {
      const m = marks ? marks[li] : { html: esc(normalize(line)), hit: false };
      if (m.hit) found = true;
      if (line.includes(' | ')) {
        // Строка таблицы подсвечивается целиком (фон строки), ячейки — без разметки.
        const cells = normalize(line).split(' | ').map(esc);
        table.push({ cells, hit: m.hit });
      } else {
        flushTable();
        html += `<p class="${m.hit ? 'p-hit' : ''}">${m.html}</p>`;
      }
    });
    flushTable();
  });
  return { html, found };
}

// Цитата не найдена — хотя бы открываем страницу источника, а не начало документа.
export function scrollToHit(container, page = null) {
  const el = container.querySelector('.hl, .row-hit') || (page && container.querySelector(`#page-${page}`));
  if (el) el.scrollIntoView({ block: 'center' });
}
