// Экран чата: стартовый экран, сообщения, ответы с источниками, область поиска, ввод.

import { state, chat as getChat, doc as getDoc, collection, commit, emit, save, createChat, toggleSaved, uid, liveDocs, loadDemo, restoreDocs, accessibleDocs, visibleCollections, isContractor, role } from './store.js';
import { askAI, scopeInfo } from './agent.js';
import { EXAMPLES, EXAMPLES_EXT, FILES } from '../demo/manifest.js';
import { lattice, ring } from './fx.js';
import { esc, icon, inline, anchor, plural, nDocs, fmtDate, toast, modal, statusBadge, TYPE, reveal } from './ui.js';

const running = new Map(); // msgId → { cancelled, ctrl }
const justSent = new Set(); // id нового диалога и сообщений: анимируются, даже если вид только что открыт
let morph = null; // id вопроса, в который «перелетает» пример или поле ввода (View Transitions)
const inDocs = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'документе' : 'документах'}`;
const shortName = (name) => name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export const scopeOf = (c) => (c ? c.scope : state.newScope);
// Агент получает только документы, доступные роли: фильтр до поиска, а не после.
const info = (c) => scopeInfo(scopeOf(c), accessibleDocs(), visibleCollections());
const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

// ---------- Отправка и формирование ответа ----------
async function runAnswer(c, m) {
  const token = { cancelled: false, ctrl: new AbortController() };
  running.set(m.id, token);
  m.t0 = Date.now();
  const step = async (i, ms) => { m.step = i; emit(); await pause(ms); return token.cancelled; };
  const idx = c.messages.indexOf(m);
  const question = c.messages[idx - 1].text;
  const fail = state.settings.failNext;
  // Поиск фрагментов синхронный и заканчивается сразу; паузы между шагами — только чтобы их было видно.
  const job = fail ? null : askAI({ question, history: c.messages.slice(0, idx - 1), scope: c.scope, docs: accessibleDocs(), collections: visibleCollections() },
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
  m.ms = Date.now() - m.t0;
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
  Object.assign(m, { pending: true, step: 0, error: null, stopped: false, answer: null, found: null, checks: 0, ms: null });
  commit();
  runAnswer(c, m);
}

function stop(c, m) {
  const t = running.get(m.id);
  if (t) { t.cancelled = true; t.ctrl.abort(); }
  running.delete(m.id);
  Object.assign(m, { pending: false, stopped: true, ms: Date.now() - (m.t0 || Date.now()) });
  delete m.found; delete m.checks;
  commit();
}

export function setScope(c, scope) {
  if (c) {
    const before = JSON.stringify(c.scope);
    c.scope = scope;
    if (before !== JSON.stringify(scope) && c.messages.length) {
      c.messages.push({ id: uid(), role: 'system', text: `Область поиска изменена: ${scopeInfo(scope, accessibleDocs(), visibleCollections()).label}`, at: Date.now() });
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
    note = inf.pending ? `Ответ — по ${nDocs(inf.ready.length)}; ${extra.join(', ')}.` : ''; // ошибки чтения видны в карточке базы
  }
  const actions = tone === 'warn' ? `<span class="scope-actions">${liveDocs().some((d) => d.status === 'ready') && scopeOf(c).type !== 'all' ? '<button type="button" class="link-btn" data-act="scope-all">Искать во всех документах</button>' : ''}<a class="link-btn" href="#/docs">Открыть документы</a></span>` : '';
  return `<button type="button" class="scope-chip ${tone}" data-act="scope" aria-haspopup="dialog">
      ${icon('scope')}<span class="scope-label">Область: <b>${esc(inf.label)}</b></span>
      <span class="scope-count">${inf.ready.length} ${plural(inf.ready.length, 'готов', 'готовы', 'готовы')}</span>${icon('chevron', 'sm')}
    </button>
    ${note ? `<span class="scope-note ${tone}" role="status">${esc(note)} ${actions}</span>` : ''}`;
}

// Стартовый экран — без рекламного текста: состояние базы (кольцо готовности) и вопросы, с которых можно начать.
// Карточка базы — это шаг «готовность к поиску» из основного пути, по нажатию открывает документы.
function kbCard() {
  const all = liveDocs();
  const ready = all.filter((d) => d.status === 'ready');
  const err = all.filter((d) => d.status === 'error').length;
  const pending = all.length - ready.length - err;
  const chunks = ready.reduce((n, d) => n + (d.chunks || 0), 0);
  const cols = new Set(all.map((d) => d.collectionId).filter(Boolean)).size;
  const r = ring({ key: 'home', ready: ready.length, error: err, total: all.length, size: 58, width: 6, center: `<b data-cu="home:ready" data-to="${ready.length}">${ready.length}</b><small>/${all.length}</small>` });
  const title = pending ? `Обработка: ${pending} ${plural(pending, 'файл', 'файла', 'файлов')}` : isContractor() ? 'Документы, открытые подрядчику' : 'База готова к поиску';
  const sub = [`${chunks} ${plural(chunks, 'фрагмент', 'фрагмента', 'фрагментов')}`, `${cols} ${plural(cols, 'коллекция', 'коллекции', 'коллекций')}`, err ? `${err} с ошибкой` : ''].filter(Boolean).join(' · ');
  return `<a class="kb-card spot" href="#/docs" style="--i:0">${r}<span class="kb-text"><b>${pending ? lattice({ pattern: 'snake', mini: true }) : ''}${esc(title)}</b><small>${esc(sub)}</small></span>${icon('next', 'kb-go')}</a>`;
}

function startScreen(c) {
  const inf = info(c);
  const all = liveDocs();
  if (!all.length) {
    const body = isContractor()
      ? `<b>Документы ещё не открыты</b><small>Подрядчик видит только коллекции, к которым ему дали доступ. Переключитесь на роль «Сотрудник», чтобы загрузить демо-набор.</small>`
      : `<b>Документов пока нет</b><small>Демо-набор — ${FILES.length} вымышленных документов стройки участка ВСМ: протоколы, отчёты, акты, регламенты.</small>`;
    return `<div class="start" data-k="start"><div class="kb-card empty" style="--i:0">${ring({ key: 'home', total: 0, size: 58, width: 6 })}<span class="kb-text">${body}</span></div>
      ${isContractor() ? '' : `<div class="start-actions" style="--i:1"><button type="button" class="btn btn-primary" data-act="demo">${icon('upload', 'sm')}Загрузить демо-набор</button><button type="button" class="btn btn-ghost" data-act="pick">Свои файлы</button></div>`}</div>`;
  }
  const list = isContractor() ? EXAMPLES_EXT : EXAMPLES;
  const examples = list.map((e, i) => `<button type="button" class="example spot" style="--i:${i + 2}; --hue:${e.hue}" data-ask="${esc(e.q)}" ${inf.ready.length ? '' : 'disabled'}>
      <span class="ex-tile" aria-hidden="true">${icon(e.icon)}</span><span class="ex-kind">${esc(e.kind)}</span><span class="ex-q">${esc(e.q)}</span></button>`).join('');
  return `<div class="start" data-k="start">
    ${kbCard()}
    <h2 class="ex-title" style="--i:1">${inf.ready.length ? 'С чего начать' : 'Вопросы станут доступны после обработки'}</h2>
    <div class="examples">${examples}</div>
  </div>`;
}

function sourceCard(msgId, s, key, attr = '') {
  const d = state.docs.find((x) => x.id === s.docId);
  const gone = !d ? 'Документ удалён — источник недоступен.' : d.deletedAt ? 'Документ в корзине.' : null;
  const ext = extOf(s.docName);
  return `<li class="src-card spot ${gone ? 'gone' : ''}" data-src-n="${s.n}" ${attr}>
    <button type="button" class="src-open" data-open="${msgId}:${key}" ${!d ? 'disabled' : ''} aria-label="Открыть источник ${s.n}: ${esc(s.docName)}, ${esc(anchor(s))}">
      <span class="src-thumb" aria-hidden="true"><span class="ftype ft-${ext}">${TYPE[ext] || '?'}</span><span class="src-n">${s.n}</span></span>
      <span class="src-meta"><span class="src-doc">${esc(shortName(s.docName))}</span><span class="src-anchor">${esc(anchor(s))}</span></span>
      ${d ? `<span class="src-go" aria-hidden="true">${icon('next', 'sm')}</span>` : ''}
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
    if (b.t === 'table') return `<div class="table-wrap" ${nx()}><table><thead><tr>${b.head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(b.head[i] || '')}"><span>${inline(c, msgId)}</span></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    if (b.t === 'quotes') return `<ol class="quotes" ${nx()}>${b.items.map((q) => `<li><span class="q-text">«${esc(q.text)}»</span> ${inline(`[${q.n}]`, msgId)}</li>`).join('')}</ol>`;
    return '';
  }).join('');
}

// Можно ли переслать ответ подрядчику: все ли источники лежат в коллекциях, открытых внешним пользователям.
// Подрядчик, получив ответ со ссылками на закрытые документы, не сможет его проверить — сотрудник видит это заранее.
function audience(a) {
  if (isContractor() || a.kind !== 'answer' || !a.sources?.length) return '';
  const closed = a.sources.filter((s) => !collection(getDoc(s.docId)?.collectionId)?.external).length;
  return closed
    ? `<span class="aud" title="${closed} из ${a.sources.length} ${plural(a.sources.length, 'источника', 'источников', 'источников')} в коллекциях, закрытых для подрядчиков: проверить ответ по ним он не сможет">${icon('lock', 'xs')}Только для сотрудников</span>`
    : `<span class="aud open" title="Все источники в коллекциях, открытых подрядчикам">${icon('eye', 'xs')}Можно переслать подрядчику</span>`;
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
  const time = m.ms != null ? `<span class="ans-time" title="Время от вопроса до ответа">${lattice({ status: 'done', label: 'Ответ за', ms: m.ms })}</span>` : '';
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
  return `<div class="ans-head">${head}${mode}${ctx}${time}</div>
    <div class="ans-body">${body}</div>
    ${extra}
    ${n ? `<section class="sources" aria-label="Источники" ${nx()}><h4>Источники</h4><ol>${a.sources.map((s) => sourceCard(m.id, s, s.n, nx())).join('')}</ol></section>` : ''}
    <div class="ans-foot" ${nx()}>
      ${a.kind === 'answer' ? `<button type="button" class="btn btn-sm btn-ghost" data-act="copy" data-msg="${m.id}">${icon('copy', 'sm')}Копировать</button>
      <button type="button" class="btn btn-sm btn-ghost ${saved ? 'on' : ''}" data-act="save" data-msg="${m.id}" aria-pressed="${saved}">${icon('bookmark', 'sm')}${saved ? 'Сохранено' : 'Сохранить'}</button>` : ''}
      ${audience(a)}
      <details class="how"><summary>Как получен ответ</summary><p>${how}</p></details>
    </div>
    ${a.suggest?.length ? `<div class="suggest" aria-label="Уточняющие вопросы">${a.suggest.map((q) => `<button type="button" class="chip" ${nx()} data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}`;
}

function messageHtml(c, m) {
  if (m.role === 'user') return `<div class="msg user" data-k="${m.id}"><div class="bubble"${morph === m.id ? ' style="view-transition-name:qfly"' : ''}>${esc(m.text)}</div></div>`;
  if (m.role === 'system') return `<div class="msg system" role="note" data-k="${m.id}">${icon('scope', 'sm')}${esc(m.text)}</div>`;
  let body;
  if (m.pending) body = thinkingHtml(c, m);
  else if (m.error || m.stopped) {
    body = `<div class="ans-error" role="alert">${icon('alert')}<div><b>${m.stopped ? 'Ответ остановлен' : 'Не удалось получить ответ'}</b>${m.ms != null ? lattice({ status: 'error', label: m.stopped ? 'Остановлен через' : 'Сбой через', ms: m.ms }) : ''}<span>${esc(m.error || 'Вы остановили формирование ответа.')}</span></div>
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
  // Заготовки карточек источников (скелет «широкой карточки»): тип файла уже известен, текст ещё нет.
  const skel = f ? `<ol class="sk-list" aria-hidden="true" data-k="${m.id}:sk">${f.docs.slice(0, 3).map((d, i) => `<li class="sk-card" style="--i:${i}"><span class="ftype ft-${extOf(d)}">${TYPE[extOf(d)] || '?'}</span><span class="sk-lines"><i></i><i></i><i></i></span><span class="sk-pill"></span></li>`).join('')}</ol>` : '';
  return `<div class="thinking" role="status" aria-live="polite">
    <div class="think-title">${lattice({ label: `Ищу ответ в ${inDocs(inf.ready.length)} · «${inf.label}»`, t0: m.t0 })}</div>
    <ol class="think-steps">${steps.map(([t, x], i) => `<li class="${i < m.step ? 'done' : i === m.step ? 'now' : ''}">
      <span class="st-ic" ${i < m.step ? `data-k="${m.id}:d${i}"` : ''}>${i < m.step ? icon('check', 'sm') : '<span class="dot"></span>'}</span><div class="st-body"><span>${t}</span>${x}</div></li>`).join('')}</ol>
    ${skel}
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
  const cols = [...visibleCollections().map((x) => ({ id: x.id, name: x.name })), ...(live.some((d) => !d.collectionId) ? [{ id: null, name: 'Без коллекции' }] : [])];
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

  // Новый диалог: вопрос «перелетает» из примера или поля ввода в пузырь сообщения (View Transitions API).
  // Без поддержки API или при «уменьшить движение» — обычный переход.
  function submit(text, from = null) {
    const go = () => {
      const c = send(chatId, text ?? ta().value);
      if (!c) return;
      if (chatId) { ta().value = ''; autosize(); return; }
      morph = c.messages[0].id;
      location.hash = `#/c/${c.id}`;
      dispatchEvent(new HashChangeEvent('hashchange')); // отрисовать сразу, внутри перехода
    };
    if (chatId || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches || !info(null).ready.length) return go();
    const src = from || root.querySelector('.composer');
    src.style.viewTransitionName = 'qfly';
    document.documentElement.classList.add('vt-morph');
    const t = document.startViewTransition(go);
    t.finished.finally(() => { morph = null; document.documentElement.classList.remove('vt-morph'); src.style.viewTransitionName = ''; });
  }

  function onClick(e) {
    const t = e.target.closest('[data-act],[data-ask],[data-open],.cite,[data-restore]');
    if (!t) return;
    const c = chatId ? getChat(chatId) : null;
    if (t.matches('.cite')) return openSource(t.dataset.msg, t.dataset.cite);
    if (t.dataset.open) { const [msg, key] = t.dataset.open.split(':'); return openSource(msg, key); }
    if (t.dataset.ask) return submit(t.dataset.ask, t.closest('.example'));
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
      let c = chatId ? getChat(chatId) : null;
      const inner = root.querySelector('#chatInner');
      const scroll = root.querySelector('#chatScroll');
      const foreign = c && (c.role || 'staff') !== role();
      if (foreign) c = null;
      if (chatId && !c) {
        inner.innerHTML = foreign
          ? `<div class="empty-card center">${icon('lock', 'lg')}<h2>Диалог другой роли</h2><p>Этот диалог вёл ${isContractor() ? 'сотрудник' : 'подрядчик'}. В текущей роли он недоступен — у ролей разные документы.</p><a class="btn btn-primary" href="#/">Новый диалог</a></div>`
          : `<div class="empty-card center"><h2>Диалог не найден</h2><p>Возможно, он был удалён или ссылка открыта в другом браузере: история хранится локально.</p><a class="btn btn-primary" href="#/">Начать новый диалог</a></div>`;
        root.querySelector('.composer-wrap').hidden = true;
        return;
      }
      const html = !c || !c.messages.length ? startScreen(c)
        : `<header class="chat-title" data-k="${c.id}"><h1>${esc(c.title)}</h1><span class="muted">${fmtDate(c.createdAt)}</span></header>${c.messages.map((m) => messageHtml(c, m)).join('')}`;
      root.classList.toggle('is-start', !c || !c.messages.length);
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
