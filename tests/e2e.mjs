// Сквозная проверка сценария из задания (раздел 07) в Chromium.
// Запуск: npm i && node tests/e2e.mjs   (CHROMIUM_PATH=… — если браузер Playwright уже установлен в системе)
// SHOTS=1 — дополнительно сохранить скриншоты в docs/screens/.

import { chromium } from 'playwright';
import { serve } from './serve.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const SHOTS = process.env.SHOTS ? new URL('../docs/screens/', import.meta.url).pathname : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const srv = await serve();
const BASE = `http://localhost:${srv.address().port}/`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// Для скриншотов — «уменьшить движение»: кадры снимаются в итоговом состоянии, а не посреди анимации.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: SHOTS ? 'reduce' : 'no-preference' });
// Модель подменяется: по умолчанию функция «недоступна» (503) — проверяется запасной режим без модели.
// MODEL = (body) => ответ — имитирует Gemini, чтобы проверить сверку цитат без сети и ключа.
let MODEL = null;
await ctx.route('**/api/ask', (route) => (MODEL
  ? route.fulfill({ json: MODEL(route.request().postDataJSON()) })
  : route.fulfill({ status: 503, json: { error: 'no_key' } })));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('favicon') && !m.location().url?.includes('api/ask') && errors.push(m.text()));

let n = 0;
async function step(name, fn) {
  n++;
  try { await fn(); console.log(`✓ ${n}. ${name}`); }
  catch (e) { console.log(`✗ ${n}. ${name}\n   ${e.message.split('\n').slice(0, 6).join(' ')}`); await page.screenshot({ path: `/tmp/e2e-fail-${n}.png` }); process.exitCode = 1; }
}
const shot = async (name, p = page) => SHOTS && (await p.waitForTimeout(300), p.screenshot({ path: SHOTS + name + '.png' }));
const text = (sel) => page.locator(sel).innerText();
const waitText = (sel, re) => page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.innerText || ''), [sel, re.source]);
const lastAnswer = () => page.locator('.msg.agent').last();
async function ask(q) {
  const before = await page.locator('.msg.user').count();
  await page.fill('#q', q);
  await page.keyboard.press('Enter');
  // Ждём, пока появится новый вопрос и ответ на него закончит формироваться.
  await page.waitForFunction((n) => document.querySelectorAll('.msg.user').length > n && document.querySelector('.msg.agent:last-child') && !document.querySelector('.thinking'), before, { timeout: 10000 });
}

await step('Первый запуск: пустое состояние и объяснение назначения', async () => {
  await page.goto(BASE);
  await page.waitForSelector('.start');
  assert.match(await text('.kb-card'), /Документов пока нет/);
  assert.ok(await page.isVisible('[data-act=demo]'));
  await page.waitForSelector('#splash', { state: 'detached', timeout: 5000 }); // заставка уходит сама и не держит клики
  assert.ok(await page.isDisabled('.send-btn'));
  await shot('01-first-run');
  await page.goto(BASE + '#/docs');
  assert.match(await text('#docList'), /Добавьте первые документы/);
});

await step('Загрузка демо-набора: очередь → обработка → готовность, скан — ошибка', async () => {
  await page.click('#docList [data-act=demo]');
  await page.waitForSelector('.st-proc, .st-queued');
  await shot('02-processing');
  await page.waitForFunction(() => !document.querySelector('.st-proc, .st-queued'), null, { timeout: 30000 });
  assert.equal(await page.locator('.doc-row .st-ready').count(), 16);
  assert.equal(await page.locator('.doc-row .st-error').count(), 1);
  assert.match(await text('.doc-row.err'), /нет текстового слоя/);
  assert.match(await text('#sidebar'), /требует внимания/);
  await shot('03-documents');
});

await step('Поиск по названию, фильтр по статусу, поиск без результатов', async () => {
  await page.fill('#docSearch', 'протокол');
  assert.equal(await page.locator('.doc-row').count(), 4);
  await page.fill('#docSearch', 'несуществующий');
  assert.match(await text('#docList'), /Ничего не найдено/);
  await page.click('[data-act=clear]');
  await page.click('[data-filter=error]');
  assert.equal(await page.locator('.doc-row').count(), 1);
  await page.click('[data-filter=all]');
});

