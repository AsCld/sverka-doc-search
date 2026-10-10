// Раздел «Документы»: коллекции, список, поиск, фильтры, выбор, загрузка, корзина.
// Также страница одного документа.

import { state, liveDocs, doc as getDoc, collection, retryDocs, canRetry, moveDocs, trashDocs, restoreDocs, purgeDocs, createCollection, renameCollection, deleteCollection, loadDemo, replaceFile, commit, visibleCollections, isContractor, canSee, setExternal } from './store.js';
import { esc, icon, fmtSize, fmtDate, statusBadge, TYPE, toast, modal, confirmDialog, promptDialog, nDocs, plural, reveal } from './ui.js';
import { docBody, scrollToHit } from './viewer.js';
import { ACCEPT } from './ingest.js';
import { lattice, fuseButton, ring } from './fx.js';
import { crumple, prewarm } from './crumple.js';

const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'ready', label: 'Готовы', test: (d) => d.status === 'ready' },
  { id: 'processing', label: 'В обработке', test: (d) => d.status === 'queued' || d.status === 'processing' },
  { id: 'error', label: 'Ошибки', test: (d) => d.status === 'error' },
];

// Скан в демо-наборе положен нарочно — показать состояние «Ошибка чтения». Объясняем это прямо в списке.
const demoNote = (d) => (d.demoKey === 'scan' && d.status === 'error'
  ? `<div class="doc-hint">${icon('info', 'xs')}Файл в демо-наборе нарочно: так выглядит ошибка чтения. Остальные документы ищутся как обычно.</div>` : '');

// Имена файлов длинные и с подчёркиваниями: разрешаем перенос после «_», а не посреди слова.
const wbr = (name) => esc(name).replace(/_/g, '_<wbr>');
const colName = (id) => (id ? collection(id)?.name || 'Без коллекции' : 'Без коллекции');

function docMeta(d) {
  const parts = [];
  if (d.status === 'ready') {
    if (d.pages) parts.push(`${d.pages} стр.`);
    else if (d.sections) parts.push(`${d.sections} ${plural(d.sections, 'раздел', 'раздела', 'разделов')}`);
    parts.push(`${d.chunks} ${plural(d.chunks, 'фрагмент', 'фрагмента', 'фрагментов')}`);
  }
  if (d.size) parts.push(fmtSize(d.size));
  parts.push(`добавлен ${fmtDate(d.addedAt, false)}`);
  return parts.join(' · ');
}

// Перемещение: выбор коллекции или создание новой прямо в диалоге.
export async function moveDialog(ids) {
  const docs = ids.map(getDoc).filter(Boolean);
  const current = docs.length === 1 ? docs[0].collectionId : undefined;
  const opts = [...state.collections.map((c) => ({ id: c.id, name: c.name })), { id: '', name: 'Без коллекции' }];
  const res = await modal({
    title: docs.length === 1 ? 'Переместить документ' : `Переместить ${nDocs(docs.length)}`,
    body: `${docs.length === 1 ? `<p class="muted">${esc(docs[0].name)}</p>` : ''}
      <fieldset class="scope-opts"><legend class="sr-only">Коллекция</legend>
      ${opts.map((o) => `<label class="opt"><input type="radio" name="c" value="${o.id}" ${(current ?? '') === o.id && current !== undefined ? 'checked' : ''}><span><b>${o.id ? icon('folder', 'sm') : ''}${esc(o.name)}</b>${(current ?? '') === o.id && current !== undefined ? '<small>текущая</small>' : ''}</span></label>`).join('')}
      <label class="opt"><input type="radio" name="c" value="__new"><span><b>${icon('plus', 'sm')}Новая коллекция</b></span></label>
      </fieldset>
      <label class="field" data-new hidden><span>Название новой коллекции</span><input class="input" name="n" maxlength="60" autocomplete="off"></label>
      <p class="field-err" hidden></p>`,
    actions: [{ label: 'Отмена', value: null }, { label: 'Переместить', cls: 'btn-primary', submit: true, collect: (dlg) => {
      const err = dlg.querySelector('.field-err');
      const v = dlg.querySelector('input[name=c]:checked')?.value;
      if (v === undefined) { err.textContent = 'Выберите коллекцию'; err.hidden = false; return undefined; }
      if (v === '__new') {
        const n = dlg.querySelector('[name=n]').value.trim();
        if (!n) { err.textContent = 'Введите название коллекции'; err.hidden = false; return undefined; }
        return { newName: n };
      }
      return { id: v || null };
    } }],
    onMount: (dlg) => dlg.querySelectorAll('input[name=c]').forEach((r) => r.addEventListener('change', () => {
      const nw = dlg.querySelector('[data-new]'); nw.hidden = r.value !== '__new' || !r.checked;
      if (!nw.hidden) nw.querySelector('input').focus();
    })),
  });
  if (!res) return false;
  const id = res.newName ? createCollection(res.newName).id : res.id;
  moveDocs(ids, id);
  toast(`${docs.length === 1 ? 'Документ перемещён' : `Перемещено: ${nDocs(docs.length)}`} в «${colName(id)}».`);
  return true;
}

