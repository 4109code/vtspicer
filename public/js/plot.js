/**
 * Canvas plot: datasheet image + calibrated axes + curve overlay.
 */

const GRID_DIVISIONS = 10;
const CENTER_R = 3.5;
const SWING_R = 4.5;
const NEGATIVE_GRID_COLOR = '#1e3a8a';
const POSITIVE_GRID_COLOR = '#7f1d1d';
const PMAX_COLOR = '#ff2a2a';
/** Clearance so a parked center stays grabbable beside a swing ring on the same border. */
const HANDLE_GAP = CENTER_R + SWING_R + 3;

function formatTick(n) {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return String(Number(n.toFixed(digits)));
}

export function formatMa(amps) {
  return +(amps * 1000).toFixed(3);
}

function insideRect(p, rect) {
  return p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1;
}

function dedupeHits(hits) {
  const out = [];
  for (const h of hits) {
    if (out.some((p) => Math.hypot(p.x - h.x, p.y - h.y) < 0.5)) continue;
    out.push(h);
  }
  return out;
}

/** Intersections of the infinite line through a→b with the rectangle edges. */
function lineRectHits(a, b, rect) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const hits = [];
  const eps = 1e-6;
  if (Math.abs(dx) > eps) {
    for (const x of [rect.x0, rect.x1]) {
      const t = (x - a.x) / dx;
      const y = a.y + t * dy;
      if (y >= rect.y0 - eps && y <= rect.y1 + eps) hits.push({ x, y });
    }
  }
  if (Math.abs(dy) > eps) {
    for (const y of [rect.y0, rect.y1]) {
      const t = (y - a.y) / dy;
      const x = a.x + t * dx;
      if (x >= rect.x0 - eps && x <= rect.x1 + eps) hits.push({ x, y });
    }
  }
  return dedupeHits(hits);
}

function axisClamp(p, rect) {
  return {
    x: Math.min(rect.x1, Math.max(rect.x0, p.x)),
    y: Math.min(rect.y1, Math.max(rect.y0, p.y)),
  };
}

function dominantEdge(p, rect) {
  const edges = [
    ['left', Math.abs(p.x - rect.x0)],
    ['right', Math.abs(p.x - rect.x1)],
    ['top', Math.abs(p.y - rect.y0)],
    ['bottom', Math.abs(p.y - rect.y1)],
  ];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0][0];
}

function edgeTangents(edge) {
  if (edge === 'left' || edge === 'right') return [{ x: 0, y: -1 }, { x: 0, y: 1 }];
  return [{ x: -1, y: 0 }, { x: 1, y: 0 }];
}

function roomAlong(p, tangent, rect) {
  if (tangent.x > 0) return rect.x1 - p.x;
  if (tangent.x < 0) return p.x - rect.x0;
  if (tangent.y > 0) return rect.y1 - p.y;
  return p.y - rect.y0;
}

/** Smallest s≥0 such that moving from p along tangent clears o by gap. */
function clearanceShift(p, o, tangent, gap) {
  const vx = p.x - o.x;
  const vy = p.y - o.y;
  const dist = Math.hypot(vx, vy);
  if (dist >= gap) return 0;
  const vd = vx * tangent.x + vy * tangent.y;
  const disc = vd * vd - dist * dist + gap * gap;
  return -vd + Math.sqrt(Math.max(0, disc));
}

