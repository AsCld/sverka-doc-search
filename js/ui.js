// Общие помощники интерфейса: экранирование, иконки, форматирование, тосты, диалоги.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const P = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
  docs: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4Z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  move: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="m11 13h6M14 10l3 3-3 3"/>',
  scope: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5"/>',
};
export const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}
export const nDocs = (n) => `${n} ${plural(n, 'документ', 'документа', 'документов')}`;

export function fmtSize(b) {
  if (!b) return '—';
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}
export function fmtDate(ts, withTime = true) {
  const d = new Date(ts), now = new Date();
  const same = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (same) return withTime ? `сегодня, ${t}` : 'сегодня';
  const date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return withTime ? `${date}, ${t}` : date;
}

// Короткая разметка ответа: **жирный** и ссылки на источники [n].
export function inline(text, msgId) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(\d+)\]/g, (_, n) => `<button type="button" class="cite" data-cite="${n}" data-msg="${msgId}" aria-label="Источник ${n}">${n}</button>`);
}

export function anchor(s) {
  const parts = [];
  if (s.page) parts.push(`стр. ${s.page}`);
  if (s.section) parts.push(s.page ? s.section : `раздел «${s.section}»`);
  return parts.join(' · ') || 'начало документа';
}

export const TYPE = { pdf: 'PDF', docx: 'DOCX', txt: 'TXT', md: 'MD' };
export const STATUS = {
  queued: { label: 'В очереди', cls: 'st-queued' },
  processing: { label: 'Обработка', cls: 'st-proc' },
  ready: { label: 'Готов к поиску', cls: 'st-ready' },
  error: { label: 'Ошибка чтения', cls: 'st-error' },
};
export function statusBadge(d) {
  const s = STATUS[d.status];
  const text = d.status === 'processing' && d.stage ? `${s.label}: ${d.stage.toLowerCase()}` : s.label;
  return `<span class="status ${s.cls}">${d.status === 'processing' ? '<span class="spin" aria-hidden="true"></span>' : '<span class="dot" aria-hidden="true"></span>'}${esc(text)}</span>`;
}

// ---------- Анимация появления ----------
// Виды перерисовываются целиком (innerHTML), поэтому CSS-анимация сама по себе запускалась бы
// при каждом обновлении. Элемент с data-k получает класс enter только при первом показе ключа.
export function reveal(root, seen, animate = () => true) {
  for (const el of root.querySelectorAll('[data-k]')) {
    const k = el.dataset.k;
    if (seen.has(k)) continue;
    seen.add(k);
    if (animate(k)) el.classList.add('enter');
  }
}

// ---------- Тосты ----------
export function toast(text, { action, onAction, kind = '' } = {}) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button" class="btn btn-ghost btn-sm">${esc(action)}</button>` : ''}<button type="button" class="icon-btn btn-sm" aria-label="Закрыть уведомление">${icon('x')}</button>`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  if (action) el.querySelector('.btn').onclick = () => { onAction?.(); close(); };
  el.querySelector('.icon-btn').onclick = close;
  box.append(el);
  setTimeout(close, action ? 8000 : 4500);
}

// ---------- Модальные окна на <dialog> ----------
export function modal({ title, body, actions = [], wide = false, onMount }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = `modal ${wide ? 'wide' : ''}`;
    dlg.innerHTML = `<form method="dialog" class="modal-inner">
      <header class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Закрыть">${icon('x')}</button></header>
      <div class="modal-body">${body}</div>
      <footer class="modal-foot">${actions.map((a, i) => `<button type="${a.submit ? 'submit' : 'button'}" class="btn ${a.cls || 'btn-ghost'}" data-act="${i}" ${a.submit ? 'value="ok"' : ''}>${esc(a.label)}</button>`).join('')}</footer>
    </form>`;
    document.body.append(dlg);
    let result = null;
    const done = (v) => { result = v; dlg.close(); };
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.querySelector('[data-close]').onclick = () => done(null);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) done(null); });
    actions.forEach((a, i) => {
      const b = dlg.querySelector(`[data-act="${i}"]`);
      if (!a.submit) b.onclick = () => done(a.value ?? null);
    });
    dlg.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const a = actions.find((x) => x.submit);
      const v = a.collect ? a.collect(dlg) : a.value;
      if (v === undefined) return; // collect вернул undefined — ошибка валидации, окно остаётся
      done(v);
    };
    onMount?.(dlg);
    dlg.showModal();
  });
}

export function confirmDialog({ title, text, ok = 'Удалить', danger = true }) {
  return modal({
    title, body: `<p>${esc(text)}</p>`,
    actions: [{ label: 'Отмена', value: false }, { label: ok, cls: danger ? 'btn-danger' : 'btn-primary', submit: true, value: true }],
  });
}

export function promptDialog({ title, label, value = '', ok = 'Сохранить' }) {
  return modal({
    title,
    body: `<label class="field"><span>${esc(label)}</span><input class="input" name="v" required maxlength="60" value="${esc(value)}" autocomplete="off"></label><p class="field-err" hidden>Введите название</p>`,
    actions: [{ label: 'Отмена', value: null }, { label: ok, cls: 'btn-primary', submit: true, collect: (d) => {
      const v = d.querySelector('[name=v]').value.trim();
      if (!v) { d.querySelector('.field-err').hidden = false; return undefined; }
      return v;
    } }],
    onMount: (d) => setTimeout(() => d.querySelector('input').select(), 0),
  });
}
