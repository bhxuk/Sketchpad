/* Sketchpad app: state, tools, input, UI. */
(function () {
  'use strict';
  const SP = window.SP;
  const I = SP.ICONS;
  const $ = (s) => document.querySelector(s);

  /* ================================================================
     Constants
     ================================================================ */
  const TOOLS = [
    { id: 'hand', key: 'h', label: 'Hand, for panning', short: 'H' },
    { id: 'selection', key: 'v', num: '1', label: 'Selection', short: 'V or 1' },
    { id: 'rectangle', key: 'r', num: '2', label: 'Rectangle', short: 'R or 2' },
    { id: 'diamond', key: 'd', num: '3', label: 'Diamond', short: 'D or 3' },
    { id: 'ellipse', key: 'o', num: '4', label: 'Ellipse', short: 'O or 4' },
    { id: 'arrow', key: 'a', num: '5', label: 'Arrow', short: 'A or 5' },
    { id: 'line', key: 'l', num: '6', label: 'Line', short: 'L or 6' },
    { id: 'freedraw', key: 'p', alt: 'x', num: '7', label: 'Draw', short: 'P or 7' },
    { id: 'text', key: 't', num: '8', label: 'Text', short: 'T or 8' },
    { id: 'image', num: '9', label: 'Insert image', short: '9' },
    { id: 'eraser', key: 'e', num: '0', label: 'Eraser', short: 'E or 0' },
    { id: 'laser', key: 'k', label: 'Laser pointer', short: 'K' },
  ];
  const DRAW_TOOLS = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text']);
  const STROKES = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00'];
  const FILLS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99'];
  const CANVAS_BGS = ['#ffffff', '#f8f9fa', '#f5faff', '#fffce8', '#fdf8f6'];
  const MIN_ZOOM = 0.1, MAX_ZOOM = 30;
  const LS = { scene: 'sketchpad-scene', files: 'sketchpad-files', prefs: 'sketchpad-prefs', lib: 'sketchpad-library', theme: 'sketchpad-theme' };

  /* ================================================================
     State
     ================================================================ */
  const state = {
    elements: [],
    files: {},
    tool: 'selection',
    toolLocked: false,
    view: { x: 0, y: 0, zoom: 1 },
    selected: new Set(),
    action: null,
    multi: null,
    editingText: null,
    erasing: new Set(),
    bindHover: null,
    pointer: null,
    laser: [],
    grid: false,
    bg: '#ffffff',
    style: {
      strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'hachure', strokeWidth: 2,
      strokeStyle: 'solid', roughness: 1, opacity: 100, roundness: 'round', arrowType: 'round',
      startArrowhead: null, endArrowhead: 'arrow', fontSize: 20, fontFamily: 1, textAlign: 'left',
    },
    copiedStyle: null,
    fileHandle: null,
  };
  let clipboardMem = null;
  let library = [];
  let spaceDown = false;
  const pointers = new Map();

  /* ================================================================
     DOM
     ================================================================ */
  const sceneCanvas = $('#scene'), uiCanvas = $('#ui');
  const sctx = sceneCanvas.getContext('2d'), uctx = uiCanvas.getContext('2d');
  const rc = rough.canvas(sceneCanvas);
  const ta = $('#textEditor');
  let W = 0, H = 0, dpr = 1;

  /* ================================================================
     Element helpers
     ================================================================ */
  const getEl = (id) => state.elements.find((e) => e.id === id);
  const selectedElements = () => state.elements.filter((e) => state.selected.has(e.id));
  const boundTextOf = (c) => state.elements.find((e) => e.type === 'text' && e.containerId === c.id);

  function newElement(type, x, y, extra) {
    const s = state.style;
    const el = {
      id: SP.uid(), type, x, y, width: 0, height: 0, angle: 0,
      strokeColor: s.strokeColor, backgroundColor: s.backgroundColor, fillStyle: s.fillStyle,
      strokeWidth: s.strokeWidth, strokeStyle: s.strokeStyle, roughness: s.roughness, opacity: s.opacity,
      groupIds: [], frameId: null, roundness: null, seed: SP.seed(), version: 1, versionNonce: SP.seed(),
      isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
    };
    if (type === 'rectangle' || type === 'diamond') el.roundness = s.roundness === 'round' ? { type: 3 } : null;
    if (type === 'line' || type === 'arrow') {
      el.points = [[0, 0]];
      el.startBinding = null; el.endBinding = null;
      el.startArrowhead = type === 'arrow' ? s.startArrowhead : null;
      el.endArrowhead = type === 'arrow' ? s.endArrowhead : null;
      el.roundness = s.arrowType === 'round' ? { type: 2 } : null;
    }
    if (type === 'freedraw') { el.points = [[0, 0]]; el.pressures = []; el.simulatePressure = true; el.backgroundColor = 'transparent'; }
    if (type === 'text') {
      Object.assign(el, { text: '', originalText: '', fontSize: s.fontSize, fontFamily: s.fontFamily, textAlign: s.textAlign,
        verticalAlign: 'top', containerId: null, lineHeight: 1.25, autoResize: true, backgroundColor: 'transparent' });
    }
    if (type === 'image') Object.assign(el, { fileId: null, status: 'saved', scale: [1, 1], backgroundColor: 'transparent' });
    return Object.assign(el, extra || {});
  }

  /* the outermost group (or the element itself) that a click should select */
  function groupOf(el) {
    if (el.containerId) el = getEl(el.containerId) || el;
    if (el.groupIds && el.groupIds.length) {
      const g = el.groupIds[el.groupIds.length - 1];
      return state.elements.filter((e) => !e.containerId && e.groupIds.includes(g)).map((e) => e.id);
    }
    return [el.id];
  }

  /* selected ids plus the text bound inside selected containers */
  function selectionWithBound(ids) {
    const set = new Set(ids || state.selected);
    for (const e of state.elements) if (e.type === 'text' && e.containerId && set.has(e.containerId)) set.add(e.id);
    return set;
  }

  function measureFreeText(el) {
    const m = SP.measureText(el.text, el);
    el.width = Math.max(m.w, 1);
    el.height = m.h;
  }

  /* lay out the text inside a container, growing the container if needed */
  function updateBoundText(container) {
    const t = boundTextOf(container);
    if (!t) return;
    const inner = SP.containerInner(container);
    t.text = SP.wrapText(t.originalText, t, inner.w);
    const m = SP.measureText(t.text, t);
    if (m.h > inner.h) {
      const need = (m.h + inner.pad * 2) / inner.f;
      container.height = need;
      SP.bump(container);
    }
    const [cx, cy] = SP.center(container);
    t.width = inner.w;
    t.height = m.h;
    t.x = cx - inner.w / 2;
    t.y = cy - m.h / 2;
    t.angle = container.angle || 0;
    t.verticalAlign = 'middle';
    SP.bump(t);
  }

  /* ---------- arrow binding ---------- */
  function bindableAt(px, py, excludeId) {
    const tol = 8 / state.view.zoom;
    for (let i = state.elements.length - 1; i >= 0; i--) {
      const el = state.elements[i];
      if (el.id === excludeId || el.locked || !SP.isBindable(el)) continue;
      if (SP.hitElement(el, px, py, tol, true)) return el;
    }
    return null;
  }

  function updateArrowBinding(a) {
    const s = a.startBinding && getEl(a.startBinding.elementId);
    const t = a.endBinding && getEl(a.endBinding.elementId);
    if (!s && !t) return;
    const n = a.points.length;
    const pts = a.points.map(([x, y]) => [a.x + x, a.y + y]);
    if (s) {
      const ref = n === 2 && t ? SP.center(t) : pts[1];
      pts[0] = SP.outlinePoint(s, ref[0], ref[1], 6);
    }
    if (t) {
      const ref = n === 2 && s ? SP.center(s) : pts[n - 2];
      pts[n - 1] = SP.outlinePoint(t, ref[0], ref[1], 6);
    }
    a.x = pts[0][0]; a.y = pts[0][1];
    a.points = pts.map(([x, y]) => [x - a.x, y - a.y]);
    SP.mutate(a);
  }

  function updateBoundArrows(changed) {
    for (const el of state.elements) {
      if (el.type !== 'arrow' || changed.has(el.id)) continue;
      if ((el.startBinding && changed.has(el.startBinding.elementId)) || (el.endBinding && changed.has(el.endBinding.elementId))) updateArrowBinding(el);
    }
  }

  function tryBind(a, which) {
    if (a.type !== 'arrow') return;
    const n = a.points.length;
    const at = (i) => [a.x + a.points[i][0], a.y + a.points[i][1]];
    if (which !== 'end') {
      const p = at(0), s = bindableAt(p[0], p[1], a.id);
      a.startBinding = s ? { elementId: s.id, focus: 0, gap: 6 } : null;
    }
    if (which !== 'start') {
      const p = at(n - 1), t = bindableAt(p[0], p[1], a.id);
      a.endBinding = t && !(a.startBinding && a.startBinding.elementId === t.id) ? { elementId: t.id, focus: 0, gap: 6 } : null;
    }
    updateArrowBinding(a);
  }

  function removeElements(ids) {
    const set = new Set(ids);
    state.elements = state.elements.filter((e) => !set.has(e.id));
    for (const e of state.elements) {
      if (e.type === 'arrow') {
        if (e.startBinding && set.has(e.startBinding.elementId)) e.startBinding = null;
        if (e.endBinding && set.has(e.endBinding.elementId)) e.endBinding = null;
      }
      if (e.type === 'text' && e.containerId && set.has(e.containerId)) e.containerId = null;
    }
    for (const id of set) state.selected.delete(id);
  }

  /* copy elements with fresh ids, keeping groups, labels and bindings that stay inside the copy */
  function cloneElements(els, dx, dy) {
    const idMap = new Map(), gMap = new Map();
    for (const e of els) idMap.set(e.id, SP.uid());
    return els.map((e) => {
      const c = SP.clone(e);
      c.id = idMap.get(e.id);
      c.seed = SP.seed();
      c.x += dx; c.y += dy;
      c.groupIds = (c.groupIds || []).map((g) => { if (!gMap.has(g)) gMap.set(g, SP.uid()); return gMap.get(g); });
      if (c.containerId) c.containerId = idMap.get(c.containerId) || null;
      if (c.startBinding) c.startBinding = idMap.has(c.startBinding.elementId) ? Object.assign({}, c.startBinding, { elementId: idMap.get(c.startBinding.elementId) }) : null;
      if (c.endBinding) c.endBinding = idMap.has(c.endBinding.elementId) ? Object.assign({}, c.endBinding, { elementId: idMap.get(c.endBinding.elementId) }) : null;
      c.boundElements = null;
      SP.bump(c);
      return c;
    });
  }

  /* ================================================================
     History & persistence
     ================================================================ */
  const history = { stack: [], index: -1 };

  function snapshot() { return JSON.stringify(state.elements); }

  function commit() {
    const snap = snapshot();
    if (history.stack[history.index] === snap) return;
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push(snap);
    if (history.stack.length > 150) history.stack.shift();
    history.index = history.stack.length - 1;
    scheduleSave();
    updateChrome();
  }

  function restore(snap) {
    state.elements = JSON.parse(snap);
    for (const id of [...state.selected]) if (!getEl(id)) state.selected.delete(id);
    state.multi = null;
    onSelectionChange();
    scheduleSave();
    scheduleRender();
  }

  function undo() {
    if (state.editingText) finishTextEdit();
    if (state.multi) { finishMulti(); return; }
    if (history.index > 0) { history.index--; restore(history.stack[history.index]); }
  }
  function redo() {
    if (history.index < history.stack.length - 1) { history.index++; restore(history.stack[history.index]); }
  }

  let saveTimer = 0, storageWarned = false;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocal, 350);
  }
  function usedFiles() {
    const out = {};
    for (const e of state.elements) if (e.type === 'image' && state.files[e.fileId]) out[e.fileId] = state.files[e.fileId];
    return out;
  }
  function saveLocal() {
    let ok = true;
    try { localStorage.setItem(LS.scene, JSON.stringify({ elements: state.elements })); } catch (e) { ok = false; }
    try { localStorage.setItem(LS.files, JSON.stringify(usedFiles())); } catch (e) { ok = false; }
    try {
      localStorage.setItem(LS.prefs, JSON.stringify({ view: state.view, grid: state.grid, bg: state.bg, style: state.style, toolLocked: state.toolLocked }));
    } catch (e) { /* ignore */ }
    if (!ok && !storageWarned) {
      storageWarned = true;
      toast('Browser storage is full, so this drawing is not saving automatically. Use Save to file.', 6000);
    }
  }
  function loadLocal() {
    try {
      const p = JSON.parse(localStorage.getItem(LS.prefs) || 'null');
      if (p) {
        if (p.view && isFinite(p.view.zoom)) state.view = p.view;
        state.grid = !!p.grid;
        if (p.bg) state.bg = p.bg;
        if (p.style) Object.assign(state.style, p.style);
        state.toolLocked = !!p.toolLocked;
      }
    } catch (e) { /* ignore */ }
    try {
      const f = JSON.parse(localStorage.getItem(LS.files) || 'null');
      if (f) state.files = f;
      const s = localStorage.getItem(LS.scene);
      if (s) state.elements = SP.parseScene({ elements: JSON.parse(s).elements, files: state.files }).elements;
    } catch (e) { console.warn('Could not read the saved drawing', e); }
    try { library = JSON.parse(localStorage.getItem(LS.lib) || '[]'); } catch (e) { library = []; }
  }

  /* ================================================================
     View
     ================================================================ */
  const toScene = (sx, sy) => [sx / state.view.zoom - state.view.x, sy / state.view.zoom - state.view.y];
  const toScreen = (x, y) => [(x + state.view.x) * state.view.zoom, (y + state.view.y) * state.view.zoom];
  const snap = (v) => (state.grid ? Math.round(v / SP.GRID) * SP.GRID : v);

  function zoomAt(sx, sy, z) {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const [px, py] = toScene(sx, sy);
    state.view.zoom = z;
    state.view.x = sx / z - px;
    state.view.y = sy / z - py;
    if (state.editingText) positionEditor();
    scheduleRender();
    scheduleSave();
  }
  function zoomStep(dir) {
    const z = state.view.zoom;
    const next = dir > 0 ? Math.round((z + 0.1) * 10) / 10 : Math.round((z - 0.1) * 10) / 10;
    zoomAt(W / 2, H / 2, next < 0.1 ? 0.1 : next);
  }
  function zoomToFit(els, maxZoom) {
    els = els || state.elements;
    if (!els.length) { state.view = { x: 0, y: 0, zoom: 1 }; scheduleRender(); return; }
    const b = SP.commonBounds(els);
    const pad = 80;
    const z = Math.max(MIN_ZOOM, Math.min(maxZoom || 1, (W - pad * 2) / Math.max(b.w, 1), (H - pad * 2) / Math.max(b.h, 1)));
    state.view.zoom = z;
    state.view.x = W / 2 / z - (b.minX + b.w / 2);
    state.view.y = H / 2 / z - (b.minY + b.h / 2);
    scheduleRender();
    scheduleSave();
  }

  /* ================================================================
     Rendering
     ================================================================ */
  let raf = 0;
  function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  SP.onImageLoad = scheduleRender;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    for (const c of [sceneCanvas, uiCanvas]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    scheduleRender();
  }

  let accent = '#0a8ea3';
  function readTheme() { accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent; }

  function render() {
    renderScene();
    renderUI();
    updateChrome();
  }

  function visibleRect() {
    const [x0, y0] = toScene(0, 0), [x1, y1] = toScene(W, H);
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }

  function renderScene() {
    const z = state.view.zoom;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.fillStyle = state.bg;
    sctx.fillRect(0, 0, W, H);
    if (state.grid) drawGrid();
    sctx.save();
    sctx.scale(z, z);
    sctx.translate(state.view.x, state.view.y);
    const vr = visibleRect(), m = 60 / z;
    for (const el of SP.orderForDraw(state.elements)) {
      if (state.editingText === el.id) continue;
      const b = SP.getAABB(el);
      if (b.maxX < vr.minX - m || b.minX > vr.maxX + m || b.maxY < vr.minY - m || b.minY > vr.maxY + m) continue;
      SP.drawElement(sctx, rc, el, state.files, state.erasing.has(el.id) ? 0.25 : 1);
    }
    sctx.restore();
  }

  function drawGrid() {
    const z = state.view.zoom, g = SP.GRID * z;
    if (g < 6) return;
    const ox = (state.view.x * z) % g, oy = (state.view.y * z) % g;
    const major = SP.GRID * 5 * z;
    const mx = (state.view.x * z) % major, my = (state.view.y * z) % major;
    sctx.lineWidth = 1;
    sctx.beginPath();
    for (let x = ox; x < W; x += g) { sctx.moveTo(Math.round(x) + 0.5, 0); sctx.lineTo(Math.round(x) + 0.5, H); }
    for (let y = oy; y < H; y += g) { sctx.moveTo(0, Math.round(y) + 0.5); sctx.lineTo(W, Math.round(y) + 0.5); }
    sctx.strokeStyle = 'rgba(0,0,0,0.05)';
    sctx.stroke();
    sctx.beginPath();
    for (let x = mx; x < W; x += major) { sctx.moveTo(Math.round(x) + 0.5, 0); sctx.lineTo(Math.round(x) + 0.5, H); }
    for (let y = my; y < H; y += major) { sctx.moveTo(0, Math.round(y) + 0.5); sctx.lineTo(W, Math.round(y) + 0.5); }
    sctx.strokeStyle = 'rgba(0,0,0,0.09)';
    sctx.stroke();
  }

  function screenBoxCorners(el, pad) {
    const b = SP.getBox(el), z = state.view.zoom;
    const [cx, cy] = toScreen(b.x + b.w / 2, b.y + b.h / 2);
    const hw = (b.w * z) / 2 + pad, hh = (b.h * z) / 2 + pad;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => SP.rotate(cx + dx, cy + dy, cx, cy, el.angle || 0));
  }

  function strokePoly(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }

  function renderUI() {
    uctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    uctx.clearRect(0, 0, W, H);
    const a = state.action;

    if (state.bindHover) {
      const el = getEl(state.bindHover);
      if (el) {
        uctx.save();
        uctx.strokeStyle = accent; uctx.globalAlpha = 0.45; uctx.lineWidth = 5;
        strokePoly(uctx, screenBoxCorners(el, 6));
        uctx.restore();
      }
    }

    const sel = selectedElements();
    const busy = a && (a.type === 'move' || a.type === 'resize' || a.type === 'rotate');
    if (sel.length && !state.editingText) {
      uctx.save();
      uctx.strokeStyle = accent;
      uctx.lineWidth = 1;
      uctx.setLineDash(sel.length > 1 ? [4, 4] : []);
      for (const el of sel) {
        if (sel.length === 1 && SP.isLinear(el)) continue;
        strokePoly(uctx, screenBoxCorners(el, 4));
      }
      uctx.setLineDash([]);
      if (sel.length > 1) {
        const b = SP.commonBounds(sel);
        const [x0, y0] = toScreen(b.minX, b.minY), [x1, y1] = toScreen(b.maxX, b.maxY);
        uctx.lineWidth = 1;
        uctx.strokeRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12);
      }
      if (!busy) {
        if (sel.length === 1 && SP.isLinear(sel[0]) && !sel[0].locked) drawPointHandles(sel[0]);
        else for (const h of getHandles()) drawHandle(h);
      }
      if (sel.length === 1 && sel[0].locked) {
        const [x, y] = screenBoxCorners(sel[0], 4)[1];
        uctx.fillStyle = accent; uctx.font = '11px system-ui, sans-serif'; uctx.fillText('Locked', x - 40, y - 6);
      }
      uctx.restore();
    }

    if (a && a.type === 'marquee') {
      const [x0, y0] = toScreen(Math.min(a.x0, a.x1), Math.min(a.y0, a.y1));
      const [x1, y1] = toScreen(Math.max(a.x0, a.x1), Math.max(a.y0, a.y1));
      uctx.save();
      uctx.fillStyle = accent; uctx.globalAlpha = 0.08; uctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      uctx.globalAlpha = 0.8; uctx.strokeStyle = accent; uctx.lineWidth = 1; uctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      uctx.restore();
    }

    if (state.multi) {
      const el = getEl(state.multi.id);
      if (el) {
        uctx.save();
        uctx.fillStyle = '#fff'; uctx.strokeStyle = accent; uctx.lineWidth = 1.5;
        el.points.slice(0, -1).forEach(([x, y]) => {
          const [sx, sy] = toScreen(el.x + x, el.y + y);
          uctx.beginPath(); uctx.arc(sx, sy, 4, 0, Math.PI * 2); uctx.fill(); uctx.stroke();
        });
        uctx.restore();
      }
    }

    if (state.laser.length) drawLaser();
  }

  function drawHandle(h) {
    uctx.save();
    uctx.fillStyle = '#fff';
    uctx.strokeStyle = accent;
    uctx.lineWidth = 1.5;
    if (h.name === 'rotation') {
      uctx.beginPath(); uctx.arc(h.x, h.y, 5, 0, Math.PI * 2); uctx.fill(); uctx.stroke();
    } else {
      uctx.beginPath();
      if (uctx.roundRect) uctx.roundRect(h.x - 4.5, h.y - 4.5, 9, 9, 2); else uctx.rect(h.x - 4.5, h.y - 4.5, 9, 9);
      uctx.fill(); uctx.stroke();
    }
    uctx.restore();
  }

  function pointHandles(el) {
    const pts = el.points.map(([x, y]) => toScreen(el.x + x, el.y + y));
    const mids = [];
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      if (Math.hypot(bx - ax, by - ay) > 36) mids.push({ i: i - 1, x: (ax + bx) / 2, y: (ay + by) / 2 });
    }
    return { pts, mids };
  }

  function drawPointHandles(el) {
    const { pts, mids } = pointHandles(el);
    uctx.save();
    uctx.lineWidth = 1.5;
    uctx.strokeStyle = accent;
    for (const m of mids) {
      uctx.globalAlpha = 0.6; uctx.fillStyle = '#fff';
      uctx.beginPath(); uctx.arc(m.x, m.y, 3.5, 0, Math.PI * 2); uctx.fill(); uctx.stroke();
    }
    uctx.globalAlpha = 1;
    for (const [x, y] of pts) {
      uctx.fillStyle = '#fff';
      uctx.beginPath(); uctx.arc(x, y, 5, 0, Math.PI * 2); uctx.fill(); uctx.stroke();
    }
    uctx.restore();
  }

  function drawLaser() {
    const now = performance.now(), life = 1100;
    uctx.save();
    uctx.lineCap = uctx.lineJoin = 'round';
    for (const stroke of state.laser) {
      for (let i = 1; i < stroke.length; i++) {
        const age = now - stroke[i].t;
        if (age > life) continue;
        const k = 1 - age / life;
        const [x0, y0] = toScreen(stroke[i - 1].x, stroke[i - 1].y), [x1, y1] = toScreen(stroke[i].x, stroke[i].y);
        uctx.strokeStyle = `rgba(255, 52, 64, ${k})`;
        uctx.lineWidth = 2 + 3 * k;
        uctx.beginPath(); uctx.moveTo(x0, y0); uctx.lineTo(x1, y1); uctx.stroke();
      }
    }
    uctx.restore();
    state.laser = state.laser.map((s) => s.filter((p) => now - p.t < life)).filter((s) => s.length || s === (state.action && state.action.stroke));
    if (state.laser.length) scheduleRender();
  }

  /* transform handles in screen space */
  function getHandles() {
    const sel = selectedElements();
    if (!sel.length || state.editingText) return [];
    if (sel.some((e) => e.locked)) return [];
    if (sel.length === 1 && SP.isLinear(sel[0])) return [];
    let box, angle = 0, cornersOnly;
    if (sel.length === 1) {
      box = SP.getBox(sel[0]);
      angle = sel[0].angle || 0;
      cornersOnly = sel[0].type === 'text';
    } else {
      const b = SP.commonBounds(sel);
      box = { x: b.minX, y: b.minY, w: b.w, h: b.h };
      cornersOnly = true;
    }
    const z = state.view.zoom;
    const [cx, cy] = toScreen(box.x + box.w / 2, box.y + box.h / 2);
    const pad = sel.length > 1 ? 6 : 4;
    const hw = (box.w * z) / 2 + pad, hh = (box.h * z) / 2 + pad;
    const pts = { nw: [-hw, -hh], ne: [hw, -hh], se: [hw, hh], sw: [-hw, hh] };
    if (!cornersOnly && box.w * z > 40) { pts.n = [0, -hh]; pts.s = [0, hh]; }
    if (!cornersOnly && box.h * z > 40) { pts.e = [hw, 0]; pts.w = [-hw, 0]; }
    pts.rotation = [0, -hh - 22];
    return Object.entries(pts).map(([name, [dx, dy]]) => {
      const [x, y] = SP.rotate(cx + dx, cy + dy, cx, cy, angle);
      return { name, x, y, angle };
    });
  }

  function hitHandle(sx, sy) {
    for (const h of getHandles()) if (Math.abs(sx - h.x) <= 8 && Math.abs(sy - h.y) <= 8) return h;
    return null;
  }

  function hitPointHandle(el, sx, sy) {
    const { pts, mids } = pointHandles(el);
    for (let i = pts.length - 1; i >= 0; i--) if (Math.hypot(sx - pts[i][0], sy - pts[i][1]) <= 8) return { idx: i };
    for (const m of mids) if (Math.hypot(sx - m.x, sy - m.y) <= 7) return { mid: m.i };
    return null;
  }

  function cursorForHandle(h) {
    if (h.name === 'rotation') return 'grab';
    const base = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[h.name];
    let deg = (base + (h.angle * 180) / Math.PI) % 180;
    if (deg < 0) deg += 180;
    return ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'][Math.round(deg / 45) % 4];
  }

  /* topmost element under a scene point (bound text resolves to its container) */
  function hitTest(px, py, tolPx) {
    const tol = (tolPx || 8) / state.view.zoom;
    for (let i = state.elements.length - 1; i >= 0; i--) {
      const el = state.elements[i];
      if (el.locked) continue;
      if (SP.hitElement(el, px, py, tol)) {
        if (el.containerId) return getEl(el.containerId) || el;
        return el;
      }
    }
    return null;
  }

  /* topmost shape that contains the point, filled or not (for adding labels) */
  function containerAt(px, py) {
    for (let i = state.elements.length - 1; i >= 0; i--) {
      const el = state.elements[i];
      if (!el.locked && SP.isContainer(el) && SP.hitElement(el, px, py, 0, true)) return el;
    }
    return null;
  }

  /* text tool click or double-click: edit text, label a shape, or start new text */
  function textAt(px, py) {
    const hit = hitTest(px, py);
    if (hit && hit.type === 'text') return startTextEdit(hit);
    const c = hit && SP.isContainer(hit) ? hit : !hit || !SP.isPointBased(hit) ? containerAt(px, py) : null;
    if (c) return editContainerText(c);
    if (!hit || hit.type !== 'image') createTextAt(px, py);
  }

  function insideSelectionBox(px, py) {
    const sel = selectedElements();
    if (!sel.length) return false;
    if (sel.length === 1) {
      const el = sel[0];
      if (SP.isLinear(el)) return false;
      const b = SP.getBox(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const [lx, ly] = SP.rotate(px, py, cx, cy, -(el.angle || 0));
      return lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h;
    }
    const b = SP.commonBounds(sel);
    return px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY;
  }

  /* ================================================================
     Pointer input
     ================================================================ */
  function setCursor(c) { uiCanvas.style.cursor = c; }
  const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="6" fill="white" stroke="black" stroke-width="1.5"/></svg>')}") 10 10, crosshair`;

  function toolCursor() {
    const t = state.tool;
    if (spaceDown || t === 'hand') return 'grab';
    if (t === 'text') return 'text';
    if (t === 'eraser') return ERASER_CURSOR;
    if (t === 'selection') return 'default';
    return 'crosshair';
  }

  function onPointerDown(e) {
    hideFloating();
    if (e.button === 2) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { abortAction(); startPinch(); return; }
    if (pointers.size > 2) return;
    try { uiCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (document.activeElement !== ta) uiCanvas.focus({ preventScroll: true });
    const [px, py] = toScene(e.clientX, e.clientY);
    state.pointer = { x: px, y: py };

    if (state.editingText) { finishTextEdit(); if (state.tool !== 'text') return; }
    if (e.button === 1 || spaceDown || state.tool === 'hand') {
      state.action = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y };
      setCursor('grabbing');
      return;
    }
    if (state.multi) { multiClick(px, py, e); return; }

    switch (state.tool) {
      case 'selection': return selectionDown(px, py, e);
      case 'rectangle': case 'diamond': case 'ellipse': return shapeDown(px, py);
      case 'line': case 'arrow': return linearDown(px, py, e);
      case 'freedraw': return freedrawDown(px, py);
      case 'text': state.action = { type: 'textPlace', x: px, y: py }; return;
      case 'image': state.action = { type: 'imagePlace', x: px, y: py }; return;
      case 'eraser': state.erasing = new Set(); state.action = { type: 'erase', lx: px, ly: py }; eraseAt(px, py); scheduleRender(); return;
      case 'laser': {
        const stroke = [{ x: px, y: py, t: performance.now() }];
        state.laser.push(stroke);
        state.action = { type: 'laser', stroke };
        scheduleRender();
      }
    }
  }

  function selectionDown(px, py, e) {
    const sel = selectedElements();
    if (sel.length === 1 && SP.isLinear(sel[0]) && !sel[0].locked) {
      const el = sel[0];
      const ph = hitPointHandle(el, e.clientX, e.clientY);
      if (ph) {
        let idx = ph.idx;
        if (ph.mid != null) {
          const a = el.points[ph.mid], b = el.points[ph.mid + 1];
          el.points.splice(ph.mid + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
          idx = ph.mid + 1;
          SP.mutate(el);
        }
        const last = el.points.length - 1;
        if (idx === 0) el.startBinding = null;
        if (idx === last) el.endBinding = null;
        state.action = { type: 'point', id: el.id, idx };
        return;
      }
    }
    const h = hitHandle(e.clientX, e.clientY);
    if (h) return startTransform(h.name, px, py);

    const hit = hitTest(px, py);
    if (hit) {
      const ids = groupOf(hit);
      if (e.shiftKey) {
        if (ids.every((id) => state.selected.has(id))) {
          ids.forEach((id) => state.selected.delete(id));
          onSelectionChange();
          return;
        }
        ids.forEach((id) => state.selected.add(id));
      } else if (!state.selected.has(hit.id)) {
        state.selected = new Set(ids);
      }
      onSelectionChange();
      return startMove(px, py, e);
    }
    if (sel.length && !e.shiftKey && insideSelectionBox(px, py)) return startMove(px, py, e);
    if (!e.shiftKey && state.selected.size) { state.selected.clear(); onSelectionChange(); }
    state.action = { type: 'marquee', x0: px, y0: py, x1: px, y1: py, base: new Set(state.selected) };
  }

  function startMove(px, py, e) {
    const ids = selectionWithBound();
    if (e.altKey) {
      // leave a copy behind and drag the originals
      const els = state.elements.filter((x) => ids.has(x.id));
      const copies = cloneElements(els, 0, 0);
      const first = state.elements.findIndex((x) => ids.has(x.id));
      state.elements.splice(first, 0, ...copies);
    }
    const orig = new Map();
    for (const id of ids) { const el = getEl(id); orig.set(id, { x: el.x, y: el.y }); }
    const b = SP.commonBounds(selectedElements());
    state.action = { type: 'move', x0: px, y0: py, orig, box: b, ids, moved: false };
  }

  function startTransform(handle, px, py) {
    const sel = selectedElements();
    const ids = selectionWithBound();
    const orig = new Map();
    for (const id of ids) orig.set(id, SP.clone(getEl(id)));
    let box;
    if (sel.length === 1) box = SP.getBox(sel[0]);
    else { const b = SP.commonBounds(sel); box = { x: b.minX, y: b.minY, w: b.w, h: b.h }; }
    state.action = {
      type: handle === 'rotation' ? 'rotate' : 'resize', handle, x0: px, y0: py, orig, box,
      selIds: sel.map((x) => x.id), single: sel.length === 1 ? sel[0].id : null,
    };
    setCursor(handle === 'rotation' ? 'grabbing' : uiCanvas.style.cursor);
  }

  function shapeDown(px, py) {
    const x = snap(px), y = snap(py);
    const el = newElement(state.tool, x, y);
    state.elements.push(el);
    state.selected.clear();
    state.action = { type: 'create', id: el.id, x0: x, y0: y };
    onSelectionChange();
  }

  function linearDown(px, py, e) {
    const x = snap(px), y = snap(py);
    const el = newElement(state.tool, x, y);
    el.points = [[0, 0], [0, 0]];
    state.elements.push(el);
    state.selected.clear();
    state.action = { type: 'createLinear', id: el.id, sx: e.clientX, sy: e.clientY };
    onSelectionChange();
  }

  function freedrawDown(px, py) {
    const el = newElement('freedraw', px, py);
    state.elements.push(el);
    state.selected.clear();
    state.action = { type: 'freedraw', id: el.id };
    onSelectionChange();
  }

  /* constrain a point to 15 degree steps from an anchor */
  function angleSnap(ax, ay, x, y) {
    const dx = x - ax, dy = y - ay, len = Math.hypot(dx, dy);
    const step = Math.PI / 12;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    return [ax + Math.cos(a) * len, ay + Math.sin(a) * len];
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (state.pinch) { if (pointers.size === 2) movePinch(); return; }
    const [px, py] = toScene(e.clientX, e.clientY);
    state.pointer = { x: px, y: py };
    const a = state.action;

    if (!a) {
      if (state.multi) {
        const el = getEl(state.multi.id);
        if (el) {
          const n = el.points.length;
          const prev = [el.x + el.points[n - 2][0], el.y + el.points[n - 2][1]];
          let [x, y] = e.shiftKey ? angleSnap(prev[0], prev[1], px, py) : [snap(px), snap(py)];
          el.points[n - 1] = [x - el.x, y - el.y];
          SP.mutate(el);
          setBindHover(el.type === 'arrow' ? bindableAt(x, y, el.id) : null);
          scheduleRender();
        }
        return;
      }
      updateHoverCursor(e, px, py);
      return;
    }

    switch (a.type) {
      case 'pan':
        state.view.x = a.vx + (e.clientX - a.sx) / state.view.zoom;
        state.view.y = a.vy + (e.clientY - a.sy) / state.view.zoom;
        break;
      case 'create': {
        const el = getEl(a.id);
        let w = snap(px) - a.x0, h = snap(py) - a.y0;
        if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        const props = e.altKey
          ? { x: a.x0 - Math.abs(w), y: a.y0 - Math.abs(h), width: Math.abs(w) * 2, height: Math.abs(h) * 2 }
          : { x: Math.min(a.x0, a.x0 + w), y: Math.min(a.y0, a.y0 + h), width: Math.abs(w), height: Math.abs(h) };
        SP.mutate(el, props);
        break;
      }
      case 'createLinear': {
        const el = getEl(a.id);
        let [x, y] = e.shiftKey ? angleSnap(el.x, el.y, px, py) : [snap(px), snap(py)];
        el.points[1] = [x - el.x, y - el.y];
        SP.mutate(el);
        setBindHover(el.type === 'arrow' ? bindableAt(x, y, el.id) : null);
        break;
      }
      case 'freedraw': {
        const el = getEl(a.id);
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of evs.length ? evs : [e]) {
          const [qx, qy] = toScene(ev.clientX, ev.clientY);
          const last = el.points[el.points.length - 1];
          const nx = qx - el.x, ny = qy - el.y;
          if (Math.hypot(nx - last[0], ny - last[1]) * state.view.zoom >= 1) el.points.push([nx, ny]);
        }
        SP.mutate(el);
        break;
      }
      case 'move': moveSelection(a, px, py, e); break;
      case 'resize': resizeSelection(a, px, py, e); break;
      case 'rotate': rotateSelection(a, px, py, e); break;
      case 'point': movePoint(a, px, py, e); break;
      case 'marquee': {
        a.x1 = px; a.y1 = py;
        const minX = Math.min(a.x0, px), maxX = Math.max(a.x0, px), minY = Math.min(a.y0, py), maxY = Math.max(a.y0, py);
        const next = new Set(a.base);
        for (const el of state.elements) {
          if (el.locked || el.containerId) continue;
          const b = SP.getAABB(el);
          if (b.minX >= minX && b.maxX <= maxX && b.minY >= minY && b.maxY <= maxY) groupOf(el).forEach((id) => next.add(id));
        }
        state.selected = next;
        onSelectionChange(true);
        break;
      }
      case 'erase': {
        const steps = Math.max(1, Math.ceil((Math.hypot(px - a.lx, py - a.ly) * state.view.zoom) / 4));
        for (let i = 1; i <= steps; i++) eraseAt(a.lx + ((px - a.lx) * i) / steps, a.ly + ((py - a.ly) * i) / steps);
        a.lx = px; a.ly = py;
        break;
      }
      case 'laser':
        a.stroke.push({ x: px, y: py, t: performance.now() });
        break;
    }
    scheduleRender();
  }

  function updateHoverCursor(e, px, py) {
    if (state.tool !== 'selection' || spaceDown) { setCursor(toolCursor()); return; }
    const sel = selectedElements();
    if (sel.length === 1 && SP.isLinear(sel[0]) && !sel[0].locked && hitPointHandle(sel[0], e.clientX, e.clientY)) { setCursor('pointer'); return; }
    const h = hitHandle(e.clientX, e.clientY);
    if (h) { setCursor(cursorForHandle(h)); return; }
    if (hitTest(px, py) || insideSelectionBox(px, py)) { setCursor('move'); return; }
    setCursor('default');
  }

  function setBindHover(el) {
    const id = el ? el.id : null;
    if (id !== state.bindHover) { state.bindHover = id; scheduleRender(); }
  }

  function moveSelection(a, px, py, e) {
    let dx = px - a.x0, dy = py - a.y0;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (state.grid) { dx = snap(a.box.minX + dx) - a.box.minX; dy = snap(a.box.minY + dy) - a.box.minY; }
    for (const [id, o] of a.orig) { const el = getEl(id); if (el) { el.x = o.x + dx; el.y = o.y + dy; } }
    a.moved = a.moved || dx !== 0 || dy !== 0;
    updateBoundArrows(a.ids);
  }

  function scalePointBased(el, o, L, T, sx, sy, bx, by) {
    el.x = L + (o.x - bx) * sx;
    el.y = T + (o.y - by) * sy;
    el.points = o.points.map(([x, y]) => [x * sx, y * sy]);
    SP.mutate(el);
  }

  function resizeSelection(a, px, py, e) {
    const handle = a.handle;
    if (a.single) {
      const el = getEl(a.single), o = a.orig.get(a.single);
      const b = a.box, ang = o.angle || 0;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      let [lx, ly] = SP.rotate(px, py, cx, cy, -ang);
      if (!ang) { lx = snap(lx); ly = snap(ly); }
      let L = b.x, R = b.x + b.w, T = b.y, B = b.y + b.h;
      if (handle.includes('e')) R = lx;
      if (handle.includes('w')) L = lx;
      if (handle.includes('n')) T = ly;
      if (handle.includes('s')) B = ly;
      const forced = el.type === 'text' || el.type === 'image';
      const keep = el.type === 'text' ? true : forced ? !e.shiftKey : e.shiftKey;
      if (keep && b.w > 0 && b.h > 0) {
        if (handle.length === 2) {
          const s = Math.max(Math.abs(R - L) / b.w, Math.abs(B - T) / b.h);
          const nw = Math.sign(R - L || 1) * b.w * s, nh = Math.sign(B - T || 1) * b.h * s;
          if (handle.includes('e')) R = L + nw; else L = R - nw;
          if (handle.includes('s')) B = T + nh; else T = B - nh;
        } else if (handle === 'e' || handle === 'w') {
          const nh = (Math.abs(R - L) * b.h) / b.w, mid = (T + B) / 2;
          T = mid - nh / 2; B = mid + nh / 2;
        } else {
          const nw = (Math.abs(B - T) * b.w) / b.h, mid = (L + R) / 2;
          L = mid - nw / 2; R = mid + nw / 2;
        }
      }
      if (e.altKey) {
        if (handle.includes('e')) L = 2 * cx - R;
        if (handle.includes('w')) R = 2 * cx - L;
        if (handle.includes('n')) B = 2 * cy - T;
        if (handle.includes('s')) T = 2 * cy - B;
      }
      if (SP.isPointBased(el)) {
        const sx = b.w ? (R - L) / b.w : 1, sy = b.h ? (B - T) / b.h : 1;
        scalePointBased(el, o, b.w ? L : b.x, b.h ? T : b.y, sx, sy, b.x, b.y);
      } else {
        const [ncx, ncy] = SP.rotate((L + R) / 2, (T + B) / 2, cx, cy, ang);
        let nw = Math.max(1, Math.abs(R - L)), nh = Math.max(1, Math.abs(B - T));
        if (el.type === 'text') {
          el.fontSize = Math.max(4, o.fontSize * (nh / b.h));
          measureFreeText(el);
          nw = el.width; nh = el.height;
          el.x = ncx - nw / 2; el.y = ncy - nh / 2;
          SP.bump(el);
        } else {
          SP.mutate(el, { x: ncx - nw / 2, y: ncy - nh / 2, width: nw, height: nh });
          if (el.type === 'image') el.scale = [(R < L ? -1 : 1) * Math.sign(o.scale ? o.scale[0] : 1), (B < T ? -1 : 1) * Math.sign(o.scale ? o.scale[1] : 1)];
          if (SP.isContainer(el)) updateBoundText(el);
        }
      }
    } else {
      // several elements: scale uniformly from the opposite corner
      const b = a.box;
      let L = b.x, R = b.x + b.w, T = b.y, B = b.y + b.h;
      if (handle.includes('e')) R = px; else L = px;
      if (handle.includes('s')) B = py; else T = py;
      const s = Math.max(Math.abs(R - L) / (b.w || 1), Math.abs(B - T) / (b.h || 1), 0.02);
      const sxs = Math.sign(R - L || 1) * s, sys = Math.sign(B - T || 1) * s;
      if (handle.includes('e')) R = L + b.w * sxs; else L = R - b.w * sxs;
      if (handle.includes('s')) B = T + b.h * sys; else T = B - b.h * sys;
      const ax = handle.includes('e') ? b.x : b.x + b.w, ay = handle.includes('s') ? b.y : b.y + b.h;
      const mapX = (x) => ax + (x - ax) * sxs, mapY = (y) => ay + (y - ay) * sys;
      for (const id of a.selIds) {
        const el = getEl(id), o = a.orig.get(id);
        if (SP.isPointBased(el)) {
          el.x = mapX(o.x); el.y = mapY(o.y);
          el.points = o.points.map(([x, y]) => [x * sxs, y * sys]);
          SP.mutate(el);
        } else {
          const ob = SP.getBox(o);
          const ncx = mapX(ob.x + ob.w / 2), ncy = mapY(ob.y + ob.h / 2);
          if (el.type === 'text') {
            el.fontSize = Math.max(4, o.fontSize * s);
            measureFreeText(el);
            el.x = ncx - el.width / 2; el.y = ncy - el.height / 2;
            SP.bump(el);
          } else {
            const nw = Math.max(1, o.width * s), nh = Math.max(1, o.height * s);
            SP.mutate(el, { x: ncx - nw / 2, y: ncy - nh / 2, width: nw, height: nh });
          }
          if (SP.isContainer(el)) {
            const t = boundTextOf(el), ot = t && a.orig.get(t.id);
            if (t && ot) t.fontSize = Math.max(4, ot.fontSize * s);
            updateBoundText(el);
          }
        }
      }
    }
    for (const id of a.selIds) { const el = getEl(id); if (el && el.type === 'arrow') updateArrowBinding(el); }
    updateBoundArrows(new Set(a.selIds));
  }

  function rotateSelection(a, px, py, e) {
    const b = a.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let delta = Math.atan2(py - cy, px - cx) - Math.atan2(a.y0 - cy, a.x0 - cx);
    const step = Math.PI / 12;
    const norm = (v) => ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (a.single) {
      const el = getEl(a.single), o = a.orig.get(a.single);
      if (SP.isPointBased(el)) {
        if (e.shiftKey) delta = Math.round(delta / step) * step;
        rotatePoints(el, o, cx, cy, delta);
      } else {
        let na = (o.angle || 0) + delta;
        if (e.shiftKey) na = Math.round(na / step) * step;
        el.angle = norm(na);
        if (SP.isContainer(el)) updateBoundText(el);
      }
    } else {
      if (e.shiftKey) delta = Math.round(delta / step) * step;
      for (const id of a.selIds) {
        const el = getEl(id), o = a.orig.get(id);
        if (SP.isPointBased(el)) rotatePoints(el, o, cx, cy, delta);
        else {
          const ob = SP.getBox(o);
          const [ncx, ncy] = SP.rotate(ob.x + ob.w / 2, ob.y + ob.h / 2, cx, cy, delta);
          el.x = ncx - ob.w / 2; el.y = ncy - ob.h / 2;
          el.angle = norm((o.angle || 0) + delta);
          if (SP.isContainer(el)) updateBoundText(el);
        }
      }
    }
    updateBoundArrows(new Set(a.selIds));
  }

  function rotatePoints(el, o, cx, cy, d) {
    const w = o.points.map(([x, y]) => SP.rotate(o.x + x, o.y + y, cx, cy, d));
    el.x = w[0][0]; el.y = w[0][1];
    el.points = w.map(([x, y]) => [x - el.x, y - el.y]);
    SP.mutate(el);
  }

  function movePoint(a, px, py, e) {
    const el = getEl(a.id);
    if (!el) return;
    const n = el.points.length, i = a.idx;
    let x = snap(px), y = snap(py);
    if (e.shiftKey) {
      const ni = i === 0 ? 1 : i - 1;
      [x, y] = angleSnap(el.x + el.points[ni][0], el.y + el.points[ni][1], px, py);
    }
    const abs = el.points.map(([qx, qy]) => [el.x + qx, el.y + qy]);
    abs[i] = [x, y];
    el.x = abs[0][0]; el.y = abs[0][1];
    el.points = abs.map(([qx, qy]) => [qx - el.x, qy - el.y]);
    SP.mutate(el);
    if (el.type === 'arrow' && (i === 0 || i === n - 1)) setBindHover(bindableAt(x, y, el.id));
    updateArrowBinding(el);
  }

  function eraseAt(px, py) {
    const el = hitTest(px, py, 6);
    if (!el) return;
    for (const id of selectionWithBound(groupOf(el))) state.erasing.add(id);
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (state.pinch) { if (pointers.size < 2) state.pinch = null; return; }
    const a = state.action;
    state.action = null;
    if (!a) return;
    const [px, py] = toScene(e.clientX, e.clientY);

    switch (a.type) {
      case 'pan': setCursor(toolCursor()); scheduleSave(); break;
      case 'create': {
        const el = getEl(a.id);
        if (!el || (el.width < 3 && el.height < 3)) { if (el) removeElements([el.id]); break; }
        afterCreate(el);
        break;
      }
      case 'createLinear': {
        const el = getEl(a.id);
        if (!el) break;
        if (Math.hypot(e.clientX - a.sx, e.clientY - a.sy) < 5) {
          // click without drag: keep adding points with each click
          el.points = [[0, 0], [0, 0]];
          SP.mutate(el);
          state.multi = { id: el.id };
        } else finishLinear(el);
        break;
      }
      case 'freedraw': {
        const el = getEl(a.id);
        if (!el) break;
        if (el.points.length === 1) el.points.push([0.01, 0]);
        SP.mutate(el);
        commit();
        break;
      }
      case 'move': {
        if (!a.moved) break;
        // arrows moved without their targets let go, then grab whatever they now touch
        for (const id of a.ids) {
          const el = getEl(id);
          if (el && el.type === 'arrow') {
            const s = el.startBinding && a.ids.has(el.startBinding.elementId);
            const t = el.endBinding && a.ids.has(el.endBinding.elementId);
            if (!s && !t) tryBind(el);
          }
        }
        commit();
        break;
      }
      case 'resize': case 'rotate': setCursor('default'); commit(); renderProps(); break;
      case 'point': {
        const el = getEl(a.id);
        if (el) {
          const i = a.idx, pts = el.points;
          // dropping a point onto a neighbour removes it
          for (const ni of [i - 1, i + 1]) {
            if (pts[ni] && pts.length > 2 && Math.hypot(pts[ni][0] - pts[i][0], pts[ni][1] - pts[i][1]) * state.view.zoom < 8) {
              pts.splice(i, 1);
              SP.mutate(el);
              break;
            }
          }
          if (el.type === 'arrow') {
            if (a.idx === 0) tryBind(el, 'start');
            else if (a.idx >= el.points.length - 1) tryBind(el, 'end');
          }
        }
        setBindHover(null);
        commit();
        break;
      }
      case 'marquee': break;
      case 'erase': {
        if (state.erasing.size) { removeElements([...state.erasing]); commit(); }
        state.erasing = new Set();
        break;
      }
      case 'textPlace': textAt(a.x, a.y); break;
      case 'imagePlace': pickImage({ x: a.x, y: a.y }); break;
    }
    scheduleRender();
  }

  function afterCreate(el) {
    state.selected = new Set([el.id]);
    if (!state.toolLocked) setTool('selection', true);
    onSelectionChange();
    commit();
  }

  function finishLinear(el) {
    setBindHover(null);
    // drop repeated points
    el.points = el.points.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 0.5);
    if (el.points.length < 2) { removeElements([el.id]); commit(); return; }
    SP.mutate(el);
    tryBind(el);
    afterCreate(el);
  }

  function multiClick(px, py, e) {
    const el = getEl(state.multi.id);
    if (!el) { state.multi = null; return; }
    const pts = el.points, n = pts.length;
    const prev = pts[n - 2];
    const [psx, psy] = toScreen(el.x + prev[0], el.y + prev[1]);
    if (Math.hypot(e.clientX - psx, e.clientY - psy) < 10) { finishMulti(); return; }
    if (el.type === 'line' && n >= 3) {
      const [fsx, fsy] = toScreen(el.x, el.y);
      if (Math.hypot(e.clientX - fsx, e.clientY - fsy) < 10) {
        pts[n - 1] = [0, 0];
        state.multi = null;
        finishLinear(el);
        return;
      }
    }
    pts.push([pts[n - 1][0], pts[n - 1][1]]);
    SP.mutate(el);
    scheduleRender();
  }

  function finishMulti() {
    const el = state.multi && getEl(state.multi.id);
    state.multi = null;
    if (!el) return;
    el.points.pop();
    finishLinear(el);
    scheduleRender();
  }

  /* undo whatever is in progress, back to the last committed state */
  function abortAction() {
    const a = state.action;
    state.action = null;
    state.multi = null;
    state.erasing = new Set();
    setBindHover(null);
    if (a && a.type !== 'pan' && a.type !== 'marquee' && a.type !== 'laser') restore(history.stack[history.index]);
  }

  function startPinch() {
    const [p, q] = [...pointers.values()];
    state.pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2, zoom: state.view.zoom, vx: state.view.x, vy: state.view.y };
  }
  function movePinch() {
    const [p, q] = [...pointers.values()];
    const s = state.pinch;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    const cx = (p.x + q.x) / 2, cy = (p.y + q.y) / 2;
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (s.zoom * d) / s.d));
    const sx = s.cx / s.zoom - s.vx, sy = s.cy / s.zoom - s.vy;
    state.view.zoom = z;
    state.view.x = cx / z - sx;
    state.view.y = cy / z - sy;
    scheduleRender();
  }

  function onWheel(e) {
    e.preventDefault();
    hideFloating();
    if (e.ctrlKey || e.metaKey) {
      const d = Math.max(-100, Math.min(100, e.deltaY));
      zoomAt(e.clientX, e.clientY, state.view.zoom * Math.exp(-d * 0.004));
      return;
    }
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    state.view.x -= dx / state.view.zoom;
    state.view.y -= dy / state.view.zoom;
    if (state.editingText) positionEditor();
    scheduleRender();
    scheduleSave();
  }

  function onDoubleClick(e) {
    if (state.multi) { finishMulti(); return; }
    if (state.tool !== 'selection') return;
    const [px, py] = toScene(e.clientX, e.clientY);
    const hit = hitTest(px, py);
    if (hit && SP.isLinear(hit)) return;
    textAt(px, py);
  }

  /* ================================================================
     Text editing
     ================================================================ */
  function createTextAt(px, py) {
    const s = state.style;
    const el = newElement('text', snap(px), py - (s.fontSize * 1.25) / 2);
    measureFreeText(el);
    state.elements.push(el);
    startTextEdit(el);
  }

  function editContainerText(c) {
    let t = boundTextOf(c);
    if (!t) {
      t = newElement('text', c.x, c.y, { containerId: c.id, textAlign: 'center', verticalAlign: 'middle', strokeColor: c.strokeColor, opacity: c.opacity });
      const idx = state.elements.indexOf(c);
      state.elements.splice(idx + 1, 0, t);
      updateBoundText(c);
    }
    startTextEdit(t);
  }

  function startTextEdit(el) {
    state.editingText = el.id;
    state.selected.clear();
    onSelectionChange();
    ta.value = el.originalText != null ? el.originalText : el.text;
    ta.hidden = false;
    positionEditor();
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 0);
    scheduleRender();
  }

  function positionEditor() {
    const el = getEl(state.editingText);
    if (!el) return;
    const z = state.view.zoom;
    const c = el.containerId && getEl(el.containerId);
    const lh = el.fontSize * SP.lineHeight(el) * z;
    ta.style.font = `${el.fontSize * z}px ${SP.FONTS[SP.fontKind(el.fontFamily)]}`;
    ta.style.lineHeight = lh + 'px';
    ta.style.color = el.strokeColor;
    ta.style.opacity = (el.opacity == null ? 100 : el.opacity) / 100;
    ta.style.textAlign = el.textAlign || 'left';
    ta.style.whiteSpace = c ? 'pre-wrap' : 'pre';
    const w = c ? el.width : Math.max(el.width, 4) + el.fontSize;
    const lines = Math.max(1, (c ? el.text : ta.value).split('\n').length);
    const h = Math.max(lines * lh, lh);
    let [sx, sy] = toScreen(el.x, el.y);
    if (!c && el.textAlign === 'center') sx -= (el.fontSize * z) / 2;
    if (!c && el.textAlign === 'right') sx -= el.fontSize * z;
    ta.style.left = sx + 'px';
    ta.style.top = sy + 'px';
    ta.style.width = w * z + 'px';
    ta.style.height = h + 'px';
    ta.style.transform = el.angle ? `rotate(${el.angle}rad)` : '';
  }

  function onTextInput() {
    const el = getEl(state.editingText);
    if (!el) return;
    el.originalText = ta.value;
    if (el.containerId) {
      const c = getEl(el.containerId);
      if (c) { updateBoundText(c); updateBoundArrows(new Set([c.id])); }
    } else {
      // keep centred/right text anchored while it grows
      const oldW = el.width;
      el.text = ta.value;
      measureFreeText(el);
      if (el.textAlign === 'center') el.x -= (el.width - oldW) / 2;
      else if (el.textAlign === 'right') el.x -= el.width - oldW;
      SP.bump(el);
      updateBoundArrows(new Set([el.id]));
    }
    positionEditor();
    scheduleRender();
  }

  function finishTextEdit() {
    const id = state.editingText;
    if (!id) return;
    state.editingText = null;
    ta.hidden = true;
    ta.blur();
    const el = getEl(id);
    if (!el) return;
    const c = el.containerId && getEl(el.containerId);
    if (!el.originalText.trim()) {
      removeElements([el.id]);
      if (c) state.selected = new Set([c.id]);
    } else {
      if (c) updateBoundText(c);
      else { el.text = el.originalText; measureFreeText(el); SP.bump(el); }
      state.selected = new Set([c ? c.id : el.id]);
      updateBoundArrows(new Set([el.id, c && c.id]));
    }
    if (!state.toolLocked) setTool('selection', true);
    onSelectionChange();
    commit();
    scheduleRender();
  }

  /* ================================================================
     Commands
     ================================================================ */
  function setTool(t, keepSelection) {
    if (state.editingText && t !== 'text') finishTextEdit();
    if (state.multi) finishMulti();
    if (t === 'image') { pickImage(null); return; }
    state.tool = t;
    if (!keepSelection && t !== 'selection') { state.selected.clear(); }
    setCursor(toolCursor());
    renderToolbar();
    onSelectionChange();
  }

  function deleteSelected() {
    const ids = selectionWithBound();
    if (!ids.size) return;
    removeElements([...ids]);
    onSelectionChange();
    commit();
    scheduleRender();
  }

  function duplicateSelected() {
    const ids = selectionWithBound();
    if (!ids.size) return;
    const els = state.elements.filter((e) => ids.has(e.id));
    const copies = cloneElements(els, 10, 10);
    state.elements.push(...copies);
    state.selected = new Set(copies.filter((c) => !c.containerId).map((c) => c.id));
    onSelectionChange();
    commit();
    scheduleRender();
  }

  function selectAll() {
    state.selected = new Set(state.elements.filter((e) => !e.locked && !e.containerId).map((e) => e.id));
    if (state.tool !== 'selection') setTool('selection', true);
    onSelectionChange();
    scheduleRender();
  }

  function groupSelected() {
    const sel = selectedElements();
    if (sel.length < 2) return;
    const g = SP.uid();
    for (const el of sel) el.groupIds = [...(el.groupIds || []), g];
    commit();
    renderProps();
  }

  function ungroupSelected() {
    const sel = selectedElements();
    let changed = false;
    for (const el of sel) if (el.groupIds && el.groupIds.length) { el.groupIds = el.groupIds.slice(0, -1); changed = true; }
    if (changed) { commit(); renderProps(); scheduleRender(); }
  }

  function reorder(kind) {
    const ids = selectionWithBound();
    if (!ids.size) return;
    let els = state.elements;
    if (kind === 'front') els = [...els.filter((e) => !ids.has(e.id)), ...els.filter((e) => ids.has(e.id))];
    else if (kind === 'back') els = [...els.filter((e) => ids.has(e.id)), ...els.filter((e) => !ids.has(e.id))];
    else if (kind === 'forward') {
      els = [...els];
      for (let i = els.length - 2; i >= 0; i--) if (ids.has(els[i].id) && !ids.has(els[i + 1].id)) [els[i], els[i + 1]] = [els[i + 1], els[i]];
    } else if (kind === 'backward') {
      els = [...els];
      for (let i = 1; i < els.length; i++) if (ids.has(els[i].id) && !ids.has(els[i - 1].id)) [els[i], els[i - 1]] = [els[i - 1], els[i]];
    }
    state.elements = els;
    commit();
    scheduleRender();
  }

  /* groups align and distribute as one unit */
  function selectionUnits() {
    const units = new Map();
    for (const el of selectedElements()) {
      const key = el.groupIds && el.groupIds.length ? 'g:' + el.groupIds[el.groupIds.length - 1] : el.id;
      if (!units.has(key)) units.set(key, []);
      units.get(key).push(el);
    }
    return [...units.values()].map((els) => ({ els, b: SP.commonBounds(els) }));
  }

  function shiftUnit(u, dx, dy) {
    const ids = selectionWithBound(u.els.map((e) => e.id));
    for (const id of ids) { const el = getEl(id); el.x += dx; el.y += dy; }
    updateBoundArrows(ids);
  }

  function align(kind) {
    const units = selectionUnits();
    if (units.length < 2) return;
    const all = SP.commonBounds(selectedElements());
    for (const u of units) {
      const b = u.b;
      let dx = 0, dy = 0;
      if (kind === 'left') dx = all.minX - b.minX;
      if (kind === 'right') dx = all.maxX - b.maxX;
      if (kind === 'centerH') dx = all.minX + all.w / 2 - (b.minX + b.w / 2);
      if (kind === 'top') dy = all.minY - b.minY;
      if (kind === 'bottom') dy = all.maxY - b.maxY;
      if (kind === 'centerV') dy = all.minY + all.h / 2 - (b.minY + b.h / 2);
      shiftUnit(u, dx, dy);
    }
    commit();
    scheduleRender();
  }

  function distribute(axis) {
    const units = selectionUnits();
    if (units.length < 3) return;
    const k0 = axis === 'h' ? 'minX' : 'minY', k1 = axis === 'h' ? 'maxX' : 'maxY', sz = axis === 'h' ? 'w' : 'h';
    units.sort((a, b) => a.b[k0] + a.b[sz] / 2 - (b.b[k0] + b.b[sz] / 2));
    const span = units[units.length - 1].b[k1] - units[0].b[k0];
    const total = units.reduce((s, u) => s + u.b[sz], 0);
    const gap = (span - total) / (units.length - 1);
    let pos = units[0].b[k1] + gap;
    for (let i = 1; i < units.length - 1; i++) {
      const u = units[i];
      const d = pos - u.b[k0];
      shiftUnit(u, axis === 'h' ? d : 0, axis === 'h' ? 0 : d);
      pos += u.b[sz] + gap;
    }
    commit();
    scheduleRender();
  }

  function toggleLockSelected() {
    const sel = selectedElements();
    if (!sel.length) return;
    const lock = !sel.every((e) => e.locked);
    for (const el of sel) el.locked = lock;
    if (lock) state.selected.clear();
    onSelectionChange();
    commit();
    scheduleRender();
    toast(lock ? 'Locked. Right-click the canvas to unlock.' : 'Unlocked');
  }

  function unlockAll() {
    let n = 0;
    for (const el of state.elements) if (el.locked) { el.locked = false; n++; }
    if (n) { commit(); toast(`Unlocked ${n} element${n === 1 ? '' : 's'}`); scheduleRender(); }
  }

  function nudge(dx, dy) {
    const ids = selectionWithBound();
    if (!ids.size) return;
    for (const id of ids) { const el = getEl(id); el.x += dx; el.y += dy; }
    updateBoundArrows(ids);
    commit();
    scheduleRender();
  }

  const STYLE_KEYS = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'fontSize', 'fontFamily', 'textAlign'];
  function copyStyles() {
    const el = selectedElements()[0];
    if (!el) return;
    const src = SP.isContainer(el) && boundTextOf(el) ? Object.assign({}, boundTextOf(el), el) : el;
    state.copiedStyle = {};
    for (const k of STYLE_KEYS) if (src[k] !== undefined) state.copiedStyle[k] = src[k];
    toast('Styles copied');
  }
  function pasteStyles() {
    if (!state.copiedStyle) return;
    for (const [k, v] of Object.entries(state.copiedStyle)) applyProp(k, v, false);
    commit();
    renderProps();
    scheduleRender();
  }

  /* ---------- clipboard ---------- */
  function clipboardPayload() {
    const ids = selectionWithBound();
    if (!ids.size) return null;
    const els = state.elements.filter((e) => ids.has(e.id));
    const files = {};
    for (const e of els) if (e.type === 'image' && state.files[e.fileId]) files[e.fileId] = state.files[e.fileId];
    return { type: 'excalidraw/clipboard', elements: SP.serializeElements(els), files };
  }

  function pasteElements(data, at) {
    let parsed;
    try { parsed = SP.parseScene({ elements: data.elements, files: data.files }); } catch (e) { return; }
    if (!parsed.elements.length) return;
    Object.assign(state.files, parsed.files);
    const b = SP.commonBounds(parsed.elements);
    const target = at || pasteTarget();
    const copies = cloneElements(parsed.elements, target.x - (b.minX + b.w / 2), target.y - (b.minY + b.h / 2));
    state.elements.push(...copies);
    state.selected = new Set(copies.filter((c) => !c.containerId).map((c) => c.id));
    setTool('selection', true);
    onSelectionChange();
    commit();
    scheduleRender();
  }

  function pasteTarget() {
    const p = state.pointer;
    const vr = visibleRect();
    if (p && p.x > vr.minX && p.x < vr.maxX && p.y > vr.minY && p.y < vr.maxY) return { x: snap(p.x), y: snap(p.y) };
    return { x: (vr.minX + vr.maxX) / 2, y: (vr.minY + vr.maxY) / 2 };
  }

  function pasteText(text) {
    try {
      const data = JSON.parse(text);
      if (data && Array.isArray(data.elements)) { pasteElements(data); return; }
    } catch (e) { /* plain text */ }
    if (!text.trim()) return;
    const t = pasteTarget();
    const el = newElement('text', t.x, t.y);
    el.text = el.originalText = text.replace(/\r\n?/g, '\n');
    measureFreeText(el);
    el.x -= el.width / 2; el.y -= el.height / 2;
    state.elements.push(el);
    state.selected = new Set([el.id]);
    onSelectionChange();
    commit();
    scheduleRender();
  }

  function copyToClipboard(cut) {
    const p = clipboardPayload();
    if (!p) return;
    clipboardMem = p;
    const txt = JSON.stringify(p);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(() => {});
    if (cut) deleteSelected();
  }

  function pasteFromClipboard() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then((t) => (t ? pasteText(t) : clipboardMem && pasteElements(clipboardMem)))
        .catch(() => clipboardMem && pasteElements(clipboardMem));
    } else if (clipboardMem) pasteElements(clipboardMem);
  }

  /* ---------- images ---------- */
  let pendingImageAt = null;
  function pickImage(at) {
    pendingImageAt = at;
    const inp = $('#imageInput');
    inp.value = '';
    inp.click();
  }

  function readAsDataURL(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }

  async function insertImageFile(file, at) {
    try {
      let url = await readAsDataURL(file);
      let img = await loadImage(url);
      let w = img.naturalWidth || 200, h = img.naturalHeight || 200;
      const MAX = 1600;
      if (Math.max(w, h) > MAX || file.size > 1.5e6) {
        const s = Math.min(1, MAX / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const webp = c.toDataURL('image/webp', 0.9);
        url = webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png');
      }
      const fileId = SP.uid();
      state.files[fileId] = { id: fileId, mimeType: url.slice(5, url.indexOf(';')), dataURL: url, created: Date.now() };
      const s = Math.min(1, 420 / Math.max(w, h));
      const dw = w * s, dh = h * s;
      const p = at || pasteTarget();
      const el = newElement('image', p.x - dw / 2, p.y - dh / 2, { width: dw, height: dh, fileId });
      state.elements.push(el);
      state.selected = new Set([el.id]);
      setTool('selection', true);
      onSelectionChange();
      commit();
      scheduleRender();
    } catch (e) {
      toast('That image could not be read. Try a PNG, JPEG, GIF, WebP or SVG.');
    }
  }

  /* ================================================================
     Files: open, save, export, share
     ================================================================ */
  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function saveFile() {
    if (state.editingText) finishTextEdit();
    const json = JSON.stringify(SP.sceneFile(state.elements, state.files, state), null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    if (window.showSaveFilePicker) {
      try {
        if (!state.fileHandle) {
          state.fileHandle = await window.showSaveFilePicker({
            suggestedName: `sketch-${stamp()}.excalidraw`,
            types: [{ description: 'Drawing', accept: { 'application/json': ['.excalidraw', '.json'] } }],
          });
        }
        const w = await state.fileHandle.createWritable();
        await w.write(blob);
        await w.close();
        toast(`Saved ${state.fileHandle.name}`);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        state.fileHandle = null;
      }
    }
    download(blob, `sketch-${stamp()}.excalidraw`);
    toast('Drawing saved to your downloads');
  }

  async function openFile() {
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({
          types: [{ description: 'Drawing', accept: { 'application/json': ['.excalidraw', '.json', '.sketchpad'] } }],
        });
        const f = await h.getFile();
        if (await loadFromFile(f)) state.fileHandle = h;
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    const inp = $('#fileInput');
    inp.value = '';
    inp.click();
  }

  async function loadFromFile(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.type === 'excalidrawlib' || data.libraryItems || data.library) { importLibrary(data); return false; }
      loadScene(SP.parseScene(data));
      toast(`Opened ${file.name}. Undo brings back what was here before.`);
      return true;
    } catch (e) {
      toast('That file could not be opened. Sketchpad reads .excalidraw and .json drawings.');
      return false;
    }
  }

  function loadScene(scene) {
    if (state.editingText) finishTextEdit();
    state.elements = scene.elements;
    Object.assign(state.files, scene.files);
    if (scene.appState) {
      if (scene.appState.viewBackgroundColor) state.bg = scene.appState.viewBackgroundColor;
      if ('gridSize' in scene.appState) state.grid = !!scene.appState.gridSize;
    }
    state.selected.clear();
    state.multi = null;
    onSelectionChange();
    zoomToFit();
    commit();
    renderMenu();
  }

  function exportElements() {
    const onlySel = $('#expSel').checked && state.selected.size;
    if (!onlySel) return state.elements;
    const ids = selectionWithBound();
    return state.elements.filter((e) => ids.has(e.id));
  }
  function exportOpts() {
    return {
      background: $('#expBg').checked ? state.bg : null,
      dark: $('#expDark').checked,
      scale: +$('#expScale .on').dataset.v,
    };
  }
  function darken(canvas) {
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    const x = c.getContext('2d');
    x.filter = 'invert(93%) hue-rotate(180deg)';
    x.drawImage(canvas, 0, 0);
    return c;
  }
  function buildPNGCanvas(scaleOverride) {
    const els = exportElements();
    if (!els.length) return null;
    const o = exportOpts();
    let c = SP.exportCanvas(els, state.files, { background: o.background, scale: scaleOverride || o.scale });
    if (o.dark) c = darken(c);
    return c;
  }

  function openExport() {
    if (!state.elements.length) { toast('Draw something first, then export it.'); return; }
    if (state.editingText) finishTextEdit();
    $('#expSelWrap').hidden = !state.selected.size;
    $('#expSel').checked = !!state.selected.size;
    renderExportPreview();
    $('#exportDialog').showModal();
  }

  function renderExportPreview() {
    const c = buildPNGCanvas(1.5);
    const pv = $('#exportPreview');
    if (!c) { pv.width = pv.height = 1; return; }
    pv.width = c.width; pv.height = c.height;
    pv.getContext('2d').drawImage(c, 0, 0);
  }

  function exportPNG() {
    const c = buildPNGCanvas();
    if (!c) return;
    c.toBlob((b) => { download(b, `sketch-${stamp()}.png`); toast('PNG saved to your downloads'); }, 'image/png');
  }

  async function exportSVG() {
    const els = exportElements();
    if (!els.length) return;
    const o = exportOpts();
    let svg = await SP.exportSVG(els, state.files, { background: o.background });
    if (o.dark) svg = svg.replace('<svg ', '<svg style="filter:invert(93%) hue-rotate(180deg)" ');
    download(new Blob([svg], { type: 'image/svg+xml' }), `sketch-${stamp()}.svg`);
    toast('SVG saved to your downloads');
  }

  function copyPNG() {
    const c = buildPNGCanvas();
    if (!c) return;
    if (!navigator.clipboard || !window.ClipboardItem) { toast('This browser cannot copy images. Use PNG instead.'); return; }
    const blob = new Promise((res) => c.toBlob(res, 'image/png'));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => toast('Image copied to the clipboard'))
      .catch(() => toast('The browser blocked clipboard access. Use PNG instead.'));
  }

  /* share links carry the drawing in the URL hash, compressed */
  const b64url = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fromB64url = (str) => {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  async function encodeScene(json) {
    const bytes = new TextEncoder().encode(json);
    if (window.CompressionStream) {
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
      return 'z' + b64url(new Uint8Array(buf));
    }
    return 'j' + b64url(bytes);
  }
  async function decodeScene(code) {
    const bytes = fromB64url(code.slice(1));
    if (code[0] === 'z') {
      const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
      return new TextDecoder().decode(buf);
    }
    return new TextDecoder().decode(bytes);
  }

  async function shareLink() {
    const els = state.elements.filter((e) => e.type !== 'image');
    if (!els.length) { toast('Draw something first, then share it.'); return; }
    const json = JSON.stringify({ type: 'excalidraw', version: 2, elements: SP.serializeElements(els), appState: { viewBackgroundColor: state.bg } });
    const url = location.href.split('#')[0] + '#scene=' + (await encodeScene(json));
    const note = els.length < state.elements.length ? ' Images are left out of links.' : '';
    if (url.length > 60000) toast('This drawing is large, so the link may be too long for some apps.' + note, 5000);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied.' + note, 4000);
    } catch (e) {
      window.history.replaceState(null, '', url);
      toast('Copy the share link from the address bar.' + note, 5000);
    }
  }

  async function loadFromHash() {
    const m = location.hash.match(/^#scene=(.+)$/);
    if (!m) return;
    try {
      const json = await decodeScene(m[1]);
      loadScene(SP.parseScene(json));
      toast('Opened a shared drawing. Undo brings back what was here before.', 5000);
    } catch (e) {
      toast('That share link is damaged and could not be opened.');
    }
    window.history.replaceState(null, '', location.href.split('#')[0]);
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((res) => {
      const d = $('#confirmDialog');
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      $('#confirmOk').textContent = okLabel || 'Confirm';
      let ok = false;
      $('#confirmOk').onclick = () => { ok = true; d.close(); };
      d.addEventListener('close', () => res(ok), { once: true });
      d.showModal();
    });
  }

  async function resetCanvas() {
    if (!state.elements.length) return;
    if (!(await confirmDialog('Reset the canvas?', 'This clears the whole drawing. You can still undo it straight afterwards.', 'Reset'))) return;
    state.elements = [];
    state.selected.clear();
    state.fileHandle = null;
    state.view = { x: 0, y: 0, zoom: 1 };
    onSelectionChange();
    commit();
    scheduleRender();
  }

  /* ================================================================
     Library
     ================================================================ */
  function saveLibrary() {
    try { localStorage.setItem(LS.lib, JSON.stringify(library)); return true; } catch (e) {
      toast('Browser storage is full, so the library could not be saved.');
      return false;
    }
  }

  function addToLibrary() {
    const p = clipboardPayload();
    if (!p) return;
    library.unshift({ id: SP.uid(), created: Date.now(), elements: p.elements, files: p.files });
    if (!saveLibrary()) library.shift();
    renderLibrary();
    $('#library').hidden = false;
    toast('Added to the library');
  }

  function importLibrary(data) {
    let items = [];
    if (Array.isArray(data.libraryItems)) items = data.libraryItems.map((i) => (Array.isArray(i) ? i : i.elements)).filter(Boolean);
    else if (Array.isArray(data.library)) items = data.library;
    let n = 0;
    for (const els of items) {
      if (!Array.isArray(els) || !els.length) continue;
      library.push({ id: SP.uid(), created: Date.now(), elements: els, files: {} });
      n++;
    }
    saveLibrary();
    renderLibrary();
    $('#library').hidden = false;
    toast(`Added ${n} item${n === 1 ? '' : 's'} to the library`);
  }

  const thumbCache = new Map();
  function renderLibrary() {
    const box = $('#libraryItems');
    box.innerHTML = '';
    $('#libraryEmpty').hidden = library.length > 0;
    for (const item of library) {
      let src = thumbCache.get(item.id);
      if (!src) {
        try {
          const parsed = SP.parseScene({ elements: item.elements, files: item.files });
          if (!parsed.elements.length) continue;
          src = SP.exportCanvas(parsed.elements, Object.assign({}, state.files, parsed.files), { scale: 2, maxSize: 200 }).toDataURL();
          thumbCache.set(item.id, src);
        } catch (e) { continue; }
      }
      const div = document.createElement('div');
      div.className = 'lib-item';
      div.tabIndex = 0;
      div.title = 'Click to add to the drawing';
      div.innerHTML = `<img alt="Library item" src="${src}"><button class="del" title="Remove from library">${I.close}</button>`;
      div.addEventListener('click', (e) => {
        if (e.target.closest('.del')) {
          library = library.filter((x) => x.id !== item.id);
          saveLibrary();
          renderLibrary();
          return;
        }
        const vr = visibleRect();
        pasteElements(item, { x: (vr.minX + vr.maxX) / 2, y: (vr.minY + vr.maxY) / 2 });
      });
      div.addEventListener('keydown', (e) => { if (e.key === 'Enter') div.click(); });
      box.appendChild(div);
    }
  }

  /* ================================================================
     Properties panel
     ================================================================ */
  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const PICONS = {
    hachure: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12l8-8M4 20L20 4M12 20l8-8"/>'),
    'cross-hatch': svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12l8-8M4 20L20 4M12 20l8-8M12 4l8 8M4 4l16 16M4 12l8 8"/>'),
    solid: svg('<rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor"/>'),
    zigzag: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M6 9l3-3 3 3 3-3 3 3M6 15l3-3 3 3 3-3 3 3"/>'),
    sw1: '<svg viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    sw2: '<svg viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor" stroke-width="2.75" stroke-linecap="round"/></svg>',
    sw4: '<svg viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>',
    solidLine: svg('<path d="M4 12h16" stroke-width="2"/>'),
    dashed: svg('<path d="M4 12h16" stroke-width="2" stroke-dasharray="4.5 3.5"/>'),
    dotted: svg('<path d="M4 12h16" stroke-width="2.25" stroke-dasharray="0.1 4"/>'),
    r0: svg('<path d="M3 16c5 0 13-8 18-8"/>'),
    r1: svg('<path d="M3 16.5c3 .5 6-2.5 9-4.5s6-4 9-3.5"/><path d="M3.5 15c4 0 7-3.5 10-5s5-2 7-1.8" opacity=".55"/>'),
    r2: svg('<path d="M3 17c2-1 2.5-3 5-3.5s2.5 1.5 5-1 3-4 8-4"/><path d="M3.5 15.5c2.5-.5 3-3.5 6-3s3.5-1.5 5.5-2.5 3.5-1 6-1.5" opacity=".55"/>'),
    sharp: svg('<path d="M5 19V5h14"/>'),
    round: svg('<path d="M5 19v-8a6 6 0 0 1 6-6h8"/>'),
    straight: svg('<path d="M4 18L20 6"/>'),
    curved: svg('<path d="M4 18C9 4 15 20 20 6"/>'),
    ah_none: svg('<path d="M4 12h16"/>'),
    ah_arrow: svg('<path d="M4 12h16M14 7l6 5-6 5"/>'),
    ah_triangle: svg('<path d="M4 12h11"/><path d="M14 7l6 5-6 5z" fill="currentColor"/>'),
    ah_dot: svg('<path d="M4 12h12"/><circle cx="17.5" cy="12" r="2.8" fill="currentColor"/>'),
    ah_bar: svg('<path d="M4 12h16M20 6v12"/>'),
    left: svg('<path d="M4 6h16M4 12h10M4 18h13"/>'),
    center: svg('<path d="M4 6h16M7 12h10M5.5 18h13"/>'),
    right: svg('<path d="M4 6h16M10 12h10M7 18h13"/>'),
  };

  function relevant(el, key) {
    const t = el.type;
    switch (key) {
      case 'strokeColor': return t !== 'image';
      case 'backgroundColor': case 'fillStyle': return SP.isShape(el) || t === 'line';
      case 'strokeWidth': return SP.isShape(el) || SP.isLinear(el) || t === 'freedraw';
      case 'strokeStyle': case 'roughness': return SP.isShape(el) || SP.isLinear(el);
      case 'roundness': return t === 'rectangle' || t === 'diamond';
      case 'arrowType': return SP.isLinear(el);
      case 'startArrowhead': case 'endArrowhead': return t === 'arrow';
      case 'fontSize': case 'fontFamily': case 'textAlign': return t === 'text';
      case 'opacity': return true;
    }
    return false;
  }

  function readProp(el, key) {
    if (key === 'roundness') return el.roundness ? 'round' : 'sharp';
    if (key === 'arrowType') return el.roundness ? 'round' : 'sharp';
    return el[key];
  }

  /* elements a property change should touch: the selection plus labels inside it */
  function propTargets() {
    const sel = selectedElements();
    const out = [...sel];
    for (const el of sel) if (SP.isContainer(el)) { const t = boundTextOf(el); if (t) out.push(t); }
    return out;
  }

  function currentValue(key) {
    const targets = propTargets().filter((e) => relevant(e, key));
    if (!targets.length) return state.style[key];
    const v0 = readProp(targets[0], key);
    return targets.every((e) => readProp(e, key) === v0) ? v0 : undefined;
  }

  function applyProp(key, value, doCommit = true) {
    state.style[key] = value;
    const changed = new Set();
    for (const el of propTargets()) {
      if (!relevant(el, key)) continue;
      if (key === 'roundness') el.roundness = value === 'round' ? { type: 3 } : null;
      else if (key === 'arrowType') el.roundness = value === 'round' ? { type: 2 } : null;
      else el[key] = value;
      if (el.type === 'text' && (key === 'fontSize' || key === 'fontFamily' || key === 'textAlign')) {
        if (el.containerId) { const c = getEl(el.containerId); if (c) { updateBoundText(c); changed.add(c.id); } }
        else if (key !== 'textAlign') { measureFreeText(el); changed.add(el.id); }
      }
      SP.mutate(el);
    }
    if (changed.size) updateBoundArrows(changed);
    if (doCommit) { commit(); renderProps(); }
    scheduleRender();
  }

  function seg(key, options, cur) {
    return `<div class="seg">${options.map(([v, label, title]) =>
      `<button data-prop="${key}" data-val='${JSON.stringify(v)}' class="${v === cur ? 'on' : ''}" title="${title || ''}" aria-pressed="${v === cur}">${label}</button>`).join('')}</div>`;
  }

  function colorRow(key, quick, cur) {
    const sw = quick.map((c) => `<button class="sw ${c === 'transparent' ? 'transparent' : ''} ${c === cur ? 'on' : ''}" style="${c === 'transparent' ? '' : 'background:' + c}" data-prop="${key}" data-val='${JSON.stringify(c)}' title="${c}"></button>`).join('');
    const hex = cur && cur !== 'transparent' ? cur : '';
    return `<div class="colors">${sw}</div>
      <div class="hexrow"><input type="color" data-color="${key}" value="${/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000'}" title="Pick any colour" id="cp-${key}">
      <input type="text" data-hex="${key}" value="${cur === undefined ? '' : hex}" placeholder="${cur === undefined ? 'Mixed' : cur === 'transparent' ? 'None' : '#hex'}" spellcheck="false" aria-label="Hex colour" id="hx-${key}"></div>`;
  }

  function renderProps() {
    const panel = $('#props');
    const sel = selectedElements();
    let kinds;
    if (state.editingText) {
      const el = getEl(state.editingText);
      kinds = el ? [el] : [];
    } else if (sel.length) kinds = propTargets();
    else if (DRAW_TOOLS.has(state.tool)) kinds = [{ type: state.tool, containerId: null }];
    else kinds = [];
    const show = kinds.length > 0;
    panel.hidden = !show || (isNarrow() && !propsOpen);
    $('#propsToggle').hidden = !show || !isNarrow();
    if (!show) { panel.innerHTML = ''; return; }
    const has = (key) => kinds.some((e) => relevant(e, key));
    const val = (key) => (sel.length ? currentValue(key) : state.style[key]);
    let h = '';
    const section = (title, body) => (h += `<section class="prop"><h3>${title}</h3>${body}</section>`);

    if (has('strokeColor')) section('Stroke', colorRow('strokeColor', STROKES, val('strokeColor')));
    if (has('backgroundColor')) section('Background', colorRow('backgroundColor', FILLS, val('backgroundColor')));
    const bgv = val('backgroundColor');
    if (has('fillStyle') && bgv && bgv !== 'transparent') {
      section('Fill', seg('fillStyle', [['hachure', PICONS.hachure, 'Hachure'], ['cross-hatch', PICONS['cross-hatch'], 'Cross-hatch'], ['solid', PICONS.solid, 'Solid'], ['zigzag', PICONS.zigzag, 'Zigzag']], val('fillStyle')));
    }
    if (has('strokeWidth')) section('Stroke width', seg('strokeWidth', [[1, PICONS.sw1, 'Thin'], [2, PICONS.sw2, 'Bold'], [4, PICONS.sw4, 'Extra bold']], val('strokeWidth')));
    if (has('strokeStyle')) section('Stroke style', seg('strokeStyle', [['solid', PICONS.solidLine, 'Solid'], ['dashed', PICONS.dashed, 'Dashed'], ['dotted', PICONS.dotted, 'Dotted']], val('strokeStyle')));
    if (has('roughness')) section('Sloppiness', seg('roughness', [[0, PICONS.r0, 'Architect'], [1, PICONS.r1, 'Artist'], [2, PICONS.r2, 'Cartoonist']], val('roughness')));
    if (has('roundness')) section('Edges', seg('roundness', [['sharp', PICONS.sharp, 'Sharp'], ['round', PICONS.round, 'Round']], val('roundness')));
    if (has('arrowType')) section('Line shape', seg('arrowType', [['sharp', PICONS.straight, 'Straight'], ['round', PICONS.curved, 'Curved']], val('arrowType')));
    if (has('endArrowhead')) {
      const heads = (key, flip) => seg(key, [[null, PICONS.ah_none, 'None'], ['arrow', PICONS.ah_arrow, 'Arrow'], ['triangle', PICONS.ah_triangle, 'Triangle'], ['dot', PICONS.ah_dot, 'Dot'], ['bar', PICONS.ah_bar, 'Bar']]
        .map(([v, ic, t]) => [v, flip ? ic.replace('<svg ', '<svg style="transform:scaleX(-1)" ') : ic, t]), val(key));
      section('Arrow start', heads('startArrowhead', true));
      section('Arrow end', heads('endArrowhead', false));
    }
    if (has('fontSize')) {
      section('Font size', seg('fontSize', [[16, 'S', 'Small'], [20, 'M', 'Medium'], [28, 'L', 'Large'], [36, 'XL', 'Very large']], val('fontSize')));
      const fv = val('fontFamily');
      const fk = fv === undefined ? undefined : SP.fontKind(fv);
      section('Font', `<div class="seg">${[[1, 'hand', 'Hand-drawn'], [2, 'normal', 'Normal'], [3, 'code', 'Code']].map(([v, k, t]) =>
        `<button data-prop="fontFamily" data-val="${v}" class="${fk === k ? 'on' : ''}" title="${t}" style="font-family:${SP.FONTS[k].replace(/"/g, "'")};font-size:15px">Aa</button>`).join('')}</div>`);
      section('Text align', seg('textAlign', [['left', PICONS.left, 'Left'], ['center', PICONS.center, 'Centre'], ['right', PICONS.right, 'Right']], val('textAlign')));
    }
    const op = val('opacity');
    section('Opacity', `<div class="range-row"><input type="range" min="0" max="100" step="5" value="${op === undefined ? 100 : op}" data-range="opacity" id="opacityRange" aria-label="Opacity"><output>${op === undefined ? '–' : op}</output></div>`);

    if (sel.length) {
      section('Layers', `<div class="seg">
        <button data-cmd="back" title="Send to back (Ctrl+Shift+[)">${I.toBack}</button>
        <button data-cmd="backward" title="Send backward (Ctrl+[)">${I.backward}</button>
        <button data-cmd="forward" title="Bring forward (Ctrl+])">${I.forward}</button>
        <button data-cmd="front" title="Bring to front (Ctrl+Shift+])">${I.toFront}</button></div>`);
      const units = selectionUnits().length;
      if (units >= 2) {
        section('Align', `<div class="seg">
          <button data-cmd="alignLeft" title="Align left">${I.alignLeft}</button>
          <button data-cmd="alignCenterH" title="Centre horizontally">${I.alignCenterH}</button>
          <button data-cmd="alignRight" title="Align right">${I.alignRight}</button>
          <button data-cmd="alignTop" title="Align top">${I.alignTop}</button>
          <button data-cmd="alignCenterV" title="Centre vertically">${I.alignCenterV}</button>
          <button data-cmd="alignBottom" title="Align bottom">${I.alignBottom}</button>
          ${units >= 3 ? `<button data-cmd="distributeH" title="Space evenly across">${I.distributeH}</button><button data-cmd="distributeV" title="Space evenly down">${I.distributeV}</button>` : ''}
        </div>`);
      }
      const grouped = sel.some((e) => e.groupIds && e.groupIds.length);
      section('Actions', `<div class="seg">
        <button data-cmd="duplicate" title="Duplicate (Ctrl+D)">${I.duplicate}</button>
        <button data-cmd="delete" title="Delete (Del)">${I.trash}</button>
        ${sel.length > 1 ? `<button data-cmd="group" title="Group (Ctrl+G)">${I.group}</button>` : ''}
        ${grouped ? `<button data-cmd="ungroup" title="Ungroup (Ctrl+Shift+G)">${I.ungroup}</button>` : ''}
        <button data-cmd="lock" title="Lock (Ctrl+Shift+L)">${I.lock}</button>
        <button data-cmd="addLibrary" title="Add to library">${I.plusSquare}</button>
      </div>`);
    }
    panel.innerHTML = h;
  }

  function onPropsClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.prop) {
      applyProp(b.dataset.prop, JSON.parse(b.dataset.val));
      return;
    }
    if (b.dataset.cmd) runCommand(b.dataset.cmd);
  }

  function onPropsInput(e) {
    const t = e.target;
    if (t.dataset.range === 'opacity') {
      applyProp('opacity', +t.value, false);
      t.nextElementSibling.textContent = t.value;
    } else if (t.dataset.color) {
      applyProp(t.dataset.color, t.value, false);
      const hx = $('#hx-' + t.dataset.color);
      if (hx) hx.value = t.value;
    }
  }

  function onPropsChange(e) {
    const t = e.target;
    if (t.dataset.range === 'opacity' || t.dataset.color) { commit(); renderProps(); return; }
    if (t.dataset.hex) {
      let v = t.value.trim();
      if (!v) return;
      if (/^(none|transparent)$/i.test(v)) v = 'transparent';
      else {
        if (!v.startsWith('#')) v = '#' + v;
        if (!/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) { toast('Use a hex colour like #1971c2'); return; }
        v = v.toLowerCase();
      }
      applyProp(t.dataset.hex, v);
    }
  }

  /* ================================================================
     Commands, menus, context menu
     ================================================================ */
  function runCommand(cmd) {
    switch (cmd) {
      case 'open': return openFile();
      case 'save': return saveFile();
      case 'export': return openExport();
      case 'share': return shareLink();
      case 'reset': return resetCanvas();
      case 'theme': return toggleTheme();
      case 'grid': state.grid = !state.grid; renderMenu(); scheduleRender(); scheduleSave(); return;
      case 'help': return $('#helpDialog').showModal();
      case 'back': return reorder('back');
      case 'backward': return reorder('backward');
      case 'forward': return reorder('forward');
      case 'front': return reorder('front');
      case 'alignLeft': return align('left');
      case 'alignCenterH': return align('centerH');
      case 'alignRight': return align('right');
      case 'alignTop': return align('top');
      case 'alignCenterV': return align('centerV');
      case 'alignBottom': return align('bottom');
      case 'distributeH': return distribute('h');
      case 'distributeV': return distribute('v');
      case 'duplicate': return duplicateSelected();
      case 'delete': return deleteSelected();
      case 'group': return groupSelected();
      case 'ungroup': return ungroupSelected();
      case 'lock': return toggleLockSelected();
      case 'unlockAll': return unlockAll();
      case 'addLibrary': return addToLibrary();
      case 'cut': return copyToClipboard(true);
      case 'copy': return copyToClipboard(false);
      case 'paste': return pasteFromClipboard();
      case 'copyStyles': return copyStyles();
      case 'pasteStyles': return pasteStyles();
      case 'selectAll': return selectAll();
      case 'fit': return zoomToFit();
      case 'fitSelection': return zoomToFit(selectedElements(), 3);
    }
  }

  function hideFloating() {
    $('#ctxmenu').hidden = true;
    if (!$('#menu').hidden) { $('#menu').hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); }
  }

  function showContextMenu(e) {
    e.preventDefault();
    if (state.editingText) finishTextEdit();
    const [px, py] = toScene(e.clientX, e.clientY);
    const hit = hitTest(px, py);
    if (hit && !state.selected.has(hit.id)) { state.selected = new Set(groupOf(hit)); setTool('selection', true); }
    const onEl = hit || (state.selected.size && insideSelectionBox(px, py));
    if (!onEl && state.selected.size) { state.selected.clear(); onSelectionChange(); }
    scheduleRender();
    const item = (cmd, label, key, cls) => `<button data-cmd="${cmd}" class="${cls || ''}" role="menuitem">${label}${key ? `<kbd>${key}</kbd>` : ''}</button>`;
    let h;
    if (onEl) {
      const sel = selectedElements();
      const grouped = sel.some((x) => x.groupIds && x.groupIds.length);
      h = item('cut', 'Cut', 'Ctrl+X') + item('copy', 'Copy', 'Ctrl+C') + item('paste', 'Paste', 'Ctrl+V') + '<hr>' +
        item('copyStyles', 'Copy styles', 'Ctrl+Alt+C') + item('pasteStyles', 'Paste styles', 'Ctrl+Alt+V') + '<hr>' +
        item('duplicate', 'Duplicate', 'Ctrl+D') + item('addLibrary', 'Add to library') +
        (sel.length > 1 ? item('group', 'Group', 'Ctrl+G') : '') + (grouped ? item('ungroup', 'Ungroup', 'Ctrl+Shift+G') : '') + '<hr>' +
        item('front', 'Bring to front', 'Ctrl+Shift+]') + item('forward', 'Bring forward', 'Ctrl+]') +
        item('backward', 'Send backward', 'Ctrl+[') + item('back', 'Send to back', 'Ctrl+Shift+[') + '<hr>' +
        item('fitSelection', 'Zoom to selection', 'Shift+2') + item('lock', 'Lock', 'Ctrl+Shift+L') + item('delete', 'Delete', 'Del', 'danger');
    } else {
      const anyLocked = state.elements.some((x) => x.locked);
      h = item('paste', 'Paste', 'Ctrl+V') + item('selectAll', 'Select all', 'Ctrl+A') + '<hr>' +
        item('grid', state.grid ? 'Hide grid' : 'Show grid', "Ctrl+'") + item('fit', 'Zoom to fit', 'Shift+1') +
        (anyLocked ? item('unlockAll', 'Unlock all') : '') + '<hr>' + item('export', 'Export image', 'Ctrl+Shift+E');
    }
    const m = $('#ctxmenu');
    m.innerHTML = h;
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(e.clientX, W - r.width - 8) + 'px';
    m.style.top = Math.max(8, Math.min(e.clientY, H - r.height - 8)) + 'px';
  }

  /* ================================================================
     Keyboard
     ================================================================ */
  function isTyping(t) {
    return !!t && (t === ta || (typeof t.matches === 'function' && t.matches('input, textarea, select, [contenteditable]')));
  }

  function onKeyDown(e) {
    if (isTyping(e.target)) return;
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (e.key === ' ' && !mod) {
      if (!spaceDown) { spaceDown = true; if (!state.action) setCursor('grab'); }
      e.preventDefault();
      return;
    }

    if (mod) {
      let handled = true;
      if (e.code === 'BracketRight') reorder(e.shiftKey ? 'front' : 'forward');
      else if (e.code === 'BracketLeft') reorder(e.shiftKey ? 'back' : 'backward');
      else if (e.code === 'Quote') runCommand('grid');
      else if (e.altKey && k === 'c') copyStyles();
      else if (e.altKey && k === 'v') pasteStyles();
      else switch (k) {
        case 'z': e.shiftKey ? redo() : undo(); break;
        case 'y': redo(); break;
        case 'a': selectAll(); break;
        case 'd': duplicateSelected(); break;
        case 'g': e.shiftKey ? ungroupSelected() : groupSelected(); break;
        case 's': saveFile(); break;
        case 'o': openFile(); break;
        case 'e': if (e.shiftKey) openExport(); else handled = false; break;
        case 'l': if (e.shiftKey) toggleLockSelected(); else handled = false; break;
        case '=': case '+': zoomStep(1); break;
        case '-': case '_': zoomStep(-1); break;
        case '0': zoomAt(W / 2, H / 2, 1); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
      return;
    }

    if (e.altKey && e.shiftKey && e.code === 'KeyD') { toggleTheme(); e.preventDefault(); return; }
    if (e.shiftKey && e.code === 'Digit1') { zoomToFit(); return; }
    if (e.shiftKey && e.code === 'Digit2') { zoomToFit(selectedElements(), 3); return; }

    switch (e.key) {
      case 'Escape':
        if (!$('#ctxmenu').hidden || !$('#menu').hidden) { hideFloating(); return; }
        if (state.multi) { finishMulti(); return; }
        if (state.action) { abortAction(); scheduleRender(); return; }
        if (state.selected.size) { state.selected.clear(); onSelectionChange(); scheduleRender(); return; }
        if (state.tool !== 'selection') setTool('selection');
        return;
      case 'Delete': case 'Backspace': deleteSelected(); e.preventDefault(); return;
      case 'Enter': {
        if (state.multi) { finishMulti(); return; }
        const sel = selectedElements();
        if (sel.length === 1) {
          if (sel[0].type === 'text') startTextEdit(sel[0]);
          else if (SP.isContainer(sel[0])) editContainerText(sel[0]);
          e.preventDefault();
        }
        return;
      }
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!state.selected.size) return;
        const d = e.shiftKey ? 10 : 1;
        nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
        e.preventDefault();
        return;
      }
      case '?': $('#helpDialog').showModal(); return;
    }
    if (e.altKey || e.shiftKey) return;
    if (k === 'q') { toggleToolLock(); return; }
    const tool = TOOLS.find((t) => t.key === k || t.alt === k || t.num === e.key);
    if (tool) setTool(tool.id);
  }

  function onKeyUp(e) {
    if (e.key === ' ') { spaceDown = false; if (!state.action) setCursor(toolCursor()); }
  }

  /* ================================================================
     Chrome: toolbar, menu, toasts, theme
     ================================================================ */
  function renderToolbar() {
    const box = $('#tools');
    if (!box.children.length) {
      box.innerHTML = TOOLS.map((t) => `<button class="tool" data-tool="${t.id}" title="${t.label} (${t.short})" aria-label="${t.label}">${I[t.id]}${t.num ? `<span class="num">${t.num}</span>` : ''}</button>`).join('');
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-tool]');
        if (b) setTool(b.dataset.tool);
      });
    }
    for (const b of box.children) {
      const on = b.dataset.tool === state.tool;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    }
    const lock = $('#lockBtn');
    lock.innerHTML = state.toolLocked ? I.lock : I.unlock;
    lock.classList.toggle('on', state.toolLocked);
    lock.setAttribute('aria-pressed', state.toolLocked);
  }

  function toggleToolLock() {
    state.toolLocked = !state.toolLocked;
    renderToolbar();
    scheduleSave();
  }

  function effectiveTheme() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(LS.theme, next); } catch (e) { /* ignore */ }
    readTheme();
    renderMenu();
    thumbCache.clear();
    scheduleRender();
  }

  function renderMenu() {
    const dark = effectiveTheme() === 'dark';
    $('#themeLabel').textContent = dark ? 'Light mode' : 'Dark mode';
    $('#themeIcon').innerHTML = dark ? I.sun : I.moon;
    $('#gridLabel').textContent = state.grid ? 'Hide grid' : 'Show grid';
    $('#bgSwatches').innerHTML = CANVAS_BGS.map((c) => `<button class="sw canvas ${c === state.bg ? 'on' : ''}" style="background:${c}" data-bg="${c}" title="${c}"></button>`).join('');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#1c2327' : '#ffffff';
  }

  let toastTimer = 0;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms || 2600);
  }

  let lastChrome = '';
  function updateChrome() {
    const z = Math.round(state.view.zoom * 100) + '%';
    const empty = !state.elements.length;
    let offscreen = false;
    if (!empty) {
      const vr = visibleRect();
      offscreen = !state.elements.some((el) => {
        const b = SP.getAABB(el);
        return b.maxX > vr.minX && b.minX < vr.maxX && b.maxY > vr.minY && b.minY < vr.maxY;
      });
    }
    const key = [z, empty, offscreen, history.index, history.stack.length, state.selected.size, !!state.action, state.tool].join('|');
    if (key === lastChrome) return;
    lastChrome = key;
    $('#zoomLabel').textContent = z;
    $('#welcome').hidden = !empty || !!state.action || state.tool !== 'selection' && state.tool !== 'hand';
    $('#scrollBack').hidden = !offscreen;
    $('#undoBtn').disabled = history.index <= 0;
    $('#redoBtn').disabled = history.index >= history.stack.length - 1;
    $('#libraryAdd').disabled = !state.selected.size;
  }

  let lastSelKey = '';
  function onSelectionChange(quiet) {
    const key = [...state.selected].join(',') + '|' + state.tool + '|' + state.editingText;
    if (key !== lastSelKey || !quiet) { lastSelKey = key; renderProps(); }
    updateChrome();
  }

  let propsOpen = false;
  const isNarrow = () => window.innerWidth <= 720;

  function renderHelp() {
    const rows = [
      ['Tools', [
        ['Hand (pan)', ['H', 'Space + drag']], ['Selection', ['V', '1']], ['Rectangle', ['R', '2']], ['Diamond', ['D', '3']],
        ['Ellipse', ['O', '4']], ['Arrow', ['A', '5']], ['Line', ['L', '6']], ['Draw', ['P', '7']], ['Text', ['T', '8']],
        ['Insert image', ['9']], ['Eraser', ['E', '0']], ['Laser pointer', ['K']], ['Keep tool selected', ['Q']],
      ]],
      ['Drawing', [
        ['Perfect square or circle', ['Shift + drag']], ['Draw from the centre', ['Alt + drag']], ['Snap lines to 15°', ['Shift']],
        ['Multi-point line', ['Click, click, Enter']], ['Close a line into a shape', ['Click its first point']],
        ['Add text inside a shape', ['Double-click it', 'Enter']], ['New text anywhere', ['Double-click canvas']], ['Finish text', ['Esc', 'Ctrl + Enter']],
        ['Bend a line', ['Drag its midpoint']], ['Remove a line point', ['Drag it onto a neighbour']],
        ['Connect an arrow', ['End it on a shape']],
      ]],
      ['Editing', [
        ['Undo / redo', ['Ctrl + Z', 'Ctrl + Shift + Z']], ['Copy / cut / paste', ['Ctrl + C', 'Ctrl + X', 'Ctrl + V']],
        ['Duplicate', ['Ctrl + D', 'Alt + drag']], ['Delete', ['Del']], ['Select all', ['Ctrl + A']], ['Add to selection', ['Shift + click']],
        ['Group / ungroup', ['Ctrl + G', 'Ctrl + Shift + G']], ['Bring forward / to front', ['Ctrl + ]', 'Ctrl + Shift + ]']],
        ['Send backward / to back', ['Ctrl + [', 'Ctrl + Shift + [']], ['Copy / paste styles', ['Ctrl + Alt + C', 'Ctrl + Alt + V']],
        ['Lock', ['Ctrl + Shift + L']], ['Nudge', ['Arrows', 'Shift + arrows']], ['Keep proportions', ['Shift + resize']], ['Rotate in 15° steps', ['Shift + rotate']],
      ]],
      ['View and files', [
        ['Zoom', ['Ctrl + scroll', 'Ctrl + =', 'Ctrl + -']], ['Reset zoom', ['Ctrl + 0']], ['Zoom to fit / selection', ['Shift + 1', 'Shift + 2']],
        ['Pan', ['Scroll', 'Shift + scroll']], ['Grid', ["Ctrl + '"]], ['Dark mode', ['Alt + Shift + D']],
        ['Open / save', ['Ctrl + O', 'Ctrl + S']], ['Export image', ['Ctrl + Shift + E']],
      ]],
    ];
    $('#helpGrid').innerHTML = rows.map(([title, items]) => `<h3>${title}</h3>` + items.map(([label, keys]) =>
      `<div class="help-row"><span>${label}</span><span>${keys.map((k) => `<kbd>${SP.escapeHTML(k)}</kbd>`).join('')}</span></div>`).join('')).join('');
  }

  /* ================================================================
     Wiring
     ================================================================ */
  function fillIcons(root) {
    for (const el of (root || document).querySelectorAll('[data-icon]')) el.innerHTML = I[el.dataset.icon] || '';
  }

  function remeasureTexts() {
    for (const el of state.elements) {
      if (el.type !== 'text') continue;
      if (el.containerId) { const c = getEl(el.containerId); if (c) updateBoundText(c); }
      else measureFreeText(el);
    }
    scheduleRender();
  }

  function init() {
    loadLocal();
    readTheme();
    fillIcons();
    $('#menuBtn').innerHTML = I.menu;
    $('#zoomOut').innerHTML = I.minus;
    $('#zoomIn').innerHTML = I.plus;
    $('#undoBtn').innerHTML = I.undo;
    $('#redoBtn').innerHTML = I.redo;
    $('#helpBtn').innerHTML = I.help;
    $('#libraryClose').innerHTML = I.close;
    $('#propsToggle').innerHTML = I.styles;
    for (const b of document.querySelectorAll('[data-close]')) if (!b.textContent.trim()) b.innerHTML = I.close;

    renderToolbar();
    renderMenu();
    renderHelp();
    renderLibrary();
    resize();
    commit();
    onSelectionChange();
    setCursor(toolCursor());
    if (document.fonts && document.fonts.load) document.fonts.load('20px Kalam').then(remeasureTexts).catch(() => {});

    window.addEventListener('resize', () => { resize(); renderProps(); if (state.editingText) positionEditor(); });
    uiCanvas.addEventListener('pointerdown', onPointerDown);
    uiCanvas.addEventListener('pointermove', onPointerMove);
    uiCanvas.addEventListener('pointerup', onPointerUp);
    uiCanvas.addEventListener('pointercancel', onPointerUp);
    uiCanvas.addEventListener('dblclick', onDoubleClick);
    uiCanvas.addEventListener('wheel', onWheel, { passive: false });
    uiCanvas.addEventListener('contextmenu', showContextMenu);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => { spaceDown = false; });
    // stop browser page-zoom gestures on the app
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    ta.addEventListener('input', onTextInput);
    ta.addEventListener('blur', () => { if (state.editingText) finishTextEdit(); });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishTextEdit(); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText('    ', s, ta.selectionEnd, 'end');
        onTextInput();
      }
    });

    document.addEventListener('copy', (e) => {
      if (isTyping(e.target) || state.editingText) return;
      const p = clipboardPayload();
      if (!p) return;
      clipboardMem = p;
      e.clipboardData.setData('text/plain', JSON.stringify(p));
      e.preventDefault();
    });
    document.addEventListener('cut', (e) => {
      if (isTyping(e.target) || state.editingText) return;
      const p = clipboardPayload();
      if (!p) return;
      clipboardMem = p;
      e.clipboardData.setData('text/plain', JSON.stringify(p));
      e.preventDefault();
      deleteSelected();
    });
    document.addEventListener('paste', (e) => {
      if (isTyping(e.target) || state.editingText || document.querySelector('dialog[open]')) return;
      const dt = e.clipboardData;
      if (!dt) return;
      const file = [...dt.files].find((f) => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); insertImageFile(file); return; }
      const text = dt.getData('text/plain');
      if (text) { e.preventDefault(); pasteText(text); }
    });

    const app = $('#app');
    app.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    app.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const [px, py] = toScene(e.clientX, e.clientY);
      if (f.type.startsWith('image/')) insertImageFile(f, { x: px, y: py });
      else loadFromFile(f);
    });

    $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { state.fileHandle = null; loadFromFile(f); } });
    $('#imageInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) insertImageFile(f, pendingImageAt); });

    $('#menuBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const m = $('#menu');
      $('#ctxmenu').hidden = true;
      m.hidden = !m.hidden;
      $('#menuBtn').setAttribute('aria-expanded', String(!m.hidden));
    });
    $('#menu').addEventListener('click', (e) => {
      const sw = e.target.closest('[data-bg]');
      if (sw) { state.bg = sw.dataset.bg; renderMenu(); scheduleRender(); scheduleSave(); return; }
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      hideFloating();
      runCommand(b.dataset.cmd);
    });
    $('#ctxmenu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      hideFloating();
      runCommand(b.dataset.cmd);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#menu, #menuBtn, #ctxmenu')) hideFloating();
    });

    $('#lockBtn').addEventListener('click', toggleToolLock);
    $('#zoomIn').addEventListener('click', () => zoomStep(1));
    $('#zoomOut').addEventListener('click', () => zoomStep(-1));
    $('#zoomLabel').addEventListener('click', () => zoomAt(W / 2, H / 2, 1));
    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
    $('#scrollBack').addEventListener('click', () => zoomToFit(null, state.view.zoom));
    $('#libraryBtn').addEventListener('click', () => { const l = $('#library'); l.hidden = !l.hidden; });
    $('#libraryClose').addEventListener('click', () => ($('#library').hidden = true));
    $('#libraryAdd').addEventListener('click', addToLibrary);
    $('#propsToggle').addEventListener('click', () => { propsOpen = !propsOpen; renderProps(); });

    const props = $('#props');
    props.addEventListener('click', onPropsClick);
    props.addEventListener('input', onPropsInput);
    props.addEventListener('change', onPropsChange);
    props.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.hex) e.target.blur(); });
    // keep the text editor open while using the panel
    props.addEventListener('pointerdown', (e) => { if (state.editingText && !e.target.matches('input')) e.preventDefault(); });

    for (const d of document.querySelectorAll('dialog')) {
      d.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) { d.close(); return; }
        if (e.target !== d) return;
        const r = d.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
      });
    }
    $('#expBg').addEventListener('change', renderExportPreview);
    $('#expDark').addEventListener('change', renderExportPreview);
    $('#expSel').addEventListener('change', renderExportPreview);
    $('#expScale').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const x of $('#expScale').children) x.classList.toggle('on', x === b);
    });
    $('#expPng').addEventListener('click', exportPNG);
    $('#expSvg').addEventListener('click', exportSVG);
    $('#expCopy').addEventListener('click', copyPNG);

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); renderMenu(); scheduleRender(); });
    }
    window.addEventListener('beforeunload', saveLocal);
    window.addEventListener('hashchange', loadFromHash);
    loadFromHash();
    scheduleRender();

    // a small hook for tests and the console
    window.sketchpad = { state, commit, setTool, render, toScreen, toScene, getEl, history };
  }

  init();
})();
