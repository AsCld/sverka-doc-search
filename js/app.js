// Точка входа: маршрутизация (hash — работает на GitHub Pages без 404), каркас (боковое меню на компьютере,
// шапка и нижние вкладки на телефоне), панель/лист источника, история, сохранённые, роли, заставка.

import { state, subscribe, commit, chat as getChat, doc as getDoc, liveDocs, addFiles, deleteChat, reset, toggleSaved, storageError, flush, myChats, mySaved, role, setRole, isContractor, canSee } from './store.js';
import { chatView } from './chat.js';
import { docsView, docPage } from './docs.js';
import { docBody, scrollToHit } from './viewer.js';
import { esc, icon, anchor, fmtDate, toast, modal, confirmDialog, nDocs, plural } from './ui.js';
import { ACCEPT } from './ingest.js';
import { initFx, lattice } from './fx.js';

const $ = (s) => document.querySelector(s);
const main = $('#main');
const panel = $('#panel');
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = () => matchMedia('(max-width: 900px)').matches;

// ---------- Выбор файлов ----------
const picker = $('#filePick');
picker.accept = ACCEPT;
let pickCb = null;
function pickFiles(colId, onFile = null, multiple = true) {
  if (isContractor()) return toast('Подрядчик не может загружать файлы: документы выдаёт сотрудник.', { kind: 'warn' });
  picker.multiple = multiple;
  pickCb = (list) => {
    if (onFile) return onFile(list[0]);
    const added = addFiles(list, colId);
    toast(`Добавлено: ${nDocs(added.length)}. Идёт обработка.`, location.hash.startsWith('#/docs') ? {} : { action: 'К документам', onAction: () => { location.hash = '#/docs'; } });
  };
  picker.value = '';
  picker.click();
}
picker.addEventListener('change', () => { if (picker.files.length && pickCb) pickCb([...picker.files]); });

// ---------- Маршруты ----------
function parse() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(qs || '');
  if (!seg.length) return { view: 'chat', id: null, query };
  if (seg[0] === 'c' && seg[1]) return { view: 'chat', id: seg[1], query };
  if (seg[0] === 'docs') return { view: 'docs', col: seg[1] || 'all', query };
  if (seg[0] === 'doc' && seg[1]) return { view: 'doc', id: seg[1], query };
  if (seg[0] === 'saved') return { view: 'saved', query };
  if (seg[0] === 'history') return { view: 'history', query };
  return { view: 'notfound', query };
}

const views = {
  chat: () => chatView({ pickFiles }),
  docs: () => docsView({ pickFiles }),
  doc: () => docPage(),
  saved: () => savedView(),
  history: () => historyView(),
  notfound: () => ({ mount(m) { m.innerHTML = `<div class="empty-card center page-pad"><h1>Страница не найдена</h1><p>Проверьте ссылку или вернитесь на главный экран.</p><a class="btn btn-primary" href="#/">К чату</a></div>`; }, update() {} }),
};

// Вкладки телефона. Диалог и документ — «вложенные» экраны: вкладки прячутся, в шапке — «назад».
const TABS = [
  { id: 'chat', href: '#/', label: 'Чат', ic: 'chat' },
  { id: 'history', href: '#/history', label: 'История', ic: 'history' },
  { id: 'docs', href: '#/docs', label: 'Документы', ic: 'docs' },
  { id: 'saved', href: '#/saved', label: 'Сохранённые', ic: 'bookmark' },
];
const tabOf = (r) => (r.view === 'chat' ? (r.id ? 'history' : 'chat') : r.view === 'doc' ? 'docs' : r.view);
const isDetail = (r) => (r.view === 'chat' && !!r.id) || r.view === 'doc';

// Направление перехода: вкладка правее — экран въезжает справа; вложенный экран — сдвиг «вперёд», возврат — «назад».
function navAnim(prev, next) {
  if (!prev || reduce() || document.documentElement.classList.contains('vt-morph')) return;
  let cls = 'nav-fade';
  if (isDetail(next) && !isDetail(prev)) cls = 'nav-push';
  else if (isDetail(prev) && !isDetail(next)) cls = 'nav-pop';
  else {
    const a = TABS.findIndex((t) => t.id === tabOf(prev)), b = TABS.findIndex((t) => t.id === tabOf(next));
    if (a >= 0 && b >= 0 && a !== b) cls = b > a ? 'nav-r' : 'nav-l';
  }
  main.classList.remove('nav-fade', 'nav-push', 'nav-pop', 'nav-r', 'nav-l');
  void main.offsetWidth; // перезапуск анимации
  main.classList.add(cls);
}

