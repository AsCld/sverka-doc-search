/* Порт: https://reactbits.dev/micro/paper-crumple · MIT + Commons Clause · © React Bits; three.js — MIT (vendor/three)
   «Бумага сминается»: документ, отправленный в корзину, комкается в шарик и улетает к ссылке «Корзина».
   Из оригинала без изменений перенесены физика смятия (createPaperPath — предрасчёт кадров методом
   позиционных ограничений), сетка листа, материалы с зерном бумаги, свет, тень и пружины (advance).
   Отличия: вместо удержания мышью смятие запускается программно; текстура листа рисуется на canvas
   (имя и тип файла), а не грузится картинкой; полёт к корзине — дописан. three.js грузится лениво.
   Нет WebGL или включено «уменьшение движения» — анимация просто не показывается. */

const spring = (value = 0) => ({ value, target: value, velocity: 0 });
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function advance(s, dt, duration, instant) {
  if (instant || duration <= 0) { s.value = s.target; s.velocity = 0; return false; }
  const omega = 8 / Math.max(0.06, duration);
  const offset = s.value - s.target;
  const term = s.velocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  s.value = s.target + (offset + term * dt) * decay;
  s.velocity = (s.velocity - omega * term * dt) * decay;
  if (Math.abs(s.value - s.target) < 0.0001 && Math.abs(s.velocity) < 0.001) { s.value = s.target; s.velocity = 0; return false; }
  return true;
}

