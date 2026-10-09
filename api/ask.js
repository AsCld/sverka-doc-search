// Vercel Function: вопрос + найденные поиском фрагменты → GigaChat → ответ со ссылками [n] и цитатами.
// Ключ авторизации — только в переменной окружения GIGACHAT_AUTH_KEY на Vercel; в репозитории и в браузере его нет.
// В модель уходят только найденные фрагменты (до 12), а не документы целиком.
// Проверку цитат делает браузер (js/agent.js): сервер ответу модели не доверяет и ничего не правит.

import https from 'node:https';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { RU_CA } from './_ca.js';

// GigaChat-2-Max точнее, но длинные ответы пишет 10–30 с; GigaChat-2-Pro / GigaChat-2 быстрее.
const MODEL = process.env.GIGACHAT_MODEL || 'GigaChat-2-Max';
const SCOPE = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS'; // физлицо
const API = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';
const OAUTH = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
// Серверы GigaChat подписаны НУЦ Минцифры: доверяем стандартным корневым сертификатам плюс ему.
const agent = new https.Agent({ ca: [...tls.rootCertificates, ...RU_CA], keepAlive: true });

const SYSTEM = `Ты — агент поиска по рабочим документам (регламенты, протоколы, отчёты, планы). Отвечай по-русски.
Правила:
1. Используй только факты из пронумерованных фрагментов. Ничего не добавляй от себя и не додумывай.
2. После каждого утверждения ставь ссылку на фрагмент: [1], [2]. Ссылайся только на фрагменты, которые действительно подтверждают утверждение.
3. В quotes для КАЖДОГО фрагмента, на который ссылаешься, дай одну дословную цитату из него: точная копия подряд идущего текста фрагмента, 1–2 предложения, без пересказа, сокращений и многоточий.
4. Нет ответа во фрагментах — status "none", answer — одно предложение, чего именно нет в документах, quotes пустой. Ответ есть лишь частично — status "partial", в missing коротко укажи, чего не хватает.
5. Пиши кратко: 1–3 абзаца или список (каждый пункт — строка, начинающаяся с "- "). Ключевые факты (даты, числа, ФИО) выделяй **так** и пиши точно как в документе (20.10.2026, а не «20 октября»). Без заголовков и таблиц.
6. Уточняющий вопрос («а кто за это отвечает?», «почему?») относится к предмету предыдущего вопроса: отвечай только про него, а не про всё подряд во фрагментах.
7. Если фрагменты расходятся (например, разные протоколы), приведи оба варианта и укажи, какой документ новее.
8. В suggest дай 2 коротких уточняющих вопроса, на которые, судя по фрагментам, тоже есть ответ.
Ответ верни вызовом функции answer.`;

// Ответ модели принимаем вызовом функции: так GigaChat возвращает JSON по схеме, а не свободный текст.
const ANSWER_FN = {
  name: 'answer',
  description: 'Вернуть ответ на вопрос по фрагментам документов',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['answer', 'partial', 'none'], description: 'answer — ответ есть, partial — частично, none — нет во фрагментах' },
      answer: { type: 'string', description: 'Текст ответа со ссылками [n] на фрагменты' },
      quotes: { type: 'array', description: 'Дословные цитаты для каждой ссылки', items: { type: 'object', properties: { n: { type: 'integer', description: 'Номер фрагмента' }, quote: { type: 'string', description: 'Точная копия текста из фрагмента' } }, required: ['n', 'quote'] } },
      missing: { type: 'string', description: 'Чего не хватает для полного ответа' },
      suggest: { type: 'array', items: { type: 'string' }, description: 'Два уточняющих вопроса' },
    },
    required: ['status', 'answer', 'quotes'],
  },
};

const s = (v, max) => String(v ?? '').slice(0, max);

// GigaChat иногда «протекает»: дописывает остаток JSON (quotes, status…) внутрь строки answer.
// Отрезаем протечку и, если массив quotes пуст, достаём цитаты из неё. Факты не трогаем — их сверяет браузер.
export function repair(out) {
  const a = String(out.answer ?? '');
  const leak = a.search(/["\s,]*"?\b(quotes|status|missing|suggest)"?\s*:/);
  if (leak < 0) return out;
  const quotes = [...a.slice(leak).matchAll(/"?n"?\s*:\s*(\d+)\s*,\s*"?quote"?\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => ({ n: +m[1], quote: m[2].replace(/\\"/g, '"') }));
  return { ...out, answer: a.slice(0, leak), quotes: out.quotes?.length ? out.quotes : quotes };
}

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, agent, timeout: 50000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = { message: data.slice(0, 300) }; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// Токен живёт 30 минут; держим его между «тёплыми» вызовами функции и обновляем заранее.
let token = null;
async function getToken(key) {
  if (token && token.until > Date.now()) return token.value;
  const r = await post(OAUTH, {
    authorization: `Basic ${key}`, RqUID: randomUUID(),
    'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
  }, `scope=${SCOPE}`);
  if (r.status !== 200 || !r.json.access_token) throw new Error(`авторизация GigaChat: ${r.status} ${s(r.json.message, 200)}`);
  token = { value: r.json.access_token, until: Date.now() + 25 * 60 * 1000 };
  return token.value;
}

async function chat(key, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await post(API, { authorization: `Bearer ${await getToken(key)}`, 'content-type': 'application/json', accept: 'application/json' }, JSON.stringify(body));
    if (r.status !== 401 || attempt) return r;
    token = null; // токен отозван раньше срока — получаем новый и повторяем один раз
  }
}

export default async function handler(req, res) {
  // ponytail: CORS для всех и без лимита запросов — защищает только квота ключа; ограничить origin, если ключ платный.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const key = process.env.GIGACHAT_AUTH_KEY;
  if (!key) return res.status(503).json({ error: 'no_key' });

  const { question, history = [], fragments = [] } = req.body || {};
  if (typeof question !== 'string' || !question.trim() || !Array.isArray(fragments) || !fragments.length || fragments.length > 12) {
    return res.status(400).json({ error: 'bad_request' });
  }
  const hist = (Array.isArray(history) ? history : []).slice(-2)
    .map((h) => `Вопрос: ${s(h.q, 500)}\nОтвет: ${s(h.a, 1500)}`).join('\n\n');
  const frags = fragments.map((f, i) => `[${i + 1}] ${s(f.doc, 200)} — ${s(f.where, 200)}\n${s(f.text, 3000)}`).join('\n\n');
  const prompt = `${hist ? `Предыдущие вопросы диалога (только чтобы понять уточнение; факты бери из фрагментов):\n${hist}\n\n` : ''}Фрагменты документов:\n\n${frags}\n\nВопрос: ${s(question, 1000)}`;

  try {
    const r = await chat(key, {
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      functions: [ANSWER_FN],
      function_call: { name: 'answer' },
      max_tokens: 1000, // ответы короткие; без предела модель иногда «зацикливается» и пишет минуту
    });
    if (r.status !== 200) {
      return res.status(r.status === 429 ? 429 : 502).json({ error: r.status === 429 ? 'rate_limit' : 'model_error', detail: s(r.json.message, 300) });
    }
    const msg = r.json.choices?.[0]?.message || {};
    let out = msg.function_call?.arguments ?? msg.content;
    if (typeof out === 'string') out = JSON.parse(out.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return res.status(200).json({ ...repair(out), model: MODEL });
  } catch (e) {
    return res.status(502).json({ error: 'model_error', detail: s(e.message, 300) });
  }
}
