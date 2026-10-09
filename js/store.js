// Состояние приложения и его сохранение в localStorage.
// Здесь же — очередь обработки файлов (извлечение текста идёт в ingest.js).

import { extract, extOf, ReadError } from './ingest.js';
import { chunkPages } from './search.js';
import { FILES, COLLECTIONS } from '../demo/manifest.js';

const KEY = 'sverka.v1';
const listeners = new Set();
const files = new Map(); // docId → File, только в текущей сессии (нужно для «Повторить»)

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function fresh() {
  return { v: 1, collections: [], docs: [], chats: [], saved: [], drafts: {}, newScope: { type: 'all' }, settings: { failNext: false } };
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (!s || s.v !== 1) return fresh();
    return { ...fresh(), ...s };
  } catch { return fresh(); }
}

export let state = load();
export let storageError = null;

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try { localStorage.setItem(KEY, JSON.stringify(state)); storageError = null; }
    catch (e) { storageError = 'Не удалось сохранить данные в браузере: закончилось место. Удалите лишние документы.'; emit(); }
  }, 150);
}
// При закрытии вкладки дописываем только несохранённые изменения (не затираем данные другой вкладки).
export function flush() {
  if (!timer) return;
  clearTimeout(timer); timer = null;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* сообщение покажет save() */ }
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit() { listeners.forEach((fn) => fn()); }
export function commit() { save(); emit(); }

export const doc = (id) => state.docs.find((d) => d.id === id);
export const chat = (id) => state.chats.find((c) => c.id === id);
export const collection = (id) => state.collections.find((c) => c.id === id);
export const liveDocs = () => state.docs.filter((d) => !d.deletedAt);

// ---------- Документы ----------
function newDoc(name, size, collectionId, demoKey = null) {
  return { id: uid(), name, ext: extOf(name), size, collectionId, status: 'queued', stage: null, error: null, addedAt: Date.now(), deletedAt: null, demoKey, blocks: [], pages: 0, sections: 0, chunks: 0 };
}

export function addFiles(list, collectionId = null) {
  const added = [];
  for (const f of list) {
    const demo = FILES.find((x) => x.file === f.name);
    const d = newDoc(f.name, f.size, collectionId, demo?.key || null);
    files.set(d.id, f);
    added.push(d);
  }
  state.docs.unshift(...added);
  commit();
  pump();
  return added;
}

export function ensureCollection(name) {
  let c = state.collections.find((x) => x.name === name);
  if (!c) { c = { id: uid(), name, createdAt: Date.now() }; state.collections.push(c); }
  return c;
}

// Демо-набор проходит тот же конвейер, что и загруженные пользователем файлы.
export function loadDemo() {
  const have = new Set(liveDocs().map((d) => d.demoKey).filter(Boolean));
  const cols = Object.fromEntries(Object.entries(COLLECTIONS).map(([k, name]) => [k, ensureCollection(name).id]));
  const add = FILES.filter((f) => !have.has(f.key)).map((f) => newDoc(f.file, 0, cols[f.col], f.key));
  state.docs.unshift(...add);
  const n = add.length;
  commit();
  pump();
  return n;
}

