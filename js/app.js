// Точка входа: маршрутизация (hash — работает на GitHub Pages без 404), каркас, боковая панель
// источника, сохранённые ответы, «О прототипе», глобальная загрузка перетаскиванием.

import { state, subscribe, emit, commit, chat as getChat, doc as getDoc, liveDocs, addFiles, deleteChat, reset, toggleSaved, storageError, flush } from './store.js';
import { chatView } from './chat.js';
import { docsView, docPage } from './docs.js';
import { docBody, scrollToHit } from './viewer.js';
import { esc, icon, anchor, fmtDate, toast, modal, confirmDialog, nDocs } from './ui.js';
import { ACCEPT } from './ingest.js';

const $ = (s) => document.querySelector(s);
const main = $('#main');
const panel = $('#panel');

// ---------- Выбор файлов ----------
const picker = $('#filePick');
picker.accept = ACCEPT;
let pickCb = null;
function pickFiles(colId, onFile = null, multiple = true) {
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
  return { view: 'notfound', query };
}

const views = {
  chat: () => chatView({ pickFiles }),
  docs: () => docsView({ pickFiles }),
  doc: () => docPage(),
  saved: () => savedView(),
  notfound: () => ({ mount(m) { m.innerHTML = `<div class="empty-card center page-pad"><h1>Страница не найдена</h1><p>Проверьте ссылку или вернитесь на главный экран.</p><a class="btn btn-primary" href="#/">К чату</a></div>`; }, update() {} }),
};

let cur = { key: '', view: null, route: null };
function route() {
  const r = parse();
  const key = `${r.view}:${r.id || r.col || ''}`;
  if (key !== cur.key) {
    cur = { key, view: views[r.view](), route: r };
    cur.view.mount(main, r);
    main.scrollTop = 0;
    closeDrawer();
    if (document.activeElement === document.body || document.activeElement?.closest('.sidebar')) main.focus({ preventScroll: true });
  } else {
    cur.route = r;
    cur.view.update(r);
  }
  document.title = titleFor(r);
  renderSidebar();
  renderPanel();
}
function titleFor(r) {
  const base = 'Сверка — поиск по документам';
  if (r.view === 'chat' && r.id) return `${getChat(r.id)?.title || 'Диалог'} · Сверка`;
  if (r.view === 'docs') return `Документы · Сверка`;
  if (r.view === 'doc') return `${getDoc(r.id)?.name || 'Документ'} · Сверка`;
  if (r.view === 'saved') return 'Сохранённые ответы · Сверка';
  return base;
}

// ---------- Боковое меню ----------
function renderSidebar() {
  const r = cur.route;
  const errs = liveDocs().filter((d) => d.status === 'error').length;
  const proc = liveDocs().filter((d) => d.status === 'queued' || d.status === 'processing').length;
  const chats = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const today = new Date().toDateString();
  const groups = [['Сегодня', chats.filter((c) => new Date(c.updatedAt).toDateString() === today)], ['Ранее', chats.filter((c) => new Date(c.updatedAt).toDateString() !== today)]].filter(([, l]) => l.length);
  const html = `
    <div class="brand"><a href="#/" class="brand-link" aria-label="Сверка — на главный экран"><span class="logo-mark" aria-hidden="true"></span><span class="brand-name">Сверка</span></a><span class="brand-tag">прототип</span></div>
    <a href="#/" class="btn btn-primary new-chat">${icon('plus', 'sm')}Новый диалог</a>
    <nav class="nav" aria-label="Разделы">
      <a href="#/docs" class="${r.view === 'docs' || r.view === 'doc' ? 'active' : ''}" ${r.view === 'docs' ? 'aria-current="page"' : ''}>${icon('docs')}<span>Документы</span>
        ${errs ? `<span class="badge warn" title="Требуют внимания">${errs}</span>` : proc ? `<span class="badge info"><span class="spin" aria-hidden="true"></span>${proc}</span>` : `<span class="count">${liveDocs().length}</span>`}</a>
      <a href="#/saved" class="${r.view === 'saved' ? 'active' : ''}" ${r.view === 'saved' ? 'aria-current="page"' : ''}>${icon('bookmark')}<span>Сохранённые</span><span class="count">${state.saved.length}</span></a>
    </nav>
    ${errs ? `<a class="side-alert" href="#/docs?status=error">${icon('alert', 'sm')}${errs} ${errs === 1 ? 'файл требует' : 'файла требуют'} внимания</a>` : ''}
    <div class="history" aria-label="История диалогов">
      ${groups.length ? groups.map(([g, l]) => `<h2 class="side-h">${g}</h2><ul>${l.map((c) => `<li class="${r.view === 'chat' && r.id === c.id ? 'active' : ''}"><a href="#/c/${c.id}" ${r.view === 'chat' && r.id === c.id ? 'aria-current="page"' : ''}><span class="h-title">${esc(c.title)}</span><span class="h-meta">${c.messages.filter((m) => m.role === 'user').length} вопр. · ${fmtDate(c.updatedAt)}</span></a><button type="button" class="icon-btn btn-sm h-del" data-del-chat="${c.id}" aria-label="Удалить диалог «${esc(c.title)}»">${icon('trash', 'sm')}</button></li>`).join('')}</ul>`).join('')
        : '<p class="side-empty">Здесь появятся ваши диалоги. Каждый сохраняет свою область поиска и контекст.</p>'}
    </div>
    <div class="side-foot">
      <button type="button" class="link-btn" data-act="about">${icon('info', 'sm')}О прототипе</button>
      <span class="muted">Данные хранятся в этом браузере</span>
    </div>`;
  const sb = $('#sidebar');
  if (sb._html !== html) { sb.innerHTML = html; sb._html = html; }
  $('#storageErr').hidden = !storageError;
  $('#storageErr').textContent = storageError || '';
}

