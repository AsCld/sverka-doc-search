// Логика агента: область поиска → поиск BM25 → ответ модели (GigaChat) с проверкой цитат.
// Без DOM — тестируется в Node. Если модель недоступна или ответ не прошёл сверку, работает
// запасной режим без модели: подготовленный ответ на демо-вопрос (цитаты сверяются с текстом) или дословные цитаты.

import { buildIndex, chunkPages, search, bestSentences, tokens, normalize, stem, idf } from './search.js';
import { CURATED } from '../demo/manifest.js';

const MIN_COVERAGE = 0.5;   // ниже — «нет в документах»
const FULL_COVERAGE = 0.75; // ниже — «частично»

export function scopeInfo(scope, docs, collections) {
  const live = docs.filter((d) => !d.deletedAt);
  let inScope, label;
  if (scope?.type === 'collection') {
    const c = collections.find((x) => x.id === scope.id);
    inScope = live.filter((d) => d.collectionId === scope.id);
    label = c ? c.name : 'Удалённая коллекция';
  } else if (scope?.type === 'docs') {
    inScope = live.filter((d) => scope.ids.includes(d.id));
    label = inScope.length === 1 ? inScope[0].name : `Выбрано документов: ${inScope.length}`;
  } else {
    inScope = live;
    label = 'Все документы';
  }
  return {
    label,
    docs: inScope,
    ready: inScope.filter((d) => d.status === 'ready'),
    pending: inScope.filter((d) => d.status === 'queued' || d.status === 'processing').length,
    errors: inScope.filter((d) => d.status === 'error').length,
  };
}

// Индекс по готовым документам; пересобирается при изменении набора (дёшево для десятков файлов).
let cache = { sig: '', index: null };
function indexFor(readyDocs) {
  const sig = readyDocs.map((d) => d.id).sort().join(',');
  if (sig !== cache.sig) {
    const chunks = readyDocs.flatMap((d) => chunkPages(d.id, d.blocks));
    cache = { sig, index: buildIndex(chunks) };
  }
  return cache.index;
}

export function locate(doc, quote) {
  const q = normalize(quote).toLowerCase();
  for (let i = 0; i < doc.blocks.length; i++) {
    const b = doc.blocks[i];
    if (normalize(b.text).toLowerCase().includes(q)) return { blockIndex: i, page: b.n, section: b.section };
  }
  return null;
}

const FOLLOW = /^(а|и|ещё|еще|тогда|а если|почему|зачем|кто|когда|подробнее|уточни)\b|(?:^|\s)(это|этого|этом|эти|этих|этот|эту|он|она|они|оно|его|её|ее|их|там|тот|та|те|него|неё|ним|ней|них|туда|такой)(?=[\s?.!,]|$)/i;
const FOLLOW_REF = /(?:^|\s)(это|этого|этом|эти|этих|этот|эту|он|она|они|оно|его|её|ее|их|там|тот|него|неё|ним|ней|них|туда|такой)(?=[\s?.!,]|$)/i;
export function isFollowUp(q, prevUser) {
  if (!prevUser) return false;
  return FOLLOW.test(q.trim()) || tokens(q).length <= 2;
}

const stemSet = (words) => new Set(words.map((w) => (/^\d/.test(w) ? w : stem(w))));
const groupsHit = (groups, qs) => groups.every((g) => [...stemSet(g)].some((s) => qs.has(s)));

function pickCurated(question, prevCuratedId, follow) {
  const qs = new Set(question.toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я]+|\d+/g)?.map((w) => (/^\d/.test(w) ? w : stem(w))) || []);
  if (follow && prevCuratedId) {
    for (const c of CURATED) {
      if (!c.after?.includes(prevCuratedId)) continue;
      if (groupsHit(c.afterMatch || c.match, qs)) return c;
    }
  }
  for (const c of CURATED) {
    if (c.after && !c.afterMatch) continue; // только как уточнение
    if (groupsHit(c.match, qs)) return c;
  }
  return null;
}