export function trashWithUndo(ids) {
  trashDocs(ids);
  toast(ids.length === 1 ? 'Документ перемещён в корзину и исключён из поиска.' : `${nDocs(ids.length)} в корзине и исключены из поиска.`, { action: 'Отменить', undo: true, onAction: () => restoreDocs(ids) });
}

function askAbout(ids) {
  state.newScope = { type: 'docs', ids };
  commit();
  location.hash = '#/';
}

// Документ в корзину: лист с его названием комкается и летит к ссылке «Корзина» (PaperCrumple).
function toBin(ids) {
  ids.slice(0, 3).forEach((id, i) => {
    const row = document.querySelector(`.doc-row[data-k="${CSS.escape(id)}"] .ftype`);
    const d = getDoc(id);
    if (row && d) crumple(row.getBoundingClientRect(), { name: d.name, ext: d.ext, delay: i * 120, target: () => document.querySelector('.trash-link a') });
  });
}

// Сводка над списком: числа «добегают» до значения (CountUp) — видно, как растёт готовность к поиску.
function statsHtml() {
  const live = liveDocs();
  if (!live.length) return '';
  const ready = live.filter((d) => d.status === 'ready');
  const chunks = ready.reduce((n, d) => n + (d.chunks || 0), 0);
  const err = live.filter((d) => d.status === 'error').length;
  const stat = (key, label, n) => `<span class="stat"><b data-cu="stat:${key}" data-to="${n}">${n}</b><span>${label}</span></span>`;
  return ring({ key: 'docs', ready: ready.length, error: err, total: live.length, size: 46, width: 5 })
    + `<span class="stat main"><b><span data-cu="stat:ready" data-to="${ready.length}">${ready.length}</span> из ${live.length}</b><span>готовы к поиску</span></span>`
    + stat('chunks', plural(chunks, 'фрагмент', 'фрагмента', 'фрагментов'), chunks) + stat('cols', plural(visibleCollections().length, 'коллекция', 'коллекции', 'коллекций'), visibleCollections().length);
}