let cur = { key: '', view: null, route: null };
function route() {
  const r = parse();
  const key = `${r.view}:${r.id || r.col || ''}`;
  if (key !== cur.key) {
    const prev = cur.route;
    cur = { key, view: views[r.view](), route: r };
    cur.view.mount(main, r);
    main.scrollTop = 0;
    navAnim(prev, r);
    if (document.activeElement === document.body || document.activeElement?.closest('.sidebar, .tabbar')) main.focus({ preventScroll: true });
  } else {
    cur.route = r;
    cur.view.update(r);
  }
  document.title = titleFor(r);
  renderShell();
  renderPanel();
}
function titleFor(r) {
  if (r.view === 'chat' && r.id) return `${getChat(r.id)?.title || 'Диалог'} · Сверка`;
  if (r.view === 'docs') return 'Документы · Сверка';
  if (r.view === 'doc') return `${getDoc(r.id)?.name || 'Документ'} · Сверка`;
  if (r.view === 'saved') return 'Сохранённые ответы · Сверка';
  if (r.view === 'history') return 'История · Сверка';
  return 'Сверка — поиск по документам';
}

// ---------- Каркас ----------
const docsBadge = () => {
  const live = liveDocs();
  const errs = live.filter((d) => d.status === 'error').length;
  const proc = live.filter((d) => d.status === 'queued' || d.status === 'processing').length;
  return { errs, proc, html: proc ? `<span class="badge info">${lattice({ pattern: 'snake', mini: true })}${proc}</span>` : errs && !isContractor() ? `<span class="badge warn" title="Требуют внимания">${errs}</span>` : '' };
};

function chatListHtml(r, cls = '') {
  const chats = [...myChats()].sort((a, b) => b.updatedAt - a.updatedAt);
  const today = new Date().toDateString();
  const groups = [['Сегодня', chats.filter((c) => new Date(c.updatedAt).toDateString() === today)], ['Ранее', chats.filter((c) => new Date(c.updatedAt).toDateString() !== today)]].filter(([, l]) => l.length);
  if (!groups.length) return '';
  return groups.map(([g, l]) => `<h2 class="side-h">${g}</h2><ul class="${cls}">${l.map((c) => {
    const on = r.view === 'chat' && r.id === c.id;
    const n = c.messages.filter((m) => m.role === 'user').length;
    return `<li class="${on ? 'active' : ''}" data-k="${c.id}"><a href="#/c/${c.id}" ${on ? 'aria-current="page"' : ''}><span class="h-title">${esc(c.title)}</span><span class="h-meta">${n} ${plural(n, 'вопрос', 'вопроса', 'вопросов')} · ${fmtDate(c.updatedAt)}</span></a><button type="button" class="icon-btn btn-sm h-del" data-del-chat="${c.id}" aria-label="Удалить диалог «${esc(c.title)}»">${icon('trash', 'sm')}</button></li>`;
  }).join('')}</ul>`).join('');
}

function renderSidebar(r) {
  const b = docsBadge();
  const html = `
    <div class="brand"><a href="#/" class="brand-link" aria-label="Сверка — на главный экран"><span class="logo-mark" aria-hidden="true"></span><span class="brand-name">Сверка</span></a></div>
    <a href="#/" class="btn btn-primary new-chat">${icon('plus', 'sm')}Новый диалог</a>
    <nav class="nav" aria-label="Разделы">
      <a href="#/docs" class="${r.view === 'docs' || r.view === 'doc' ? 'active' : ''}" ${r.view === 'docs' ? 'aria-current="page"' : ''}>${icon('docs')}<span>Документы</span>${b.html || `<span class="count">${liveDocs().length}</span>`}</a>
      <a href="#/saved" class="${r.view === 'saved' ? 'active' : ''}" ${r.view === 'saved' ? 'aria-current="page"' : ''}>${icon('bookmark')}<span>Сохранённые</span><span class="count">${mySaved().length}</span></a>
    </nav>
    ${b.errs && !isContractor() ? `<a class="side-alert" href="#/docs?status=error">${icon('alert', 'sm')}${b.errs} ${b.errs === 1 ? 'файл требует' : 'файла требуют'} внимания</a>` : ''}
    <div class="history" aria-label="История диалогов">${chatListHtml(r) || '<p class="side-empty">Здесь появятся ваши диалоги.</p>'}</div>`;
  const sb = $('#sideMain');
  if (sb._html !== html) { sb.innerHTML = html; sb._html = html; }
}