await step('Просмотр документа: извлечённый текст с номерами страниц', async () => {
  await page.click('a.doc-name:has-text("Регламент")');
  await page.waitForSelector('.doc-text');
  assert.match(await text('.doc-text'), /страница 2/i);
  assert.match(await text('.doc-text'), /не позднее чем за 3 рабочих дня/);
});

let firstChat;
await step('Область «Снабжение»: ответа нет, агент предлагает расширить область', async () => {
  await page.goto(BASE + '#/');
  await page.click('.scope-chip');
  await page.click('dialog .opt:has-text("Снабжение")');
  await page.click('dialog button:has-text("Применить")');
  await waitText('.scope-chip', /Снабжение/);
  await ask('Какой срок бетонирования опор моста через Тьму?');
  firstChat = page.url();
  assert.match(await lastAnswer().innerText(), /Нет в документах/);
  assert.ok(await lastAnswer().locator('.outside').isVisible());
  await shot('04-out-of-scope');
});

await step('Расширение области и ответ с источниками (поиск факта)', async () => {
  await lastAnswer().locator('[data-act=ask-all]').click();
  await page.waitForFunction(() => !document.querySelector('.thinking'));
  const a = await lastAnswer().innerText();
  assert.match(a, /Подтверждено документами/);
  assert.match(a, /20\.10\.2026/);
  assert.equal(await lastAnswer().locator('.src-card').count(), 3);
  assert.match(await text('.msg.system'), /Теперь ищу в: Все документы/);
  await shot('05-answer');
});

await step('Открытие источника и возврат к диалогу без потери состояния', async () => {
  const before = await page.locator('.msg').count();
  await page.fill('#q', 'черновик уточнения');
  await lastAnswer().locator('.cite').first().click();
  await page.waitForSelector('#panel mark.hl');
  assert.match(await page.locator('#panel mark.hl').first().innerText(), /20\.10\.2026/);
  assert.match(page.url(), /src=/);
  await shot('06-source');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#panel', { state: 'hidden' });
  assert.equal(await page.locator('.msg').count(), before);
  assert.equal(await page.inputValue('#q'), 'черновик уточнения');
  await page.fill('#q', '');
});

await step('Уточняющий вопрос с сохранением контекста', async () => {
  await ask('А кто за это отвечает?');
  const a = await lastAnswer().innerText();
  assert.match(a, /с учётом вопроса/);
  assert.match(a, /Гусев Денис Андреевич/);
  await lastAnswer().locator('.suggest .chip', { hasText: 'Почему' }).click();
  await page.waitForFunction(() => !document.querySelector('.thinking'));
  assert.match(await lastAnswer().innerText(), /недопоставки арматуры/);
});

await step('Нет информации в документах', async () => {
  await ask('Какой бюджет строительства участка?');
  const a = await lastAnswer().innerText();
  assert.match(a, /Нет в документах/);
  assert.match(a, /«бюджет»/);
});

await step('Поиск без подготовленного ответа (обычный BM25)', async () => {
  await ask('Сколько единиц техники в ремонте?');
  const a = await lastAnswer().innerText();
  assert.match(a, /7 единиц в ремонте/);
  assert.match(a, /Отчёт о ходе работ/);
});

await step('Ответ модели: цитаты сверяются с документом, выдуманная цитата — запасной режим', async () => {
  const sentence = (b) => b.fragments[0].text.split(/(?<=\.)\s+/).find((x) => /ремонт/.test(x));
  MODEL = (b) => ({ status: 'answer', answer: 'В ремонте **7 единиц** техники [1].', quotes: [{ n: 1, quote: sentence(b) }], suggest: ['Сколько всего техники на участке?'], model: 'test-model' });
  await ask('Сколько единиц техники в ремонте?');
  let a = await lastAnswer().innerText();
  assert.match(a, /Ответ ИИ · цитаты сверены/);
  assert.match(a, /Подтверждено документами · 1 источник/);
  assert.match(await lastAnswer().locator('.src-quote').innerText(), /ремонте/);
  assert.ok(await lastAnswer().locator('.suggest .chip').isVisible());
  MODEL = () => ({ status: 'answer', answer: 'В ремонте 100 единиц техники [1].', quotes: [{ n: 1, quote: 'В ремонте находится 100 единиц техники.' }], model: 'test-model' });
  await ask('Сколько единиц техники в ремонте?');
  a = await lastAnswer().innerText();
  assert.match(a, /Без ИИ — ответ собран из цитат/);
  assert.match(a, /7 единиц в ремонте/);
  assert.doesNotMatch(a, /100 единиц/);
  MODEL = null;
});