function randomSource(seed) {
  let value = seed | 0;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let n = Math.imul(value ^ (value >>> 15), 1 | value);
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

function createPaperPath(rest, triangles, shortSide, density, sharpness, depth, seed) {
  const count = rest.length / 3;
  const points = Float64Array.from(rest);
  const previous = Float64Array.from(rest);
  const before = Float64Array.from(rest);
  const edges = [];
  const hinges = [];
  const adjacency = new Map();
  const random = randomSource(seed);
  const guides = Array.from({ length: density }, () => {
    const angle = random() * Math.PI * 2;
    return { x: Math.cos(angle), y: Math.sin(angle), phase: random() * Math.PI * 2, weight: random() * 0.6 + 0.4 };
  });
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k], b = triangles[t + ((k + 1) % 3)], opposite = triangles[t + ((k + 2) % 3)];
      const key = Math.min(a, b) * count + Math.max(a, b);
      const other = adjacency.get(key);
      if (!other) {
        adjacency.set(key, { a, b, opposite });
        const length = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1]);
        edges.push(a * 3, b * 3, length);
      } else {
        const c = other.opposite * 3, d = opposite * 3;
        const length = Math.hypot(rest[c] - rest[d], rest[c + 1] - rest[d + 1]);
        const mx = (rest[c] + rest[d]) * 0.5, my = (rest[c + 1] + rest[d + 1]) * 0.5;
        let weakness = 0;
        for (const guide of guides) {
          const distance = Math.abs(Math.sin(((mx * guide.x + my * guide.y) / shortSide) * 4 + guide.phase));
          weakness = Math.max(weakness, Math.exp(-distance * distance * 80) * guide.weight);
        }
        hinges.push(c, d, length, 0.12 + (1 - weakness) * 0.75);
      }
    }
  }
  const spacing = Math.sqrt((shortSide * shortSide) / count);
  const thickness = shortSide * 0.008;
  const samples = [rest.slice()];
  const frameCount = 64;
  const stepsPerFrame = 3;
  const totalSteps = frameCount * stepsPerFrame;
  let initialRadius = 0;
  for (let i = 0; i < rest.length; i += 3) initialRadius = Math.max(initialRadius, Math.hypot(rest[i] / 0.94, rest[i + 1] / 1.02));
  initialRadius *= 1.02;
  function constrain(list, stride, stiffness, reverse) {
    for (let n = 0; n < list.length; n += stride) {
      const edge = reverse ? list.length - stride - n : n;
      const a = list[edge], b = list[edge + 1];
      const dx = points[b] - points[a], dy = points[b + 1] - points[a + 1], dz = points[b + 2] - points[a + 2];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length < 0.000001) continue;
      const weight = stride === 4 ? list[edge + 3] : 1;
      const amount = (1 - list[edge + 2] / length) * 0.5 * stiffness * weight;
      points[a] += dx * amount; points[b] -= dx * amount;
      points[a + 1] += dy * amount; points[b + 1] -= dy * amount;
      points[a + 2] += dz * amount; points[b + 2] -= dz * amount;
    }
  }
  function separateLayers() {
    const margin = thickness * 2;
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t] * 3, b = triangles[t + 1] * 3, c = triangles[t + 2] * 3;
      const ax = points[a], ay = points[a + 1], az = points[a + 2];
      const bx = points[b] - ax, by = points[b + 1] - ay, bz = points[b + 2] - az;
      const cx = points[c] - ax, cy = points[c + 1] - ay, cz = points[c + 2] - az;
      let nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
      const length = Math.hypot(nx, ny, nz);
      if (length < 0.0000001) continue;
      nx /= length; ny /= length; nz /= length;
      const minX = Math.min(ax, points[b], points[c]) - margin, maxX = Math.max(ax, points[b], points[c]) + margin;
      const minY = Math.min(ay, points[b + 1], points[c + 1]) - margin, maxY = Math.max(ay, points[b + 1], points[c + 1]) + margin;
      const minZ = Math.min(az, points[b + 2], points[c + 2]) - margin, maxZ = Math.max(az, points[b + 2], points[c + 2]) + margin;
      const bb = bx * bx + by * by + bz * bz, cc = cx * cx + cy * cy + cz * cz;
      const bc = bx * cx + by * cy + bz * cz;
      const determinant = bb * cc - bc * bc;
      if (determinant < 0.0000000001) continue;
      for (let p = 0; p < points.length; p += 3) {
        if (p === a || p === b || p === c) continue;
        if (points[p] < minX || points[p] > maxX || points[p + 1] < minY || points[p + 1] > maxY || points[p + 2] < minZ || points[p + 2] > maxZ) continue;
        const rx = rest[p] - (rest[a] + rest[b] + rest[c]) / 3;
        const ry = rest[p + 1] - (rest[a + 1] + rest[b + 1] + rest[c + 1]) / 3;
        if (rx * rx + ry * ry < spacing * spacing * 6) continue;
        const dx = points[p] - ax, dy = points[p + 1] - ay, dz = points[p + 2] - az;
        const distance = dx * nx + dy * ny + dz * nz;
        const previousDistance = (before[p] - before[a]) * nx + (before[p + 1] - before[a + 1]) * ny + (before[p + 2] - before[a + 2]) * nz;
        const side = previousDistance >= 0 ? 1 : -1;
        if (distance * side >= thickness || Math.abs(distance) > margin) continue;
        const pb = dx * bx + dy * by + dz * bz, pc = dx * cx + dy * cy + dz * cz;
        const u = (cc * pb - bc * pc) / determinant;
        const v = (bb * pc - bc * pb) / determinant;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const w = 1 - u - v;
        const correction = (thickness * side - distance) / (1 + w * w + u * u + v * v);
        for (let axis = 0; axis < 3; axis++) {
          const normal = axis === 0 ? nx : axis === 1 ? ny : nz;
          const movement = normal * correction;
          points[p + axis] += movement;
          points[a + axis] -= movement * w;
          points[b + axis] -= movement * u;
          points[c + axis] -= movement * v;
        }
      }
    }
  }
  for (let step = 1; step <= totalSteps; step++) {
    const progress = step / totalSteps;
    const compression = progress * progress * (3 - 2 * progress);
    const radius = initialRadius * (1 - compression) + shortSide * (0.19 - depth * 0.025) * compression;
    before.set(points);
    for (let i = 0; i < points.length; i += 3) {
      const x = rest[i] / shortSide, y = rest[i + 1] / shortSide;
      let buckle = 0;
      for (const guide of guides) buckle += Math.sin((x * guide.x + y * guide.y) * 5 + guide.phase) * guide.weight;
      for (let axis = 0; axis < 3; axis++) {
        const velocity = (points[i + axis] - previous[i + axis]) * 0.55;
        previous[i + axis] = points[i + axis];
        points[i + axis] += clamp(velocity, -spacing * 0.15, spacing * 0.15);
      }
      points[i + 2] += (buckle / density) * shortSide * 0.0007 * Math.sin(progress * Math.PI);
    }
    for (let pass = 0; pass < 18; pass++) {
      constrain(hinges, 4, 0.45 * (1 - sharpness * 0.4), pass % 2 === 0);
      for (let i = 0; i < points.length; i += 3) {
        const x = points[i] / 0.94, y = points[i + 1] / 1.02, z = points[i + 2] / 0.86;
        const distance = Math.hypot(x, y, z);
        if (distance > radius) {
          const push = (1 - radius / distance) * 0.55;
          points[i] -= points[i] * push; points[i + 1] -= points[i + 1] * push; points[i + 2] -= points[i + 2] * push;
        }
      }
      constrain(edges, 3, 1, pass % 2 !== 0);
      if (pass === 8 || pass === 17) separateLayers();
    }
    for (let h = 0; h < hinges.length; h += 4) {
      const a = hinges[h], b = hinges[h + 1];
      const length = Math.hypot(points[a] - points[b], points[a + 1] - points[b + 1], points[a + 2] - points[b + 2]);
      if (length < hinges[h + 2] * 0.86) hinges[h + 2] += (length - hinges[h + 2]) * 0.12;
    }
    if (step % stepsPerFrame === 0) samples.push(Float32Array.from(points));
  }
  return { samples };
}

