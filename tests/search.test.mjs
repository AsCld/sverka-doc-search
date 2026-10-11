// Модульные проверки поиска и агента без браузера: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { stem, sentences, chunkPages, buildIndex, search } from '../js/search.js';
import { ask, askAI, findQuote, scopeInfo } from '../js/agent.js';

test('стемминг сводит формы слова к одной основе', () => {
  assert.equal(stem('бетонирования'), stem('бетонирование'));
  assert.equal(stem('поставки'), stem('поставка'));
  assert.equal(stem('Тьма'), stem('Тьму'));
});

test('предложения не режутся на сокращениях «р.» и инициалах', () => {
  assert.deepEqual(sentences('Мост через р. Тьма готов. Ковалёв А.С. доложил.'), ['Мост через р. Тьма готов.', 'Ковалёв А.С. доложил.']);
});

const docs = [
  { id: 'a', name: 'Отчёт.pdf', status: 'ready', collectionId: 'c1', blocks: [
    { n: 1, section: '1. Ресурсы', text: 'Численность персонала — 412 человек.\nТехника: 96 единиц, из них 7 в ремонте.' },
    { n: 2, section: '2. Риски', text: 'Похолодание: температура ниже +5 °C ограничит бетонные работы.' },
  ] },
  { id: 'b', name: 'Регламент.docx', status: 'ready', collectionId: 'c2', blocks: [
    { n: null, section: 'Уведомления', text: 'Технадзор уведомляют не позднее чем за 3 рабочих дня.' },
  ] },
  { id: 'c', name: 'Скан.pdf', status: 'error', collectionId: 'c1', blocks: [] },
];
const cols = [{ id: 'c1', name: 'Участок' }, { id: 'c2', name: 'Нормативы' }];

test('BM25 находит нужный фрагмент и возвращает страницу и раздел', () => {
  const idx = buildIndex(docs.flatMap((d) => chunkPages(d.id, d.blocks)));
  const r = search(idx, 'сколько техники в ремонте');
  assert.equal(r.results[0].chunk.page, 1);
  assert.equal(r.results[0].chunk.section, '1. Ресурсы');
  assert.ok(r.coverage >= 0.75);
});

test('ответ из цитат с источником', () => {
  const a = ask({ question: 'Сколько техники в ремонте?', scope: { type: 'all' }, docs, collections: cols });
  assert.equal(a.kind, 'answer');
  assert.equal(a.sources[0].docName, 'Отчёт.pdf');
  assert.match(a.sources[0].quote, /7 в ремонте/);
});

test('слова, которого нет в документах, — явное «нет информации»', () => {
  const a = ask({ question: 'Какой бюджет участка?', scope: { type: 'all' }, docs, collections: cols });
  assert.equal(a.kind, 'noinfo');
  assert.equal(a.sources.length, 0);
});

test('область поиска ограничивает ответ и подсказывает, где искать', () => {
  const a = ask({ question: 'За сколько дней уведомляют технадзор?', scope: { type: 'collection', id: 'c1' }, docs, collections: cols });
  assert.equal(a.kind, 'noinfo');
  assert.deepEqual(a.outside.names, ['Регламент.docx']);
});

test('уточняющий вопрос использует контекст предыдущего', () => {
  const first = { role: 'user', text: 'Какие риски по бетонным работам?' };
  const a = ask({ question: 'А при какой температуре это?', history: [first, { role: 'assistant', answer: {} }], scope: { type: 'all' }, docs, collections: cols });
  assert.equal(a.kind, 'answer');
  assert.equal(a.context, first.text);
  assert.match(a.sources[0].quote, /\+5 °C/);
});

test('документы с ошибкой не участвуют в поиске; пустая область распознаётся', () => {
  const inf = scopeInfo({ type: 'docs', ids: ['c'] }, docs, cols);
  assert.equal(inf.ready.length, 0);
  assert.equal(ask({ question: 'что угодно', scope: { type: 'docs', ids: ['c'] }, docs, collections: cols }).kind, 'noscope');
});

test('цитата модели находится в тексте без учёта регистра и пунктуации; выдуманная — нет', () => {
  const t = 'Техника: 96 единиц, из них 7 в ремонте.';
  assert.equal(findQuote(t, 'техника — 96 единиц из них 7 в ремонте'), 'Техника: 96 единиц, из них 7 в ремонте');
  assert.equal(findQuote(t, 'Техника: 96 единиц, из них 9 в ремонте.'), null);
});

const reply = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
const q = { question: 'Сколько техники в ремонте?', scope: { type: 'all' }, docs, collections: cols };