function nearestWithin(p, avoid, gap) {
  let best = null;
  let bestD = gap;
  for (const o of avoid) {
    if (!o) continue;
    const d = Math.hypot(p.x - o.x, p.y - o.y);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

function snapToEdge(p, edge, rect) {
  if (edge === 'left') return { x: rect.x0, y: p.y };
  if (edge === 'right') return { x: rect.x1, y: p.y };
  if (edge === 'top') return { x: p.x, y: rect.y0 };
  return { x: p.x, y: rect.y1 };
}

/** Slide along the border until the dot is gap away from every obstacle. */
function slideClear(p, rect, avoid, gap) {
  let cur = { x: p.x, y: p.y };
  for (let n = 0; n < avoid.length + 2; n++) {
    const o = nearestWithin(cur, avoid, gap);
    if (!o) return cur;
    const edge = dominantEdge(cur, rect);
    const tangents = edgeTangents(edge);
    let tangent = null;
    let best = -Infinity;
    for (const t of tangents) {
      if (roomAlong(cur, t, rect) < 0.5) continue;
      const score = (cur.x - o.x) * t.x + (cur.y - o.y) * t.y;
      if (score > best) {
        best = score;
        tangent = t;
      }
    }
    if (!tangent) return cur;
    const s = clearanceShift(cur, o, tangent, gap);
    const room = roomAlong(cur, tangent, rect);
    const step = Math.min(s, Math.max(0, room));
    cur = snapToEdge(
      { x: cur.x + tangent.x * step, y: cur.y + tangent.y * step },
      edge,
      rect,
    );
  }
  return cur;
}

/**
 * Pixel for the load-line center. A point outside the canvas is parked on the
 * border where the load line exits, then slid along that border so a swing
 * marker already sitting there does not cover it.
 */
export function parkOnCanvas(point, line, rect, avoid = [], gap = HANDLE_GAP) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (insideRect(point, rect)) return { x: point.x, y: point.y };
  const a = line?.[0];
  const b = line?.[1];
  let parked = axisClamp(point, rect);
  if (a && b && Number.isFinite(a.x) && Number.isFinite(b.x)) {
    const hits = lineRectHits(a, b, rect);
    if (hits.length) {
      parked = hits.reduce((best, h) => (
        Math.hypot(h.x - point.x, h.y - point.y) < Math.hypot(best.x - point.x, best.y - point.y) ? h : best
      ));
    }
  }
  return slideClear(parked, rect, avoid, gap);
}

export class Plot {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    this.imageOpacity = 0.55;
    /** @type {{ origin: {x,y}|null, vpMaxPx: {x,y}|null, ipMaxPx: {x,y}|null, vpMax: number, ipMax: number }} */
    this.calib = {
      origin: null,
      vpMaxPx: null,
      ipMaxPx: null,
      vpMax: 400,
      ipMax: 0.01,
      /** Axis end values captured when calibration finished. Older fraction guides convert back with these. */
      vpScale: null,
      ipScale: null,
    };
    this.curves = [];
    this.screenCurves = [];
    this.showScreenCurves = true;
    this.screenCurveColor = '#1d4ed8';
    this.loadLine = null;
    this.qPoint = null;
    this.swingPoints = [];
    this.dissip = null;
    this.igCurves = [];
    this.sumCurves = [];
    this.guides = [];
    this.screenGuides = [];
    this.pad = { left: 64, right: 16, top: 16, bottom: 56 };
    /** @type {{ step: number, message: string }|null} */
    this.calibMode = null;
  }

  setImage(img) {
    this.image = img;
    this.draw();
  }

  clearImage() {
    this.image = null;
    this.draw();
  }

  isCalibrated() {
    const c = this.calib;
    return !!(c.origin && c.vpMaxPx && c.ipMaxPx);
  }

  /**
   * Axis basis from calibration clicks (supports rotated datasheet axes):
   *   pixel = origin + (vp/vpMax)·vpVec + (ip/ipMax)·ipVec
   */
  calibBasis() {
    const c = this.calib;
    const ox = c.origin.x;
    const oy = c.origin.y;
    return {
      ox,
      oy,
      vx: c.vpMaxPx.x - ox,
      vy: c.vpMaxPx.y - oy,
      ix: c.ipMaxPx.x - ox,
      iy: c.ipMaxPx.y - oy,
      vpMax: c.vpMax,
      ipMax: c.ipMax,
    };
  }

  /** Map data (Vp, Ip) → canvas pixels when calibrated, else plot box. */
  dataToPx(vp, ip) {
    const c = this.calib;
    return this.unitToPx(vp / c.vpMax, ip / c.ipMax);
  }

  pxToData(x, y) {
    const { u, v } = this.pxToUnit(x, y);
    const c = this.calib;
    return { vp: u * c.vpMax, ip: v * c.ipMax };
  }

  /** Fraction along the calibrated axes, or the plot box when they are not set. */
  pxToUnit(x, y) {
    if (this.isCalibrated()) {
      const b = this.calibBasis();
      const dx = x - b.ox;
      const dy = y - b.oy;
      const det = b.vx * b.iy - b.vy * b.ix;
      if (Math.abs(det) < 1e-9) return { u: 0, v: 0 };
      return {
        u: (dx * b.iy - dy * b.ix) / det,
        v: (b.vx * dy - b.vy * dx) / det,
      };
    }
    const box = this.plotBox();
    return {
      u: (x - box.x) / box.w,
      v: (box.y + box.h - y) / box.h,
    };
  }

  unitToPx(u, v) {
    if (this.isCalibrated()) {
      const b = this.calibBasis();
      return {
        x: b.ox + u * b.vx + v * b.ix,
        y: b.oy + u * b.vy + v * b.iy,
      };
    }
    const box = this.plotBox();
    return {
      x: box.x + u * box.w,
      y: box.y + box.h - v * box.h,
    };
  }

  plotBox() {
    const { left, right, top, bottom } = this.pad;
    return {
      x: left,
      y: top,
      w: this.canvas.width - left - right,
      h: this.canvas.height - top - bottom,
    };
  }

  eventToLocal(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY,
    };
  }

  paintBackdrop(ctx) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.image) {
      const key = `${w}x${h}`;
      if (!this._sheet || this._sheetKey !== key || this._sheetImage !== this.image) {
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        off.getContext('2d').drawImage(this.image, 0, 0, w, h);
        this._sheet = off;
        this._sheetKey = key;
        this._sheetImage = this.image;
      }
      ctx.fillStyle = '#f4f1ea';
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.globalAlpha = this.imageOpacity;
      ctx.drawImage(this._sheet, 0, 0);
      ctx.restore();
      return;
    }
    const key = `${w}x${h}`;
    if (!this._backdrop || this._backdropKey !== key) {
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const saved = this.ctx;
      this.ctx = off.getContext('2d');
      this.ctx.fillStyle = '#f4f1ea';
      this.ctx.fillRect(0, 0, w, h);
      this.drawGrid();
      this.ctx = saved;
      this._backdrop = off;
      this._backdropKey = key;
    }
    ctx.drawImage(this._backdrop, 0, 0);
  }

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    this.paintBackdrop(ctx);
    if (!this.image) this.drawGridLabels(this.plotBox(), GRID_DIVISIONS);

    this.drawAxesLabels();
    this.drawCurves();
    this.drawScreenCurves();
    this.drawSumCurves();
    this.drawIgCurves();
    this.drawDissipation();
    this.drawLoadLine();
    this.drawGuides();
    this.drawCalibMarkers();
    this.drawCalibModeChrome();
  }

  drawGrid() {
    const ctx = this.ctx;
    const box = this.plotBox();
    const divisions = GRID_DIVISIONS;
    ctx.strokeStyle = '#d0cbc0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= divisions; i++) {
      const x = box.x + (i / divisions) * box.w;
      const y = box.y + (i / divisions) * box.h;
      ctx.beginPath();
      ctx.moveTo(x, box.y);
      ctx.lineTo(x, box.y + box.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + box.w, y);
      ctx.stroke();
    }
  }

  drawGridLabels(box, divisions) {
    const c = this.calib;
    const font = '12px sans-serif';
    const fill = '#4a453c';
    for (let i = 0; i <= divisions; i++) {
      const t = i / divisions;
      const x = box.x + t * box.w;
      const y = box.y + t * box.h;
      this.drawLabel(formatTick(c.vpMax * t), x, box.y + box.h + 3, {
        fill,
        font,
        align: 'center',
        baseline: 'top',
      });
      this.drawLabel(formatTick(c.ipMax * 1000 * (1 - t)), box.x - 6, y, {
        fill,
        font,
        align: 'right',
        baseline: 'middle',
      });
    }
  }

  /**
   * Plain filled label (no stroke/halo).
   */
  drawLabel(text, x, y, {
    fill = '#222',
    font = '12px sans-serif',
    align = 'left',
    baseline = 'alphabetic',
  } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  measureLabel(text, font = '12px sans-serif') {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = font;
    const w = ctx.measureText(text).width;
    ctx.restore();
    return w;
  }

  drawAxesLabels() {
    const c = this.calib;
    const font = '16px sans-serif';
    const ipMa = formatMa(c.ipMax);
    this.drawLabel(`Vp → 0…${c.vpMax} V`, this.pad.left, this.canvas.height - 12, {
      fill: '#222',
      font,
    });
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(16, this.canvas.height / 2);
    ctx.rotate(-Math.PI / 2);
    this.drawLabel(`Ip → 0…${ipMa} mA`, 0, 0, { fill: '#222', font });
    ctx.restore();
  }

  strokePolyline(points) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      if (i === 0) ctx.moveTo(points[i].x, points[i].y);
      else ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  clampLabel(x, y, tw, th, margin = 8) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    return {
      x: Math.min(Math.max(margin, x), w - tw - margin),
      y: Math.min(Math.max(th + margin, y), h - margin),
    };
  }

  drawCurves() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const margin = 8;
    const font = '16px sans-serif';
    ctx.lineWidth = 1.75;

    for (const curve of this.curves) {
      const pts = curve.points;
      if (!pts.length) continue;
      const color = curve.vg > 0 ? POSITIVE_GRID_COLOR : NEGATIVE_GRID_COLOR;
      ctx.strokeStyle = color;
      this.strokePolyline(pts.map((pt) => this.dataToPx(pt.vp, pt.ip)));

      const label = `${curve.vg} V`;
      const tw = this.measureLabel(label, font);
      const th = 16;
      const prefer = Math.floor(pts.length * 0.7);
      let anchor = null;
      for (let dist = 0; dist < pts.length; dist++) {
        for (const idx of [prefer + dist, prefer - dist]) {
          if (idx < 0 || idx >= pts.length) continue;
          const p = this.dataToPx(pts[idx].vp, pts[idx].ip);
          if (
            p.x >= margin &&
            p.x <= w - margin &&
            p.y >= margin &&
            p.y <= h - margin
          ) {
            anchor = p;
            break;
          }
        }
        if (anchor) break;
      }
      if (!anchor) {
        const mid = pts[prefer] || pts[pts.length - 1];
        anchor = this.dataToPx(mid.vp, mid.ip);
      }

      const labelPos = this.clampLabel(anchor.x + 5, anchor.y - 5, tw, th, margin);
      this.drawLabel(label, labelPos.x, labelPos.y, {
        fill: color,
        font,
      });
    }
  }

  drawScreenCurves() {
    if (!this.showScreenCurves || !this.screenCurves?.length) return;
    const ctx = this.ctx;
    const margin = 8;
    const font = '15px sans-serif';
    const color = this.screenCurveColor || '#1d4ed8';

    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;

    for (const curve of this.screenCurves) {
      const pts = curve.points;
      if (!pts.length) continue;
      this.strokePolyline(pts.map((pt) => this.dataToPx(pt.vp, pt.ip)));

      const label = `${curve.vg} Ig2`;
      const tw = this.measureLabel(label, font);
      const th = 15;
      const prefer = Math.floor(pts.length * 0.55);
      const mid = pts[prefer] || pts[pts.length - 1];
      if (!mid) continue;
      const anchor = this.dataToPx(mid.vp, mid.ip);
      const labelPos = this.clampLabel(anchor.x + 5, anchor.y - 5, tw, th, margin);
      this.drawLabel(label, labelPos.x, labelPos.y, { fill: color, font });
    }
    ctx.restore();
  }

  strokeSeries(series, { color, width = 1.25, dash } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    for (const points of series) {
      if (!points.length) continue;
      this.strokePolyline(points.map((pt) => this.dataToPx(pt.vp, pt.ip)));
    }
    ctx.restore();
  }

  drawSumCurves() {
    if (!this.sumCurves?.length) return;
    this.strokeSeries(
      this.sumCurves.map((curve) => curve.points),
      { color: '#0f766e', dash: [6, 3] },
    );
  }

  drawIgCurves() {
    if (!this.igCurves?.length) return;
    this.strokeSeries(
      this.igCurves.map((curve) => curve.points),
      { color: '#b45309', dash: [1, 3] },
    );
  }

  drawDissipation() {
    if (!this.dissip?.length) return;
    this.strokeSeries([this.dissip], { color: PMAX_COLOR });
  }

  canvasInset(pad) {
    return {
      x0: pad,
      y0: pad,
      x1: this.canvas.width - pad,
      y1: this.canvas.height - pad,
    };
  }

  /** Drawn pixel of the quiescent dot, parked on the canvas border when the point is off-plot. */
  loadCenterPx() {
    if (!this.qPoint || this.qPoint.vp == null || this.qPoint.ip == null) return null;
    const line = (this.loadLine || []).map((pt) => this.dataToPx(pt.vp, pt.ip));
    const avoid = (this.swingPoints || [])
      .filter((pt) => pt && pt.vp != null && pt.ip != null)
      .map((pt) => this.dataToPx(pt.vp, pt.ip));
    return parkOnCanvas(
      this.dataToPx(this.qPoint.vp, this.qPoint.ip),
      line,
      this.canvasInset(CENTER_R + 1),
      avoid,
    );
  }

  drawLoadLine() {
    const ctx = this.ctx;
    if (this.loadLine?.length) {
      ctx.save();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.5;
      this.strokePolyline(this.loadLine.map((pt) => this.dataToPx(pt.vp, pt.ip)));
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = '#111';
    ctx.fillStyle = '#f4f1ea';
    ctx.lineWidth = 1.5;
    for (const pt of this.swingPoints || []) {
      if (pt.vp == null || pt.ip == null) continue;
      const s = this.dataToPx(pt.vp, pt.ip);
      ctx.beginPath();
      ctx.arc(s.x, s.y, SWING_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const center = this.loadCenterPx();
    if (center) {
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.arc(center.x, center.y, CENTER_R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawGuideSet(guides, style) {
    if (!guides?.length) return;
    const ctx = this.ctx;
    for (const g of guides) {
      const pts = g.points || [];
      if (!pts.length) continue;
      const px = pts.map((pt) => this.dataToPx(pt.vp, pt.ip));

      ctx.save();
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = 2.25;
      this.strokePolyline(px);
      ctx.setLineDash([]);

      for (const p of px) {
        ctx.beginPath();
        ctx.fillStyle = style.fill;
        ctx.strokeStyle = style.ring;
        ctx.lineWidth = 2;
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      const anchor = px[Math.min(px.length - 1, Math.floor(px.length * 0.6))];
      this.drawLabel(style.label(g), anchor.x + 8, anchor.y - 10, {
        fill: style.labelFill,
        font: '15px sans-serif',
      });
      ctx.restore();
    }
  }

  drawGuides() {
    this.drawGuideSet(this.guides, {
      stroke: '#0284c7',
      fill: '#38bdf8',
      ring: '#0c4a6e',
      labelFill: '#0369a1',
      label: (g) => `${g.vg} V`,
    });
    this.drawGuideSet(this.screenGuides, {
      stroke: '#c2410c',
      fill: '#fb923c',
      ring: '#7c2d12',
      labelFill: '#9a3412',
      label: (g) => `${g.vg} Ig2`,
    });
  }

  drawCalibMarkers() {
    const ctx = this.ctx;
    const c = this.calib;
    const marks = [
      { p: c.origin, label: '0' },
      { p: c.vpMaxPx, label: 'Vpmax' },
      { p: c.ipMaxPx, label: 'Ipmax' },
    ];
    for (const m of marks) {
      if (!m.p) continue;
      const size = 8;
      ctx.strokeStyle = '#e5a50a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(m.p.x - size, m.p.y);
      ctx.lineTo(m.p.x + size, m.p.y);
      ctx.moveTo(m.p.x, m.p.y - size);
      ctx.lineTo(m.p.x, m.p.y + size);
      ctx.stroke();
      this.drawLabel(m.label, m.p.x + 9, m.p.y - 9, {
        fill: '#a16207',
        font: '14px sans-serif',
      });
    }
  }

  drawCalibModeChrome() {
    if (!this.calibMode) return;
    this.drawLabel(this.calibMode.message, this.canvas.width / 2, this.canvas.height / 2, {
      fill: '#8b1a1a',
      font: 'bold 28px sans-serif',
      align: 'center',
      baseline: 'middle',
    });
  }
}