function resolveCurated(c, readyDocs) {
  const sources = [];
  for (const [i, cite] of c.cites.entries()) {
    const doc = readyDocs.find((d) => d.demoKey === cite.doc);
    const loc = doc && locate(doc, cite.quote);
    if (!loc) return null;
    sources.push({ n: i + 1, docId: doc.id, docName: doc.name, page: loc.page, section: loc.section, blockIndex: loc.blockIndex, quote: cite.quote });
  }
  return sources;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

function originalWords(question, stems) {
  const out = [];
  for (const w of question.match(/[A-Za-zА-Яа-яЁё]+|\d+(?:[.,]\d+)*/g) || []) {
    const s = /^\d/.test(w) ? w : stem(w.toLowerCase());
    if (stems.includes(s) && !out.includes(w.toLowerCase())) out.push(w.toLowerCase());
  }
  return out;
}

function sourceFromChunk(n, chunk, docs, quote) {
  const doc = docs.find((d) => d.id === chunk.docId);
  return { n, docId: doc.id, docName: doc.name, page: chunk.page, section: chunk.section, blockIndex: chunk.pageIndex, quote };
}

// Поиск фрагментов в области. Контекст прошлого вопроса подмешиваем, только если вопрос
// явно ссылается на него («это», «он»…), слишком короткий или сам по себе не находится.
function retrieve(question, history, info, docs, limit) {
  const prevUser = [...history].reverse().find((m) => m.role === 'user');
  const follow = isFollowUp(question, prevUser);
  const allReady = docs.filter((d) => !d.deletedAt && d.status === 'ready');
  const inScope = new Set(info.ready.map((d) => d.id));
  const index = indexFor(allReady);
  const scoped = { filter: (c) => inScope.has(c.docId), limit };
  let r = search(index, question, scoped);
  let context = null;
  if (follow && (FOLLOW_REF.test(question) || r.terms.length <= 1 || r.coverage < MIN_COVERAGE)) {
    const rc = search(index, question, { ...scoped, extra: prevUser.text });
    if (rc.results.length && (rc.coverage >= r.coverage || !r.results.length)) { r = rc; context = prevUser.text; }
  }
  return { r, context, index, inScope, allReady, prevUser, follow };
}

// history: сообщения текущего диалога до вопроса.
export function ask({ question, history = [], scope, docs, collections }) {
  const info = scopeInfo(scope, docs, collections);
  const base = { scope: { label: info.label, ready: info.ready.length, pending: info.pending } };
  if (!info.ready.length) return { ...base, kind: 'noscope', status: 'none', blocks: [], sources: [] };

  const prevAns = [...history].reverse().find((m) => m.role === 'assistant' && m.answer)?.answer;
  const { r, context, index, inScope, allReady, prevUser, follow } = retrieve(question, history, info, docs);

  // 1. Подготовленный ответ — только если все его цитаты найдены в документах области.
  const cur = pickCurated(question, prevAns?.curatedId, follow);
  if (cur) {
    const sources = resolveCurated(cur, info.ready);
    if (sources) {
      const usedPrev = follow && cur.after?.includes(prevAns?.curatedId);
      return { ...base, kind: 'answer', status: 'confirmed', mode: 'prepared', curatedId: cur.id, blocks: cur.blocks, sources, suggest: cur.suggest || [], context: usedPrev ? prevUser.text : null };
    }
  }

  // 2. Поиск по фрагментам.
  const searchedWords = originalWords(question, r.terms);
  const curOutside = cur && !resolveCurated(cur, info.ready) ? resolveCurated(cur, allReady) : null;

  // Слово вопроса, которого нет ни в одном документе (например, «бюджет»), — признак того,
  // что ответа нет: частичное совпадение по общим словам («участок») не считаем ответом.
  if (!r.results.length || r.coverage < MIN_COVERAGE || r.absent.length || curOutside) {
    let outside = null;
    if (curOutside) outside = { names: [...new Set(curOutside.map((x) => x.docName))] };
    else if (info.ready.length < allReady.length) {
      const other = search(index, question, { filter: (c) => !inScope.has(c.docId), extra: context });
      if (other.results.length && other.coverage >= MIN_COVERAGE && !other.absent.length) {
        outside = { names: [...new Set(other.results.slice(0, 3).map((x) => allReady.find((d) => d.id === x.chunk.docId).name))] };
      }
    }
    const near = [];
    if (r.coverage >= 0.2 && !outside) {
      for (const x of r.results) {
        const quote = bestSentences(x.chunk.text, question, context, 1, r.variants)[0];
        if (!quote || near.some((n) => n.quote === quote)) continue;
        near.push(sourceFromChunk(near.length + 1, x.chunk, docs, quote));
        if (near.length === 2) break;
      }
    }
    const missing = originalWords(question, r.missing);
    const lead = curOutside
      ? `В области «${info.label}» нет документов, которые отвечают на этот вопрос.`
      : `В документах области «${info.label}» нет ответа на этот вопрос.`;
    const note = curOutside ? 'Ответ есть в других документах — расширьте область поиска.'
      : missing.length ? `Не найдено ни в одном фрагменте: ${missing.map((w) => `«${w}»`).join(', ')}.`
      : 'Совпадения слишком слабые, чтобы считать их ответом.';
    return {
      ...base, kind: 'noinfo', status: 'none', mode: 'extractive', context,
      blocks: [{ t: 'p', text: lead }, { t: 'note', text: note }],
      sources: [], near, outside, searched: searchedWords, suggest: [],
    };
  }

  // Самый специфичный из найденных терминов: фрагмент без него — скорее шум («участок», «работы»).
  const found = r.terms.filter((t) => !r.missing.includes(t) && [...r.variants.get(t).keys()].some((v) => index.df.get(v)));
  const keyIdf = (t) => Math.max(...[...r.variants.get(t)].filter(([v]) => index.df.get(v)).map(([v, w]) => w * idf(index, v)));
  const key = found.sort((a, b) => keyIdf(b) - keyIdf(a))[0];
  const picked = [];
  const perDoc = new Map();
  const top = r.results[0].score;
  for (const x of r.results) {
    if (picked.length >= 4 || x.score < top * 0.5) break;
    if (picked.length && key && found.length > 1 && ![...r.variants.get(key).keys()].some((v) => x.hit.has(v))) continue;
    if ((perDoc.get(x.chunk.docId) || 0) >= 2) continue;
    const quote = bestSentences(x.chunk.text, question, context, 2, r.variants).join(' ');
    if (!quote || picked.some((p) => p.quote === quote)) continue;
    perDoc.set(x.chunk.docId, (perDoc.get(x.chunk.docId) || 0) + 1);
    picked.push({ chunk: x.chunk, quote });
  }
  const sources = picked.map((p, i) => sourceFromChunk(i + 1, p.chunk, docs, p.quote));
  const nDocs = new Set(sources.map((s) => s.docId)).size;
  const partial = r.coverage < FULL_COVERAGE;
  const missing = originalWords(question, r.missing);
  const blocks = [
    { t: 'p', text: `Нашёл ${sources.length} ${plural(sources.length, 'подходящий фрагмент', 'подходящих фрагмента', 'подходящих фрагментов')} в ${nDocs} ${plural(nDocs, 'документе', 'документах', 'документах')}. Привожу их дословно, без пересказа:` },
    { t: 'quotes', items: sources.map((s) => ({ n: s.n, text: s.quote })) },
  ];
  if (partial && missing.length) blocks.push({ t: 'note', text: `Не нашёл в документах: ${missing.map((w) => `«${w}»`).join(', ')}. Ответ может быть неполным — уточните вопрос.` });
  return { ...base, kind: 'answer', status: partial ? 'partial' : 'confirmed', mode: 'extractive', blocks, sources, suggest: [], context, searched: searchedWords };
}

// ---------- Ответ модели: поиск → GigaChat (api/ask.js на Vercel) → сверка цитат ----------
// Адрес функции модели. Сайт на GitHub Pages обращается к ней напрямую (CORS открыт).
export const API_URL = 'https://sverka-doc-search.vercel.app/api/ask';
const MAX_FRAGS = 8;

// Ищет цитату модели в тексте фрагмента без учёта регистра, пробелов и знаков препинания.
// Возвращает точный кусок оригинала — в источнике показывается текст документа, а не пересказ модели.
export function findQuote(text, quote) {
  const pos = [];
  let flat = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i].toLowerCase().replace('ё', 'е');
    if (/[a-zа-я0-9]/.test(ch)) { pos.push(i); flat += ch; }
  }
  const q = String(quote).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
  const at = q.length >= 10 ? flat.indexOf(q) : -1;
  return at < 0 ? null : text.slice(pos[at], pos[at + q.length - 1] + 1).replace(/\s+/g, ' ');
}

