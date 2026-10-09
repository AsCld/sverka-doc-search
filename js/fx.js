// Микроанимации, перенесённые с React на ванильный JS (без React и сборки).
// Поведение повторено по исходникам реестра reactbits.dev (вариант JS-CSS): длительности, кривые и формулы — оттуда же.
// Лицензия React Bits — MIT + Commons Clause: использовать в проекте можно, продавать сами компоненты нельзя.
// Цвета и радиусы — из токенов приложения (css/app.css), а не из демо-настроек.

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtSec = (ms) => {
  const ds = Math.max(0, Math.floor(ms / 100));
  const s = (x) => (x / 10).toFixed(1).replace('.', ',');
  return ds < 600 ? `${s(ds)} с` : `${Math.floor(ds / 600)} мин ${s(ds % 600)} с`;
};

/* Порт: https://reactbits.dev/micro/lattice-loader · MIT + Commons Clause · © React Bits
   Сетка 3×3, ячейки вспыхивают волной; по завершении сетка складывается в галочку или крестик.
   Отличия от оригинала: строка HTML вместо компонента (виды перерисовываются целиком), фаза волны
   берётся от общих часов страницы — после перерисовки анимация продолжается, а не начинается заново. */
const LL = {
  orbit: { cells: [0, 1, 2, 7, null, 3, 6, 5, 4], loop: 8, scale: 1.2 },
  snake: { cells: [0, 1, 2, 5, 4, 3, 6, 7, 8], loop: 9, scale: 1, lit: 0.35 },
};
const LL_MARKS = { done: [2, 3, 5, 7], error: [0, 2, 4, 6, 8] };
const LL_STEP = 90;

export function lattice({ status = 'working', label = '', pattern = 'orbit', t0 = null, ms = null, mini = false } = {}) {
  const p = LL[pattern];
  const d = LL_STEP * p.scale;
  const cycle = Math.round(p.loop * d);
  const lit = p.lit ? ` data-lit="${Math.round(p.lit * 100)}"` : '';
  const run = p.cells.map((u) => (u == null ? '<i data-hole></i>' : `<i${lit} style="--d:${Math.round(u * d)}ms"></i>`)).join('');
  const mark = status === 'working' ? '' : `<span class="ll-layer ll-mark">${p.cells.map((_, i) => `<i${LL_MARKS[status].includes(i) ? ' data-on' : ''}></i>`).join('')}</span>`;
  const timer = ms != null ? fmtSec(ms) : t0 != null ? '' : null; // текст живого таймера проставляет tick()
  return `<span class="lattice${mini ? ' mini' : ''}" data-status="${status}" data-cycle="${cycle}" style="--ll-cycle:${cycle}ms"${t0 != null && status === 'working' ? ` data-t0="${t0}"` : ''}>`
    + `<span class="ll-grid" aria-hidden="true"><span class="ll-layer ll-run">${run}</span>${mark}</span>`
    + `${label ? `<span class="ll-label">${esc(label)}</span>` : ''}${timer != null ? `<span class="ll-timer">${timer}</span>` : ''}</span>`;
}

let timers = 0;
function tick() {
  const live = document.querySelectorAll('.lattice[data-t0]');
  for (const el of live) { const t = el.querySelector('.ll-timer'); if (t) t.textContent = fmtSec(Date.now() - Number(el.dataset.t0)); }
  if (!live.length) { clearInterval(timers); timers = 0; }
}
function syncLattice(el) {
  el.style.setProperty('--t', `${-(performance.now() % Number(el.dataset.cycle))}ms`);
  if (el.dataset.t0) { const t = el.querySelector('.ll-timer'); if (t) t.textContent = fmtSec(Date.now() - Number(el.dataset.t0)); if (!timers) timers = setInterval(tick, 100); }
}

/* Порт: https://reactbits.dev/text-animations/count-up · MIT + Commons Clause · © React Bits
   Пружина motion/react: stiffness = 100 / duration, damping = 20 + 40 / duration, масса 1 (здесь duration = 1 с).
   <b data-cu="ключ" data-to="16">16</b>: при перерисовке число продолжает с текущего значения к новому. */