test('ответ модели: ссылки перенумерованы, источник — точная цитата документа', async () => {
  const a = await askAI(q, { fetchFn: reply({ status: 'answer', answer: 'В ремонте **7** единиц [1].', quotes: [{ n: 1, quote: 'из них 7 в ремонте' }], model: 'm' }) });
  assert.equal(a.mode, 'model');
  assert.equal(a.status, 'confirmed');
  assert.equal(a.sources.length, 1);
  assert.equal(a.sources[0].quote, 'из них 7 в ремонте');
  assert.equal(a.sources[0].page, 1);
});

test('модель недоступна или цитата не сверилась — запасной режим из цитат', async () => {
  const down = await askAI(q, { fetchFn: reply({ error: 'rate_limit' }, 429) });
  assert.equal(down.mode, 'extractive');
  assert.match(down.fallback, /лимит/);
  const fake = await askAI(q, { fetchFn: reply({ status: 'answer', answer: 'В ремонте 100 единиц [1].', quotes: [{ n: 1, quote: 'в ремонте 100 единиц техники' }] }) });
  assert.equal(fake.mode, 'extractive');
  assert.match(fake.fallback, /сверку/);
});

test('модель не дала цитату — подтверждаем ссылку предложением фрагмента; выдуманное число — отказ', async () => {
  const noQuote = await askAI(q, { fetchFn: reply({ status: 'answer', answer: 'В ремонте **7** единиц техники [1].",\n  ', quotes: [] }) });
  assert.equal(noQuote.mode, 'model');
  assert.equal(noQuote.sources[0].quote, 'Техника: 96 единиц, из них 7 в ремонте.');
  assert.equal(noQuote.blocks.at(-1).text, 'В ремонте **7** единиц техники [1].');
  const wrongNum = await askAI(q, { fetchFn: reply({ status: 'answer', answer: 'В ремонте 9 единиц техники [1].', quotes: [{ n: 1, quote: 'из них 7 в ремонте' }] }) });
  assert.match(wrongNum.fallback, /число «9»/);
});

test('дата из названия документа и «28» из 28.09.2026 не считаются выдумкой; «нет ответа» модели не перекрывает найденное', async () => {
  const d = [{ ...docs[0], name: 'Протокол_№39_от_28.09.2026.docx' }, docs[1], docs[2]];
  const a = await askAI({ ...q, docs: d }, { fetchFn: reply({ status: 'answer', answer: 'По протоколу от 28 сентября в ремонте 7 единиц [1].', quotes: [{ n: 1, quote: 'из них 7 в ремонте' }] }) });
  assert.equal(a.mode, 'model');
  const none = await askAI(q, { fetchFn: reply({ status: 'none', answer: 'Нет информации [1], [2].",' }) });
  assert.equal(none.kind, 'answer');
  assert.match(none.fallback, /не нашла/);
});

test('функция модели отрезает протёкший в ответ JSON и достаёт из него цитаты', async () => {
  const { repair } = await import('../api/ask.js');
  const r = repair({ status: 'answer', answer: 'Срок — **20.10.2026** [1].",\n  "quotes": [\n {\n "n": 1,\n "quote": "Срок — 20.10.2026"\n }, {"n": 2, "quote": "обры', quotes: [] });
  assert.equal(r.answer, 'Срок — **20.10.2026** [1].');
  assert.deepEqual(r.quotes, [{ n: 1, quote: 'Срок — 20.10.2026' }]);
  assert.equal(repair({ answer: 'Обычный ответ [1].' }).answer, 'Обычный ответ [1].');
  assert.equal(repair({ answer: 'Риски:\\n- первый [1]' }).answer, 'Риски:\n- первый [1]');
  assert.equal(repair({ answer: 'Срок — 20.10.2026 [1][2].\n\nquotes [\n{' }).answer, 'Срок — 20.10.2026 [1][2].');
  assert.equal(repair({ answer: 'Срок — 20.10.2026 [4][1].  quotes' }).answer, 'Срок — 20.10.2026 [4][1].'); // живой GigaChat, 11.10
});

test('оборванный по длине JSON модели: берём answer и законченные цитаты; без answer — понятная ошибка', async () => {
  const { salvage } = await import('../api/ask.js');
  const r = salvage('{"status": "answer", "answer": "Срок — **20.10.2026** [1].", "quotes": [{"n": 1, "quote": "Срок — 20.10.2026"}, {"n": 2, "quote": "обор', 'length');
  assert.deepEqual(r, { status: 'answer', answer: 'Срок — **20.10.2026** [1].', quotes: [{ n: 1, quote: 'Срок — 20.10.2026' }] });
  assert.throws(() => salvage('', 'length'), /оборван \(length, 0 симв\.\)/);
});