function toBlocks(text) {
  const out = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
    const last = out[out.length - 1];
    if (!li) out.push({ t: 'p', text: line });
    else if (last?.t === 'ul') last.items.push(li[1]);
    else out.push({ t: 'ul', items: [li[1]] });
  }
  return out;
}

// Каждая ссылка [n] ответа должна опираться на дословную цитату из фрагмента n. Нет — ответ отклоняется.
export function verifyModel(res, frags, docs) {
  const text = String(res.answer || '').replace(/\[(\d+(?:\s*,\s*\d+)+)\]/g, (_, l) => l.split(/\s*,\s*/).map((n) => `[${n}]`).join(''));
  const cited = [...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]))];
  if (!cited.length) return { failed: 'в ответе нет ссылок на фрагменты' };
  const sources = [];
  for (const n of cited) {
    const chunk = frags[n - 1];
    const quote = chunk && (res.quotes || []).filter((q) => q.n === n).map((q) => findQuote(chunk.text, q.quote)).find(Boolean);
    if (!quote) return { failed: `цитата для ссылки [${n}] не найдена в документе` };
    sources.push(sourceFromChunk(sources.length + 1, chunk, docs, quote));
  }
  return { sources, blocks: toBlocks(text.replace(/\[(\d+)\]/g, (_, n) => `[${cited.indexOf(+n) + 1}]`)) };
}

