// Экран чата: стартовый экран, сообщения, ответы с источниками, область поиска, ввод.

import { state, chat as getChat, commit, emit, save, createChat, toggleSaved, uid, liveDocs, loadDemo, restoreDocs } from './store.js';
import { askAI, scopeInfo } from './agent.js';
import { EXAMPLES } from '../demo/manifest.js';
import { esc, icon, inline, anchor, plural, nDocs, fmtDate, toast, modal, statusBadge, TYPE, reveal } from './ui.js';

const running = new Map(); // msgId → { cancelled, ctrl }
const justSent = new Set(); // id нового диалога и сообщений: анимируются, даже если вид только что открыт
const inDocs = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'документе' : 'документах'}`;
const shortName = (name) => name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export const scopeOf = (c) => (c ? c.scope : state.newScope);
const info = (c) => scopeInfo(scopeOf(c), state.docs, state.collections);

// ---------- Отправка и формирование ответа ----------
async function runAnswer(c, m) {
  const token = { cancelled: false, ctrl: new AbortController() };
  running.set(m.id, token);
  const step = async (i, ms) => { m.step = i; emit(); await pause(ms); return token.cancelled; };
  const idx = c.messages.indexOf(m);
  const question = c.messages[idx - 1].text;
  const fail = state.settings.failNext;
  // Поиск фрагментов синхронный и заканчивается сразу; паузы между шагами — только чтобы их было видно.
  const job = fail ? null : askAI({ question, history: c.messages.slice(0, idx - 1), scope: c.scope, docs: state.docs, collections: state.collections },
    { signal: token.ctrl.signal, onFound: (f) => { m.found = f; } });
  job?.catch(() => {}); // ошибку разбираем ниже, при await
  if (await step(0, m.found ? 700 : 300)) return;
  m.step = 1; emit();
  if (fail) {
    state.settings.failNext = false;
    m.error = 'Сервис ответа не отвечает (ошибка смоделирована в настройках прототипа).';
  } else {
    try {
      const answer = await job;
      if (token.cancelled) return;
      m.checks = answer.kind === 'answer' ? answer.sources.length : 0; // столько цитат прошло сверку
      if (await step(2, 250 + m.checks * 160)) return;
      m.answer = answer;
    } catch (e) {
      if (token.cancelled) return;
      console.error(e);
      m.error = 'Внутренняя ошибка поиска. Повторите запрос; если ошибка повторяется — обновите страницу.';
    }
  }
  m.pending = false;
  delete m.found; delete m.checks;
  running.delete(m.id);
  c.updatedAt = Date.now();
  commit();
}

export function send(chatId, text) {
  text = text.trim();
  if (!text) return null;
  let c = chatId ? getChat(chatId) : null;
  const inf = info(c);
  if (!inf.ready.length) { toast('В выбранной области нет готовых документов.', { kind: 'warn' }); return null; }
  if (c?.messages.some((m) => m.pending)) return null;
  if (!c) { c = createChat({ ...state.newScope }, text); state.drafts.new = ''; state.newScope = { type: 'all' }; justSent.add(c.id); }
  else state.drafts[c.id] = '';
  const q = { id: uid(), role: 'user', text, at: Date.now() };
  const m = { id: uid(), role: 'assistant', pending: true, step: 0, at: Date.now() };
  justSent.add(q.id).add(m.id);
  c.messages.push(q);
  c.messages.push(m);
  c.updatedAt = Date.now();
  commit();
  runAnswer(c, m);
  return c;
}

function retry(c, m) {
  Object.assign(m, { pending: true, step: 0, error: null, stopped: false, answer: null, found: null, checks: 0 });
  commit();
  runAnswer(c, m);
}

function stop(c, m) {
  const t = running.get(m.id);
  if (t) { t.cancelled = true; t.ctrl.abort(); }
  running.delete(m.id);
  Object.assign(m, { pending: false, stopped: true });
  delete m.found; delete m.checks;
  commit();
}

export function setScope(c, scope) {
  if (c) {
    const before = JSON.stringify(c.scope);
    c.scope = scope;
    if (before !== JSON.stringify(scope) && c.messages.length) {
      c.messages.push({ id: uid(), role: 'system', text: `Область поиска изменена: ${scopeInfo(scope, state.docs, state.collections).label}`, at: Date.now() });
    }
  } else state.newScope = scope;
  commit();
}

// ---------- Отрисовка ----------
function scopeBar(c) {
  const inf = info(c);
  let note = '', tone = '';
  if (!inf.docs.length) { note = liveDocs().length ? 'В этой области нет документов.' : 'Документов пока нет — добавьте их, чтобы начать поиск.'; tone = 'warn'; }
  else if (!inf.ready.length && inf.pending) { note = `Документы ещё обрабатываются (${inf.pending}). Вопрос можно будет задать после готовности.`; tone = 'info'; }
  else if (!inf.ready.length) { note = 'В области нет готовых документов: все файлы с ошибкой чтения.'; tone = 'warn'; }
  else {
    const extra = [];
    if (inf.pending) extra.push(`ещё ${inf.pending} в обработке`);
    if (inf.errors) extra.push(`${inf.errors} с ошибкой не участвуют`);
    note = extra.length ? `Ответ — по ${nDocs(inf.ready.length)}; ${extra.join(', ')}.` : '';
  }
  const actions = tone === 'warn' ? `<span class="scope-actions">${state.docs.some((d) => d.status === 'ready' && !d.deletedAt) && scopeOf(c).type !== 'all' ? '<button type="button" class="link-btn" data-act="scope-all">Искать во всех документах</button>' : ''}<a class="link-btn" href="#/docs">Открыть документы</a></span>` : '';
  return `<button type="button" class="scope-chip ${tone}" data-act="scope" aria-haspopup="dialog">
      ${icon('scope')}<span class="scope-label">Область: <b>${esc(inf.label)}</b></span>
      <span class="scope-count">${inf.ready.length} ${plural(inf.ready.length, 'готов', 'готовы', 'готовы')}</span>${icon('chevron', 'sm')}
    </button>
    ${note ? `<span class="scope-note ${tone}" role="status">${esc(note)} ${actions}</span>` : ''}`;
}

// Иллюстрация стартового экрана — суть продукта за 7 секунд: лупа ищет строку → строка подсвечивается
// как цитата → появляется ссылка [1] → печать «сверено». Только CSS; при reduce motion — статичный кадр.
const HERO_ART = `<div class="hero-art" aria-hidden="true">
  <span class="sheet s3"></span><span class="sheet s2"></span>
  <span class="sheet s1"><i class="ln ttl"></i><i class="ln"></i><i class="ln w9"></i><i class="ln hit"></i><i class="ln w8"></i><i class="ln w6"></i><i class="ln w9"></i>
    <span class="art-cite">1</span><span class="stamp">${icon('check')}</span></span>
  <span class="lens"></span>