// Настройки из конфигурации пользователя (PaperCrumple): сгибы, резкость, глубина, бумага.
const CFG = { width: 112, height: 146, crumpleAmount: 0.92, crumpleDuration: 0.55, foldCount: 6, foldSharpness: 0.6,
  wrinkleDepth: 0.65, paperColor: '#f4f0e8', roughness: 0.92, paperTexture: 0.08, lightIntensity: 1.8, lightAngle: -35,
  shadowOpacity: 0.08, seed: 7, detail: 64 };

let THREE = null, sheetCache = null;
const disabled = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

async function load() {
  THREE ||= await import('../vendor/three/three.module.min.js');
  if (sheetCache) return sheetCache;
  const { width, height, detail, seed } = CFG;
  const aspect = height / width;
  const shortSide = Math.min(1, aspect);
  const resolution = Math.round(clamp(detail / 4, 8, 24));
  const columns = Math.max(8, Math.round(resolution / Math.max(1, aspect)));
  const rows = Math.max(8, Math.round(resolution * Math.min(1, aspect)));
  const rng = randomSource(seed);
  const count = (columns + 1) * (rows + 1);
  const original = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const indices = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= columns; col++) {
      const index = row * (columns + 1) + col;
      const u = (col + (col > 0 && col < columns ? (rng() - 0.5) * 0.5 : 0)) / columns;
      const v = (row + (row > 0 && row < rows ? (rng() - 0.5) * 0.5 : 0)) / rows;
      original[index * 3] = u - 0.5;
      original[index * 3 + 1] = (v - 0.5) * aspect;
      uvs[index * 2] = u;
      uvs[index * 2 + 1] = v;
      if (col < columns && row < rows) {
        const a = index, b = index + 1, c = index + columns + 1, d = c + 1;
        if (rng() > 0.5) indices.push(a, b, d, a, d, c);
        else indices.push(a, b, c, b, d, c);
      }
    }
  }
  const path = createPaperPath(original, indices, shortSide, CFG.foldCount, CFG.foldSharpness, CFG.wrinkleDepth, seed);
  sheetCache = { aspect, shortSide, count, original, uvs, indices, path, rng };
  return sheetCache;
}