const plainAnswer = (a) => a.blocks.map((b) => b.text || (b.items || []).map((x) => x.text || x).join('; ')).join(' ');
const where = (c) => [c.page && `стр. ${c.page}`, c.section].filter(Boolean).join(', ') || 'начало документа';

export async function askAI(params, { signal, fetchFn = fetch } = {}) {
  const local = ask(params);
  // Нет готовых документов или ответ явно в другой области — модель ничего не добавит.
  if (local.kind === 'noscope' || local.outside) return local;
  const { question, history = [], docs } = params;
  const info = scopeInfo(params.scope, docs, params.collections);
  const { r, context } = retrieve(question, history, info, docs, MAX_FRAGS);
  if (!r.results.length) return local;
  const frags = r.results.map((x) => x.chunk);
  const fallback = (why) => ({ ...local, fallback: why });

  let res;
  try {
    const resp = await fetchFn(API_URL, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        question,
        history: history.flatMap((m, i) => (m.role === 'user' && history[i + 1]?.answer ? [{ q: m.text, a: plainAnswer(history[i + 1].answer) }] : [])).slice(-2),
        fragments: frags.map((c) => ({ doc: docs.find((d) => d.id === c.docId).name, where: where(c), text: c.text })),
      }),
    });
    res = resp.ok ? await resp.json() : null;
    if (!res) return fallback(resp.status === 429 ? 'исчерпан лимит запросов к модели' : 'модель не ответила');
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return fallback('модель недоступна');
  }

  const meta = { mode: 'model', model: res.model, sent: frags.length, context };
  if (res.status === 'none') {
    return {
      ...local, ...meta, kind: 'noinfo', status: 'none', outside: null, suggest: [], sources: [],
      blocks: [{ t: 'p', text: String(res.answer || 'В документах области нет ответа на этот вопрос.').replace(/\s*\[\d+\]/g, '') }],
      near: local.near || local.sources.slice(0, 2).map((s, i) => ({ ...s, n: i + 1 })),
    };
  }
  const v = verifyModel(res, frags, docs);
  if (v.failed) return fallback(`ответ модели не прошёл сверку: ${v.failed}`);
  if (res.status === 'partial' && res.missing) v.blocks.push({ t: 'note', text: `Не нашёл в документах: ${res.missing}` });
  return {
    scope: local.scope, ...meta, kind: 'answer', status: res.status === 'partial' ? 'partial' : 'confirmed',
    blocks: v.blocks, sources: v.sources, curatedId: local.curatedId,
    suggest: (res.suggest || []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 3),
  };
}