const CU = new Map();
let cuRaf = 0;
const cuFmt = (v, dec) => new Intl.NumberFormat('ru-RU', { useGrouping: false, minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
function cuPaint(key, s) { for (const el of document.querySelectorAll(`[data-cu="${CSS.escape(key)}"]`)) el.textContent = cuFmt(s.v, s.dec); }
function cuStep(now) {
  cuRaf = 0;
  const k = 100 / 1, c = 20 + 40 / 1; // duration = 1 с
  let busy = false;
  for (const [key, s] of CU) {
    if (s.v === s.to) continue;
    let dt = Math.min(0.25, (now - (s.last || now)) / 1000) || 1 / 60;
    s.last = now;
    for (; dt > 0; dt -= 1 / 240) { const h = Math.min(dt, 1 / 240); s.vel += (-k * (s.v - s.to) - c * s.vel) * h; s.v += s.vel * h; }
    if (Math.abs(s.v - s.to) < 0.5 / 10 ** s.dec) { s.v = s.to; s.vel = 0; s.last = 0; } else busy = true;
    cuPaint(key, s);
  }
  if (busy) cuRaf = requestAnimationFrame(cuStep);
}
function syncCount(el) {
  const key = el.dataset.cu, to = Number(el.dataset.to);
  const dec = (String(el.dataset.to).split('.')[1] || '').replace(/0+$/, '').length;
  let s = CU.get(key);
  if (!s) CU.set(key, s = { v: 0, vel: 0, to: 0, dec, last: 0 });
  s.dec = dec;
  if (s.to !== to) { s.to = to; if (reduce()) s.v = to; else if (!cuRaf) cuRaf = requestAnimationFrame(cuStep); }
  el.textContent = cuFmt(s.v, s.dec);
}

// Новые узлы с решёткой или счётчиком обрабатываются до отрисовки кадра (MutationObserver — микрозадача).
function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.matches('.lattice')) syncLattice(node);
  if (node.matches('[data-cu]')) syncCount(node);
  node.querySelectorAll('.lattice').forEach(syncLattice);
  node.querySelectorAll('[data-cu]').forEach(syncCount);
}

/* Порт: https://reactbits.dev/components/spotlight-card · MIT + Commons Clause · © React Bits
   Мягкое пятно света следует за курсором, подсвечивает край карточки и «дотягивается» до соседних (proximity).
   Один общий обработчик на все элементы .spot вместо компонента на каждую карточку. Цвет — акцент приложения. */
const SPOT = { color: '#3346d3', size: 240, softness: 0.7, intensity: 0.45 * 0.28, borderGlow: 0.6 * 0.7, proximity: 80, smoothing: 0.3 };
function falloff(color, softness) {
  const soft = Math.min(1, Math.max(0, softness));
  const core = (1 - soft) ** 1.5 * 0.85;
  const stop = (alpha, at) => `color-mix(in srgb, ${color} ${(alpha * 100).toFixed(2)}%, transparent) ${(at * 100).toFixed(2)}%`;
  const list = [stop(1, 0)];
  for (let i = 0; i <= 14; i++) {
    const t = core + ((1 - core) * i) / 14;
    const g = (t - core) / (1 - core);
    const smooth = 1 - g * g * (3 - 2 * g);
    const glow = Math.exp(-4.6 * g * g) * (1 - g ** 6);
    list.push(stop(smooth + (glow - smooth) * soft, t));
  }
  return list.join(', ');
}
function initSpotlight(selector) {
  if (!fine()) return;
  const fill = falloff(SPOT.color, SPOT.softness), edge = falloff(SPOT.color, 1);
  const states = new WeakMap();
  const pointer = { x: 0, y: 0, active: false };
  let focus = null, raf = 0, last = 0;
  const tick = (now) => {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const instant = reduce();
    let busy = false;
    for (const el of document.querySelectorAll(selector)) {
      let s = states.get(el);
      if (!s) states.set(el, (s = { x: 0, y: 0, presence: 0 }));
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || !r.width) continue;
      let tx = s.x, ty = s.y, target = 0;
      if (focus && el.contains(focus)) {
        const b = focus.getBoundingClientRect();
        tx = b.left + b.width / 2 - r.left; ty = b.top + b.height / 2 - r.top; target = 1;
      } else if (pointer.active) {
        tx = pointer.x - r.left; ty = pointer.y - r.top;
        const gap = Math.hypot(Math.max(0, -tx, tx - r.width), Math.max(0, -ty, ty - r.height));
        target = gap === 0 ? 1 : Math.max(0, 1 - gap / SPOT.proximity) ** 2;
      }
      if (!target && !s.presence) continue;
      if (s.presence < 0.02 && target > 0) { s.x = tx; s.y = ty; }
      const follow = instant ? 1 : 1 - Math.exp(-dt / (0.015 + SPOT.smoothing * 0.22));
      s.x += (tx - s.x) * follow; s.y += (ty - s.y) * follow;
      const fade = instant ? 1 : 1 - Math.exp(-dt / (target > s.presence ? 0.1 : 0.32));
      s.presence += (target - s.presence) * fade;
      if (Math.abs(target - s.presence) < 0.002) s.presence = target;
      el.style.setProperty('--spot-bg', `radial-gradient(circle ${SPOT.size}px at ${s.x.toFixed(1)}px ${s.y.toFixed(1)}px, ${fill})`);
      el.style.setProperty('--spot-edge', `radial-gradient(circle ${SPOT.size * 0.6}px at ${s.x.toFixed(1)}px ${s.y.toFixed(1)}px, ${edge})`);
      el.style.setProperty('--spot-o', (s.presence * SPOT.intensity).toFixed(3));
      el.style.setProperty('--spot-eo', (s.presence * SPOT.borderGlow).toFixed(3));
      if (Math.abs(tx - s.x) > 0.1 || Math.abs(ty - s.y) > 0.1 || s.presence !== target) busy = true;
    }
    if (busy) raf = requestAnimationFrame(tick);
  };
  const wake = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = e.pointerType === 'mouse'; wake(); }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) { pointer.active = false; wake(); } });
  addEventListener('scroll', () => { if (pointer.active) wake(); }, { capture: true, passive: true });
  document.addEventListener('focusin', (e) => { if (e.target.matches?.(':focus-visible')) { focus = e.target; wake(); } });
  document.addEventListener('focusout', () => { focus = null; wake(); });
}