</div>`;

function startScreen(c) {
  const inf = info(c);
  const all = liveDocs();
  const ready = all.filter((d) => d.status === 'ready').length;
  const pending = all.filter((d) => d.status === 'queued' || d.status === 'processing').length;
  const step1 = !all.length ? '<span class="step-state warn">нет документов</span>'
    : `<span class="step-state ${ready ? 'ok' : 'info'}">${ready ? `${icon('check', 'sm')}${nDocs(ready)} готовы к поиску` : ''}${pending ? `${ready ? ' · ' : ''}<span class="spin" aria-hidden="true"></span>${pending} в обработке` : ''}</span>`;
  const examples = EXAMPLES.map((e, i) => `<button type="button" class="example" style="--i:${i + 7}" data-ask="${esc(e.q)}" ${inf.ready.length ? '' : 'disabled'}>
      <span class="ex-kind">${esc(e.kind)}</span><span class="ex-q">${esc(e.q)}</span>${icon('send', 'ex-ic')}</button>`).join('');
  return `<div class="start" data-k="start">
    <div class="start-hero">
      <div class="hero-copy">
        <span class="hero-eyebrow" style="--i:0"><span class="live-dot" aria-hidden="true"></span>ИИ-агент по рабочим документам</span>
        <h1 style="--i:1">Найдите ответ в документах и <span class="accent-text">сразу проверьте его по источнику</span></h1>
        <p style="--i:2">Сверка ищет по регламентам, протоколам, отчётам и планам. В каждом ответе — точные цитаты и ссылка на страницу или раздел, откуда они взяты.</p>
      </div>
      ${HERO_ART}
    </div>
    <ol class="steps" aria-label="Как начать">
      <li style="--i:3"><span class="step-n">1</span><div><b>Документы</b>${step1}</div><a class="link-btn" href="#/docs">Открыть</a></li>
      <li style="--i:4"><span class="step-n">2</span><div><b>Область поиска</b><span class="step-state">${esc(inf.label)}</span></div><button type="button" class="link-btn" data-act="scope">Изменить</button></li>
      <li style="--i:5"><span class="step-n">3</span><div><b>Вопрос</b><span class="step-state">ответ, цитаты, источник</span></div></li>
    </ol>
    ${!all.length ? `<div class="empty-card" style="--i:6">
        <h2>Нет документов для поиска</h2>
        <p>Загрузите демонстрационный набор — 7 вымышленных документов стройки участка ВСМ (протоколы, отчёт, регламент, план поставок, перечень ответственных и один скан без текста — он нарочно показывает ошибку чтения) — или добавьте свои PDF, DOCX, TXT, MD.</p>
        <div class="row-actions"><button type="button" class="btn btn-primary" data-act="demo">${icon('upload')}Загрузить демо-набор</button><button type="button" class="btn btn-ghost" data-act="pick">Добавить свои файлы</button></div>
      </div>`
      : `<div class="examples-head" style="--i:6"><h2>Примеры вопросов</h2>${inf.ready.length ? '' : '<span class="muted">станут доступны, когда документы будут готовы</span>'}</div><div class="examples">${examples}</div>`}
  </div>`;
}

function sourceCard(msgId, s, key, attr = '') {
  const d = state.docs.find((x) => x.id === s.docId);
  const gone = !d ? 'Документ удалён — источник недоступен.' : d.deletedAt ? 'Документ в корзине.' : null;
  return `<li class="src-card ${gone ? 'gone' : ''}" data-src-n="${s.n}" ${attr}>
    <button type="button" class="src-open" data-open="${msgId}:${key}" ${!d ? 'disabled' : ''} aria-label="Открыть источник ${s.n}: ${esc(s.docName)}, ${esc(anchor(s))}">
      <span class="src-n">${s.n}</span>
      <span class="src-meta"><span class="src-doc">${icon('doc', 'sm')}${esc(s.docName)}</span><span class="src-anchor">${esc(anchor(s))}</span></span>
      ${d ? icon('open', 'sm src-go') : ''}
    </button>
    <blockquote class="src-quote">${esc(s.quote)}</blockquote>
    ${gone ? `<p class="src-gone">${gone}${d?.deletedAt ? ` <button type="button" class="link-btn" data-restore="${d.id}">Восстановить</button>` : ''}</p>` : ''}
  </li>`;
}

// nx() — атрибут style="--i:N": порядковый номер элемента для поочерёдного появления ответа.
function blocksHtml(blocks, msgId, nx = () => '') {
  return blocks.map((b) => {
    if (b.t === 'p') return `<p ${nx()}>${inline(b.text, msgId)}</p>`;
    if (b.t === 'note') return `<p class="ans-note" ${nx()}>${inline(b.text, msgId)}</p>`;
    if (b.t === 'ul') return `<ul ${nx()}>${b.items.map((i) => `<li>${inline(i, msgId)}</li>`).join('')}</ul>`;
    if (b.t === 'table') return `<div class="table-wrap" ${nx()}><table><thead><tr>${b.head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, msgId)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    if (b.t === 'quotes') return `<ol class="quotes" ${nx()}>${b.items.map((q) => `<li><span class="q-text">«${esc(q.text)}»</span> ${inline(`[${q.n}]`, msgId)}</li>`).join('')}</ol>`;
    return '';
  }).join('');
}