test('уточняющий вопрос уходит в модель вместе с предметом прошлого вопроса', async () => {
  let sent;
  const history = [{ role: 'user', text: 'Сколько техники в ремонте?' }, { role: 'assistant', answer: { blocks: [{ t: 'p', text: '7 единиц' }] } }];
  await askAI({ ...q, question: 'А почему?', history }, { fetchFn: async (u, o) => { sent = JSON.parse(o.body); return reply({ status: 'none', answer: 'нет' })(); } });
  assert.equal(sent.question, 'А почему? (уточнение к вопросу «Сколько техники в ремонте?»)');
});

test('сбой функции модели: причина видна в «Как получен ответ»', async () => {
  const a = await askAI(q, { fetchFn: reply({ error: 'model_error', detail: 'ответ модели оборван (length, 0 симв.)' }, 502) });
  assert.equal(a.mode, 'extractive');
  assert.match(a.fallback, /оборван/);
});

test('лишняя ссылка без ключевого факта убирается, цитата — предложение с этим фактом', async () => {
  const { verifyModel } = await import('../js/agent.js');
  const d = [{ id: 'p', name: 'Протокол.docx' }, { id: 'r', name: 'Отчёт.pdf' }];
  const frags = [
    { docId: 'p', section: 'Решили', text: 'Установить срок бетонирования опор — 20.10.2026. Ответственный — Гусев Д.А.' },
    { docId: 'r', page: 4, text: 'Последствие: сдвиг бетонирования опор моста.' },
  ];
  const v = verifyModel({ answer: 'За бетонирование опор отвечает Гусев Д.А. [1][2]. quotes',
    quotes: [{ n: 1, quote: 'Установить срок бетонирования опор — 20.10.2026' }, { n: 2, quote: 'сдвиг бетонирования опор моста' }] }, frags, d);
  assert.equal(v.sources.length, 1);
  assert.match(v.sources[0].quote, /20\.10\.2026\. Ответственный — Гусев Д\.А/);
  assert.equal(v.blocks.at(-1).text, 'За бетонирование опор отвечает Гусев Д.А. [1].');
});

test('модель не дала цитат — у каждого утверждения своё предложение фрагмента, с ключевым фактом', async () => {
  const { verifyModel } = await import('../js/agent.js');
  const d = [{ id: 'r', name: 'Отчёт.pdf' }];
  const frags = [{ docId: 'r', page: 3, text: 'Ростверки опор выполнены. Срок завершения бетонирования опор — 20.10.2026 согласно протоколу. Бетонирование тела опор начнётся после поставки остатка арматуры.' }];
  const v = verifyModel({ answer: 'Срок бетонирования опор — **20.10.2026** [1]. Бетонирование начнётся после поставки остатка арматуры [1].', quotes: [] }, frags, d);
  assert.equal(v.sources[0].quote, 'Срок завершения бетонирования опор — 20.10.2026 согласно протоколу. Бетонирование тела опор начнётся после поставки остатка арматуры.');
});

test('модель не дала цитат, а лучшее по словам предложение без фамилии — показываем предложение с фамилией', async () => {
  const { verifyModel } = await import('../js/agent.js');
  const frags = [{ docId: 'p', section: 'Решили', text: '1. Установить новый срок завершения бетонирования опор моста — 20.10.2026. Ответственный — Гусев Д.А.' }];
  const v = verifyModel({ answer: 'За завершение бетонирования опор моста отвечает **Гусев Д.А.** [1].', quotes: [] }, frags, [{ id: 'p', name: 'Протокол.docx' }]);
  assert.match(v.sources[0].quote, /Гусев Д\.А/);
});

test('пункт списка целиком жирным и хвост «\'» из JSON убираются', async () => {
  const { verifyModel } = await import('../js/agent.js');
  const v = verifyModel({ answer: 'Причины отставания [1]:\n- **Недопоставка арматуры для опор моста.**\'', quotes: [] },
    [{ docId: 'r', page: 1, text: 'Основная причина отставания — недопоставка арматуры для опор моста.' }], [{ id: 'r', name: 'Отчёт.pdf' }]);
  assert.deepEqual(v.blocks.at(-1), { t: 'ul', items: ['Недопоставка арматуры для опор моста.'] });
});

test('вопросительные и «просящие» слова не делают вопрос «без ответа»', () => {
  const a = ask({ ...q, question: 'Подскажите, почему техника в ремонте?' });
  assert.equal(a.kind, 'answer');
  assert.equal(ask({ ...q, question: 'Какой бюджет на технику?' }).kind, 'noinfo');
});