// Подгрузить three.js и рассчитать смятие заранее, в простое (только на десктопе).
export function prewarm() {
  if (disabled() || !matchMedia('(pointer: fine)').matches) return;
  (window.requestIdleCallback || setTimeout)(() => load().catch(() => {}), { timeout: 3000 });
}

// Лист бумаги с «документом»: плашка типа файла, название, строки текста и одна строка-цитата маркером.
function paperTexture(name, ext) {
  const w = 448, h = Math.round(w * CFG.height / CFG.width);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fdfcf9'; g.fillRect(0, 0, w, h);
  const badge = { pdf: '#d1453b', docx: '#2f62d8' }[ext] || '#5b6475';
  g.fillStyle = badge; g.fillRect(36, 40, 92, 34);
  g.fillStyle = '#fff'; g.font = '700 22px system-ui, sans-serif'; g.textBaseline = 'middle';
  g.fillText((ext || '?').toUpperCase().slice(0, 4), 46, 58);
  g.fillStyle = '#141a26'; g.font = '700 26px system-ui, sans-serif'; g.textBaseline = 'top';
  const words = name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').split(' ');
  let line = '', y = 100;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width > w - 72 && line) { g.fillText(line, 36, y); line = word; y += 34; if (y > 170) break; }
    else line = next;
  }
  if (y <= 170) g.fillText(line, 36, y);
  let ly = Math.max(y + 60, 230);
  for (let i = 0; ly < h - 50; i++, ly += 30) {
    const lw = [0.9, 0.78, 0.95, 0.6, 0.85, 0.7][i % 6] * (w - 72);
    if (i === 3) { g.fillStyle = '#fff0b3'; g.fillRect(30, ly - 8, lw + 12, 26); }
    g.fillStyle = '#d9dde7'; g.fillRect(36, ly, lw, 10);
  }
  return c;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// from — прямоугольник, откуда «взять» лист (DOMRect), target — функция, возвращающая элемент-цель или null.