$('#sidebar').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-chat]');
  if (del) {
    const c = getChat(del.dataset.delChat);
    if (await confirmDialog({ title: 'Удалить диалог?', text: `«${c.title}» и его сохранённые ответы будут удалены.`, ok: 'Удалить' })) {
      state.saved = state.saved.filter((s) => s.chatId !== c.id);
      deleteChat(c.id);
      if (cur.route.view === 'chat' && cur.route.id === c.id) location.hash = '#/';
      toast('Диалог удалён.');
    }
  }
  if (e.target.closest('[data-act=about]')) about();
});

// Мобильное меню
const openDrawer = () => { document.body.classList.add('drawer-open'); $('#scrim').hidden = false; $('#sidebar').querySelector('a,button')?.focus(); };
function closeDrawer() { document.body.classList.remove('drawer-open'); $('#scrim').hidden = true; }
$('#menuBtn').addEventListener('click', openDrawer);
$('#scrim').addEventListener('click', closeDrawer);

// ---------- Панель источника ----------
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

let lastPanel = '';
function renderPanel() {
  const src = cur.route.query.get('src');
  const found = sourceFor(src);
  document.body.classList.toggle('panel-open', !!src);
  panel.hidden = !src;
  if (!src) { lastPanel = ''; panel.innerHTML = ''; return; }
  const close = `#/c/${cur.route.id}`;
  let html;
  if (!found) {
    html = `<div class="panel-head"><a class="icon-btn" href="${close}" aria-label="Закрыть источник">${icon('x')}</a></div><div class="panel-body"><div class="empty-card">Источник не найден.</div></div>`;
  } else {
    const { c, m, s, list, near } = found;
    const d = getDoc(s.docId);
    const i = list.indexOf(s);
    const nav = (j) => `#/c/${c.id}?src=${m.id}:${near ? 'near-' : ''}${list[j].n}`;
    let body;
    if (!d) body = '<div class="empty-card">Документ удалён навсегда — источник больше недоступен.</div>';
    else if (d.deletedAt) body = `<div class="empty-card">Документ находится в корзине.<a class="btn btn-ghost btn-sm" href="#/docs/trash">Открыть корзину</a></div>`;
    else {
      const b = docBody(d, { blockIndex: s.blockIndex, quote: s.quote });
      body = `${b.found ? '' : `<div class="banner warn">${icon('alert', 'sm')}Цитата не найдена в текущей версии документа.</div>`}<article class="doc-text compact">${b.html}</article>`;
    }
    html = `<div class="panel-head">
        <a class="back-btn" href="${close}">${icon('back', 'sm')}<span>К ответу</span></a>
        <div class="panel-title"><span class="src-n">${s.n}</span><div><b>${esc(s.docName)}</b><small>${esc(anchor(s))}</small></div></div>
        <div class="panel-tools">
          ${list.length > 1 ? `<a class="icon-btn" href="${nav((i - 1 + list.length) % list.length)}" aria-label="Предыдущий источник">${icon('back')}</a><span class="muted">${i + 1}/${list.length}</span><a class="icon-btn flip" href="${nav((i + 1) % list.length)}" aria-label="Следующий источник">${icon('back')}</a>` : ''}
          <a class="icon-btn close-x" href="${close}" aria-label="Закрыть источник">${icon('x')}</a>
        </div>
      </div>
      <div class="panel-quote"><span class="eyebrow">${near ? 'Ближайший фрагмент' : 'Подтверждающий фрагмент'}</span><blockquote>${esc(s.quote)}</blockquote>
        ${d && !d.deletedAt ? `<a class="link-btn" href="#/doc/${d.id}?b=${s.blockIndex}&q=${encodeURIComponent(s.quote)}&from=${c.id}">${icon('open', 'sm')}Открыть документ целиком</a>` : ''}</div>
      <div class="panel-body" tabindex="-1">${body}</div>`;
  }
  if (html !== lastPanel) {
    const wasOpen = !!lastPanel;
    panel.innerHTML = html;
    lastPanel = html;
    requestAnimationFrame(() => { scrollToHit(panel.querySelector('.panel-body') || panel); if (!wasOpen) panel.querySelector('.back-btn, .close-x')?.focus({ preventScroll: true }); });
  }
}

