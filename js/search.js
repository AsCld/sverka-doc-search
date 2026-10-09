// Поиск: нормализация, стемминг (Snowball Russian), разбиение на фрагменты, BM25.
// Чистые функции без DOM — тестируются в Node (tests/search.test.mjs).

const STOP = new Set(`а без более бы был была были было быть в вам вас весь во вот все всего всех вы где да даже для до его ее если есть еще же за здесь и из или им их к как ко когда кто ли либо мне может мы на надо наш не него нее нет ни них но ну о об однако он она они оно от очень по под при с со так также такой там те тем то того тоже той только том ты у уже хотя чего чей чем что чтобы чье чья эта эти это я какой какая какие какое каких каким какую каков сколько который которая которые нужно нужна нужен нужны надо можно должен должна должны является ли про через после также либо сейчас сегодня всего`.split(/\s+/));

const VOWEL = /[аеиоуыэюя]/;

function rx(list, pre) {
  const alts = list.sort((a, b) => b.length - a.length).join('|');
  return pre ? new RegExp(`([ая])(${alts})$`) : new RegExp(`(${alts})$`);
}
const PERF1 = rx(['в', 'вши', 'вшись'], true), PERF2 = rx(['ив', 'ивши', 'ившись', 'ыв', 'ывши', 'ывшись']);
const REFL = /(ся|сь)$/;
const ADJ = '(ее|ие|ые|ое|ими|ыми|ей|ий|ый|ой|ем|им|ым|ом|его|ого|ему|ому|их|ых|ую|юю|ая|яя|ою|ею)';
const ADJECTIVAL = [new RegExp(`(ивш|ывш|ующ)${ADJ}$`), new RegExp(`([ая])(ем|нн|вш|ющ|щ)${ADJ}$`), new RegExp(`${ADJ}$`)];
const VERB1 = rx(['ла', 'на', 'ете', 'йте', 'ли', 'й', 'л', 'ем', 'н', 'ло', 'но', 'ет', 'ют', 'ны', 'ть', 'ешь', 'нно'], true);
const VERB2 = rx(['ила', 'ыла', 'ена', 'ейте', 'уйте', 'ите', 'или', 'ыли', 'ей', 'уй', 'ил', 'ыл', 'им', 'ым', 'ен', 'ило', 'ыло', 'ено', 'ят', 'ует', 'уют', 'ит', 'ыт', 'ены', 'ить', 'ыть', 'ишь', 'ую', 'ю']);
const NOUN = rx(['а', 'ев', 'ов', 'ие', 'ье', 'е', 'иями', 'ями', 'ами', 'еи', 'ии', 'и', 'ией', 'ей', 'ой', 'ий', 'й', 'иям', 'ям', 'ием', 'ем', 'ам', 'ом', 'о', 'у', 'ах', 'иях', 'ях', 'ы', 'ь', 'ию', 'ью', 'ю', 'ия', 'ья', 'я']);

// Удаляет окончание по regex; для групп с префиксом [ая] префикс сохраняется.
function cut(s, re) {
  const m = s.match(re);
  if (!m) return null;
  const keep = re.source.startsWith('([ая])') ? m[1].length : 0;
  return s.slice(0, s.length - m[0].length + keep);
}

// Нерегулярные короткие формы, которые Snowball не сводит к одной основе.
const IRREG = { день: 'ден', дня: 'ден', дней: 'ден', дни: 'ден', дням: 'ден', днях: 'ден', днем: 'ден' };