// Переключатель роли: строится один раз, дальше меняются только атрибуты — бегунок едет, а не перерисовывается.
function renderRoleSeg() {
  const i = isContractor() ? 1 : 0;
  for (const seg of document.querySelectorAll('.role-seg')) {
    seg.style.setProperty('--ri', i);
    seg.querySelectorAll('[data-role]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.role === role())));
  }
  const note = $('#roleNote');
  if (note) note.textContent = isContractor() ? 'Видны только папки, открытые подрядчикам' : 'Видны все документы, можно ими управлять';
}

function renderTopbar(r) {
  const back = (href, label) => `<a class="icon-btn tb-back" href="${href}" aria-label="${label}">${icon('back')}</a>`;
  let left, title, right = `<button type="button" class="role-chip ${isContractor() ? 'ext' : ''}" data-act="profile" aria-haspopup="dialog" aria-label="Роль: ${isContractor() ? 'подрядчик' : 'сотрудник'}. Сменить роль"><span class="rc-ava" aria-hidden="true">${isContractor() ? 'П' : 'С'}</span><span class="rc-name">${isContractor() ? 'Подрядчик' : 'Сотрудник'}</span>${icon('chevron', 'sm')}</button>`;
  if (r.view === 'chat' && r.id) {
    left = back('#/history', 'К истории');
    title = esc(getChat(r.id)?.title || 'Диалог');
    right = `<a href="#/" class="icon-btn" aria-label="Новый диалог">${icon('plus')}</a>`;
  } else if (r.view === 'doc') {
    const from = r.query.get('from');
    left = back(from ? `#/c/${esc(from)}` : `#/docs${getDoc(r.id)?.collectionId ? '/' + getDoc(r.id).collectionId : ''}`, from ? 'К диалогу' : 'К документам');
    title = esc(getDoc(r.id)?.name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ') || 'Документ');
    right = '';
  } else {
    left = '<a href="#/" class="tb-logo" aria-label="Сверка — новый вопрос"><span class="logo-mark" aria-hidden="true"></span></a>';
    title = { chat: 'Сверка', history: 'История', docs: 'Документы', saved: 'Сохранённые' }[r.view] || 'Сверка';
  }
  const html = `${left}<span class="tb-title">${title}</span>${right}`;
  const tb = $('#topbar');
  if (tb._html !== html) { tb.innerHTML = html; tb._html = html; }
}

function renderTabbar(r) {
  const bar = $('#tabbar');
  if (!bar.firstChild) {
    bar.innerHTML = `<span class="tab-ind" aria-hidden="true"></span>${TABS.map((t) => `<a href="${t.href}" data-tab="${t.id}">${icon(t.ic)}<span>${t.label}</span><span class="tab-badge"></span></a>`).join('')}`;
  }
  const i = TABS.findIndex((t) => t.id === tabOf(r));
  bar.style.setProperty('--ti', Math.max(0, i));
  bar.classList.toggle('none', i < 0);
  bar.querySelectorAll('[data-tab]').forEach((a) => { if (a.dataset.tab === tabOf(r)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const b = docsBadge();
  const set = (id, html) => { const el = bar.querySelector(`[data-tab="${id}"] .tab-badge`); if (el._html !== html) { el.innerHTML = html; el._html = html; } };
  set('docs', b.proc ? lattice({ pattern: 'snake', mini: true }) : b.errs && !isContractor() ? `<i class="dot-err" title="Есть файлы с ошибкой"></i>` : '');
  set('saved', mySaved().length ? `<i class="n">${mySaved().length}</i>` : '');
}

function renderShell() {
  const r = cur.route;
  document.body.dataset.view = r.view;
  document.body.classList.toggle('detail', isDetail(r));
  document.body.classList.toggle('contractor', isContractor());
  renderSidebar(r);
  renderTopbar(r);
  renderTabbar(r);
  renderRoleSeg();
  $('#storageErr').hidden = !storageError;
  $('#storageErr').textContent = storageError || '';
}

// ---------- Действия каркаса ----------
document.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-chat]');
  if (del) {
    const c = getChat(del.dataset.delChat);
    if (await confirmDialog({ title: 'Удалить диалог?', text: `«${c.title}» и его сохранённые ответы будут удалены.`, ok: 'Удалить' })) {
      state.saved = state.saved.filter((s) => s.chatId !== c.id);
      deleteChat(c.id);
      if (cur.route.view === 'chat' && cur.route.id === c.id) location.hash = '#/';
      toast('Диалог удалён.');
    }
    return;
  }
  const t = e.target.closest('[data-act=about],[data-act=profile],[data-role]');
  if (!t) return;
  if (t.dataset.role) return switchRole(t.dataset.role, t);
  if (t.dataset.act === 'about') return about();
  if (t.dataset.act === 'profile') return profile(t);
});

// Смена роли: новый «мир» раскрывается кругом от переключателя (View Transitions), без API — сразу.
function switchRole(r, from) {
  if (r === role()) return;
  const run = () => {
    setRole(r);
    if (isDetail(cur.route) || (r === 'contractor' && cur.route.query.get('status'))) { location.hash = '#/'; dispatchEvent(new HashChangeEvent('hashchange')); }
  };
  toast(r === 'contractor' ? 'Роль «Подрядчик»: видны только документы, открытые подрядчикам.' : 'Роль «Сотрудник»: видны все документы.');
  if (!document.startViewTransition || reduce()) return run();
  const b = from?.getBoundingClientRect();
  const root = document.documentElement;
  if (b) { root.style.setProperty('--vx', `${b.left + b.width / 2}px`); root.style.setProperty('--vy', `${b.top + b.height / 2}px`); }
  root.classList.add('vt-role');
  document.startViewTransition(run).finished.finally(() => root.classList.remove('vt-role'));
}

async function profile(btn) {
  const opt = (id, title, text) => `<label class="opt role-opt"><input type="radio" name="role" value="${id}" ${role() === id ? 'checked' : ''}><span><b>${title}</b><small>${text}</small></span></label>`;
  const res = await modal({
    title: 'Кто вы?',
    body: `<p class="muted">От роли зависит, какие документы вы видите. Это демо: входа по паролю нет, роль можно менять в любой момент.</p>
      <fieldset class="scope-opts"><legend class="sr-only">Роль</legend>
      ${opt('staff', 'Сотрудник', 'Видит все документы. Может загружать, перемещать и удалять их, открывать папки подрядчикам')}
      ${opt('contractor', 'Подрядчик', 'Внешний пользователь. Видит только папки, которые ему открыли. Загружать и удалять не может')}
      </fieldset>`,
    actions: [{ label: 'О прототипе', value: 'about' }, { label: 'Готово', cls: 'btn-primary', submit: true, collect: (d) => d.querySelector('[name=role]:checked').value }],
  });
  if (res === 'about') return about();
  if (res) switchRole(res, btn);
}

// ---------- Панель источника (компьютер) / лист источника (телефон) ----------
function sourceFor(src) {
  if (!src || cur.route.view !== 'chat') return null;
  const [msgId, key] = src.split(':');
  const c = getChat(cur.route.id);
  const m = c?.messages.find((x) => x.id === msgId);
  const a = m?.answer;
  if (!a) return null;
  const list = String(key).startsWith('near-') ? a.near : a.sources;
  const n = Number(String(key).replace('near-', ''));
  const s = list?.find((x) => x.n === n);
  return s ? { c, m, s, list, near: String(key).startsWith('near-') } : null;
}

let lastPanel = '', closing = 0;
function renderPanel() {
  const src = cur.route.query.get('src');
  const found = sourceFor(src);
  if (!src) {
    if (!lastPanel) return;
    lastPanel = '';
    $('#scrim').hidden = true;
    // Лист уезжает вниз, панель — вправо; потом скрываем (колонку панели убираем тоже после анимации).
    const done = () => { panel.hidden = true; panel.innerHTML = ''; panel.classList.remove('closing'); panel.style.transform = ''; document.body.classList.remove('panel-open'); };
    if (reduce()) return done();
    panel.classList.add('closing');
    clearTimeout(closing);
    closing = setTimeout(done, 280);
    return;
  }
  clearTimeout(closing);
  panel.classList.remove('closing');
  document.body.classList.add('panel-open');
  panel.hidden = false;
  $('#scrim').hidden = !mobile();
  const close = `#/c/${cur.route.id}`;
  let html;
  if (!found) {
    html = `<div class="panel-grab" aria-hidden="true"></div><div class="panel-head"><a class="icon-btn" href="${close}" aria-label="Закрыть источник">${icon('x')}</a></div><div class="panel-body"><div class="empty-card">Источник не найден.</div></div>`;
  } else {
    const { c, m, s, list, near } = found;
    const d = getDoc(s.docId);
    const i = list.indexOf(s);
    const nav = (j) => `#/c/${c.id}?src=${m.id}:${near ? 'near-' : ''}${list[j].n}`;
    let body;
    if (!d) body = '<div class="empty-card">Документ удалён навсегда — источник больше недоступен.</div>';
    else if (!canSee(d)) body = `<div class="empty-card">${icon('lock', 'sm')}Документ закрыт для вашей роли.</div>`;
    else if (d.deletedAt) body = `<div class="empty-card">Документ находится в корзине.<a class="btn btn-ghost btn-sm" href="#/docs/trash">Открыть корзину</a></div>`;
    else {
      const b = docBody(d, { blockIndex: s.blockIndex, quote: s.quote });
      body = `${b.found ? '' : `<div class="banner warn">${icon('alert', 'sm')}Цитата не найдена в текущей версии документа.</div>`}<article class="doc-text compact">${b.html}</article>`;
    }
    html = `<div class="panel-grab" aria-hidden="true"></div><div class="panel-head">
        <div class="panel-title"><span class="src-n">${s.n}</span><div><b>${esc(s.docName)}</b><small>${esc(anchor(s))}</small></div></div>
        <div class="panel-tools">
          ${list.length > 1 ? `<a class="icon-btn" href="${nav((i - 1 + list.length) % list.length)}" aria-label="Предыдущий источник">${icon('back')}</a><span class="muted">${i + 1}/${list.length}</span><a class="icon-btn flip" href="${nav((i + 1) % list.length)}" aria-label="Следующий источник">${icon('back')}</a>` : ''}
          <a class="icon-btn close-x" href="${close}" aria-label="Закрыть источник">${icon('x')}</a>
        </div>
      </div>
      <div class="panel-quote"><span class="eyebrow">${near ? 'Похожее место в документе' : 'Цитата из документа'}</span><blockquote>${esc(s.quote)}</blockquote>
        <div class="pq-actions">${d && !d.deletedAt && canSee(d) ? `<button type="button" class="link-btn pq-expand" data-sheet="full">${icon('docs', 'sm')}Показать в документе</button><a class="link-btn" href="#/doc/${d.id}?b=${s.blockIndex}&q=${encodeURIComponent(s.quote)}&from=${c.id}">${icon('open', 'sm')}Открыть документ целиком</a>` : ''}</div></div>
      <div class="panel-body" tabindex="-1">${body}</div>`;
  }
  if (html !== lastPanel) {
    const wasOpen = !!lastPanel;
    panel.innerHTML = html;
    lastPanel = html;
    if (!wasOpen) { setDetent('peek'); panel.classList.remove('opened'); void panel.offsetWidth; panel.classList.add('opened'); }
    requestAnimationFrame(() => {
      measurePeek();
      scrollToHit(panel.querySelector('.panel-body') || panel);
      if (!wasOpen) panel.querySelector('.close-x, .panel-head .icon-btn')?.focus({ preventScroll: true });
    });
  }
}

// Лист источника на телефоне: два положения. «Цитата» — видно только подтверждающий фрагмент, чат под ним;
// «Документ» — весь текст с подсветкой. Тянуть за верх: вверх — документ, вниз — назад к цитате или закрыть.
function measurePeek() {
  const h = (panel.querySelector('.panel-grab')?.offsetHeight || 0) + (panel.querySelector('.panel-head')?.offsetHeight || 0) + (panel.querySelector('.panel-quote')?.offsetHeight || 0);
  panel.style.setProperty('--peek', `${h + 6}px`);
}
const setDetent = (v) => { panel.dataset.detent = v; panel.style.transform = ''; $('#scrim').classList.toggle('dim', v === 'full'); };
panel.addEventListener('click', (e) => { if (e.target.closest('[data-sheet=full]')) { if (mobile()) setDetent('full'); else panel.querySelector('.panel-body .hl, .panel-body .row-hit')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } });
{
  let drag = null;
  panel.addEventListener('pointerdown', (e) => {
    if (!mobile() || !e.target.closest('.panel-grab, .panel-head, .panel-quote') || e.target.closest('a, button')) return;
    const base = panel.getBoundingClientRect().top - (innerHeight - panel.offsetHeight);
    drag = { y: e.clientY, t: e.timeStamp, base, dy: 0 };
    panel.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
  });
  panel.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.dy = e.clientY - drag.y;
    panel.style.transform = `translateY(${Math.max(0, drag.base + drag.dy)}px)`;
  });
  const end = (e) => {
    if (!drag) return;
    const v = drag.dy / Math.max(1, e.timeStamp - drag.t); // px/мс
    const full = panel.dataset.detent === 'full';
    panel.classList.remove('dragging');
    if (drag.dy < -50 || v < -0.5) setDetent('full');
    else if (drag.dy > 70 || v > 0.5) { if (full && drag.dy < 260) setDetent('peek'); else location.hash = `#/c/${cur.route.id}`; }
    else setDetent(panel.dataset.detent);
    drag = null;
  };
  panel.addEventListener('pointerup', end);
  panel.addEventListener('pointercancel', end);
}
panel.addEventListener('animationend', (e) => { if (e.target === panel) panel.classList.remove('opened'); });
$('#scrim').addEventListener('click', () => { if (cur.route.query.get('src')) location.hash = `#/c/${cur.route.id}`; });
addEventListener('resize', () => { if (!panel.hidden) measurePeek(); });