export function docsView({ pickFiles }) {
  let root, route, q = '', filter = 'all', ri = 0;
  const selected = new Set();
  const seen = new Set(); // строки и статусы, которые уже показаны (см. reveal)

  const isTrash = () => route.col === 'trash' && !isContractor();
  const current = () => {
    let list = isTrash() ? state.docs.filter((d) => d.deletedAt) : liveDocs();
    if (!isTrash() && route.col && route.col !== 'all') list = list.filter((d) => (route.col === 'none' ? !d.collectionId : d.collectionId === route.col));
    return list;
  };
  const visible = () => {
    const f = FILTERS.find((x) => x.id === filter);
    return current().filter((d) => (!q || d.name.toLowerCase().includes(q.toLowerCase())) && (!f.test || f.test(d)));
  };

  function colsHtml() {
    const live = liveDocs();
    const item = (href, name, n, active, extra = '', ic = 'folder') => `<li class="${active ? 'active' : ''}"><a href="${href}" ${active ? 'aria-current="page"' : ''}>${icon(ic, 'sm')}<span class="col-name">${esc(name)}</span><span class="count">${n}</span></a>${extra}</li>`;
    const noCol = live.filter((d) => !d.collectionId).length;
    return `<ul class="col-list">
      ${item('#/docs', 'Все документы', live.length, !route.col || route.col === 'all', '', 'docs')}
      ${visibleCollections().map((c) => item(`#/docs/${c.id}`, c.name, live.filter((d) => d.collectionId === c.id).length, route.col === c.id,
        `${c.external && !isContractor() ? `<span class="col-ext" title="Открыта подрядчикам">${icon('eye', 'xs')}</span>` : ''}<span class="col-tools staff-only"><button type="button" class="icon-btn btn-sm" data-act="rename-col" data-id="${c.id}" aria-label="Переименовать коллекцию ${esc(c.name)}">${icon('edit', 'sm')}</button><button type="button" class="icon-btn btn-sm" data-act="del-col" data-id="${c.id}" aria-label="Удалить коллекцию ${esc(c.name)}">${icon('trash', 'sm')}</button></span>`)).join('')}
      ${noCol ? item('#/docs/none', 'Без коллекции', noCol, route.col === 'none') : ''}
    </ul>
    <button type="button" class="btn btn-ghost btn-sm add-col staff-only" data-act="new-col">${icon('plus', 'sm')}Новая коллекция</button>
    <ul class="col-list trash-link staff-only">${item('#/docs/trash', 'Корзина', state.docs.filter((d) => d.deletedAt).length, isTrash(), '', 'trash')}</ul>`;
  }

  function rowHtml(d, showCol) {
    const sel = selected.has(d.id);
    const actions = isTrash()
      ? `<button type="button" class="btn btn-sm btn-ghost" data-act="restore" data-id="${d.id}">${icon('restore', 'sm')}Восстановить</button>
         <button type="button" class="icon-btn" data-act="purge" data-id="${d.id}" aria-label="Удалить навсегда ${esc(d.name)}" title="Удалить навсегда">${icon('trash')}</button>`
      : `${d.status === 'ready' ? `<button type="button" class="btn btn-sm btn-ghost hide-sm" data-act="ask" data-id="${d.id}">${icon('chat', 'sm')}Спросить</button>` : ''}
         ${d.status === 'error' ? (canRetry(d) ? `<button type="button" class="btn btn-sm btn-ghost" data-act="retry" data-id="${d.id}">${icon('refresh', 'sm')}Повторить</button>` : `<button type="button" class="btn btn-sm btn-ghost" data-act="replace" data-id="${d.id}">${icon('upload', 'sm')}Загрузить снова</button>`) : ''}
         <button type="button" class="icon-btn staff-only" data-act="move" data-id="${d.id}" aria-label="Переместить ${esc(d.name)}" title="Переместить в коллекцию">${icon('move')}</button>
         <button type="button" class="icon-btn staff-only" data-act="trash" data-id="${d.id}" aria-label="Удалить ${esc(d.name)}" title="В корзину">${icon('trash')}</button>`;
    return `<li class="doc-row ${sel ? 'sel' : ''} ${d.status === 'error' ? 'err' : ''} ${d.status === 'processing' ? 'proc' : ''}" data-k="${d.id}" style="--i:${Math.min(ri++, 12)}">
      <label class="cb"><input type="checkbox" data-sel="${d.id}" ${sel ? 'checked' : ''} aria-label="Выбрать ${esc(d.name)}"></label>
      <span class="ftype ft-${d.ext}" aria-hidden="true">${TYPE[d.ext] || (d.ext || '?').toUpperCase().slice(0, 4)}</span>
      <div class="doc-main">
        ${isTrash() ? `<span class="doc-name">${wbr(d.name)}</span>` : `<a class="doc-name" href="#/doc/${d.id}">${wbr(d.name)}</a>`}
        <div class="doc-meta">${showCol ? `${icon('folder', 'xs')}${esc(colName(d.collectionId))} · ` : ''}${isTrash() ? `удалён ${fmtDate(d.deletedAt)}` : d.status === 'queued' || d.status === 'processing' ? '<span class="sk-bar" aria-hidden="true"></span><span class="sk-bar short" aria-hidden="true"></span>' : docMeta(d)}</div>
        ${d.status === 'error' ? `<div class="doc-err">${esc(d.error)}</div>${demoNote(d)}` : ''}
      </div>
      <div class="doc-status" data-k="${d.id}:${d.status}">${statusBadge(d)}</div>
      <div class="doc-actions">${actions}</div>
    </li>`;
  }

  function listHtml() {
    ri = 0;
    const all = current();
    const list = visible();
    if (!all.length) {
      if (isTrash()) return `<div class="empty-card center">${icon('trash', 'lg')}<h2>Корзина пуста</h2><p>Удалённые документы попадают сюда и не участвуют в поиске. Их можно восстановить.</p></div>`;
      if (!liveDocs().length && isContractor()) return `<div class="empty-card center">${icon('lock', 'lg')}<h2>Документы ещё не открыты</h2><p>Подрядчик видит только коллекции, к которым ему дали доступ.</p></div>`;
      if (!liveDocs().length) return `<div class="empty-card center dropzone" data-act="pick">
          ${icon('upload', 'lg')}<h2>Добавьте первые документы</h2>
          <p>PDF с текстовым слоем, DOCX, TXT и MD до 15 МБ. Перетащите файлы сюда или выберите.</p>
          <div class="row-actions"><button type="button" class="btn btn-primary" data-act="pick">Выбрать файлы</button><button type="button" class="btn btn-ghost" data-act="demo">Загрузить демо-набор</button></div></div>`;
      return `<div class="empty-card center">${icon('folder', 'lg')}<h2>В коллекции пока пусто</h2><p>Перетащите файлы сюда или переместите документы из других коллекций.</p><button type="button" class="btn btn-primary" data-act="pick">Добавить файлы</button></div>`;
    }
    if (!list.length) {
      return `<div class="empty-card center">${icon('search', 'lg')}<h2>Ничего не найдено</h2><p>${q ? `Нет документов, в названии которых есть «${esc(q)}»` : 'Нет документов с таким статусом'}${filter !== 'all' ? ` и статусом «${FILTERS.find((f) => f.id === filter).label.toLowerCase()}»` : ''}. Поиск здесь — по названию; по содержимому ищет агент в чате.</p><button type="button" class="btn btn-ghost" data-act="clear">Сбросить поиск и фильтр</button></div>`;
    }
    const allSel = list.every((d) => selected.has(d.id));
    const head = `<div class="list-head"><label class="cb"><input type="checkbox" data-act="sel-all" ${allSel ? 'checked' : ''} aria-label="Выбрать все показанные документы"></label><span>${nDocs(list.length)}${list.length !== all.length ? ` из ${all.length}` : ''}</span></div>`;
    if ((!route.col || route.col === 'all') && !isTrash()) {
      const groups = [...visibleCollections().map((c) => [c.id, c.name]), [null, 'Без коллекции']]
        .map(([id, name]) => [name, list.filter((d) => (d.collectionId || null) === id)]).filter(([, l]) => l.length);
      return head + groups.map(([name, l]) => `<section class="group"><h3 class="group-h">${icon('folder', 'sm')}${esc(name)} <span class="count">${l.length}</span></h3><ul class="doc-list">${l.map((d) => rowHtml(d, false)).join('')}</ul></section>`).join('');
    }
    return head + `<ul class="doc-list">${list.map((d) => rowHtml(d, isTrash())).join('')}</ul>`;
  }

  function bulkHtml() {
    const ids = [...selected].filter((id) => visible().some((d) => d.id === id));
    if (!ids.length) return '';
    const readyIds = ids.filter((id) => getDoc(id)?.status === 'ready');
    const errIds = ids.filter((id) => getDoc(id)?.status === 'error' && canRetry(getDoc(id)));
    return `<div class="bulk" role="region" aria-label="Действия с выбранными"><b>Выбрано: ${ids.length}</b>
      ${isTrash() ? `<button type="button" class="btn btn-sm btn-ghost" data-act="bulk-restore">${icon('restore', 'sm')}Восстановить</button><button type="button" class="btn btn-sm btn-danger" data-act="bulk-purge">Удалить навсегда</button>`
        : `${readyIds.length ? `<button type="button" class="btn btn-sm btn-primary" data-act="bulk-ask">${icon('chat', 'sm')}Спросить по выбранным${readyIds.length !== ids.length ? ` (${readyIds.length})` : ''}</button>` : ''}
        ${errIds.length ? `<button type="button" class="btn btn-sm btn-ghost" data-act="bulk-retry">${icon('refresh', 'sm')}Повторить обработку</button>` : ''}
        <button type="button" class="btn btn-sm btn-ghost staff-only" data-act="bulk-move">${icon('move', 'sm')}Переместить</button>
        <button type="button" class="btn btn-sm btn-ghost staff-only" data-act="bulk-trash">${icon('trash', 'sm')}В корзину</button>`}
      <button type="button" class="icon-btn btn-sm" data-act="unselect" aria-label="Снять выбор">${icon('x')}</button></div>`;
  }

  function attentionHtml() {
    if (isTrash()) return `<p class="trash-note">${icon('info', 'sm')}Документы в корзине не участвуют в поиске. Удаление из корзины необратимо.</p>`;
    const errs = current().filter((d) => d.status === 'error');
    const proc = current().filter((d) => d.status === 'queued' || d.status === 'processing');
    let h = '';
    if (proc.length) h += `<div class="banner info" role="status">${lattice({ pattern: 'snake', mini: true })}Обрабатывается ${nDocs(proc.length)}. Они станут доступны для поиска автоматически — можно продолжать работу.</div>`;
    if (errs.length && filter !== 'error') h += `<div class="banner warn">${icon('alert', 'sm')}<span>${errs.length} ${plural(errs.length, 'файл требует', 'файла требуют', 'файлов требуют')} внимания: текст не удалось прочитать.</span><button type="button" class="link-btn" data-act="show-errors">Показать</button></div>`;
    return h;
  }

  function toolbarCounts() {
    root.querySelectorAll('[data-filter]').forEach((b) => {
      const f = FILTERS.find((x) => x.id === b.dataset.filter);
      const n = current().filter((d) => !f.test || f.test(d)).length;
      b.querySelector('.count').textContent = n;
      b.setAttribute('aria-pressed', String(filter === f.id));
    });
  }

  async function onClick(e) {
    const t = e.target.closest('[data-act],[data-filter]');
    if (!t || (t.matches('input[data-act=ext]') && e.type !== 'change')) return;
    if (t.dataset.filter) { filter = t.dataset.filter; return render(); }
    const id = t.dataset.id;
    const ids = [...selected];
    switch (t.dataset.act) {
      case 'pick': return pickFiles(targetCol());
      case 'ext': { const c = collection(id); setExternal(id, t.checked); toast(t.checked ? `«${c.name}» открыта подрядчикам: они видят её документы и ищут по ним.` : `«${c.name}» закрыта для подрядчиков.`); return; }
      case 'demo': { const n = loadDemo(); toast(n ? `Добавлено ${nDocs(n)} демо-набора — идёт обработка.` : 'Демо-набор уже загружен.'); return; }
      case 'clear': q = ''; filter = 'all'; root.querySelector('#docSearch').value = ''; return render();
      case 'show-errors': filter = 'error'; return render();
      case 'sel-all': { const list = visible(); const all = list.every((d) => selected.has(d.id)); list.forEach((d) => (all ? selected.delete(d.id) : selected.add(d.id))); return render(); }
      case 'unselect': selected.clear(); return render();
      case 'ask': return askAbout([id]);
      case 'retry': return retryDocs([id]);
      case 'replace': return pickFiles(null, (f) => replaceFile(id, f), false);
      case 'move': return moveDialog([id]);
      case 'trash': selected.delete(id); toBin([id]); return trashWithUndo([id]);
      case 'restore': restoreDocs([id]); toast('Документ восстановлен.'); return;
      case 'purge': if (await confirmDialog({ title: 'Удалить навсегда?', text: `«${getDoc(id).name}» будет удалён без возможности восстановления. Ссылки на него в ответах станут недоступны.`, ok: 'Удалить навсегда' })) { selected.delete(id); purgeDocs([id]); } return;
      case 'bulk-ask': return askAbout(ids.filter((x) => getDoc(x)?.status === 'ready'));
      case 'bulk-retry': retryDocs(ids); selected.clear(); return;
      case 'bulk-move': if (await moveDialog(ids)) selected.clear(); return render();
      case 'bulk-trash': toBin(ids); trashWithUndo(ids); selected.clear(); return render();
      case 'bulk-restore': restoreDocs(ids); toast(`Восстановлено: ${nDocs(ids.length)}.`); selected.clear(); return render();
      case 'bulk-purge': if (await confirmDialog({ title: 'Удалить навсегда?', text: `${nDocs(ids.length)} будут удалены без возможности восстановления.`, ok: 'Удалить навсегда' })) { purgeDocs(ids); selected.clear(); } return render();
      case 'empty-trash': { const all = state.docs.filter((d) => d.deletedAt).map((d) => d.id); if (all.length && await confirmDialog({ title: 'Очистить корзину?', text: `${nDocs(all.length)} будут удалены навсегда.`, ok: 'Очистить' })) purgeDocs(all); return; }
      case 'new-col': { const n = await promptDialog({ title: 'Новая коллекция', label: 'Название', ok: 'Создать' }); if (n) { const c = createCollection(n); location.hash = `#/docs/${c.id}`; } return; }
      case 'rename-col': { const c = collection(id); const n = await promptDialog({ title: 'Переименовать коллекцию', label: 'Название', value: c.name }); if (n) renameCollection(id, n); return; }
      case 'del-col': {
        const c = collection(id);
        const cnt = liveDocs().filter((d) => d.collectionId === id).length;
        if (await confirmDialog({ title: `Удалить коллекцию «${c.name}»?`, text: cnt ? `Документы (${cnt}) не удалятся — они перейдут в «Без коллекции».` : 'Коллекция пустая.', ok: 'Удалить коллекцию' })) {
          deleteCollection(id);
          state.chats.forEach((ch) => { if (ch.scope.type === 'collection' && ch.scope.id === id) ch.scope = { type: 'all' }; });
          if (state.newScope.type === 'collection' && state.newScope.id === id) state.newScope = { type: 'all' };
          commit();
          if (route.col === id) location.hash = '#/docs';
        }
      }
    }
  }

  function onChange(e) {
    if (e.target.matches('[data-act=ext]')) return onClick(e);
    const cb = e.target.closest('[data-sel]');
    if (cb) { cb.checked ? selected.add(cb.dataset.sel) : selected.delete(cb.dataset.sel); render(); }
  }

  const targetCol = () => (route.col && !['all', 'none', 'trash'].includes(route.col) && collection(route.col) ? route.col : null);

  function render() {
    if (!root) return;
    const c = route.col && !['all', 'none', 'trash'].includes(route.col) ? collection(route.col) : null;
    if (route.col && !['all', 'none', 'trash'].includes(route.col) && !c) {
      root.querySelector('#docList').innerHTML = `<div class="empty-card center"><h2>Коллекция не найдена</h2><p>Возможно, она была удалена.</p><a class="btn btn-primary" href="#/docs">Все документы</a></div>`;
    } else root.querySelector('#docList').innerHTML = listHtml();
    reveal(root.querySelector('#docList'), seen);
    root.querySelector('#docTitle').textContent = isTrash() ? 'Корзина' : c ? c.name : route.col === 'none' ? 'Без коллекции' : 'Все документы';
    const access = c && !isContractor() ? `<label class="switch"><input type="checkbox" role="switch" data-act="ext" data-id="${c.id}" ${c.external ? 'checked' : ''}><span class="sw" aria-hidden="true"></span>Открыта подрядчикам</label>` : '';
    const ax = root.querySelector('#access');
    if (ax._html !== access) { ax.innerHTML = access; ax._html = access; }
    root.querySelector('#cols').innerHTML = colsHtml();
    const st = statsHtml();
    if (root._stats !== st) { root.querySelector('#stats').innerHTML = st; root._stats = st; }
    root.querySelector('#attention').innerHTML = attentionHtml();
    root.querySelector('#bulk').innerHTML = bulkHtml();
    root.querySelector('#headActions').innerHTML = isTrash()
      ? (state.docs.some((d) => d.deletedAt) ? `<button type="button" class="btn btn-ghost" data-act="empty-trash">${icon('trash', 'sm')}Очистить корзину</button>` : '')
      : isContractor() ? '' : `<button type="button" class="btn btn-primary" data-act="pick">${icon('upload', 'sm')}Добавить файлы</button>`;
    root.querySelector('.toolbar').hidden = !current().length;
    toolbarCounts();
  }

  return {
    mount(main, r) {
      route = r; selected.clear(); q = ''; filter = r.query.get('status') || 'all';
      if (!FILTERS.some((f) => f.id === filter)) filter = 'all';
      main.innerHTML = `<section class="docs-view">
        <header class="view-head">
          <div class="vh-main"><h1 id="docTitle"></h1><div id="access"></div><div class="stats" id="stats"></div></div>
          <div class="head-actions" id="headActions"></div>
        </header>
        <div class="docs-layout">
          <nav class="cols" id="cols" aria-label="Коллекции"></nav>
          <div class="docs-main">
            <div class="toolbar">
              <label class="search-box">${icon('search', 'sm')}<span class="sr-only">Поиск по названию</span><input id="docSearch" class="input" type="search" placeholder="Поиск по названию" autocomplete="off"></label>
              <div class="filters" role="group" aria-label="Фильтр по статусу">${FILTERS.map((f) => `<button type="button" class="chip" data-filter="${f.id}" aria-pressed="false">${f.label} <span class="count"></span></button>`).join('')}</div>
            </div>
            <div id="attention"></div>
            <div id="bulk"></div>
            <div id="docList"></div>
          </div>
        </div>
        <button type="button" class="fab staff-only" data-act="pick" aria-label="Добавить файлы">${icon('plus')}</button>
      </section>`;
      root = main.querySelector('.docs-view');
      root.querySelector('#docSearch').addEventListener('input', (e) => { q = e.target.value.trim(); render(); });
      root.addEventListener('click', onClick);
      root.addEventListener('change', onChange);
      render();
      prewarm();
    },
    update(r) { if (r) route = r; render(); },
    dropTarget: () => targetCol(),
  };
}