/* Порт: https://reactbits.dev/animations/magnet · MIT + Commons Clause · © React Bits
   <span class="magnet" data-pad="60" data-k="4"><button>…</button></span>: внешний элемент меряем,
   внутренний смещаем на (курсор − центр) / k. Переходы — как в оригинале. На тач-экранах выключено. */
function initMagnet() {
  if (!fine()) return;
  addEventListener('mousemove', (e) => {
    if (reduce()) return;
    for (const w of document.querySelectorAll('.magnet')) {
      const inner = w.firstElementChild;
      if (!inner) continue;
      const pad = Number(w.dataset.pad || 100), k = Number(w.dataset.k || 2);
      const { left, top, width, height } = w.getBoundingClientRect();
      const cx = left + width / 2, cy = top + height / 2;
      const on = Math.abs(cx - e.clientX) < width / 2 + pad && Math.abs(cy - e.clientY) < height / 2 + pad;
      inner.style.transition = on ? 'transform 0.3s ease-out' : 'transform 0.5s ease-in-out';
      inner.style.transform = on ? `translate3d(${(e.clientX - cx) / k}px, ${(e.clientY - cy) / k}px, 0)` : 'translate3d(0, 0, 0)';
    }
  }, { passive: true });
}

/* Порт: https://reactbits.dev/text-animations/blur-text · MIT + Commons Clause · © React Bits
   Слова проявляются из размытия по очереди; ключевые кадры — в css/app.css (@keyframes blur-word).
   Возвращает HTML: каждое слово — inline-block с индексом --w для задержки. */
export const blurWords = (text, from = 0) => text.split(' ').map((w, i) => `<span class="bw" style="--w:${from + i}">${esc(w)}</span>`).join(' ');

/* Порт: https://reactbits.dev/micro/fuse-button · MIT + Commons Clause · © React Bits
   Кнопка действия, которая сама несёт отмену: нажали → подпись меняется на «Отменить», по контуру горит
   «бикфордов шнур» (окно отмены), наведение мышью ставит шнур на паузу, Esc — отмена.
   Иконки HugeIcons заменены на иконки приложения (передаются строкой SVG). */