// ---------- История (вкладка телефона; на компьютере — в боковом меню) ----------
function historyView() {
  let root;
  return {
    mount(m) { m.innerHTML = '<section class="list-view" id="histView"></section>'; root = m.querySelector('#histView'); this.update(); },
    update() {
      const list = chatListHtml(cur.route || { view: 'history' }, 'hist-list');
      const html = `<header class="view-head"><h1>История</h1></header>${list || `<div class="empty-card center">${icon('history', 'lg')}<h2>Диалогов пока нет</h2><p>Каждый диалог помнит, где вы искали и что уточняли.</p><a class="btn btn-primary" href="#/">Задать вопрос</a></div>`}`;
      if (root._html !== html) { root.innerHTML = html; root._html = html; }
    },
  };
}

// ---------- Сохранённые ответы ----------
function savedView() {
  let root;
  return {
    mount(m) {
      m.innerHTML = '<section class="saved-view list-view" id="savedView"></section>';
      root = m.querySelector('#savedView');
      root.addEventListener('click', (e) => {
        const t = e.target.closest('[data-unsave]');
        if (t) { const s = state.saved.find((x) => x.id === t.dataset.unsave); toggleSaved(s.chatId, s.msgId); toast('Убрано из сохранённых.'); }
      });
      this.update();
    },
    update() {
      const items = mySaved();
      root.innerHTML = `<header class="view-head"><h1>Сохранённые ответы</h1></header>
      ${items.length ? `<ul class="saved-list">${items.map((s) => {
        const lead = s.answer.blocks.find((b) => b.t === 'p')?.text.replace(/\*\*/g, '').replace(/\s*\[\d+\]/g, '') || '';
        const alive = getChat(s.chatId);
        const missing = s.answer.sources.filter((x) => { const d = getDoc(x.docId); return !d || d.deletedAt; }).length;
        return `<li class="saved-card spot"><p class="saved-q">${icon('chat', 'sm')}${esc(s.question)}</p><p class="saved-a">${esc(lead)}</p>
          <div class="saved-src">${s.answer.sources.map((x) => `<span class="src-pill">${x.n} · ${esc(x.docName)}</span>`).join('')}</div>
          ${missing ? `<p class="banner warn">${icon('alert', 'sm')}${missing} ${missing === 1 ? 'источник недоступен' : 'источника недоступны'}: документ удалён или в корзине.</p>` : ''}
          <div class="row-actions"><span class="muted">${fmtDate(s.savedAt)}</span>${alive ? `<a class="btn btn-sm btn-ghost" href="#/c/${s.chatId}?m=${s.msgId}">${icon('open', 'sm')}Открыть в диалоге</a>` : '<span class="muted">диалог удалён</span>'}<button type="button" class="btn btn-sm btn-ghost" data-unsave="${s.id}">${icon('x', 'sm')}Убрать</button></div></li>`;
      }).join('')}</ul>` : `<div class="empty-card center">${icon('bookmark', 'lg')}<h2>Пока ничего не сохранено</h2><p>Нажмите «Сохранить» под ответом — сроки, нормы и ответственные будут под рукой.</p><a class="btn btn-primary" href="#/">К чату</a></div>`}`;
    },
  };
}

