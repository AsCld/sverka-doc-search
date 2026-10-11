// Извлечение текста из файлов в браузере. Результат — блоки {n: страница|null, section: раздел|null, text}.
// DOCX: zip + XML разбираются нативно (DecompressionStream + DOMParser), без библиотек.
// PDF: pdf.js (vendor/pdfjs, Apache-2.0), подгружается только при первом PDF. Скан без текстового слоя → ошибка.

export const ACCEPT = '.pdf,.docx,.txt,.md';
export const MAX_SIZE = 15 * 1024 * 1024;

export class ReadError extends Error {}

export function extOf(name) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export async function extract(file) {
  const ext = extOf(file.name);
  if (file.size === 0) throw new ReadError('Файл пустой.');
  if (file.size > MAX_SIZE) throw new ReadError('Файл больше 15 МБ — в прототипе такой размер не поддерживается.');
  let blocks;
  if (ext === 'txt' || ext === 'md') blocks = fromText(await file.text(), ext);
  else if (ext === 'docx') blocks = await fromDocx(await file.arrayBuffer());
  else if (ext === 'pdf') blocks = await fromPdf(await file.arrayBuffer());
  else if (ext === 'doc') throw new ReadError('Старый формат .doc не поддерживается. Сохраните файл как DOCX или PDF.');
  else throw new ReadError(`Формат ${ext ? '.' + ext : 'без расширения'} не поддерживается. Подходят PDF, DOCX, TXT, MD.`);
  blocks = blocks.filter((b) => b.text.trim());
  if (!blocks.length) {
    throw new ReadError(ext === 'pdf'
      ? 'В PDF нет текстового слоя (похоже на скан). Распознавание (OCR) в прототипе не поддерживается.'
      : 'В файле не найден текст.');
  }
  return blocks;
}