// ---------- Страница документа ----------
export function docPage() {
  let root, fb = null, holding = false; // кнопка «В корзину» со шнуром отмены переживает перерисовки страницы
  return {
    // FuseButton: нажали — документ сразу в корзине, 5 секунд горит шнур «Вернуть». Догорел — обычное состояние корзины.
    fuse(d) {
      fb ||= fuseButton({ label: 'В корзину', undoLabel: 'Вернуть', doneLabel: 'В корзине', icon: icon('trash', 'sm'), undoIcon: icon('undo', 'sm'), doneIcon: icon('check', 'sm'),
        undoWindow: 5000, className: 'fb-ghost',
        onCommit: () => { holding = true; trashDocs([d.id]); },
        onUndo: () => { holding = false; restoreDocs([d.id]); },
        onFuseEnd: () => { holding = false; fb = null; this.update(); toast('Документ в корзине и исключён из поиска.'); } });
      return fb;
    },
    mount(main, route) {
      main.innerHTML = '<section class="doc-page" id="docPage"></section>';
      root = main.querySelector('#docPage');
      root.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-act]');
        if (!t) return;
        const d = getDoc(route.id);
        if (t.dataset.act === 'move') moveDialog([d.id]);
        if (t.dataset.act === 'restore') restoreDocs([d.id]);
        if (t.dataset.act === 'ask') askAbout([d.id]);
        if (t.dataset.act === 'retry') retryDocs([d.id]);
      });
      this.route = route;
      this.update(route, true);
    },
    update(route = this.route, first = false) {
      this.route = route;
      const d = getDoc(route.id);
      const from = route.query.get('from');
      const back = from ? `<a class="back-link" href="#/c/${esc(from)}">${icon('back', 'sm')}Вернуться к диалогу</a>` : `<a class="back-link" href="#/docs${d?.collectionId ? '/' + d.collectionId : ''}">${icon('back', 'sm')}К документам</a>`;
      if (!d) { root.innerHTML = `${back}<div class="empty-card center"><h2>Документ не найден</h2><p>Он удалён навсегда или ссылка открыта в другом браузере: документы хранятся локально.</p></div>`; return; }
      if (!canSee(d)) { root.innerHTML = `${back}<div class="empty-card center">${icon('lock', 'lg')}<h2>Документ недоступен</h2><p>Он лежит в коллекции, закрытой для подрядчиков.</p></div>`; this.last = ''; return; }
      const hl = route.query.get('q') ? { blockIndex: Number(route.query.get('b')), quote: route.query.get('q') } : null;
      let content = '';
      if (d.status === 'ready') {
        const body = docBody(d, hl);
        content = `${hl && !body.found ? `<div class="banner warn">${icon('alert', 'sm')}Цитата не найдена в текущем тексте документа.</div>` : ''}<article class="doc-text">${body.html}</article>`;
      } else if (d.status === 'error') {
        content = `<div class="empty-card">${icon('alert', 'lg')}<h2>Не удалось прочитать файл</h2><p>${esc(d.error)}</p>${demoNote(d)}${canRetry(d) ? `<button type="button" class="btn btn-primary" data-act="retry">${icon('refresh', 'sm')}Повторить обработку</button>` : ''}</div>`;
      } else {
        content = `<div class="empty-card">${lattice({ pattern: 'snake' })}<h2>Документ обрабатывается</h2><p>${esc(d.stage || 'В очереди')}… Содержимое появится здесь, когда текст будет извлечён.</p></div>`;
      }
      const html = `${back}
        <header class="doc-head">
          <span class="ftype ft-${d.ext} lg" aria-hidden="true">${TYPE[d.ext] || '?'}</span>
          <div class="doc-head-main"><h1>${wbr(d.name)}</h1>
            <div class="doc-facts">${statusBadge(d)}<span>${icon('folder', 'xs')}${esc(colName(d.collectionId))}</span><span>${docMeta(d)}</span>${d.deletedAt ? '<span class="status st-error">В корзине</span>' : ''}</div>
          </div>
          <div class="head-actions">
            ${d.deletedAt && !holding ? `<button type="button" class="btn btn-primary" data-act="restore">${icon('restore', 'sm')}Восстановить</button>`
              : `${d.status === 'ready' ? `<button type="button" class="btn btn-primary" data-act="ask">${icon('chat', 'sm')}Спросить по документу</button>` : ''}
              ${isContractor() ? '' : `<button type="button" class="btn btn-ghost" data-act="move">${icon('move', 'sm')}Переместить</button><span data-fuse></span>`}`}
          </div>
        </header>
        ${d.status === 'ready' ? `<p class="doc-note">${icon('info', 'xs')}Текст, по которому ищет агент. Выделите фрагмент, чтобы спросить о нём.</p>` : ''}
        ${content}`;
      if (html !== this.last) {
        root.innerHTML = html;
        this.last = html;
        root.querySelector('[data-fuse]')?.replaceWith(this.fuse(d));
        if (first && hl) requestAnimationFrame(() => scrollToHit(root));
      }
    },
  };
}