// ---------- О прототипе ----------
async function about() {
  const res = await modal({
    title: 'О прототипе', wide: true,
    body: `<div class="about">
      <p><b>Сверка</b> — прототип ИИ-агента для поиска по документам: вопрос → ответ с цитатами → проверка по источнику → уточнение.</p>
      <h3>Что работает по-настоящему</h3>
      <ul><li>Извлечение текста в браузере: PDF (pdf.js) с номерами страниц, DOCX (разбор архива и XML) с разделами, TXT, MD.</li>
      <li>Ошибки чтения: скан без текста, пустой файл, неподдерживаемый формат, файл больше 15 МБ.</li>
      <li>Поиск BM25 со стеммингом по фрагментам документов выбранной области; признак «нет в документах».</li>
      <li>Ответ пишет модель GigaChat (через серверную функцию на Vercel, ключ только на сервере) — по найденным фрагментам. Каждая ссылка [n] сверяется с текстом документа: цитата должна найтись дословно, иначе ответ модели не показывается.</li>
      <li>Уточняющие вопросы с учётом предыдущего вопроса диалога; вопрос по выделенному фрагменту документа.</li>
      <li>Роли «Сотрудник» и «Подрядчик»: доступ задаётся на папку (коллекцию), фильтр стоит до поиска. Авторизации нет — роль переключается вручную.</li>
      <li>Хранение документов, диалогов и сохранённых ответов в localStorage.</li></ul>
      <h3>Что моделируется</h3>
      <ul><li>Запасной режим без модели (лимит, сбой сети, ответ не прошёл сверку — в ответе пометка «Без ИИ»): на демо-вопросы — заранее подготовленные ответы, каждая цитата которых проверяется по тексту документов; на остальные — дословные найденные цитаты.</li>
      <li>Паузы обработки и «шаги» ответа замедлены, чтобы состояния были различимы.</li></ul>
      <h3>Клавиатура</h3>
      <ul><li><kbd>Enter</kbd> — отправить, <kbd>Shift</kbd>+<kbd>Enter</kbd> — новая строка, <kbd>/</kbd> — к полю вопроса, <kbd>Esc</kbd> — закрыть источник или окно.</li></ul>
      <h3>Проверка состояний</h3>
      <label class="opt"><input type="checkbox" name="fail" ${state.settings.failNext ? 'checked' : ''}><span><b>Смоделировать ошибку следующего ответа</b><small>Чтобы проверить сообщение об ошибке и кнопку «Повторить»</small></span></label>
      <p class="muted">Все организации, лица и цифры в демо-документах вымышлены.</p>
    </div>`,
    actions: [{ label: 'Сбросить все данные', cls: 'btn-danger-ghost', value: 'reset' }, { label: 'Готово', cls: 'btn-primary', submit: true, collect: (d) => ({ fail: d.querySelector('[name=fail]').checked }) }],
  });
  if (res === 'reset') {
    if (await confirmDialog({ title: 'Сбросить все данные?', text: 'Документы, диалоги и сохранённые ответы будут удалены из этого браузера. Приложение вернётся к состоянию первого запуска.', ok: 'Сбросить' })) {
      reset(); location.hash = '#/'; cur.key = ''; route(); toast('Данные сброшены.');
    }
  } else if (res) {
    state.settings.failNext = res.fail; commit();
    if (res.fail) toast('Следующий ответ завершится ошибкой.');
  }
}