await step('Сохранение ответа', async () => {
  await page.locator('.msg.agent').nth(1).locator('[data-act=save]').click();
  await page.goto(BASE + '#/saved');
  assert.equal(await page.locator('.saved-card').count(), 1);
  await page.goBack();
});

await step('Новый диалог, сводка по нескольким источникам и возврат к предыдущему', async () => {
  await page.click('#sidebar .new-chat');
  await page.waitForSelector('.start');
  await page.click('.example:has-text("риски")');
  await page.waitForSelector('.msg.agent .ans-head'); // новый диалог: первый готовый ответ
  const a = await lastAnswer().innerText();
  assert.match(a, /четыре риска/);
  const docsCited = new Set(await lastAnswer().locator('.src-doc').allInnerTexts());
  assert.ok(docsCited.size >= 2, 'ответ должен ссылаться на несколько документов');
  assert.equal(await page.locator('#sidebar .history li').count(), 2);
  await page.click('#sidebar .history li:nth-child(1) a, #sidebar .history li a >> nth=1');
  await waitText('.chat-inner', /Гусев Денис Андреевич/);
});

await step('Ошибка ответа и повтор', async () => {
  await page.click('[data-act=about]');
  await page.check('dialog [name=fail]');
  await page.click('dialog button:has-text("Готово")');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sverka.v1') || '{}').settings?.failNext);
  await ask('За сколько дней уведомлять технадзор о скрытых работах?');
  assert.match(await lastAnswer().innerText(), /Не удалось получить ответ/);
  await shot('07-error');
  await lastAnswer().locator('[data-act=retry]').click();
  await page.waitForFunction(() => !document.querySelector('.thinking'));
  assert.match(await lastAnswer().innerText(), /3 рабочих дня/);
});

await step('Перемещение документа в другую коллекцию', async () => {
  await page.goto(BASE + '#/docs');
  await page.locator('.doc-row:has-text("План_поставок") [data-act=move]').click();
  await page.click('dialog .opt:has-text("Нормативные документы")');
  await page.click('dialog button:has-text("Переместить")');
  await page.waitForFunction(() => [...document.querySelectorAll('.group')].some((g) => g.querySelector('.group-h').textContent.includes('Нормативные документы') && g.querySelectorAll('.doc-row').length === 3));
});

await step('Удаление с отменой, корзина и восстановление', async () => {
  await page.locator('.doc-row:has-text("Перечень") [data-act=trash]').click();
  await page.click('.toast button:has-text("Отменить")');
  assert.equal(await page.locator('.doc-row:has-text("Перечень")').count(), 1);
  await page.locator('.doc-row:has-text("Перечень") [data-act=trash]').click();
  await page.goto(BASE + '#/docs/trash');
  assert.equal(await page.locator('.doc-row').count(), 1);
  await page.click('.doc-row [data-act=restore]');
  assert.match(await text('#docList'), /Корзина пуста/);
});

await step('Массовые действия: выбрать и спросить по выбранным', async () => {
  await page.goto(BASE + '#/docs');
  await page.locator('.doc-row:has-text("Протокол_совещания_№37") [data-sel]').check();
  await page.locator('.doc-row:has-text("Протокол_совещания_№39") [data-sel]').check();
  assert.match(await text('.bulk'), /Выбрано: 2/);
  await page.click('[data-act=bulk-ask]');
  await page.waitForSelector('.start');
  await waitText('.scope-chip', /Выбрано документов: 2/);
});

await step('Загрузка своих файлов: TXT готов, XLSX — понятная ошибка', async () => {
  await page.goto(BASE + '#/docs');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#headActions [data-act=pick]')]);
  await chooser.setFiles([
    { name: 'Памятка_пропускной_режим.txt', mimeType: 'text/plain', buffer: Buffer.from('Пропуск на объект оформляет служба безопасности.\n\nВременный пропуск действует 5 рабочих дней. Для оформления нужен паспорт и заявка начальника участка.') },
    { name: 'Смета.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK fake') },
  ]);
  await page.waitForFunction(() => !document.querySelector('.st-proc, .st-queued'), null, { timeout: 15000 });
  assert.match(await text('.doc-row:has-text("Памятка_пропускной")'), /Готов к поиску/);
  assert.match(await text('.doc-row:has-text("Смета")'), /не поддерживается/);
  await page.goto(BASE + '#/');
  await page.click('.scope-chip');
  await page.click('dialog .opt:has-text("Все документы")');
  await page.click('dialog button:has-text("Применить")');
  await waitText('.scope-chip', /Все документы/);
  await ask('Сколько действует временный пропуск?');
  assert.match(await lastAnswer().innerText(), /5 рабочих дней/);
});