export function stem(word) {
  let w = word.toLowerCase().replace(/ё/g, 'е');
  if (IRREG[w]) return IRREG[w];
  if (!/^[а-я]+$/.test(w) || w.length < 4) return w;
  const i = w.search(VOWEL);
  if (i < 0) return w;
  const head = w.slice(0, i + 1);
  let rv = w.slice(i + 1);
  // Шаг 1
  let r = cut(rv, PERF1) ?? cut(rv, PERF2);
  if (r !== null) rv = r;
  else {
    rv = rv.replace(REFL, '');
    r = null;
    for (const re of ADJECTIVAL) { r = cut(rv, re); if (r !== null) break; }
    if (r === null) r = cut(rv, VERB1) ?? cut(rv, VERB2);
    if (r === null) r = cut(rv, NOUN);
    if (r !== null) rv = r;
  }
  // Шаг 2–4 (упрощённо: R2 ≈ RV для «ость»)
  rv = rv.replace(/и$/, '');
  if (rv.length > 4) rv = rv.replace(/ость?$/, '');
  rv = rv.replace(/ейше?$/, '');
  rv = rv.replace(/нн$/, 'н').replace(/ь$/, '');
  const out = head + rv;
  // Короткие слова (Тьма/Тьму), где RV пуст: срезаем одну конечную гласную.
  return out === w ? w.replace(/[аяоуюыеи]$/, '') : out;
}

// Небольшой словарь синонимов предметной области (по основам).
const SYN = {
  отвеча: ['ответствен'], ответствен: ['отвеча'],
  срок: ['дат'], дат: ['срок'], когд: ['срок', 'дат'],
  постав: ['поставк', 'поставщик'], поставк: ['поставщик'], риск: ['отставан', 'срыв'],
  уведом: ['уведомлен'], уведомля: ['уведомлен'], уведомлен: ['уведомля'],
  совещан: ['протокол'], решил: ['решен', 'реш'], тьм: ['мост'],
};

export function normalize(s) {
  return s.replace(/ /g, ' ').replace(/[‐-‒−]/g, '-').replace(/\s+/g, ' ').trim();
}

// Токены: слова и числа (даты, пикеты «2245», проценты).
export function tokens(text) {
  const out = [];
  for (const m of text.toLowerCase().replace(/ё/g, 'е').matchAll(/[a-zа-я]+|\d+(?:[.,]\d+)*/g)) {
    const t = m[0];
    if (STOP.has(t)) continue;
    if (/^\d/.test(t)) { out.push(t); continue; }
    if (t.length < 2) continue;
    out.push(stem(t));
  }
  return out;
}

// Глагольные формы («находится», «работает») не считаем ключевыми словами вопроса.
const VERBISH = /(ается|яется|ется|ится|утся|ются|ятся|ает|яет|еет|ует|ут|ют|ят|ать|ять|ить|еть|ыть|ться|ал|ял|ил|ел|ала|яла|ила|али|яли|или|ели)$/;
export function verbLike(text) {
  return new Set((text.toLowerCase().replace(/ё/g, 'е').match(/[а-я]+/g) || []).filter((w) => w.length > 4 && VERBISH.test(w) && !STOP.has(w)).map(stem));
}

export function queryTerms(text) {
  const base = [...new Set(tokens(text))];
  const syn = [];
  for (const t of base) for (const s of SYN[t] || []) if (!base.includes(s)) syn.push(s);
  return { base, syn: [...new Set(syn)] };
}

// Предложения: не режем после коротких сокращений (р., п., г., А.С.).
export function sentences(text) {
  const parts = [];
  for (const line of text.split(/\n+/)) {
    let start = 0;
    const re = /[.!?](?=\s+[А-ЯЁA-Z«])/g;
    let m;
    while ((m = re.exec(line))) {
      const before = line.slice(start, m.index).match(/([А-Яа-яЁёA-Za-z]+)$/);
      if (before && before[1].length <= 2) continue;
      parts.push(line.slice(start, m.index + 1).trim());
      start = m.index + 1;
    }
    const rest = line.slice(start).trim();
    if (rest) parts.push(rest);
  }
  return parts.filter(Boolean);
}

// Фрагменты ~500 символов внутри одной страницы/раздела, по абзацам.
export function chunkPages(docId, pages) {
  const chunks = [];
  pages.forEach((pg, pi) => {
    const paras = pg.text.split(/\n/).map(normalize).filter(Boolean);
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      chunks.push({ id: `${docId}:${chunks.length}`, docId, pageIndex: pi, page: pg.n ?? null, section: pg.section ?? null, text: buf.join('\n') });
      buf = [];
    };
    for (const p of paras) {
      if (p.includes(' | ')) { flush(); buf.push(p); flush(); continue; } // строка таблицы — отдельный фрагмент
      if (buf.length && (buf.join(' ').length + p.length > 500)) flush();
      buf.push(p);
    }
    flush();
  });
  return chunks;
}