// ---------- Сохранённые ответы ----------
function savedView() {
  let root;
  return {
    mount(m) {
      m.innerHTML = '<section class="saved-view" id="savedView"></section>';
      root = m.querySelector('#savedView');
      root.addEventListener('click', (e) => {
        const t = e.target.closest('[data-unsave]');
        if (t) { const s = state.saved.find((x) => x.id === t.dataset.unsave); toggleSaved(s.chatId, s.msgId); toast('Убрано из сохранённых.'); }
      });
      this.update();
    },
    update() {
      const items = state.saved;
      root.innerHTML = `<header class="view-head"><div><p class="eyebrow">Сохранённые</p><h1>Сохранённые ответы</h1><p class="sub">Ответы, к которым нужно возвращаться: сроки, нормы, ответственные. Источники остаются кликабельными, пока документ не удалён.</p></div></header>
      ${items.length ? `<ul class="saved-list">${items.map((s) => {
        const lead = s.answer.blocks.find((b) => b.t === 'p')?.text.replace(/\*\*/g, '').replace(/\s*\[\d+\]/g, '') || '';
        const alive = getChat(s.chatId);
        const missing = s.answer.sources.filter((x) => { const d = getDoc(x.docId); return !d || d.deletedAt; }).length;
        return `<li class="saved-card"><p class="saved-q">${icon('chat', 'sm')}${esc(s.question)}</p><p class="saved-a">${esc(lead)}</p>
          <div class="saved-src">${s.answer.sources.map((x) => `<span class="src-pill">${x.n} · ${esc(x.docName)}</span>`).join('')}</div>
          ${missing ? `<p class="banner warn">${icon('alert', 'sm')}${missing} ${missing === 1 ? 'источник недоступен' : 'источника недоступны'}: документ удалён или в корзине.</p>` : ''}
          <div class="row-actions"><span class="muted">${fmtDate(s.savedAt)}</span>${alive ? `<a class="btn btn-sm btn-ghost" href="#/c/${s.chatId}?m=${s.msgId}">${icon('open', 'sm')}Открыть в диалоге</a>` : '<span class="muted">диалог удалён</span>'}<button type="button" class="btn btn-sm btn-ghost" data-unsave="${s.id}">${icon('x', 'sm')}Убрать</button></div></li>`;
      }).join('')}</ul>` : `<div class="empty-card center">${icon('bookmark', 'lg')}<h2>Пока ничего не сохранено</h2><p>Нажмите «Сохранить» под ответом агента, чтобы быстро вернуться к нему позже.</p><a class="btn btn-primary" href="#/">К чату</a></div>`}`;
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
      <li>Уточняющие вопросы с учётом предыдущего вопроса диалога.</li>
      <li>Хранение документов, диалогов и сохранённых ответов в localStorage.</li></ul>
      <h3>Что моделируется</h3>
      <ul><li>Запасной режим без модели (лимит, сбой сети, ответ не прошёл сверку — в ответе пометка «Без модели»): на демо-вопросы — заранее подготовленные ответы, каждая цитата которых проверяется по тексту документов; на остальные — дословные найденные цитаты.</li>
      <li>Паузы обработки и «шаги» ответа замедлены, чтобы состояния были различимы.</li>
      <li>Разграничение доступа не реализовано (модель описана в README).</li></ul>
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

// ---------- Перетаскивание файлов в любое место ----------
const drop = $('#drop');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    const col = cur.view.dropTarget?.();
    drop.querySelector('[data-target]').textContent = col ? `в коллекцию «${state.collections.find((c) => c.id === col)?.name}»` : 'в документы (без коллекции)';
    drop.hidden = false;
  }
});
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; drop.hidden = true; } });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; drop.hidden = true;
  const list = [...e.dataTransfer.files];
  if (!list.length) return;
  const added = addFiles(list, cur.view.dropTarget?.() || null);
  toast(`Добавлено: ${nDocs(added.length)}. Идёт обработка.`, cur.route.view === 'docs' ? {} : { action: 'К документам', onAction: () => { location.hash = '#/docs'; } });
});

// ---------- Клавиатура ----------
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
    if (document.body.classList.contains('drawer-open')) return closeDrawer();
    if (cur.route.query.get('src')) { location.hash = `#/c/${cur.route.id}`; return; }
  }
  if (e.key === '/' && !e.target.closest('input,textarea,[contenteditable]') && !document.querySelector('dialog[open]')) {
    const q = $('#q');
    if (q) { e.preventDefault(); q.focus(); }
  }
});

addEventListener('hashchange', route);
addEventListener('pagehide', flush);
subscribe(() => { cur.view?.update(cur.route); renderSidebar(); renderPanel(); });
route();