await step('Перетаскивание файла в коллекцию', async () => {
  const col = await page.evaluate(() => JSON.parse(localStorage.getItem('sverka.v1')).collections.find((c) => c.name === 'Снабжение').id);
  await page.goto(BASE + '#/docs/' + col);
  await page.waitForSelector('.docs-view');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# Заявка\n\nЗаявка на щебень согласована 02.10.2026.'], 'Заявка_щебень.md', { type: 'text/markdown' }));
    for (const type of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.doc-row')].some((r) => r.innerText.includes('Заявка_щебень.md') && r.querySelector('.st-ready')));
  assert.match(await text('#docTitle'), /Снабжение/);
});

await step('Обновление страницы: данные сохраняются, прямые ссылки открываются', async () => {
  await page.waitForTimeout(300); // сохранение в localStorage отложено на 150 мс
  const docsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('sverka.v1')).docs.length);
  await page.reload();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('sverka.v1')).chats.find((c) => c.title.includes('пропуск')).id);
  await page.goto(BASE + '#/c/' + id);
  await page.waitForSelector('.msg.agent');
  assert.match(await lastAnswer().innerText(), /5 рабочих дней/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sverka.v1')).docs.length), docsBefore, 'docs after reload');
  const p2 = await ctx.newPage();
  await p2.goto(firstChat.replace(/\?.*/, '') + '?src=' + await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem('sverka.v1')).chats.find((x) => x.messages.some((m) => m.answer?.curatedId === 'deadline'));
    return c.messages.find((m) => m.answer?.curatedId === 'deadline').id + ':1';
  }));
  await p2.waitForSelector('#panel mark.hl');
  await p2.goto(BASE + '#/docs/trash');
  await p2.waitForSelector('#docList');
  assert.match(await p2.locator('#docTitle').innerText(), /Корзина/);
  await p2.goto(BASE + '#/nope');
  assert.match(await p2.locator('main').innerText(), /Страница не найдена/);
  await p2.close();
});

await step('Узкий экран (390 px): нет горизонтальной прокрутки, источник открывается поверх', async () => {
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: SHOTS ? 'reduce' : 'no-preference' });
  const data = await page.evaluate(() => localStorage.getItem('sverka.v1'));
  await m.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sverka.v1', s); sessionStorage.setItem('seeded', '1'); } }, data);
  await m.goto(firstChat.replace(/\?.*/, ''));
  await m.waitForSelector('.msg.agent');
  const overflow = async () => m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(await overflow() <= 0, 'горизонтальная прокрутка в чате');
  await shot('m1-chat', m);
  assert.ok(await m.isHidden('#tabbar'), 'в диалоге вкладки спрятаны');
  // Лист источника: сначала только цитата, «Показать в документе» — весь текст, вниз за шапку — назад и закрыть.
  await m.locator('.cite').first().click();
  await m.waitForSelector('#panel[data-detent=peek] .panel-quote');
  await m.waitForTimeout(600);
  await shot('m2-source', m);
  await m.click('#panel .pq-expand');
  await m.waitForSelector('#panel[data-detent=full]');
  await m.waitForTimeout(600);
  await shot('m3-source-full', m);
  const drag = async (dy) => { const b = await m.locator('#panel .panel-title').boundingBox(); await m.mouse.move(b.x + 20, b.y + 10); await m.mouse.down(); await m.mouse.move(b.x + 20, b.y + 10 + dy / 2); await m.mouse.move(b.x + 20, b.y + 10 + dy); await m.mouse.up(); };
  await drag(120);
  await m.waitForSelector('#panel[data-detent=peek]');
  await m.waitForTimeout(500);
  await drag(160);
  await m.waitForSelector('#panel', { state: 'hidden' });
  assert.doesNotMatch(m.url(), /src=/);
  await m.click('.topbar .tb-back');
  await m.waitForSelector('.hist-list li');
  assert.ok(await m.locator('.hist-list li').count() >= 2);
  await m.click('#tabbar [data-tab=docs]');
  await m.waitForSelector('.doc-row');
  await m.waitForTimeout(300);
  assert.ok(await overflow() <= 0, 'горизонтальная прокрутка в документах');
  await shot('m4-docs', m);
  await m.click('#tabbar [data-tab=chat]');
  await m.waitForSelector('.start .example');
  await shot('m5-start', m);
  await m.close();
});