export function buildIndex(chunks) {
  const df = new Map();
  let total = 0;
  const docs = chunks.map((c) => {
    const toks = tokens(c.text);
    total += toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { chunk: c, tf, len: toks.length };
  });
  return { docs, df, N: chunks.length, avgLen: total / Math.max(1, chunks.length) };
}

export function idf(index, t) {
  const n = index.df.get(t) || 0;
  return Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
}

// BM25 по фрагментам, ограниченным фильтром filter(chunk) → bool.
// Возвращает результаты и «покрытие» вопроса: доля IDF-веса терминов, найденных в лучших фрагментах.
export function search(index, query, { filter = () => true, extra = null, limit = 6 } = {}) {
  const q = queryTerms(query);
  const ctx = extra ? queryTerms(extra).base.filter((t) => !q.base.includes(t)) : [];
  // Варианты каждого термина: сам термин, синонимы, однокоренные слова словаря
  // (общий префикс ≥ 5 букв — страхует от ошибок стемминга: «работает» ↔ «работ»).
  const variants = new Map();
  const vocab = [...index.df.keys()];
  for (const t of q.base) {
    const v = new Map([[t, 1]]);
    (SYN[t] || []).forEach((x) => v.set(x, 0.5));
    if (!/^\d/.test(t) && t.length >= 5) {
      const pre = t.slice(0, Math.max(5, t.length - 2));
      vocab.forEach((x) => x.startsWith(pre) && !v.has(x) && v.set(x, 0.5));
    }
    variants.set(t, v);
  }
  ctx.forEach((t) => variants.set(t, new Map([[t, 0.5]])));
  const k1 = 1.2, b = 0.75;
  const res = [];
  for (const d of index.docs) {
    if (!filter(d.chunk)) continue;
    let score = 0;
    const hit = new Set();
    // Каждый термин вопроса даёт вклад один раз — по лучшему из своих вариантов.
    for (const v of variants.values()) {
      let best = 0;
      for (const [t, w] of v) {
        const f = d.tf.get(t);
        if (!f) continue;
        hit.add(t);
        best = Math.max(best, w * idf(index, t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / index.avgLen)));
      }
      score += best;
    }
    if (score > 0) res.push({ chunk: d.chunk, score, hit });
  }
  res.sort((a, b) => b.score - a.score);
  const top = res.slice(0, limit);
  // Покрытие вопроса: доля IDF-веса терминов, найденных (в любом варианте) в топ-3 фрагментах.
  // Термин, которого нет во всём корпусе, получает максимальный вес: это самое «информативное» слово.
  const maxIdf = Math.log(1 + (index.N + 0.5) / 0.5);
  let all = 0, found = 0;
  const missing = [], absent = [];
  const top3 = top.slice(0, 3);
  const verbs = verbLike(query);
  for (const t of q.base) {
    const v = [...variants.get(t).keys()];
    const inCorpus = v.some((x) => index.df.get(x));
    if (!inCorpus && verbs.has(t)) continue; // неизвестный глагол не делает вопрос «без ответа»
    if (!inCorpus) absent.push(t);
    const w = inCorpus ? Math.max(...v.filter((x) => index.df.get(x)).map((x) => idf(index, x))) : maxIdf;
    all += w;
    if (top3.some((r) => v.some((x) => r.hit.has(x)))) found += w;
    else missing.push(t);
  }
  return { results: top, coverage: all ? found / all : 0, missing, absent, terms: q.base, contextTerms: ctx, variants };
}

// Лучшие предложения фрагмента под запрос.
export function bestSentences(chunkText, query, extra, n = 2, variants = null) {
  const q = new Set([...queryTerms(query).base, ...queryTerms(query).syn, ...(extra ? queryTerms(extra).base : [])]);
  if (variants) for (const v of variants.values()) for (const x of v.keys()) q.add(x);
  return sentences(chunkText)
    .map((s, i) => ({ s, i, score: tokens(s).filter((t) => q.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}