let fbSeq = 0;
export function fuseButton({
  label = '', undoLabel = 'Отменить', doneLabel = '', icon = '', undoIcon = '', doneIcon = '',
  undoWindow = 4000, fuse = 'outline', crossfadeMs = 200, commitOn = 'press', pauseOnHover = true,
  settle = 'reset', focusUndo = true, className = '', onCommit, onUndo, onFuseEnd,
} = {}) {
  const id = `fb-status-${++fbSeq}`;
  const root = document.createElement('span');
  root.className = `fuse-button ${className}`.trim();
  root.tabIndex = -1;
  root.dataset.phase = 'idle';
  root.dataset.fuse = fuse;
  root.style.setProperty('--fb-fade', `${crossfadeMs}ms`);
  root.innerHTML = `<button type="button" class="fuse-button__face fuse-button__idle"><span class="fuse-button__icon" aria-hidden="true">${icon}</span>${esc(label)}</button>`
    + `<button type="button" class="fuse-button__face fuse-button__undo" aria-describedby="${id}" aria-keyshortcuts="Escape" inert><span class="fuse-button__icon fuse-button__icon--undo" aria-hidden="true">${undoIcon}</span>${esc(undoLabel)}${fuse !== 'outline' ? '<i class="fuse-button__fuse" aria-hidden="true"></i>' : ''}</button>`
    + `<span class="fuse-button__face fuse-button__settled" inert><span class="fuse-button__icon" aria-hidden="true">${doneIcon}</span>${esc(doneLabel)}</span>`
    + (fuse === 'outline' ? '<svg class="fuse-button__rim" aria-hidden="true"><rect pathLength="1"/></svg>' : '')
    + `<span class="fuse-button__status" id="${id}" role="status" aria-live="polite"></span>`;
  const [idle, undoBtn, settled] = root.querySelectorAll('.fuse-button__face');
  const status = root.querySelector('.fuse-button__status');
  let phase = 'idle', anim = null, lastInput = 'pointer';
  const pause = { hover: false, hidden: false, canHoverPause: false };

  const go = (next) => {
    root.toggleAttribute('data-instant', lastInput === 'keyboard');
    const inside = root.contains(document.activeElement);
    phase = next;
    root.dataset.phase = next;
    idle.inert = next !== 'idle';
    undoBtn.inert = next !== 'armed';
    settled.inert = next !== 'settled';
    status.textContent = next === 'idle' ? '' : doneLabel;
    if (next === 'settled') root.setAttribute('aria-disabled', 'true'); else root.removeAttribute('aria-disabled');
    if (next === 'armed' && (focusUndo || inside)) undoBtn.focus({ preventScroll: true });
    else if (inside) (next === 'idle' ? idle : root).focus({ preventScroll: true });
  };
  const sync = () => {
    if (!anim) return;
    if (pause.hover || pause.hidden) { if (anim.playState === 'running') anim.pause(); }
    else if (anim.playState === 'paused') anim.play();
  };
  // Контур шнура: геометрия прямоугольника по фактическому размеру кнопки (в оригинале — CSS-свойствами x/y/rx,
  // которые поддерживают не все браузеры).
  const sizeRim = () => {
    const rect = root.querySelector('.fuse-button__rim rect');
    const cs = getComputedStyle(root);
    const t = parseFloat(cs.getPropertyValue('--fb-fuse-h')) || 1.5;
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    const { width: w, height: h } = root.getBoundingClientRect();
    Object.entries({ x: t / 2, y: t / 2, width: Math.max(0, w - t), height: Math.max(0, h - t), rx: Math.max(0, rad - t / 2) }).forEach(([k, v]) => rect.setAttribute(k, v));
  };
  const light = () => {
    anim?.cancel();
    if (fuse === 'outline') sizeRim();
    const el = root.querySelector(fuse === 'outline' ? '.fuse-button__rim rect' : '.fuse-button__fuse');
    anim = el.animate(fuse === 'outline' ? [{ strokeDashoffset: 0 }, { strokeDashoffset: -1 }] : [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
      { duration: undoWindow, easing: 'linear', fill: 'forwards' });
    anim.onfinish = () => {
      onFuseEnd?.();
      if (commitOn === 'fuseEnd') onCommit?.('fuseEnd');
      lastInput = 'pointer';
      go(settle === 'stay' ? 'settled' : 'idle');
    };
    sync();
  };
  const arm = () => {
    if (phase !== 'idle') return;
    light();
    pause.canHoverPause = false;
    pause.hover = false;
    if (commitOn === 'press') onCommit?.('press');
    go('armed');
  };
  const undo = () => {
    if (phase !== 'armed') return;
    if (anim) { anim.onfinish = null; anim.pause(); }
    onUndo?.();
    go('idle');
  };

  idle.addEventListener('click', arm);
  undoBtn.addEventListener('click', undo);
  root.addEventListener('pointerdown', (e) => {
    lastInput = 'pointer';
    if (e.button === 0 && (phase === 'armed' || phase === 'idle')) root.dataset.pressed = '';
  });
  const release = () => delete root.dataset.pressed;
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
  root.addEventListener('pointerenter', (e) => {
    if (pauseOnHover && e.pointerType === 'mouse' && pause.canHoverPause) { pause.hover = true; sync(); }
  });
  root.addEventListener('pointerleave', (e) => {
    release();
    if (e.pointerType !== 'mouse') return;
    pause.canHoverPause = true;
    pause.hover = false;
    sync();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') lastInput = 'keyboard';
    if (e.key === 'Escape' && phase === 'armed') { e.preventDefault(); e.stopPropagation(); lastInput = 'keyboard'; undo(); }
  });
  const onVisibility = () => {
    if (!root.isConnected && phase !== 'armed') return document.removeEventListener('visibilitychange', onVisibility);
    pause.hidden = document.hidden;
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);
  // Для уведомления, где действие уже выполнено: шнур загорается сразу, без нажатия.
  root.fuse = { arm, undo, get phase() { return phase; }, armNow() { arm(); pause.canHoverPause = true; } };
  return root;
}

let started = false;
export function initFx() {
  if (started) return;
  started = true;
  new MutationObserver((list) => { for (const m of list) m.addedNodes.forEach(scan); }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);
  initSpotlight('.spot');
  initMagnet();
}
