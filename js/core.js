/* Sketchpad core: geometry, element model, rendering, import/export.
   Elements use the Excalidraw JSON schema so files open in both apps. */
(function () {
  'use strict';
  const SP = (window.SP = window.SP || {});

  /* ---------- small helpers ---------- */
  SP.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  SP.seed = () => Math.floor(Math.random() * 2 ** 31);
  SP.clone = (o) => JSON.parse(JSON.stringify(o));
  SP.GRID = 20;

  const rotate = (SP.rotate = (x, y, cx, cy, a) => {
    if (!a) return [x, y];
    const c = Math.cos(a), s = Math.sin(a), dx = x - cx, dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });

  SP.distToSegment = function (px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  SP.pointInPolygon = function (px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  /* ---------- element model ---------- */
  const LINEAR = new Set(['line', 'arrow']);
  SP.isLinear = (el) => LINEAR.has(el.type);
  SP.isPointBased = (el) => LINEAR.has(el.type) || el.type === 'freedraw';
  SP.isShape = (el) => el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse';
  SP.isBindable = (el) => (SP.isShape(el) || el.type === 'image' || el.type === 'text') && !el.containerId;
  SP.isContainer = (el) => SP.isShape(el);

  SP.isClosedLine = (el) => {
    if (el.type !== 'line' || !el.points || el.points.length < 3) return false;
    const a = el.points[0], b = el.points[el.points.length - 1];
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1;
  };

  SP.bump = function (el) {
    el.version = (el.version || 0) + 1;
    el.versionNonce = SP.seed();
    el.updated = Date.now();
  };

  SP.mutate = function (el, props) {
    if (props) Object.assign(el, props);
    if (SP.isPointBased(el)) SP.normalizePoints(el);
    SP.bump(el);
    return el;
  };

  /* keep points[0] at [0,0] and width/height in sync with the points */
  SP.normalizePoints = function (el) {
    const p = el.points;
    if (!p || !p.length) return;
    const [ox, oy] = p[0];
    if (ox !== 0 || oy !== 0) {
      el.x += ox;
      el.y += oy;
      for (const q of p) { q[0] -= ox; q[1] -= oy; }
    }
    const b = SP.pointsBounds(p);
    el.width = b.maxX - b.minX;
    el.height = b.maxY - b.minY;
  };

  SP.pointsBounds = function (pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    if (!pts.length) minX = minY = maxX = maxY = 0;
    return { minX, minY, maxX, maxY };
  };

  /* unrotated box in scene coords */
  SP.getBox = function (el) {
    if (SP.isPointBased(el)) {
      const b = SP.pointsBounds(el.points);
      return { x: el.x + b.minX, y: el.y + b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
    }
    return { x: el.x, y: el.y, w: el.width, h: el.height };
  };

  SP.center = function (el) {
    const b = SP.getBox(el);
    return [b.x + b.w / 2, b.y + b.h / 2];
  };

  /* axis-aligned bounds of the rotated element */
  SP.getAABB = function (el) {
    const b = SP.getBox(el);
    if (!el.angle) return { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h };
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const cs = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => rotate(x, y, cx, cy, el.angle));
    return SP.pointsBounds(cs);
  };

  SP.commonBounds = function (els) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of els) {
      const b = SP.getAABB(el);
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  };

  /* ---------- fonts & text ---------- */
  SP.FONTS = {
    hand: '"Kalam", "Segoe Print", "Comic Sans MS", cursive',
    normal: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
    code: 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, Menlo, monospace',
  };
  // Excalidraw font ids: 1 Virgil, 2 Helvetica, 3 Cascadia, 5 Excalifont, 6 Nunito, 7 Lilita, 8 Comic Shanns
  SP.fontKind = (id) => ({ 1: 'hand', 5: 'hand', 2: 'normal', 6: 'normal', 7: 'normal', 3: 'code', 8: 'code' }[id] || 'hand');
  SP.fontString = (el) => `${el.fontSize}px ${SP.FONTS[SP.fontKind(el.fontFamily)]}`;
  SP.lineHeight = (el) => el.lineHeight || 1.25;

  const mctx = document.createElement('canvas').getContext('2d');
  SP.measureText = function (text, el) {
    mctx.font = SP.fontString(el);
    const lines = text.split('\n');
    let w = 0;
    for (const ln of lines) w = Math.max(w, mctx.measureText(ln).width);
    return { w: Math.ceil(w), h: lines.length * el.fontSize * SP.lineHeight(el) };
  };

  SP.wrapText = function (text, el, maxW) {
    mctx.font = SP.fontString(el);
    const out = [];
    for (const para of text.split('\n')) {
      if (mctx.measureText(para).width <= maxW) { out.push(para); continue; }
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const test = line + word;
        if (mctx.measureText(test).width <= maxW || !line) {
          if (mctx.measureText(test).width > maxW && !line.trim()) {
            // a single word wider than the box: break it by characters
            let chunk = '';
            for (const ch of word) {
              if (mctx.measureText(chunk + ch).width > maxW && chunk) { out.push(chunk); chunk = ch; } else chunk += ch;
            }
            line = chunk;
          } else line = test;
        } else {
          out.push(line.replace(/\s+$/, ''));
          line = word.replace(/^\s+/, '');
        }
      }
      out.push(line);
    }
    return out.join('\n');
  };

  /* inner text area of a container */
  SP.containerInner = function (c) {
    const pad = 5;
    const f = c.type === 'ellipse' ? Math.SQRT1_2 : c.type === 'diamond' ? 0.5 : 1;
    return { w: Math.max(10, c.width * f - pad * 2), h: Math.max(10, c.height * f - pad * 2), f, pad };
  };

  /* ---------- rough.js drawables ---------- */
  const gen = rough.generator();
  SP.generator = gen;

  function dash(el) {
    if (el.strokeStyle === 'dashed') return [8, 8 + el.strokeWidth];
    if (el.strokeStyle === 'dotted') return [1.5, 6 + el.strokeWidth];
    return undefined;
  }

  function roughness(el, w, h) {
    const r = el.roughness;
    const max = Math.max(Math.abs(w), Math.abs(h)), min = Math.min(Math.abs(w), Math.abs(h));
    if ((min >= 20 && max >= 50) || min >= 15 || SP.isLinear(el)) return r;
    return Math.min(r / (max < 10 ? 3 : 2), 2.5);
  }

  function opts(el, fill, w, h) {
    const sw = el.strokeWidth;
    const o = {
      seed: el.seed,
      strokeWidth: el.strokeStyle !== 'solid' ? sw + 0.5 : sw,
      roughness: roughness(el, w, h),
      stroke: el.strokeColor === 'transparent' ? 'none' : el.strokeColor,
      fillWeight: sw / 2,
      hachureGap: sw * 4,
      disableMultiStroke: el.strokeStyle !== 'solid',
      preserveVertices: el.roughness < 2,
    };
    const d = dash(el);
    if (d) o.strokeLineDash = d;
    if (fill && el.backgroundColor && el.backgroundColor !== 'transparent') {
      o.fill = el.backgroundColor;
      o.fillStyle = el.fillStyle || 'hachure';
    }
    return o;
  }

  function roundRectPath(w, h) {
    const r = cornerRadius(Math.min(w, h));
    return `M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`;
  }

  /* same corner rule as Excalidraw: a quarter of the side, capped at 32 */
  const cornerRadius = (x) => (x <= 128 ? x * 0.25 : 32);

  function roundDiamondPath(w, h) {
    const tx = w / 2, ty = 0, rx = w, ry = h / 2, bx = w / 2, by = h, lx = 0, ly = h / 2;
    const vr = cornerRadius(Math.abs(tx - lx)), hr = cornerRadius(Math.abs(ry - ty));
    return `M ${tx + vr} ${ty + hr} L ${rx - vr} ${ry - hr}
      C ${rx} ${ry}, ${rx} ${ry}, ${rx - vr} ${ry + hr}
      L ${bx + vr} ${by - hr}
      C ${bx} ${by}, ${bx} ${by}, ${bx - vr} ${by - hr}
      L ${lx + vr} ${ly + hr}
      C ${lx} ${ly}, ${lx} ${ly}, ${lx + vr} ${ly - hr}
      L ${tx - vr} ${ty + hr}
      C ${tx} ${ty}, ${tx} ${ty}, ${tx + vr} ${ty + hr}`;
  }

  const HEAD_SIZE = { arrow: 25, bar: 15, dot: 15, circle: 15, circle_outline: 15, triangle: 15, triangle_outline: 15 };
  const HEAD_ANGLE = { arrow: 20, bar: 90 };

  /* tip and a point a little way back along the drawn shaft, from rough.js ops */
  function shaftEnds(shaft, pts) {
    const ops = (shaft && shaft.sets && shaft.sets[0] && shaft.sets[0].ops) || [];
    const bez = (p0, c1, c2, p3, t) => {
      const u = 1 - t;
      return [u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
              u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]];
    };
    let first = null, last = null, cur = null;
    for (const op of ops) {
      if (op.op === 'move') cur = [op.data[0], op.data[1]];
      else if (op.op === 'bcurveTo' && cur) {
        const d = op.data, seg = { p0: cur, c1: [d[0], d[1]], c2: [d[2], d[3]], p3: [d[4], d[5]] };
        if (!first) first = seg;
        last = seg;
        cur = seg.p3;
      }
    }
    const n = pts.length;
    const end = last ? { tip: last.p3, back: bez(last.p0, last.c1, last.c2, last.p3, 0.7) } : { tip: pts[n - 1], back: pts[n - 2] };
    const start = first ? { tip: first.p0, back: bez(first.p0, first.c1, first.c2, first.p3, 0.3) } : { tip: pts[0], back: pts[1] };
    return { start, end };
  }

  function arrowheads(el, o, shaft) {
    const pts = el.points, n = pts.length, out = [];
    if (n < 2) return out;
    const ends = shaftEnds(shaft, pts);
    const headOpts = Object.assign({}, o, { fill: undefined, fillStyle: undefined, roughness: Math.min(1, o.roughness || 0), disableMultiStroke: false });
    if (el.strokeStyle === 'dotted') headOpts.strokeLineDash = [1.5, 5 + el.strokeWidth];
    else delete headOpts.strokeLineDash;
    const make = (kind, e, segLen) => {
      if (!kind) return;
      const [x2, y2] = e.tip, [x1, y1] = e.back;
      const dist = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = (x2 - x1) / dist, ny = (y2 - y1) / dist;
      const size = Math.min(HEAD_SIZE[kind] || 15, segLen * 0.5);
      const xs = x2 - nx * size, ys = y2 - ny * size;
      if (kind === 'dot' || kind === 'circle' || kind === 'circle_outline') {
        const diameter = Math.hypot(ys - y2, xs - x2) + el.strokeWidth - 2;
        const fill = kind === 'circle_outline' ? undefined : el.strokeColor;
        out.push(gen.circle(x2, y2, diameter, Object.assign({}, headOpts, { fill, fillStyle: 'solid', strokeLineDash: undefined })));
        return;
      }
      const a = ((HEAD_ANGLE[kind] || 25) * Math.PI) / 180;
      const [x3, y3] = rotate(xs, ys, x2, y2, -a);
      const [x4, y4] = rotate(xs, ys, x2, y2, a);
      if (kind === 'triangle' || kind === 'triangle_outline') {
        out.push(gen.polygon([[x2, y2], [x3, y3], [x4, y4]], Object.assign({}, headOpts, kind === 'triangle' ? { fill: el.strokeColor, fillStyle: 'solid' } : {}, { strokeLineDash: undefined })));
      } else {
        // arrow and bar: two strokes meeting at the tip, as Excalidraw draws them
        out.push(gen.line(x3, y3, x2, y2, headOpts));
        if (kind !== 'bar') out.push(gen.line(x4, y4, x2, y2, headOpts));
        else out.push(gen.line(x2, y2, x4, y4, headOpts));
      }
    };
    const segLen = (i, j) => Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
    make(el.endArrowhead, ends.end, segLen(n - 1, n - 2));
    make(el.startArrowhead, ends.start, segLen(0, 1));
    return out;
  }

  const cache = new Map();
  SP.clearCache = () => cache.clear();

  SP.getDrawables = function (el) {
    const hit = cache.get(el.id);
    if (hit && hit.key === el.versionNonce) return hit.d;
    let d = [];
    const w = el.width, h = el.height;
    if (el.type === 'rectangle') {
      const o = opts(el, true, w, h);
      d = [el.roundness ? gen.path(roundRectPath(w, h), o) : gen.rectangle(0, 0, w, h, o)];
    } else if (el.type === 'diamond') {
      const o = opts(el, true, w, h);
      const v = [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]];
      d = [el.roundness ? gen.path(roundDiamondPath(w, h), o) : gen.polygon(v, o)];
    } else if (el.type === 'ellipse') {
      d = [gen.ellipse(w / 2, h / 2, w, h, Object.assign(opts(el, true, w, h), { curveFitting: 1 }))];
    } else if (SP.isLinear(el)) {
      const pts = el.points;
      if (pts.length >= 2) {
        const closed = SP.isClosedLine(el);
        const o = opts(el, closed, w, h);
        if (closed && !el.roundness) d.push(gen.polygon(pts.slice(0, -1), o));
        else if (el.roundness && pts.length > 2) d.push(gen.curve(pts, o));
        else d.push(gen.linearPath(pts, o));
        if (el.type === 'arrow') d.push(...arrowheads(el, o, d[0]));
      }
    }
    cache.set(el.id, { key: el.versionNonce, d });
    return d;
  };

  /* pencil strokes: perfect-freehand outline with Excalidraw's settings, filled */
  function strokeOutline(el) {
    const pts = el.points.map((p, i) => [p[0], p[1], el.pressures && el.pressures[i] != null ? el.pressures[i] : 0.5]);
    if (!window.PerfectFreehand) return pts;
    return PerfectFreehand.getStroke(pts, {
      simulatePressure: el.simulatePressure !== false,
      size: el.strokeWidth * 4.25,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
      easing: (t) => Math.sin((t * Math.PI) / 2),
      last: true,
    });
  }
  SP.freedrawPathData = function (el) {
    const o = strokeOutline(el);
    if (!o.length) return '';
    const med = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const max = o.length - 1;
    let d = `M ${o[0][0].toFixed(2)} ${o[0][1].toFixed(2)} Q`;
    for (let i = 0; i < max; i++) {
      const m = med(o[i], o[i + 1]);
      d += ` ${o[i][0].toFixed(2)} ${o[i][1].toFixed(2)} ${m[0].toFixed(2)} ${m[1].toFixed(2)}`;
    }
    return d + ' Z';
  };
  SP.freedrawWidth = (el) => el.strokeWidth * 4.25;

  const pathCache = new Map();
  function freedrawPath(el) {
    const hit = pathCache.get(el.id);
    if (hit && hit.key === el.versionNonce) return hit.p;
    const p = new Path2D(SP.freedrawPathData(el));
    pathCache.set(el.id, { key: el.versionNonce, p });
    return p;
  }

  /* images */
  const images = new Map();
  SP.onImageLoad = null;
  SP.getImage = function (files, fileId) {
    const f = files[fileId];
    if (!f) return null;
    let rec = images.get(fileId);
    if (!rec || rec.src !== f.dataURL) {
      const img = new Image();
      rec = { img, src: f.dataURL, ok: false };
      img.onload = () => { rec.ok = true; SP.onImageLoad && SP.onImageLoad(); };
      img.src = f.dataURL;
      images.set(fileId, rec);
    }
    return rec.ok ? rec.img : null;
  };

  /* ---------- canvas rendering ---------- */
  SP.drawElement = function (ctx, rc, el, files, alpha) {
    const b = SP.getBox(el);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.save();
    ctx.globalAlpha = (alpha == null ? 1 : alpha) * (el.opacity == null ? 1 : el.opacity / 100);
    ctx.translate(cx, cy);
    if (el.angle) ctx.rotate(el.angle);
    ctx.translate(el.x - cx, el.y - cy);
    if (el.type === 'freedraw') {
      ctx.fillStyle = el.strokeColor;
      ctx.fill(freedrawPath(el));
    } else if (el.type === 'text') {
      ctx.font = SP.fontString(el);
      ctx.fillStyle = el.strokeColor;
      ctx.textBaseline = 'middle';
      ctx.textAlign = el.textAlign || 'left';
      const lh = el.fontSize * SP.lineHeight(el);
      const ax = el.textAlign === 'center' ? el.width / 2 : el.textAlign === 'right' ? el.width : 0;
      el.text.split('\n').forEach((ln, i) => ctx.fillText(ln, ax, i * lh + lh / 2));
    } else if (el.type === 'image') {
      const img = SP.getImage(files, el.fileId);
      if (img) {
        const sx = el.scale && el.scale[0] < 0 ? -1 : 1, sy = el.scale && el.scale[1] < 0 ? -1 : 1;
        ctx.save();
        ctx.scale(sx, sy);
        ctx.drawImage(img, sx < 0 ? -el.width : 0, sy < 0 ? -el.height : 0, el.width, el.height);
        ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(128,128,128,.15)';
        ctx.fillRect(0, 0, el.width, el.height);
      }
    } else {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const d of SP.getDrawables(el)) rc.draw(d);
    }
    ctx.restore();
  };

  /* ---------- hit testing ---------- */
  SP.hitElement = function (el, px, py, tol, forceFill) {
    const b = SP.getBox(el);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const [lx, ly] = rotate(px, py, cx, cy, -(el.angle || 0));
    const filled = forceFill || (el.backgroundColor && el.backgroundColor !== 'transparent');
    const t = tol + (el.strokeWidth || 1) / 2;
    if (el.type === 'text' || el.type === 'image') {
      return lx >= b.x - tol && lx <= b.x + b.w + tol && ly >= b.y - tol && ly <= b.y + b.h + tol;
    }
    if (el.type === 'rectangle') {
      const inOuter = lx >= b.x - t && lx <= b.x + b.w + t && ly >= b.y - t && ly <= b.y + b.h + t;
      if (!inOuter) return false;
      if (filled) return true;
      return !(lx > b.x + t && lx < b.x + b.w - t && ly > b.y + t && ly < b.y + b.h - t);
    }
    if (el.type === 'ellipse' || el.type === 'diamond') {
      const hw = b.w / 2, hh = b.h / 2, dx = Math.abs(lx - cx), dy = Math.abs(ly - cy);
      const f = (rx, ry) => {
        if (rx <= 0 || ry <= 0) return Infinity;
        return el.type === 'ellipse' ? (dx / rx) ** 2 + (dy / ry) ** 2 : dx / rx + dy / ry;
      };
      if (f(hw + t, hh + t) > 1) return false;
      if (filled) return true;
      return f(hw - t, hh - t) >= 1;
    }
    if (SP.isPointBased(el)) {
      const pts = el.points;
      const qx = lx - el.x, qy = ly - el.y;
      const tt = el.type === 'freedraw' ? tol + SP.freedrawWidth(el) / 2 : t;
      if (pts.length === 1) return Math.hypot(qx - pts[0][0], qy - pts[0][1]) <= tt;
      for (let i = 1; i < pts.length; i++) {
        if (SP.distToSegment(qx, qy, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= tt) return true;
      }
      if ((filled || forceFill) && SP.isClosedLine(el) && SP.pointInPolygon(qx, qy, pts)) return true;
      return false;
    }
    return false;
  };

  /* point on the outline of a bindable element, aimed from (fx,fy) */
  SP.outlinePoint = function (el, fx, fy, gap) {
    const b = SP.getBox(el);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const [lx, ly] = rotate(fx, fy, cx, cy, -(el.angle || 0));
    let dx = lx - cx, dy = ly - cy;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) { dx = 0; dy = -1; }
    const hw = Math.max(b.w / 2, 0.5), hh = Math.max(b.h / 2, 0.5);
    const ax = Math.abs(dx), ay = Math.abs(dy);
    let t;
    if (el.type === 'ellipse') t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
    else if (el.type === 'diamond') t = 1 / (ax / hw + ay / hh);
    else t = Math.min(ax ? hw / ax : Infinity, ay ? hh / ay : Infinity);
    const ul = Math.hypot(dx, dy);
    const px = cx + dx * t + (dx / ul) * gap, py = cy + dy * t + (dy / ul) * gap;
    return rotate(px, py, cx, cy, el.angle || 0);
  };

  /* ---------- import / normalise ---------- */
  const DEFAULTS = {
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'hachure', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, boundElements: null,
    link: null, locked: false, isDeleted: false,
  };

  SP.normalizeElement = function (raw) {
    const el = Object.assign({}, DEFAULTS, raw);
    if (!el.id) el.id = SP.uid();
    if (el.seed == null) el.seed = SP.seed();
    if (!Array.isArray(el.groupIds)) el.groupIds = [];
    el.width = +el.width || 0; el.height = +el.height || 0; el.x = +el.x || 0; el.y = +el.y || 0;
    if (SP.isPointBased(el)) {
      el.points = (el.points && el.points.length ? el.points : [[0, 0]]).map((p) => [+p[0] || 0, +p[1] || 0]);
      if (el.elbowed) el.roundness = null;
      if (el.angle) {
        // bake rotation into the points so point-based elements always have angle 0
        const b = SP.getBox(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = el.angle;
        const w = el.points.map(([x, y]) => rotate(el.x + x, el.y + y, cx, cy, a));
        el.x = w[0][0]; el.y = w[0][1];
        el.points = w.map(([x, y]) => [x - el.x, y - el.y]);
        el.angle = 0;
      }
      SP.normalizePoints(el);
      if (SP.isLinear(el)) {
        if (el.type === 'arrow') {
          if (el.endArrowhead === undefined) el.endArrowhead = 'arrow';
          if (el.startArrowhead === undefined) el.startArrowhead = null;
        } else { el.startArrowhead = el.startArrowhead || null; el.endArrowhead = el.endArrowhead || null; }
        el.startBinding = el.startBinding && el.startBinding.elementId ? { elementId: el.startBinding.elementId, focus: 0, gap: 6 } : null;
        el.endBinding = el.endBinding && el.endBinding.elementId ? { elementId: el.endBinding.elementId, focus: 0, gap: 6 } : null;
      }
    }
    if (el.type === 'text') {
      el.text = el.text == null ? '' : String(el.text);
      el.originalText = el.originalText == null ? el.text : String(el.originalText);
      el.fontSize = +el.fontSize || 20;
      el.fontFamily = el.fontFamily || 1;
      el.textAlign = el.textAlign || 'left';
      el.verticalAlign = el.verticalAlign || 'top';
      el.lineHeight = el.lineHeight || 1.25;
      el.containerId = el.containerId || null;
    }
    if (el.type === 'image') { el.scale = el.scale || [1, 1]; el.status = 'saved'; }
    el.versionNonce = SP.seed();
    el.version = el.version || 1;
    return el;
  };

  SP.SUPPORTED = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'freedraw', 'text', 'image']);

  SP.parseScene = function (data) {
    if (typeof data === 'string') data = JSON.parse(data);
    if (!data || !Array.isArray(data.elements)) throw new Error('This file has no drawing in it.');
    const elements = data.elements
      .filter((e) => e && !e.isDeleted && SP.SUPPORTED.has(e.type))
      .map(SP.normalizeElement);
    const ids = new Set(elements.map((e) => e.id));
    for (const el of elements) {
      if (el.type === 'text' && el.containerId && !ids.has(el.containerId)) el.containerId = null;
      if (el.startBinding && !ids.has(el.startBinding.elementId)) el.startBinding = null;
      if (el.endBinding && !ids.has(el.endBinding.elementId)) el.endBinding = null;
    }
    const files = {};
    if (data.files) for (const [k, f] of Object.entries(data.files)) if (f && f.dataURL) files[k] = { id: k, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created || Date.now() };
    return { elements, files, appState: data.appState || {} };
  };

  /* write Excalidraw-compatible boundElements back onto targets */
  SP.serializeElements = function (elements) {
    const out = SP.clone(elements);
    const byId = new Map(out.map((e) => [e.id, e]));
    for (const e of out) e.boundElements = null;
    const add = (id, ref) => {
      const t = byId.get(id);
      if (!t) return;
      (t.boundElements = t.boundElements || []).push(ref);
    };
    for (const e of out) {
      if (e.type === 'text' && e.containerId) add(e.containerId, { id: e.id, type: 'text' });
      if (e.type === 'arrow') {
        if (e.startBinding) add(e.startBinding.elementId, { id: e.id, type: 'arrow' });
        if (e.endBinding && (!e.startBinding || e.endBinding.elementId !== e.startBinding.elementId)) add(e.endBinding.elementId, { id: e.id, type: 'arrow' });
      }
      if (e.type === 'text') e.baseline = Math.round(e.fontSize * 0.9);
    }
    return out;
  };

  SP.sceneFile = function (elements, files, appState) {
    const used = new Set(elements.filter((e) => e.type === 'image').map((e) => e.fileId));
    const f = {};
    for (const id of used) if (files[id]) f[id] = files[id];
    return {
      type: 'excalidraw',
      version: 2,
      source: 'https://github.com/bhxuk/Sketchpad',
      elements: SP.serializeElements(elements),
      appState: { viewBackgroundColor: appState.viewBackgroundColor, gridSize: appState.grid ? SP.GRID : null },
      files: f,
    };
  };

  /* ---------- export ---------- */
  SP.EXPORT_PAD = 16;

  function orderForDraw(elements) {
    // bound text is drawn straight after its container
    const texts = new Map();
    for (const el of elements) if (el.type === 'text' && el.containerId) texts.set(el.containerId, el);
    const out = [];
    for (const el of elements) {
      if (el.type === 'text' && el.containerId) continue;
      out.push(el);
      const t = texts.get(el.id);
      if (t) out.push(t);
    }
    return out;
  }
  SP.orderForDraw = orderForDraw;

  SP.exportCanvas = function (elements, files, { background, scale = 2, maxSize } = {}) {
    const els = orderForDraw(elements);
    const b = SP.commonBounds(els);
    const pad = SP.EXPORT_PAD;
    let w = b.w + pad * 2, h = b.h + pad * 2;
    if (maxSize) scale = Math.min(scale, maxSize / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * scale));
    c.height = Math.max(1, Math.ceil(h * scale));
    const ctx = c.getContext('2d');
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.scale(scale, scale);
    ctx.translate(-b.minX + pad, -b.minY + pad);
    const rc = rough.canvas(c);
    for (const el of els) SP.drawElement(ctx, rc, el, files);
    return c;
  };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  SP.exportSVG = async function (elements, files, { background } = {}) {
    const els = orderForDraw(elements);
    const b = SP.commonBounds(els);
    const pad = SP.EXPORT_PAD;
    const w = b.w + pad * 2, h = b.h + pad * 2;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('xmlns', NS);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    const rs = rough.svg(svg);

    let fontCss = '';
    if (els.some((e) => e.type === 'text' && SP.fontKind(e.fontFamily) === 'hand')) {
      try {
        const res = await fetch('fonts/kalam-400.woff2');
        const buf = await res.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        fontCss = `@font-face{font-family:"Kalam";src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");}`;
      } catch (e) { /* opened from disk: fall back to system handwriting fonts */ }
    }
    if (fontCss) {
      const style = document.createElementNS(NS, 'style');
      style.textContent = fontCss;
      svg.appendChild(style);
    }
    if (background) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('width', '100%'); r.setAttribute('height', '100%'); r.setAttribute('fill', background);
      svg.appendChild(r);
    }
    const root = document.createElementNS(NS, 'g');
    root.setAttribute('transform', `translate(${pad - b.minX} ${pad - b.minY})`);
    svg.appendChild(root);

    for (const el of els) {
      const bx = SP.getBox(el), cx = bx.x + bx.w / 2, cy = bx.y + bx.h / 2;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('transform', `translate(${cx} ${cy}) rotate(${((el.angle || 0) * 180) / Math.PI}) translate(${el.x - cx} ${el.y - cy})`);
      if (el.opacity != null && el.opacity < 100) g.setAttribute('opacity', el.opacity / 100);
      g.setAttribute('stroke-linecap', 'round');
      g.setAttribute('stroke-linejoin', 'round');
      if (el.type === 'freedraw') {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', SP.freedrawPathData(el));
        p.setAttribute('fill', el.strokeColor);
        p.setAttribute('stroke', 'none');
        g.appendChild(p);
      } else if (el.type === 'text') {
        const lh = el.fontSize * SP.lineHeight(el);
        const ax = el.textAlign === 'center' ? el.width / 2 : el.textAlign === 'right' ? el.width : 0;
        const anchor = el.textAlign === 'center' ? 'middle' : el.textAlign === 'right' ? 'end' : 'start';
        el.text.split('\n').forEach((ln, i) => {
          const t = document.createElementNS(NS, 'text');
          t.setAttribute('x', ax);
          t.setAttribute('y', i * lh + lh / 2);
          t.setAttribute('font-family', SP.FONTS[SP.fontKind(el.fontFamily)]);
          t.setAttribute('font-size', el.fontSize);
          t.setAttribute('fill', el.strokeColor);
          t.setAttribute('text-anchor', anchor);
          t.setAttribute('dominant-baseline', 'central');
          t.setAttribute('style', 'white-space:pre');
          t.textContent = ln;
          g.appendChild(t);
        });
      } else if (el.type === 'image') {
        const f = files[el.fileId];
        if (f) {
          const im = document.createElementNS(NS, 'image');
          im.setAttribute('href', f.dataURL);
          im.setAttribute('width', el.width);
          im.setAttribute('height', el.height);
          im.setAttribute('preserveAspectRatio', 'none');
          g.appendChild(im);
        }
      } else {
        for (const d of SP.getDrawables(el)) g.appendChild(rs.draw(d));
      }
      root.appendChild(g);
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
  };

  SP.escapeHTML = esc;
})();
