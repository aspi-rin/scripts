// ==UserScript==
// @name         Florilegium 留白花园
// @namespace    https://github.com/aspi-rin/scripts
// @version      0.2.0
// @description  在网页留白处生成植物图案，自动避让文字和控件；通过菜单按站点启用。
// @author       aspi-rin
// @license      MIT
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @homepageURL  https://github.com/aspi-rin/scripts
// @supportURL   https://github.com/aspi-rin/scripts/issues
// @downloadURL  https://raw.githubusercontent.com/aspi-rin/scripts/main/florilegium.user.js
// @updateURL    https://raw.githubusercontent.com/aspi-rin/scripts/main/florilegium.user.js
// ==/UserScript==

/*
MIT License

Copyright (c) 2026 Florilegium Web contributors
Upstream adaptation credit: Copyright (c) 2026 Kevin Raymond

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(function () {
'use strict';
const module = { exports: {} };
/* Florilegium Web — a small, native JavaScript adaptation of the space-filling
 * growth idea in Kevin Raymond's florilegium (MIT), pinned to b4acf0ea9de6a6d1.
 * This implementation has its own geometry and three simplified motif families.
 * Upstream MIT notice is included above.
 * Mulberry32 by Tommy Ettinger (public domain).
 */
(function (global) {
  'use strict';
  const VERSION = '0.1.0';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const unit = (x, y) => { const d = Math.hypot(x, y) || 1; return { x: x / d, y: y / d }; };
  const fmt = n => Number(n.toFixed(2));
  const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function hash(value) {
    let h = 2166136261;
    for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  }

  function random(seed) {
    let state = seed >>> 0;
    return () => {
      let t = state += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function cubic(points, t) {
    const u = 1 - t;
    return {
      x: u ** 3 * points[0].x + 3 * u * u * t * points[1].x + 3 * u * t * t * points[2].x + t ** 3 * points[3].x,
      y: u ** 3 * points[0].y + 3 * u * u * t * points[1].y + 3 * u * t * t * points[2].y + t ** 3 * points[3].y,
    };
  }

  function numeric(value, fallback, min, max, name) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`${name} must be ${min}…${max}`);
    return n;
  }

  function normalize(options = {}) {
    const width = numeric(options.width, 800, 32, 8192, 'width');
    const height = numeric(options.height, 720, 32, 8192, 'height');
    const scale = numeric(options.scale, 1, 0.4, 2.5, 'scale');
    const padding = numeric(options.padding, 12, 0, Math.min(width, height) / 2, 'padding');
    const gap = numeric(options.gap, 10, 0, 100, 'gap');
    const obstacles = (options.obstacles || []).map(r => {
      for (const key of ['x', 'y', 'width', 'height']) {
        if (!Number.isFinite(r[key]) || (['width', 'height'].includes(key) && r[key] < 0)) throw new TypeError('Invalid obstacle rectangle');
      }
      return { x: r.x - gap, y: r.y - gap, width: r.width + gap * 2, height: r.height + gap * 2 };
    });
    const ink = options.ink || '#244f79';
    const accent = options.accent || '#b17a49';
    if (!/^#[\da-f]{6}$/i.test(ink) || !/^#[\da-f]{6}$/i.test(accent)) throw new TypeError('Colors must be six-digit hex');
    return {
      width, height, scale, padding, gap, obstacles, ink, accent,
      seed: String(options.seed ?? 7),
      density: numeric(options.density, 0.85, 0, 1.5, 'density'),
      spacing: Math.max(numeric(options.spacing, 8, 4, 40, 'spacing'), Math.sqrt(width * height / 18000)),
      maxMotifs: Math.floor(numeric(options.maxMotifs, 160, 0, 240, 'maxMotifs')),
    };
  }

  // Distance to the hard page/content boundary. Ornament proxies never shrink this boundary.
  function clearance(p, settings) {
    let result = Math.min(p.x - settings.padding, settings.width - settings.padding - p.x,
      p.y - settings.padding, settings.height - settings.padding - p.y);
    for (const r of settings.obstacles) {
      const dx = Math.max(r.x - p.x, 0, p.x - r.x - r.width);
      const dy = Math.max(r.y - p.y, 0, p.y - r.y - r.height);
      if (dx === 0 && dy === 0) return -1;
      result = Math.min(result, Math.hypot(dx, dy));
    }
    return result;
  }

  function sampleCurve(points) {
    const length = distance(points[0], points[1]) + distance(points[1], points[2]) + distance(points[2], points[3]);
    const n = Math.max(6, Math.ceil(length / 2));
    return Array.from({ length: n + 1 }, (_, i) => cubic(points, i / n));
  }

  function generate(options) {
    const settings = normalize(options);
    const { width, height, padding, spacing, scale, density } = settings;
    const rng = random(hash(`${settings.seed}/layout`));
    const scene = { version: VERSION, settings, stems: [], motifs: [], roots: [], cells: [], attempts: 0 };
    if (density === 0 || settings.maxMotifs === 0) return scene;
    const cells = scene.cells;
    for (let y = padding + spacing / 2; y < height - padding; y += spacing) {
      for (let x = padding + spacing / 2; x < width - padding; x += spacing) {
        const p = { x, y };
        const free = clearance(p, settings);
        if (free > 0) cells.push({ ...p, free, near: Infinity });
      }
    }
    const root = cells.filter(p => p.free >= 5 * scale).sort((a, b) =>
      distance(a, { x: padding + 24 * scale, y: height - padding - 16 * scale }) -
      distance(b, { x: padding + 24 * scale, y: height - padding - 16 * scale }))[0];
    if (!root) return scene;
    scene.roots.push({ x: root.x, y: root.y });
    const anchors = [];
    const reach = 92 * scale;

    function reserve(p, radius, overlap = 0.85) {
      for (const c of cells) c.free = Math.min(c.free, distance(c, p) - radius * overlap);
    }
    function addAnchor(p, tangent, stemId, plant) {
      anchors.push({ ...p, tangent, stemId, plant });
      for (const c of cells) c.near = Math.min(c.near, distance(c, p));
    }
    function addStem(points, parent, plant, kind, strokeWidth) {
      const samples = sampleCurve(points);
      if (samples.some(p => clearance(p, settings) < strokeWidth + 0.8)) return null;
      const id = scene.stems.length;
      scene.stems.push({ id, points, parent, plant, kind, width: strokeWidth });
      for (let i = 0; i < samples.length; i += 3) {
        const a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
        addAnchor(samples[i], unit(b.x - a.x, b.y - a.y), id, plant);
        reserve(samples[i], strokeWidth * 1.2, 1);
      }
      return id;
    }
    function line(a, b, parent, plant, kind = 'main', strokeWidth = 1.1) {
      return addStem([a, { x: lerp(a.x, b.x, 0.33), y: lerp(a.y, b.y, 0.33) },
        { x: lerp(a.x, b.x, 0.67), y: lerp(a.y, b.y, 0.67) }, b], parent, plant, kind, strokeWidth);
    }

    // Three stems share a root, rising through reachable empty space; a fourth follows the foot.
    for (let plant = 0; plant < 4; plant++) {
      let p = { x: root.x, y: root.y }, parent = null;
      const footer = plant === 3;
      const steps = Math.ceil((footer ? width * 0.86 : height * [0.89, 0.67, 0.46][plant]) / (8 * scale));
      const phase = rng() * TAU;
      for (let step = 1; step < steps; step++) {
        const travel = step * 8 * scale;
        const sway = Math.sin(travel / (49 * scale) + phase) * 14 * scale + Math.sin(travel / (23 * scale) + phase) * 4 * scale;
        const wanted = footer
          ? { x: root.x + travel, y: root.y - 7 * scale + sway * 0.45 }
          : { x: root.x + (plant - 1) * 12 * scale + sway, y: root.y - travel };
        wanted.x = clamp(wanted.x, padding + 16 * scale, width - padding - 16 * scale);
        wanted.y = clamp(wanted.y, padding + 16 * scale, height - padding - 16 * scale);
        const candidates = [0, -8, 8, -16, 16, -24, 24].map(delta => footer
          ? { x: wanted.x, y: wanted.y + delta * scale }
          : { x: wanted.x + delta * scale, y: wanted.y });
        let next = null, id = null;
        for (const q of candidates) {
          if (distance(p, q) > 36 * scale) continue;
          id = line(p, q, parent, plant, 'main', (footer ? 1.1 : 1.35) * scale);
          if (id !== null) { next = q; break; }
        }
        if (!next) break;
        p = next; parent = id;
      }
    }
    if (!anchors.length) return scene;

    function nearest(p) {
      let best, d = Infinity;
      for (const anchor of anchors) {
        const n = distance(p, anchor);
        if (n < d) { best = anchor; d = n; }
      }
      return best;
    }

    const limit = Math.min(settings.maxMotifs, Math.round(110 * density));
    const minimum = 5.5 * scale / Math.sqrt(density);
    for (let attempt = 0; attempt < limit * 5 && scene.motifs.length < limit; attempt++) {
      scene.attempts++;
      let selected = null, score = -1;
      for (const c of cells) {
        if (c.near > reach || c.free < minimum) continue;
        const s = c.free * (0.85 + rng() * 0.3);
        if (s > score) { score = s; selected = c; }
      }
      if (!selected) break;
      const center = { x: selected.x, y: selected.y };
      const holeRadius = selected.free;
      const anchor = nearest(center);
      const radius = Math.min(selected.free * 0.9, 34 * scale);
      const axis = unit(center.x - anchor.x, center.y - anchor.y - 12 * scale);
      const shape = random(hash(`${settings.seed}/shape/${scene.motifs.length}`));
      const kind = radius < 9 * scale ? 'bud' : shape() < 0.43 ? 'leaf' : 'flower';
      const end = kind === 'leaf' ? { x: center.x - axis.x * radius * 0.72, y: center.y - axis.y * radius * 0.72 } : center;
      const length = distance(anchor, end);
      let points = [{ x: anchor.x, y: anchor.y },
        { x: anchor.x + anchor.tangent.x * length * 0.4, y: anchor.y + anchor.tangent.y * length * 0.4 },
        { x: end.x - axis.x * length * 0.3, y: end.y - axis.y * length * 0.3 }, end];
      let stemId = addStem(points, anchor.stemId, anchor.plant, 'branch', 0.7 * scale);
      if (stemId === null) {
        stemId = line({ x: anchor.x, y: anchor.y }, end, anchor.stemId, anchor.plant, 'branch', 0.7 * scale);
      }
      if (stemId === null) { selected.free = 0; continue; }
      scene.motifs.push({ ...center, radius, freeRadius: holeRadius,
        kind, angle: Math.atan2(axis.y, axis.x), plant: anchor.plant, stemId,
        petals: 5 + Math.floor(shape() * 4), variation: shape(), parent: { x: anchor.x, y: anchor.y } });
      reserve(center, radius);
    }
    return scene;
  }

  function path(points) {
    return `M${fmt(points[0].x)} ${fmt(points[0].y)}C${points.slice(1).map(p => `${fmt(p.x)} ${fmt(p.y)}`).join(' ')}`;
  }

  function motifSVG(m, index, settings, id) {
    const r = m.radius * 0.92;
    const transform = `translate(${fmt(m.x)} ${fmt(m.y)}) rotate(${fmt(m.angle * 180 / Math.PI)})`;
    if (m.kind === 'leaf') {
      const side = r * (0.33 + m.variation * 0.17);
      let veins = '';
      for (let i = -2; i <= 2; i++) {
        const x = i * r * 0.25;
        veins += `<path d="M${fmt(x - r * 0.14)} 0Q${fmt(x)} ${fmt(side * 0.55)} ${fmt(x + r * 0.14)} ${fmt(side * 0.65)}M${fmt(x - r * 0.14)} 0Q${fmt(x)} ${fmt(-side * 0.55)} ${fmt(x + r * 0.14)} ${fmt(-side * 0.65)}"/>`;
      }
      return `<g transform="${transform}"><path d="M${fmt(-r)} 0C${fmt(-r * 0.32)} ${fmt(-side * 1.5)} ${fmt(r * 0.55)} ${fmt(-side)} ${fmt(r)} 0C${fmt(r * 0.45)} ${fmt(side)} ${fmt(-r * 0.3)} ${fmt(side * 1.5)} ${fmt(-r)} 0" fill="url(#${id}-leaf)"/><path d="M${fmt(-r * 0.88)} 0Q0 ${fmt(r * 0.06)} ${fmt(r * 0.89)} 0" fill="none" stroke="white" stroke-opacity=".65" stroke-width=".7"/><g fill="none" stroke="white" stroke-opacity=".42" stroke-width=".45">${veins}</g></g>`;
    }
    if (m.kind === 'bud') return `<g transform="${transform}"><ellipse cx="0" cy="0" rx="${fmt(r * 0.9)}" ry="${fmt(r * 0.5)}" fill="url(#${id}-petal)"/><path d="M${fmt(-r)} 0Q0 ${fmt(r * 0.3)} ${fmt(r * 0.8)} 0" fill="none" stroke="${settings.ink}" stroke-width=".6"/></g>`;
    let petals = '';
    for (let i = 0; i < m.petals; i++) {
      const angle = i * 360 / m.petals + m.variation * 30;
      const w = r * 0.33;
      petals += `<g transform="rotate(${fmt(angle)})"><path d="M0 ${fmt(r * 0.09)}C${fmt(-w)} ${fmt(r * 0.17)} ${fmt(-w * 1.22)} ${fmt(r * 0.8)} 0 ${fmt(r)}C${fmt(w * 1.16)} ${fmt(r * 0.84)} ${fmt(w)} ${fmt(r * 0.18)} 0 ${fmt(r * 0.09)}" fill="url(#${id}-petal)"/><path d="M0 ${fmt(r * 0.18)}Q${fmt(w * 0.2)} ${fmt(r * 0.5)} 0 ${fmt(r * 0.83)}" fill="none" stroke="white" stroke-opacity=".5" stroke-width=".65"/></g>`;
    }
    let stamens = '';
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * TAU;
      stamens += `<circle cx="${fmt(Math.cos(a) * r * 0.15)}" cy="${fmt(Math.sin(a) * r * 0.15)}" r="${fmt(Math.max(0.65, r * 0.025))}" fill="${settings.accent}"/>`;
    }
    return `<g transform="${transform}">${petals}<circle r="${fmt(r * 0.19)}" fill="${settings.ink}" fill-opacity=".85"/>${stamens}</g>`;
  }

  function toSVG(scene, options = {}) {
    const s = scene.settings;
    const id = `flora-${hash(JSON.stringify(s))}`;
    const progress = clamp(Number(options.progress ?? 1), 0, 1);
    if (!Number.isFinite(progress)) throw new TypeError('progress must be finite');
    const visible = scene.motifs.slice(0, Math.floor(scene.motifs.length * progress));
    const wanted = new Set(visible.map(m => m.stemId));
    // Branch ancestors must be visible before a child can appear.
    for (let i = scene.stems.length - 1; i >= 0; i--) {
      if (wanted.has(i) && scene.stems[i].parent !== null) wanted.add(scene.stems[i].parent);
    }
    const strokes = scene.stems.filter(stem => stem.kind === 'main' || wanted.has(stem.id));
    const rects = s.obstacles.map(r => `<rect x="${fmt(r.x)}" y="${fmt(r.y)}" width="${fmt(r.width)}" height="${fmt(r.height)}"/>`).join('');
    const debug = options.debug ? `<g fill="${s.accent}" fill-opacity=".07" stroke="${s.accent}" stroke-opacity=".45" stroke-width=".7">${rects}</g><g fill="none" stroke="${s.accent}" stroke-opacity=".7" stroke-width=".7" stroke-dasharray="3 4">${visible.map(m => `<circle cx="${fmt(m.x)}" cy="${fmt(m.y)}" r="${fmt(m.radius)}"/>`).join('')}</g>` : '';
    const curves = strokes.map(stem => `<path d="${path(stem.points)}" stroke-width="${fmt(stem.width)}"/>`).join('');
    const shapes = visible.map((m, i) => motifSVG(m, i, s, id)).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(s.width)}" height="${fmt(s.height)}" viewBox="0 0 ${fmt(s.width)} ${fmt(s.height)}" fill="none"${options.decorative ? ' aria-hidden="true" focusable="false"' : ' role="img"'}><title>${escape(options.title || `Florilegium garden, seed ${s.seed}`)}</title><defs><radialGradient id="${id}-petal" cx="35%" cy="25%" r="85%"><stop stop-color="${s.ink}" stop-opacity=".12"/><stop offset=".6" stop-color="${s.ink}" stop-opacity=".38"/><stop offset="1" stop-color="${s.ink}" stop-opacity=".74"/></radialGradient><linearGradient id="${id}-leaf" x2="1" y2="1"><stop stop-color="${s.ink}" stop-opacity=".25"/><stop offset="1" stop-color="${s.ink}" stop-opacity=".75"/></linearGradient><mask id="${id}-safe" maskUnits="userSpaceOnUse" x="0" y="0" width="${fmt(s.width)}" height="${fmt(s.height)}"><rect x="${fmt(s.padding)}" y="${fmt(s.padding)}" width="${fmt(s.width - s.padding * 2)}" height="${fmt(s.height - s.padding * 2)}" fill="white"/><g fill="black">${rects}</g></mask></defs><g mask="url(#${id}-safe)"><g stroke="${s.ink}" stroke-opacity=".62" stroke-linecap="round" stroke-linejoin="round">${curves}</g>${shapes}</g>${debug}</svg>`;
  }

  const protectedSelector = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,img,picture,video,canvas,table,button,input,select,textarea,svg,iframe,[data-flora-keep]';
  const mounted = new WeakMap();

  function mount(container, options = {}) {
    if (!container || container.nodeType !== 1) throw new TypeError('mount needs an HTML element');
    mounted.get(container)?.destroy();
    const doc = container.ownerDocument;
    const view = doc.defaultView;
    const initialPosition = container.style.position;
    const changedPosition = view.getComputedStyle(container).position === 'static';
    if (changedPosition) container.style.position = 'relative';
    const layer = doc.createElement('div');
    layer.className = 'florilegium-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0;contain:strict;';
    container.prepend(layer);
    let current = { ...options }, scene = null, timer = null, destroyed = false;
    let resizeObserver, mutationObserver;
    const touched = new Map();
    // Put the non-decorative children above the garden without taking them out of flow.
    function liftContent() {
      for (const child of container.children) {
        if (child === layer || touched.has(child)) continue;
        const computed = view.getComputedStyle(child);
        touched.set(child, { position: child.style.position, zIndex: child.style.zIndex });
        if (computed.position === 'static') child.style.position = 'relative';
        if (computed.zIndex === 'auto') child.style.zIndex = '1';
      }
    }
    function measure() {
      const rect = container.getBoundingClientRect();
      const sx = rect.width / (container.offsetWidth || rect.width || 1);
      const sy = rect.height / (container.offsetHeight || rect.height || 1);
      const originX = rect.left + container.clientLeft * sx;
      const originY = rect.top + container.clientTop * sy;
      const nodes = container.querySelectorAll(current.protect || protectedSelector);
      const obstacles = [];
      for (const node of nodes) {
        if (layer.contains(node) || node.closest('[data-flora-ignore]')) continue;
        if (view.getComputedStyle(node).visibility === 'hidden') continue;
        for (const r of node.getClientRects()) {
          if (r.width > 0 && r.height > 0) obstacles.push({ x: (r.left - originX) / sx + container.scrollLeft,
            y: (r.top - originY) / sy + container.scrollTop, width: r.width / sx, height: r.height / sy });
        }
      }
      return { width: Math.max(32, container.clientWidth), height: Math.max(32, container.clientHeight), obstacles };
    }
    function draw() {
      if (destroyed) return;
      mutationObserver?.disconnect();
      liftContent();
      try {
        const box = measure();
        scene = generate({ ...current, ...box, obstacles: [...box.obstacles, ...(current.obstacles || [])] });
        layer.innerHTML = toSVG(scene, { debug: current.debug, progress: current.progress, decorative: true });
        layer.firstElementChild.style.cssText = 'display:block;width:100%;height:100%;';
        current.onRender?.(scene);
      } catch (error) {
        layer.replaceChildren();
        if (current.onError) current.onError(error); else view.console.warn('Florilegium:', error);
      } finally {
        mutationObserver?.observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
      }
    }
    function schedule() {
      if (destroyed) return;
      view.clearTimeout(timer);
      timer = view.setTimeout(draw, 120);
    }
    mutationObserver = new view.MutationObserver(records => {
      if (records.some(r => !layer.contains(r.target) && r.target !== layer)) schedule();
    });
    if (view.ResizeObserver) {
      resizeObserver = new view.ResizeObserver(schedule);
      resizeObserver.observe(container);
    } else view.addEventListener('resize', schedule);
    container.addEventListener('load', schedule, true);
    doc.fonts?.ready.then(schedule);
    doc.fonts?.addEventListener('loadingdone', schedule);
    const controller = {
      refresh: draw,
      update(next) { current = { ...current, ...next }; draw(); },
      get scene() { return scene; },
      exportSVG() { return scene ? toSVG(scene) : ''; },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        view.clearTimeout(timer);
        resizeObserver?.disconnect(); mutationObserver?.disconnect();
        view.removeEventListener('resize', schedule);
        container.removeEventListener('load', schedule, true);
        doc.fonts?.removeEventListener('loadingdone', schedule);
        layer.remove();
        for (const [child, saved] of touched) {
          child.style.position = saved.position; child.style.zIndex = saved.zIndex;
        }
        if (changedPosition) container.style.position = initialPosition;
        mounted.delete(container);
      },
    };
    mounted.set(container, controller);
    draw();
    return controller;
  }

  const api = { version: VERSION, generate, toSVG, mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Florilegium = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// This file is appended inside the generated userscript's private scope.
// GM APIs below are shared by Tampermonkey and ScriptCat.
const Flora = module.exports;
if (window.top !== window.self || !document.body || !/^https?:$/.test(location.protocol)) return;

const key = `florilegium:site:${location.origin}`;
const stored = GM_getValue(key, {});
const densities = [0.35, 0.65, 1];
const densityNames = ['疏朗', '适中', '丰盛'];
const settings = {
  enabled: stored?.enabled === true,
  seed: Number.isFinite(stored?.seed) ? stored.seed : 7,
  density: densities.includes(stored?.density) ? stored.density : 0.65,
};
let menuIds = [];
let stop = null;
let scene = null;

function visibleRect(rect, width, height) {
  const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
  const right = Math.min(width, rect.right), bottom = Math.min(height, rect.bottom);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

// Protect visible text lines as well as image/control surfaces. Unknown or excessive
// content produces no decoration rather than a partially measured protection mask.
function measureVisible(layer) {
  const width = Math.min(innerWidth, 8192), height = Math.min(innerHeight, 8192);
  if (width < 32 || height < 32) return null;
  const obstacles = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node, visited = 0;
  while ((node = walker.nextNode())) {
    if (++visited > 16000) return null;
    const parent = node.parentElement;
    if (!parent || !node.nodeValue.trim() || parent.closest('script,style,noscript,template,[hidden]') || layer.contains(parent)) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const parentBox = parent.getBoundingClientRect();
    if (parentBox.bottom <= 0 || parentBox.top >= height || parentBox.right <= 0 || parentBox.left >= width) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      const r = visibleRect(rect, width, height);
      if (r) obstacles.push(r);
      if (obstacles.length > 1600) return null;
    }
  }
  const surfaces = document.body.querySelectorAll('img,svg,canvas,video,iframe,button,input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="img"],[data-flora-keep]');
  if (surfaces.length > 16000) return null;
  for (const surface of surfaces) {
    if (layer.contains(surface) || getComputedStyle(surface).visibility === 'hidden') continue;
    const r = visibleRect(surface.getBoundingClientRect(), width, height);
    if (r) obstacles.push(r);
    if (obstacles.length > 1600) return null;
  }
  return { width, height, obstacles };
}

function start() {
  stop?.();
  scene = null;
  if (!settings.enabled) { stop = null; return; }
  const layer = document.createElement('div');
  layer.id = 'florilegium-userscript-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;pointer-events:none!important;z-index:2147483646!important;overflow:hidden!important;contain:strict!important;';
  const shadow = layer.attachShadow({ mode: 'open' });
  document.body.append(layer);
  let timer = null, disposed = false;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target !== layer && !layer.contains(record.target))) schedule();
  });
  function observe() {
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
  }
  function draw() {
    if (disposed) return;
    observer.disconnect();
    try {
      if (!layer.isConnected) document.body.append(layer);
      const box = measureVisible(layer);
      if (!box) { shadow.replaceChildren(); scene = null; return; }
      scene = Flora.generate({ ...box, seed: settings.seed, density: settings.density,
        spacing: 13, gap: 9, padding: 12, scale: 0.85, maxMotifs: 110,
        ink: dark.matches ? '#9abbd5' : '#244f79' });
      shadow.innerHTML = Flora.toSVG(scene, { decorative: true });
      shadow.firstElementChild.style.cssText = 'display:block;width:100%;height:100%;';
      layer.style.visibility = 'visible';
    } catch (error) {
      scene = null; shadow.replaceChildren();
      console.warn('Florilegium:', error);
    } finally { if (!disposed) observe(); }
  }
  function schedule() {
    if (disposed) return;
    // Hide the old mask immediately while content is moving.
    layer.style.visibility = 'hidden';
    clearTimeout(timer);
    timer = setTimeout(draw, 180);
  }
  const events = ['scroll', 'resize', 'load', 'click', 'input', 'pointerover', 'focusin', 'transitionend', 'animationend'];
  for (const event of events) window.addEventListener(event, schedule, { capture: true, passive: true });
  dark.addEventListener('change', schedule);
  document.fonts?.ready.then(schedule);
  document.fonts?.addEventListener('loadingdone', schedule);
  stop = () => {
    if (disposed) return;
    disposed = true; clearTimeout(timer); observer.disconnect();
    for (const event of events) window.removeEventListener(event, schedule, true);
    dark.removeEventListener('change', schedule);
    document.fonts?.removeEventListener('loadingdone', schedule);
    layer.remove(); scene = null;
  };
  draw();
}

async function saveAndApply() {
  await GM_setValue(key, { ...settings });
  start();
  menus();
}

function menus() {
  for (const id of menuIds) GM_unregisterMenuCommand(id);
  menuIds = [];
  const add = (label, action) => menuIds.push(GM_registerMenuCommand(label, action));
  add(`${settings.enabled ? '关闭' : '启用'}本网站的留白花园`, async () => {
    settings.enabled = !settings.enabled;
    await saveAndApply();
  });
  if (!settings.enabled) return;
  add('换一颗种子', async () => {
    settings.seed = crypto.getRandomValues(new Uint32Array(1))[0];
    await saveAndApply();
  });
  add(`花叶密度：${densityNames[densities.indexOf(settings.density)]}`, async () => {
    settings.density = densities[(densities.indexOf(settings.density) + 1) % densities.length];
    await saveAndApply();
  });
  add('保存当前花园 SVG', () => {
    if (!scene) return;
    const url = URL.createObjectURL(new Blob([Flora.toSVG(scene)], { type: 'image/svg+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `florilegium-${location.hostname.replace(/[^a-z0-9.-]/gi, '_')}-${settings.seed}.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

menus();
start();

})();