// TXT/MD: разделы по заголовкам «# ...» или «1. Заголовок» в отдельной строке.
function fromText(text, ext) {
  const blocks = [];
  let cur = { n: null, section: null, text: '' };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const h = ext === 'md' ? line.match(/^#{1,3}\s+(.+)/) : null;
    if (h) {
      if (cur.text.trim()) blocks.push(cur);
      cur = { n: null, section: h[1].trim(), text: '' };
      continue;
    }
    // MD: строка таблицы → «ячейка | ячейка» (как таблицы DOCX), пункт списка — отдельный абзац.
    if (ext === 'md' && /^\|.*\|$/.test(line)) {
      if (!/^\|[\s:|-]+\|$/.test(line)) cur.text += `\n${line.slice(1, -1).split('|').map((c) => c.trim()).join(' | ')}\n\n`;
      continue;
    }
    if (ext === 'md' && /^([-*]|\d+\.)\s+/.test(line)) { cur.text += `\n${line.replace(/^[-*]\s+/, '')}\n\n`; continue; }
    cur.text += (line ? line : '') + '\n';
  }
  if (cur.text.trim()) blocks.push(cur);
  // Пустые строки — границы абзацев; одиночные переносы внутри абзаца склеиваем.
  return blocks.map((b) => ({ ...b, text: b.text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n') }));
}

// ---------- DOCX ----------
async function unzip(buf, wanted) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ReadError('Файл DOCX повреждён (не является zip-архивом).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nLen = dv.getUint16(p + 28, true), xLen = dv.getUint16(p + 30, true), cLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nLen));
    if (name === wanted) {
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = new Uint8Array(buf, start, size);
      if (method === 0) return dec.decode(data);
      if (method !== 8) throw new ReadError('Неподдерживаемое сжатие в DOCX.');
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return await new Response(stream).text();
    }
    p += 46 + nLen + xLen + cLen;
  }
  throw new ReadError('В DOCX не найден основной текст (word/document.xml).');
}

async function fromDocx(buf) {
  const xml = await unzip(buf, 'word/document.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const body = doc.getElementsByTagNameNS('*', 'body')[0];
  if (!body) throw new ReadError('Не удалось прочитать структуру DOCX.');
  const textOf = (el) => {
    let s = '';
    for (const n of el.getElementsByTagNameNS('*', '*')) {
      if (n.localName === 't') s += n.textContent;
      else if (n.localName === 'tab') s += ' ';
      else if (n.localName === 'br') s += ' ';
    }
    return s.replace(/\s+/g, ' ').trim();
  };
  const blocks = [];
  let cur = { n: null, section: null, text: '' };
  for (const el of body.children) {
    if (el.localName === 'p') {
      const style = el.getElementsByTagNameNS('*', 'pStyle')[0]?.getAttribute('w:val') || '';
      const t = textOf(el);
      if (!t) continue;
      if (/^(heading|заголовок)\s?\d/i.test(style) || /^Heading/i.test(style)) {
        if (cur.text.trim()) blocks.push(cur);
        cur = { n: null, section: t, text: '' };
      } else cur.text += t + '\n';
    } else if (el.localName === 'tbl') {
      for (const tr of el.getElementsByTagNameNS('*', 'tr')) {
        const cells = [...tr.children].filter((c) => c.localName === 'tc').map(textOf);
        if (cells.some(Boolean)) cur.text += cells.join(' | ') + '\n';
      }
    }
  }
  if (cur.text.trim()) blocks.push(cur);
  return blocks;
}

// ---------- PDF ----------
const PDFJS = new URL('../vendor/pdfjs/', import.meta.url).href;
let pdfjsReady;
function loadPdfjs() {
  pdfjsReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFJS + 'pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; resolve(window.pdfjsLib); };
    s.onerror = () => { pdfjsReady = null; reject(new ReadError('Не удалось загрузить модуль чтения PDF. Обновите страницу и повторите.')); };
    document.head.append(s);
  });
  return pdfjsReady;
}

// Новый абзац PDF: увеличенный шаг строки, пункт списка или конец предложения + красная строка /
// недописанная до правого края строка. Строки {y, x0, x1, s}; lh — обычный шаг строки.
export function paraBreak(prev, l, lh, left, right) {
  if (!prev || prev.y - l.y > lh * 1.3 || /^(\d{1,2}(\.\d{1,2})*\.\s|[•—–-]\s)/.test(l.s)) return true;
  return /[.:;!?]$/.test(prev.s) && (l.x0 - left > 8 || right - prev.x1 > 30);
}

// Заголовок раздела: «2. Название» без точки в конце и крупнее основного текста.
const HEADING = /^\d{1,2}\.\s+[А-ЯЁA-Z].{2,90}[^.]$/;

async function fromPdf(buf) {
  const lib = await loadPdfjs();
  let pdf;
  try { pdf = await lib.getDocument({ data: buf }).promise; }
  catch (e) { throw new ReadError(e?.name === 'PasswordException' ? 'PDF защищён паролем.' : 'PDF повреждён или не читается.'); }
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    // Строки по координате y, внутри строки — по x.
    const rows = [];
    for (const it of content.items) {
      if (!it.str) continue;
      const y = it.transform[5], x = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) < 2);
      if (!row) rows.push(row = { y, items: [] });
      row.items.push({ x, w: it.width, s: it.str, h: it.height });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let s = '', end = null;
      for (const it of r.items) { s += (end !== null && it.x - end > 1 && !s.endsWith(' ') ? ' ' : '') + it.s; end = it.x + it.w; }
      return { y: r.y, x0: r.items[0].x, x1: end, h: Math.max(...r.items.map((i) => i.h)), s: s.replace(/\s+/g, ' ').trim() };
    }).filter((l) => l.s);
    pages.push(lines);
  }
  // Колонтитулы: строки (без цифр), повторяющиеся на 2/3 страниц, выбрасываем.
  const key = (s) => s.replace(/\d+/g, '#');
  const freq = new Map();
  pages.forEach((ls) => new Set(ls.map((l) => key(l.s))).forEach((k) => freq.set(k, (freq.get(k) || 0) + 1)));
  const repeated = (s) => pages.length >= 2 && freq.get(key(s)) >= Math.max(2, Math.ceil(pages.length * 2 / 3));

  const blocks = [];
  let section = null;
  pages.forEach((lines, i) => {
    lines = lines.filter((l) => !repeated(l.s));
    // Шаг строки — нижний квартиль шагов. Раньше брали минимум с потолком 14 pt: при полуторном интервале
    // госдокументов (~21 pt) каждая строка становилась абзацем, и цитата не находилась в тексте (сессия 9).
    const gaps = lines.slice(1).map((l, k) => lines[k].y - l.y).filter((g) => g > 4).sort((a, b) => a - b);
    const lh = gaps[Math.floor(gaps.length / 4)] || 14;
    const left = Math.min(...lines.map((l) => l.x0)), right = Math.max(...lines.map((l) => l.x1));
    const hs = lines.map((l) => l.h).sort((a, b) => a - b);
    const bodyH = hs[Math.floor(hs.length / 2)] || 10;
    let cur = { n: i + 1, section, text: '' };
    let prev = null;
    for (const l of lines) {
      if (HEADING.test(l.s) && l.h > bodyH * 1.08) {
        if (cur.text.trim()) blocks.push(cur);
        section = l.s;
        cur = { n: i + 1, section, text: '' };
        prev = l;
        continue;
      }
      const brk = paraBreak(prev, l, lh, left, right);
      cur.text += (cur.text && brk ? '\n' : cur.text ? ' ' : '') + l.s;
      prev = l;
    }
    if (cur.text.trim()) blocks.push(cur);
  });
  return blocks;
}