export async function crumple(from, { name = '', ext = '', target = () => null, delay = 0 } = {}) {
  if (disabled() || !from) return;
  let sheet;
  try { sheet = await load(); } catch { return; }
  const T = THREE;
  const canvas = document.createElement('canvas');
  canvas.className = 'crumple-layer';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try { renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' }); } catch { return; }
  document.body.append(canvas);
  const vw = innerWidth, vh = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(vw, vh, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;

  const { aspect, shortSide, count, original, uvs, indices, path, rng } = sheet;
  const positions = new Float32Array(count * 3);
  const renderPositions = new Float32Array(indices.length * 3);
  const renderNormals = new Float32Array(indices.length * 3);
  const renderUvs = new Float32Array(indices.length * 2);
  const faceNormals = new Float32Array(indices.length);
  const incidentFaces = Array.from({ length: count }, () => []);
  for (let i = 0; i < indices.length; i++) {
    renderUvs[i * 2] = uvs[indices[i] * 2];
    renderUvs[i * 2 + 1] = uvs[indices[i] * 2 + 1];
    incidentFaces[indices[i]].push(Math.floor(i / 3) * 3);
  }
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(renderPositions, 3).setUsage(T.DynamicDrawUsage));
  geometry.setAttribute('normal', new T.BufferAttribute(renderNormals, 3).setUsage(T.DynamicDrawUsage));
  geometry.setAttribute('uv', new T.BufferAttribute(renderUvs, 2));
  const grainData = new Uint8Array(128 * 128 * 4);
  for (let i = 0; i < grainData.length; i += 4) {
    const value = 100 + Math.floor(rng() * 155);
    grainData[i] = grainData[i + 1] = grainData[i + 2] = value;
    grainData[i + 3] = 255;
  }
  const grain = new T.DataTexture(grainData, 128, 128);
  grain.wrapS = grain.wrapT = T.RepeatWrapping;
  grain.repeat.set(5, 5 * aspect);
  grain.magFilter = grain.minFilter = T.LinearFilter;
  grain.needsUpdate = true;
  const print = new T.CanvasTexture(paperTexture(name, ext));
  print.colorSpace = T.SRGBColorSpace;
  print.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const base = { roughness: CFG.roughness, metalness: 0, bumpMap: grain, bumpScale: CFG.paperTexture * 0.32, flatShading: false };
  const frontMaterial = new T.MeshStandardMaterial({ ...base, side: T.FrontSide, map: print });
  const backMaterial = new T.MeshStandardMaterial({ ...base, side: T.BackSide, color: CFG.paperColor });
  const lighting = { value: 0 };
  for (const material of [frontMaterial, backMaterial]) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.paperLighting = lighting;
      shader.fragmentShader = 'uniform float paperLighting;\n' + shader.fragmentShader.replace('#include <opaque_fragment>',
        'outgoingLight = mix(diffuseColor.rgb, outgoingLight, paperLighting);\n#include <opaque_fragment>');
    };
    material.customProgramCacheKey = () => `paper-${material === backMaterial ? 'stock' : 'print'}`;
  }
  const group = new T.Group();
  const front = new T.Mesh(geometry, frontMaterial);
  const back = new T.Mesh(geometry, backMaterial);
  front.castShadow = front.receiveShadow = back.receiveShadow = true;
  group.add(front, back);
  const scene = new T.Scene();
  scene.add(group);
  const camera = new T.PerspectiveCamera(35, vw / vh, 0.1, 10000);
  camera.position.z = vh / (2 * Math.tan(T.MathUtils.degToRad(camera.fov / 2)));
  camera.updateProjectionMatrix();
  scene.add(new T.HemisphereLight(0xffffff, 0xa4a0b0, 1.35));
  const light = new T.DirectionalLight(0xfffaf0, CFG.lightIntensity);
  const reach = Math.max(vw, vh), angle = T.MathUtils.degToRad(CFG.lightAngle);
  light.position.set(Math.sin(angle) * reach, Math.cos(angle) * reach, reach * 4);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -0.0002;
  light.shadow.normalBias = 0.6;
  Object.assign(light.shadow.camera, { left: -reach, bottom: -reach, right: reach, top: reach, near: 1, far: reach * 6 });
  light.shadow.camera.updateProjectionMatrix();
  scene.add(light, light.target);
  const floorMaterial = new T.ShadowMaterial({ opacity: CFG.shadowOpacity, depthWrite: false });
  const floor = new T.Mesh(new T.PlaneGeometry(1, 1), floorMaterial);
  floor.receiveShadow = true;
  floor.scale.set(vw * 4, vh * 4, 1);
  scene.add(floor);

  const scale = CFG.width;
  group.scale.setScalar(scale);
  const sx = from.left + from.width / 2 - vw / 2, sy = vh / 2 - (from.top + from.height / 2);
  const amount = spring(), tiltX = spring(), tiltY = spring();
  tiltX.target = (Math.random() - 0.5) * 0.5;
  tiltY.target = (Math.random() - 0.5) * 0.6;

  function deform() {
    const fold = clamp(amount.value, 0, 1);
    const f = fold * (path.samples.length - 1);
    const lower = Math.floor(f), upper = Math.min(lower + 1, path.samples.length - 1), mix = f - lower;
    const a = path.samples[lower], b = path.samples[upper];
    for (let i = 0; i < positions.length; i++) positions[i] = a[i] + (b[i] - a[i]) * mix;
    for (let face = 0; face < indices.length; face += 3) {
      const p = indices[face] * 3, q = indices[face + 1] * 3, r = indices[face + 2] * 3;
      const bx = positions[q] - positions[p], by = positions[q + 1] - positions[p + 1], bz = positions[q + 2] - positions[p + 2];
      const cx = positions[r] - positions[p], cy = positions[r + 1] - positions[p + 1], cz = positions[r + 2] - positions[p + 2];
      const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
      const length = Math.hypot(nx, ny, nz) || 1;
      faceNormals[face] = nx / length; faceNormals[face + 1] = ny / length; faceNormals[face + 2] = nz / length;
    }
    for (let i = 0; i < indices.length; i++) {
      const source = indices[i] * 3, face = Math.floor(i / 3) * 3;
      let nx = 0, ny = 0, nz = 0;
      for (const n of incidentFaces[indices[i]]) {
        const dot = faceNormals[face] * faceNormals[n] + faceNormals[face + 1] * faceNormals[n + 1] + faceNormals[face + 2] * faceNormals[n + 2];
        const weight = T.MathUtils.smoothstep(dot, 0.88 - (1 - CFG.foldSharpness) * 0.18, 0.98);
        nx += faceNormals[n] * weight; ny += faceNormals[n + 1] * weight; nz += faceNormals[n + 2] * weight;
      }
      const length = Math.hypot(nx, ny, nz) || 1;
      renderPositions[i * 3] = positions[source]; renderPositions[i * 3 + 1] = positions[source + 1]; renderPositions[i * 3 + 2] = positions[source + 2];
      renderNormals[i * 3] = nx / length; renderNormals[i * 3 + 1] = ny / length; renderNormals[i * 3 + 2] = nz / length;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    geometry.computeBoundingSphere();
    lighting.value = T.MathUtils.smoothstep(fold, 0, 0.4);
  }

  // Сценарий: 0–0,6 с — смятие на месте строки; с 0,45 с — полёт по дуге к корзине с уменьшением; в конце — растворение.
  const FLY_AT = 450 + delay, FLY = 620, END = FLY_AT + FLY + 120;
  let start = 0, last = 0, flyFrom = null, flyTo = null;
  const dispose = () => {
    geometry.dispose(); frontMaterial.dispose(); backMaterial.dispose(); floorMaterial.dispose(); floor.geometry.dispose();
    grain.dispose(); print.dispose(); light.shadow.dispose(); renderer.dispose(); canvas.remove();
  };
  const frame = (now) => {
    if (!start) { start = last = now; amount.target = delay ? 0 : CFG.crumpleAmount; }
    const t = now - start, dt = Math.min(0.04, (now - last) / 1000);
    last = now;
    if (t >= delay) amount.target = CFG.crumpleAmount;
    for (const s of [amount, tiltX, tiltY]) advance(s, dt, s === amount ? CFG.crumpleDuration : 0.42, false);
    deform();
    let x = sx, y = sy, k = 1, spin = 0;
    if (t > FLY_AT) {
      if (!flyFrom) {
        flyFrom = { x: sx, y: sy };
        const el = target();
        const r = el?.getBoundingClientRect();
        flyTo = r && r.width && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
          ? { x: r.left + Math.min(r.width, 40) / 2 + 6 - vw / 2, y: vh / 2 - (r.top + r.height / 2), el }
          : { x: sx, y: sy - 160, el: null };
      }
      const p = clamp((t - FLY_AT) / FLY, 0, 1), e = ease(p);
      x = flyFrom.x + (flyTo.x - flyFrom.x) * e;
      y = flyFrom.y + (flyTo.y - flyFrom.y) * e + Math.sin(p * Math.PI) * 90;
      k = 1 - 0.72 * e;
      spin = e * Math.PI * 0.9;
      canvas.style.opacity = String(1 - clamp((p - 0.82) / 0.18, 0, 1));
    }
    group.scale.setScalar(scale * k);
    group.position.set(x, y, 0);
    group.rotation.set(tiltX.value, tiltY.value, spin);
    floor.position.z = -scale * shortSide * 0.12;
    renderer.render(scene, camera);
    if (t < END) requestAnimationFrame(frame);
    else {
      dispose();
      if (flyTo?.el?.isConnected) { flyTo.el.classList.remove('bump'); void flyTo.el.offsetWidth; flyTo.el.classList.add('bump'); }
    }
  };
  deform();
  requestAnimationFrame(frame);
}