async function sourceFile(d) {
  if (files.has(d.id)) return files.get(d.id);
  const demo = FILES.find((x) => x.key === d.demoKey);
  if (demo) {
    const res = await fetch(new URL(`../demo/${encodeURIComponent(demo.file)}`, import.meta.url));
    if (!res.ok) throw new ReadError('Не удалось загрузить демонстрационный файл.');
    const blob = await res.blob();
    return new File([blob], demo.file);
  }
  return null;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
// Очередь: файлы обрабатываются по одному. Небольшие паузы оставлены, чтобы статусы
// «В очереди → Обработка» были различимы глазом; сама обработка реальная.
async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const d = state.docs.find((x) => x.status === 'queued' && !x.deletedAt); // сверху вниз, как в списке
      if (!d) break;
      d.status = 'processing'; d.stage = 'Чтение файла'; d.error = null; emit();
      try {
        const file = await sourceFile(d);
        if (!file) throw new ReadError('Исходный файл недоступен после перезагрузки страницы. Загрузите его снова.');
        d.size = file.size;
        await pause(200);
        d.stage = 'Извлечение текста'; emit();
        const blocks = await extract(file);
        await pause(150);
        d.stage = 'Индексация'; emit();
        d.blocks = blocks;
        d.pages = new Set(blocks.map((b) => b.n).filter(Boolean)).size;
        d.sections = new Set(blocks.map((b) => b.section).filter(Boolean)).size;
        d.chunks = chunkPages(d.id, blocks).length;
        await pause(120);
        d.status = 'ready'; d.stage = null; d.readyAt = Date.now();
      } catch (e) {
        d.status = 'error'; d.stage = null;
        d.error = e instanceof ReadError ? e.message : 'Не удалось обработать файл. Попробуйте ещё раз.';
        if (!(e instanceof ReadError)) console.error(e);
      }
      commit();
    }
  } finally { running = false; }
}

export function canRetry(d) { return files.has(d.id) || !!d.demoKey; }
export function retryDocs(ids) {
  for (const id of ids) { const d = doc(id); if (d && canRetry(d)) { d.status = 'queued'; d.error = null; } }
  commit(); pump();
}
export function replaceFile(id, f) {
  const d = doc(id);
  files.set(id, f);
  Object.assign(d, { name: f.name, ext: extOf(f.name), size: f.size, status: 'queued', error: null });
  commit(); pump();
}

export function moveDocs(ids, collectionId) {
  ids.forEach((id) => { const d = doc(id); if (d) d.collectionId = collectionId; });
  commit();
}
export function trashDocs(ids) {
  const now = Date.now();
  ids.forEach((id) => { const d = doc(id); if (d) d.deletedAt = now; });
  commit();
}
export function restoreDocs(ids) {
  ids.forEach((id) => { const d = doc(id); if (d) d.deletedAt = null; });
  commit(); pump();
}
export function purgeDocs(ids) {
  state.docs = state.docs.filter((d) => !ids.includes(d.id));
  ids.forEach((id) => files.delete(id));
  commit();
}

export function createCollection(name) { const c = ensureCollection(name.trim()); commit(); return c; }
export function renameCollection(id, name) { const c = collection(id); if (c) c.name = name.trim(); commit(); }
export function deleteCollection(id) {
  state.collections = state.collections.filter((c) => c.id !== id);
  state.docs.forEach((d) => { if (d.collectionId === id) d.collectionId = null; });
  commit();
}

// ---------- Диалоги ----------
export function createChat(scope, title) {
  const c = { id: uid(), title: title.slice(0, 80), createdAt: Date.now(), updatedAt: Date.now(), scope, messages: [] };
  state.chats.unshift(c);
  return c;
}
export function deleteChat(id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  delete state.drafts[id];
  commit();
}
export function toggleSaved(chatId, msgId) {
  const i = state.saved.findIndex((s) => s.msgId === msgId);
  if (i >= 0) state.saved.splice(i, 1);
  else {
    const c = chat(chatId);
    const idx = c.messages.findIndex((m) => m.id === msgId);
    const q = [...c.messages.slice(0, idx)].reverse().find((m) => m.role === 'user');
    state.saved.unshift({ id: uid(), chatId, msgId, question: q?.text || '', answer: c.messages[idx].answer, savedAt: Date.now() });
  }
  commit();
  return i < 0;
}

export function reset() {
  localStorage.removeItem(KEY);
  files.clear();
  state = fresh();
  emit();
}

// После перезагрузки: прерванные ответы и обработка.
for (const c of state.chats) for (const m of c.messages) if (m.pending) { m.pending = false; m.error = 'Ответ был прерван перезагрузкой страницы.'; }
for (const d of state.docs) if (d.status === 'processing') d.status = 'queued';
if (state.docs.some((d) => d.status === 'queued')) setTimeout(pump, 300);