function answerHtml(c, m) {
  const a = m.answer;
  const saved = state.saved.some((s) => s.msgId === m.id);
  const n = a.sources?.length || 0;
  let i = 0;
  const nx = () => `style="--i:${i++}"`;
  const body = blocksHtml(a.blocks, m.id, nx);
  const head = a.kind === 'noinfo'
    ? `<span class="verdict none">${icon('info', 'sm')}Нет в документах</span>`
    : a.kind === 'noscope'
      ? `<span class="verdict none">${icon('alert', 'sm')}Нет готовых документов в области</span>`
      : a.status === 'partial'
        ? `<span class="verdict partial">${icon('alert', 'sm')}Подтверждено частично · ${n} ${plural(n, 'источник', 'источника', 'источников')}</span>`
        : `<span class="verdict ok">${icon('shield', 'sm')}Подтверждено документами · ${n} ${plural(n, 'источник', 'источника', 'источников')}</span>`;
  const ctx = a.context ? `<span class="ctx-chip" title="Уточняющий вопрос: учтён предыдущий вопрос">↳ с учётом вопроса «${esc(a.context.length > 60 ? a.context.slice(0, 60) + '…' : a.context)}»</span>` : '';
  const words = a.searched?.length ? ` Искомые слова: ${a.searched.map((w) => `«${esc(w)}»`).join(', ')}.` : '';
  const how = a.mode === 'model'
    ? `Поиск BM25 нашёл ${a.sent} ${plural(a.sent, 'фрагмент', 'фрагмента', 'фрагментов')} в области «${esc(a.scope.label)}». Модель ${esc(a.model || 'GigaChat')} получила только эти фрагменты (не документы целиком) и написала ответ по ним. ${a.kind === 'answer' ? 'Каждая ссылка сверена с документом: в источнике — дословный текст (цитата модели или предложение фрагмента, совпадающее с утверждением), а все числа и даты ответа есть в источниках. Не прошёл проверку — ответ модели не показывается.' : 'Ответа во фрагментах модель не нашла.'}`
    : `${a.fallback ? `<b>Ответ без модели: ${esc(a.fallback)}.</b> ` : ''}${a.mode === 'prepared'
      ? `Демонстрационный вопрос: текст ответа подготовлен заранее. Все ${n} ${plural(n, 'цитата', 'цитаты', 'цитат')} найдены в тексте обработанных документов области в момент ответа — если хотя бы одной нет, агент переключается на обычный поиск.`
      : `Поиск BM25 со стеммингом по фрагментам документов области «${esc(a.scope.label)}» (${nDocs(a.scope.ready)}). Текст ответа — дословные цитаты, генеративная модель не используется.${words}`}`;
  let extra = '';
  if (a.kind === 'noinfo') {
    if (a.outside) {
      extra += `<div class="outside" ${nx()}>${icon('search', 'sm')}<div><b>Похоже, ответ есть вне текущей области</b><span>${a.outside.names.map(esc).join(', ')}</span></div>
        <button type="button" class="btn btn-sm btn-primary" data-act="ask-all" data-msg="${m.id}">Искать во всех документах</button></div>`;
    }
    extra += `<div class="next-steps" ${nx()}><span>Что можно сделать:</span><button type="button" class="btn btn-sm btn-ghost" data-act="rephrase">Переформулировать вопрос</button><button type="button" class="btn btn-sm btn-ghost" data-act="scope">Изменить область</button><a class="btn btn-sm btn-ghost" href="#/docs">Добавить документы</a></div>`;
    if (a.near?.length) {
      extra += `<section class="sources near" aria-label="Ближайшие фрагменты" ${nx()}><h4>Ближайшие фрагменты — напрямую на вопрос не отвечают</h4><ol>${a.near.map((s) => sourceCard(m.id, s, `near-${s.n}`, nx())).join('')}</ol></section>`;
    }
  }
  const mode = a.mode === 'model' ? `<span class="ctx-chip">${a.kind === 'answer' ? 'Ответ модели · цитаты сверены' : 'Ответ модели'}</span>` : a.fallback ? `<span class="ctx-chip" title="${esc(a.fallback)}">Без модели — ответ из цитат</span>` : '';
  return `<div class="ans-head">${head}${mode}${ctx}</div>
    <div class="ans-body">${body}</div>
    ${extra}
    ${n ? `<section class="sources" aria-label="Источники" ${nx()}><h4>Источники</h4><ol>${a.sources.map((s) => sourceCard(m.id, s, s.n, nx())).join('')}</ol></section>` : ''}
    <div class="ans-foot" ${nx()}>
      ${a.kind === 'answer' ? `<button type="button" class="btn btn-sm btn-ghost" data-act="copy" data-msg="${m.id}">${icon('copy', 'sm')}Копировать</button>
      <button type="button" class="btn btn-sm btn-ghost ${saved ? 'on' : ''}" data-act="save" data-msg="${m.id}" aria-pressed="${saved}">${icon('bookmark', 'sm')}${saved ? 'Сохранено' : 'Сохранить'}</button>` : ''}
      <details class="how"><summary>Как получен ответ</summary><p>${how}</p></details>
    </div>
    ${a.suggest?.length ? `<div class="suggest" aria-label="Уточняющие вопросы">${a.suggest.map((q) => `<button type="button" class="chip" ${nx()} data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}`;
}

function messageHtml(c, m) {
  if (m.role === 'user') return `<div class="msg user" data-k="${m.id}"><div class="bubble">${esc(m.text)}</div></div>`;
  if (m.role === 'system') return `<div class="msg system" role="note" data-k="${m.id}">${icon('scope', 'sm')}${esc(m.text)}</div>`;
  let body;
  if (m.pending) body = thinkingHtml(c, m);
  else if (m.error || m.stopped) {
    body = `<div class="ans-error" role="alert">${icon('alert')}<div><b>${m.stopped ? 'Ответ остановлен' : 'Не удалось получить ответ'}</b><span>${esc(m.error || 'Вы остановили формирование ответа.')}</span></div>
      <button type="button" class="btn btn-sm btn-primary" data-act="retry" data-msg="${m.id}">${icon('refresh', 'sm')}Повторить</button></div>`;
  } else body = answerHtml(c, m);
  const st = m.pending ? 'p' : m.error || m.stopped ? 'e' : 'a';
  return `<article class="msg agent" id="m-${m.id}" data-k="${m.id}" aria-label="Ответ агента"><div class="agent-ava" aria-hidden="true"></div><div class="agent-body" data-k="${m.id}:${st}">${body}</div></article>`;
}

// Ход ответа на реальных данных: какие документы нашёл поиск → модель пишет → сколько цитат сверено.
function thinkingHtml(c, m) {
  const inf = info(c);
  const f = m.found;
  const chips = f ? `<span class="found" data-k="${m.id}:found">${f.docs.slice(0, 4).map((d, i) => `<span class="doc-chip" style="--i:${i}" title="${esc(d)}">${icon('doc', 'xs')}<span>${esc(shortName(d))}</span></span>`).join('')}${f.docs.length > 4 ? `<span class="doc-chip" style="--i:4">+${f.docs.length - 4}</span>` : ''}</span>` : '';
  const steps = [
    [f ? `Нашёл ${f.n} ${plural(f.n, 'фрагмент', 'фрагмента', 'фрагментов')} в ${inDocs(f.docs.length)}` : 'Ищу фрагменты в документах', chips],
    ['Модель пишет ответ по фрагментам', m.step === 1 ? '<span class="writing" aria-hidden="true"><i></i><i></i><i></i></span>' : ''],
    ['Сверяю цитаты с текстом документов', m.step === 2 && m.checks ? `<span class="ticks" data-k="${m.id}:ticks">${Array.from({ length: m.checks }, (_, i) => `<span class="tick" style="--i:${i}">${icon('check', 'xs')}${i + 1}</span>`).join('')}</span>` : ''],
  ];
  return `<div class="thinking" role="status" aria-live="polite">
    <div class="think-title"><span class="scan" aria-hidden="true"></span>Ищу ответ в ${inDocs(inf.ready.length)} · «${esc(inf.label)}»</div>
    <ol class="think-steps">${steps.map(([t, x], i) => `<li class="${i < m.step ? 'done' : i === m.step ? 'now' : ''}">
      <span class="st-ic" ${i < m.step ? `data-k="${m.id}:d${i}"` : ''}>${i < m.step ? icon('check', 'sm') : '<span class="dot"></span>'}</span><div class="st-body"><span>${t}</span>${x}</div></li>`).join('')}</ol>
    <button type="button" class="btn btn-sm btn-ghost" data-act="stop" data-msg="${m.id}">${icon('stop', 'sm')}Остановить</button>
  </div>`;
}

function plainText(m) {
  const a = m.answer;
  const lines = a.blocks.flatMap((b) => b.t === 'ul' ? b.items.map((i) => '• ' + i) : b.t === 'table' ? [b.head.join(' | '), ...b.rows.map((r) => r.join(' | '))] : b.t === 'quotes' ? b.items.map((q) => `«${q.text}» [${q.n}]`) : [b.text]);
  return [...lines.map((l) => l.replace(/\*\*/g, '')), '', 'Источники:', ...a.sources.map((s) => `[${s.n}] ${s.docName}, ${anchor(s)}: «${s.quote}»`)].join('\n');
}

// ---------- Диалог выбора области ----------
export async function pickScope(c) {
  const cur = scopeOf(c);
  const live = liveDocs();
  const cnt = (list) => { const r = list.filter((d) => d.status === 'ready').length; return `${r} из ${list.length} готовы`; };
  const cols = [...state.collections.map((x) => ({ id: x.id, name: x.name })), ...(live.some((d) => !d.collectionId) ? [{ id: null, name: 'Без коллекции' }] : [])];
  const body = `<p class="muted">Агент ищет только в документах выбранной области. Файлы в обработке и с ошибкой в поиске не участвуют.</p>
    <fieldset class="scope-opts"><legend class="sr-only">Область поиска</legend>
      <label class="opt"><input type="radio" name="t" value="all" ${cur.type === 'all' ? 'checked' : ''}><span><b>Все документы</b><small>${cnt(live)}</small></span></label>
      ${cols.filter((x) => x.id).map((x) => { const l = live.filter((d) => d.collectionId === x.id); return `<label class="opt"><input type="radio" name="t" value="c:${x.id}" ${cur.type === 'collection' && cur.id === x.id ? 'checked' : ''}><span><b>${icon('folder', 'sm')}${esc(x.name)}</b><small>${cnt(l)}</small></span></label>`; }).join('')}
      <label class="opt"><input type="radio" name="t" value="docs" ${cur.type === 'docs' ? 'checked' : ''}><span><b>Выбранные документы</b><small>отметьте ниже</small></span></label>
    </fieldset>
    <div class="scope-docs" ${cur.type === 'docs' ? '' : 'hidden'}>
      <input class="input" type="search" placeholder="Найти документ по названию" aria-label="Найти документ по названию" data-filter>
      <ul>${live.map((d) => `<li data-name="${esc(d.name.toLowerCase())}"><label class="doc-opt ${d.status !== 'ready' ? 'muted' : ''}"><input type="checkbox" value="${d.id}" ${cur.type === 'docs' && cur.ids.includes(d.id) ? 'checked' : ''}><span class="ftype ft-${d.ext}">${TYPE[d.ext] || '?'}</span><span class="doc-opt-name">${esc(d.name)}</span>${d.status !== 'ready' ? statusBadge(d) : ''}</label></li>`).join('') || '<li class="muted">Документов нет</li>'}</ul>
    </div>
    <p class="field-err" hidden>Отметьте хотя бы один документ</p>`;
  const res = await modal({
    title: 'Область поиска', body, wide: true,
    actions: [{ label: 'Отмена', value: null }, { label: 'Применить', cls: 'btn-primary', submit: true, collect: (dlg) => {
      const t = dlg.querySelector('input[name=t]:checked').value;
      if (t === 'all') return { type: 'all' };
      if (t.startsWith('c:')) return { type: 'collection', id: t.slice(2) };
      const ids = [...dlg.querySelectorAll('.scope-docs input[type=checkbox]:checked')].map((i) => i.value);
      if (!ids.length) { dlg.querySelector('.field-err').hidden = false; return undefined; }
      return { type: 'docs', ids };
    } }],
    onMount: (dlg) => {
      const box = dlg.querySelector('.scope-docs');
      dlg.querySelectorAll('input[name=t]').forEach((r) => r.addEventListener('change', () => { box.hidden = r.value !== 'docs' || !r.checked; }));
      box.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => { dlg.querySelector('input[value=docs]').checked = true; }));
      dlg.querySelector('[data-filter]').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        box.querySelectorAll('li[data-name]').forEach((li) => { li.hidden = !li.dataset.name.includes(q); });
      });
    },
  });
  if (res) setScope(c, res);
}