// ---------- Вопрос по выделенному фрагменту ----------
// Выделили текст в документе или источнике — рядом кнопка «Спросить об этом»: фрагмент уходит в поле вопроса,
// его можно дописать. В источнике — уточнение в том же диалоге, на странице документа — новый вопрос по этому документу.
const selBtn = $('#selAsk');
let selText = '', selTimer = 0;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const sel = getSelection();
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    const inDoc = sel.rangeCount && sel.anchorNode?.parentElement?.closest('.doc-text');
    if (!inDoc || sel.isCollapsed || text.length < 6) { selBtn.hidden = true; return; }
    selText = text.length > 300 ? text.slice(0, 300) + '…' : text;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    selBtn.hidden = false;
    const w = selBtn.offsetWidth;
    selBtn.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
    selBtn.style.top = `${Math.min(innerHeight - 56, r.bottom + 10)}px`;
  }, 180);
});
selBtn.addEventListener('pointerdown', (e) => e.preventDefault()); // не сбрасывать выделение
selBtn.addEventListener('click', () => {
  const q = `Поясни фрагмент: «${selText}»`;
  selBtn.hidden = true;
  getSelection().removeAllRanges();
  const r = cur.route;
  if (r.view === 'chat' && r.id) {
    state.drafts[r.id] = q;
    location.hash = `#/c/${r.id}`;
    const ta = $('#q');
    if (ta) { ta.value = q; ta.dispatchEvent(new Event('input')); setTimeout(() => ta.focus(), 300); }
  } else if (r.view === 'doc') {
    state.newScope = { type: 'docs', ids: [r.id] };
    state.drafts.new = q;
    commit();
    location.hash = '#/';
    setTimeout(() => $('#q')?.focus(), 350);
  }
});