await step('Клавиатура: «/» фокусирует поле вопроса, Tab доходит до кнопки отправки', async () => {
  await page.goto(BASE + '#/');
  await page.click('main', { position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
  await page.keyboard.type('Кто отвечает за поставку арматуры?');
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains('send-btn')));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.msg.agent') && !document.querySelector('.thinking'));
  assert.match(await lastAnswer().innerText(), /Морозова Ирина Викторовна/);
  await shot('08-keyboard-answer');
});

await step('Вопрос по выделенному фрагменту документа', async () => {
  await page.goto(BASE + '#/docs');
  await page.click('a.doc-name:has-text("Регламент")');
  await page.waitForSelector('.doc-text p');
  await page.evaluate(() => { const p = [...document.querySelectorAll('.doc-text p')].find((x) => x.textContent.includes('рабочих дня')); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await page.waitForSelector('#selAsk:not([hidden])');
  await page.click('#selAsk');
  await page.waitForSelector('.start');
  assert.match(await page.inputValue('#q'), /^Поясни фрагмент: «.*рабочих дня/);
  await waitText('.scope-chip', /Регламент/);
  await page.fill('#q', '');
});

await step('Роль «Подрядчик»: видна только своя коллекция, закрытое не подсказывается', async () => {
  await page.goto(BASE + '#/');
  await page.click('.role-seg [data-role=contractor]');
  await page.waitForFunction(() => document.body.classList.contains('contractor'));
  await page.goto(BASE + '#/docs');
  await page.waitForSelector('.doc-row');
  assert.equal(await page.locator('.doc-row').count(), 1);
  assert.match(await text('.doc-row'), /Памятка/);
  assert.equal(await page.locator('.doc-row [data-act=trash]:visible, #headActions [data-act=pick]').count(), 0);
  await page.goto(BASE + '#/');
  await page.waitForSelector('.example');
  assert.match(await text('.examples'), /исполнительную документацию/);
  assert.equal(await page.locator('#sidebar .history li').count(), 0, 'диалоги сотрудника скрыты');
  await page.click('.example:has-text("Закрыто для роли")');
  await page.waitForSelector('.msg.agent .ans-head');
  let a = await lastAnswer().innerText();
  assert.match(a, /Нет в документах/);
  assert.equal(await lastAnswer().locator('.outside').count(), 0, 'нельзя подсказывать закрытые документы');
  assert.doesNotMatch(a, /Протокол/);
  await ask('До какого числа сдавать исполнительную документацию?');
  assert.match(await lastAnswer().innerText(), /25-го числа/);
  await shot('09-contractor');
});

await step('Роль «Сотрудник»: доступ коллекции и метка «можно переслать подрядчику»', async () => {
  await page.click('.role-seg [data-role=staff]');
  await page.waitForFunction(() => !document.body.classList.contains('contractor'));
  await page.goto(BASE + '#/');
  await page.waitForSelector('.start');
  await ask('До какого числа сдавать исполнительную документацию?');
  assert.match(await lastAnswer().locator('.aud').innerText(), /Можно переслать подрядчику/);
  await ask('Какой срок бетонирования опор моста через Тьму?');
  assert.match(await lastAnswer().locator('.aud').innerText(), /Только для сотрудников/);
  const col = await page.evaluate(() => JSON.parse(localStorage.getItem('sverka.v1')).collections.find((c) => c.name === 'Снабжение').id);
  await page.goto(BASE + '#/docs/' + col);
  await page.click('label.switch');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sverka.v1')).collections.find((c) => c.name === 'Снабжение').external === true);
  await page.click('.role-seg [data-role=contractor]');
  await page.goto(BASE + '#/docs');
  await page.waitForFunction(() => document.querySelectorAll('.doc-row').length === 3);
  await page.click('.role-seg [data-role=staff]');
});

assert.deepEqual(errors, [], 'ошибки в консоли');
console.log(errors.length ? errors : 'Ошибок в консоли нет.');
await browser.close();
srv.close();