// ---------- Вид ----------
export function chatView({ pickFiles }) {
  let root, chatId, lastHtml = '', lastCount = 0;
  const seen = new Set(); // ключи data-k, которые уже показаны: их не анимируем повторно

  const ta = () => root.querySelector('#q');
  const autosize = () => { const t = ta(); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; };

  function submit(text) {
    const c = send(chatId, text ?? ta().value);
    if (!c) return;
    ta().value = '';
    autosize();
    if (!chatId) location.hash = `#/c/${c.id}`;
  }

  function onClick(e) {
    const t = e.target.closest('[data-act],[data-ask],[data-open],.cite,[data-restore]');
    if (!t) return;
    const c = chatId ? getChat(chatId) : null;
    if (t.matches('.cite')) return openSource(t.dataset.msg, t.dataset.cite);
    if (t.dataset.open) { const [msg, key] = t.dataset.open.split(':'); return openSource(msg, key); }
    if (t.dataset.ask) return submit(t.dataset.ask);
    if (t.dataset.restore) { restoreDocs([t.dataset.restore]); toast('Документ восстановлен из корзины.'); return; }
    const m = c?.messages.find((x) => x.id === t.dataset.msg);
    switch (t.dataset.act) {
      case 'scope': return pickScope(c);
      case 'scope-all': return setScope(c, { type: 'all' });
      case 'demo': loadDemo(); toast('Демо-набор добавлен: идёт обработка файлов.'); return;
      case 'pick': return pickFiles(null);
      case 'stop': return stop(c, m);
      case 'retry': return retry(c, m);
      case 'rephrase': { const q = [...c.messages].reverse().find((x) => x.role === 'user'); ta().value = q?.text || ''; autosize(); ta().focus(); return; }
      case 'save': { const on = toggleSaved(c.id, m.id); toast(on ? 'Ответ сохранён — он доступен в разделе «Сохранённые».' : 'Ответ убран из сохранённых.'); return; }
      case 'copy': navigator.clipboard?.writeText(plainText(m)).then(() => toast('Ответ с источниками скопирован.'), () => toast('Не удалось скопировать.', { kind: 'warn' })); return;
      case 'ask-all': {
        const idx = c.messages.indexOf(m);
        setScope(c, { type: 'all' });
        submit(c.messages[idx - 1].text);
        return;
      }
    }
  }

  function openSource(msgId, key) {
    location.hash = `#/c/${chatId}?src=${msgId}:${key}`;
  }

  function hoverCite(e) {
    const t = e.target.closest('.cite');
    root.querySelectorAll('.src-card.peek').forEach((x) => x.classList.remove('peek'));
    if (!t) return;
    root.querySelector(`#m-${t.dataset.msg} .sources:not(.near) [data-src-n="${t.dataset.cite}"]`)?.classList.add('peek');
  }

  return {
    mount(main, route) {
      chatId = route.id;
      lastHtml = ''; lastCount = 0;
      main.innerHTML = `<section class="chat-view">
        <div class="chat-scroll" id="chatScroll"><div class="chat-inner" id="chatInner"></div></div>
        <div class="composer-wrap"><div class="composer-in">
          <div class="scope-bar" id="scopeBar"></div>
          <form class="composer" id="composer">
            <label for="q" class="sr-only">Вопрос по документам</label>
            <textarea id="q" rows="1" placeholder="Задайте вопрос по документам…" autocomplete="off"></textarea>
            <button type="submit" class="send-btn" aria-label="Отправить вопрос">${icon('send')}</button>
          </form>
          <p class="hint">Enter — отправить · Shift+Enter — новая строка · ответы содержат только то, что есть в документах</p>
        </div></div>
      </section>`;
      root = main.querySelector('.chat-view');
      const t = ta();
      t.value = state.drafts[chatId || 'new'] || '';
      autosize();
      t.addEventListener('input', () => { state.drafts[chatId || 'new'] = t.value; save(); autosize(); });
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
      root.querySelector('#composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
      root.addEventListener('click', onClick);
      root.addEventListener('mouseover', hoverCite);
      root.addEventListener('focusin', hoverCite);
      this.update(route, true);
    },
    update(route, first = false) {
      const c = chatId ? getChat(chatId) : null;
      const inner = root.querySelector('#chatInner');
      const scroll = root.querySelector('#chatScroll');
      if (chatId && !c) {
        inner.innerHTML = `<div class="empty-card center"><h2>Диалог не найден</h2><p>Возможно, он был удалён или ссылка открыта в другом браузере: история хранится локально.</p><a class="btn btn-primary" href="#/">Начать новый диалог</a></div>`;
        root.querySelector('.composer-wrap').hidden = true;
        return;
      }
      const html = !c || !c.messages.length ? startScreen(c)
        : `<header class="chat-title" data-k="${c.id}"><h1>${esc(c.title)}</h1><span class="muted">${fmtDate(c.createdAt)}</span></header>${c.messages.map((m) => messageHtml(c, m)).join('')}`;
      if (html !== lastHtml) {
        const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
        const count = c?.messages.length || 0;
        inner.innerHTML = html;
        lastHtml = html;
        // При открытии вида старое не анимируем — только стартовый экран и то, что сейчас отправлено.
        reveal(inner, seen, first ? (k) => k === 'start' || justSent.has(k.split(':')[0]) : undefined);
        if (first || count > lastCount || atBottom) {
          const lastUser = [...inner.querySelectorAll('.msg.user')].pop();
          // Новый ответ: показываем вопрос и начало ответа, а не конец длинного ответа.
          if (count > lastCount && lastUser && !first) lastUser.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
          else if (first && route?.query.get('m')) inner.querySelector(`#m-${route.query.get('m')}`)?.scrollIntoView({ block: 'start' });
          else if (first && count) scroll.scrollTop = scroll.scrollHeight; // стартовый экран — с начала
        }
        lastCount = count;
      }
      // Открытый в панели источник отмечаем и в ответе: карточку и ссылку [n].
      root.querySelectorAll('.src-card.on, .cite.on').forEach((x) => x.classList.remove('on'));
      const [srcMsg, srcKey] = (route?.query.get('src') || '').split(':');
      if (srcKey) {
        root.querySelector(`[data-open="${CSS.escape(srcMsg)}:${CSS.escape(srcKey)}"]`)?.closest('.src-card').classList.add('on');
        root.querySelectorAll(`.cite[data-msg="${CSS.escape(srcMsg)}"][data-cite="${CSS.escape(srcKey)}"]`).forEach((x) => x.classList.add('on'));
      }
      const inf = info(c);
      const sb = root.querySelector('#scopeBar');
      const sbHtml = scopeBar(c);
      if (sb._html !== sbHtml) { sb.innerHTML = sbHtml; sb._html = sbHtml; } // не сбрасываем фокус без нужды
      const pending = c?.messages.some((m) => m.pending);
      root.querySelector('.send-btn').disabled = !inf.ready.length || pending;
      ta().placeholder = !inf.ready.length ? 'Нет готовых документов' : c?.messages.length ? 'Задайте уточняющий вопрос…' : 'Задайте вопрос по документам…';
      if (first && !route?.query.get('src') && matchMedia('(min-width: 900px)').matches) ta().focus();
    },
  };
}