// ---------- Перетаскивание файлов в любое место ----------
const drop = $('#drop');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || isContractor()) return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    const col = cur.view.dropTarget?.();
    drop.querySelector('[data-target]').textContent = col ? `в папку «${state.collections.find((c) => c.id === col)?.name}»` : 'в документы (без папки)';
    drop.hidden = false;
  }
});
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; drop.hidden = true;
  if (isContractor()) return toast('Подрядчик не может загружать файлы.', { kind: 'warn' });
  const list = [...e.dataTransfer.files];
  if (!list.length) return;
  const added = addFiles(list, cur.view.dropTarget?.() || null);
  toast(`Добавлено: ${nDocs(added.length)}. Идёт обработка.`, cur.route.view === 'docs' ? {} : { action: 'К документам', onAction: () => { location.hash = '#/docs'; } });
});

// ---------- Клавиатура ----------
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
    if (cur.route.query.get('src')) { location.hash = `#/c/${cur.route.id}`; return; }
  }
  if (e.key === '/' && !e.target.closest('input,textarea,[contenteditable]') && !document.querySelector('dialog[open]')) {
    const q = $('#q');
    if (q) { e.preventDefault(); q.focus(); }
  }
});

// ---------- Заставка ----------
// Слои логотипа анимирует CSS. Здесь — финал: название и подпись уходят, знак перелетает на место логотипа
// в шапке (или в боковом меню), а тёмный фон сжимается кругом и улетает вместе со знаком.
// Фон не растворяем: полупрозрачный тёмный поверх светлого приложения даёт «грязно-серые» кадры. Здесь каждый пиксель —
// либо заставка, либо уже приложение, яркость меняется по краю круга, а не всего экрана сразу.
function splashOut() {
  const splash = $('#splash');
  if (!splash || !window.__splash) return;
  window.__splash.then((t0) => setTimeout(() => {
    const icon = splash.querySelector('.sp-icon');
    const target = [...document.querySelectorAll('.logo-mark')].find((el) => el.getClientRects().length && el.getBoundingClientRect().width);
    splash.style.animation = 'none';
    const ease = 'cubic-bezier(.65, 0, .35, 1)', duration = 780;
    for (const el of splash.querySelectorAll('.sp-title, .sp-sub, .sp-sheen')) el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(8px)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
    // Квадрат знака без свечения — 75,6 % слоя, центр совпадает с центром слоя.
    const a = icon.getBoundingClientRect(), b = target?.getBoundingClientRect();
    const [x0, y0] = [a.left + a.width / 2, a.top + a.height / 2];
    const [dx, dy] = b ? [b.left + b.width / 2 - x0, b.top + b.height / 2 - y0] : [0, 0];
    if (target) target.style.visibility = 'hidden';
    const fly = icon.animate([{ transform: 'none' }, b ? { transform: `translate(${dx}px, ${dy}px) scale(${b.width / (a.width * 0.756)})` } : { transform: 'scale(.6)', opacity: 0 }], { duration, easing: ease, fill: 'forwards' });
    // Центр круга едет по той же кривой, что и знак, поэтому круг всё время «под» знаком; в конце он меньше знака и скрыт им.
    const R = Math.hypot(Math.max(x0, innerWidth - x0), Math.max(y0, innerHeight - y0));
    const circle = (p, r) => `circle(${r}px at ${x0 + dx * p}px ${y0 + dy * p}px)`;
    splash.querySelector('.splash-bg').animate([{ clipPath: circle(0, R) }, { clipPath: circle(0.45, R * 0.3), offset: 0.45 }, { clipPath: circle(1, b ? b.width * 0.4 : 0) }], { duration, easing: ease, fill: 'forwards' });
    // Приложение чуть «поднимается» навстречу. Эффект потом снимаем: transform на .app создал бы контекст наложения
    // и лист источника ушёл бы под затемнение.
    $('.app').animate([{ transform: 'scale(.985)' }, { transform: 'none' }], { duration, easing: 'cubic-bezier(.22, .8, .24, 1)' });
    fly.finished.then(() => { if (target) target.style.visibility = ''; splash.remove(); });
  }, Math.max(0, t0 + 1450 - performance.now())));
}

addEventListener('hashchange', route);
addEventListener('pagehide', flush);
subscribe(() => { cur.view?.update(cur.route); renderShell(); renderPanel(); });
initFx();
route();
splashOut();
