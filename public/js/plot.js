/**
 * Canvas plot: datasheet image + calibrated axes + curve overlay.
 */

function formatTick(n) {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return String(Number(n.toFixed(digits)));
}

export function formatMa(amps) {
  return +(amps * 1000).toFixed(3);
}

export class Plot {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
    this.imageOpacity = 0.55;
    this.curveColor = '#c0392b';
    /** @type {{ origin: {x,y}|null, vpMaxPx: {x,y}|null, ipMaxPx: {x,y}|null, vpMax: number, ipMax: number }} */
    this.calib = {
      origin: null,
      vpMaxPx: null,
      ipMaxPx: null,
      vpMax: 400,
      ipMax: 0.01,
      /** Axis end values captured when calibration finished. Guides use these, not the live sweep maxima. */
      vpScale: null,
      ipScale: null,
    };
    this.curves = [];
    this.screenCurves = [];
    this.showScreenCurves = true;
    this.screenCurveColor = '#1d4ed8';
    this.positiveColor = '#7c3aed';
    this.loadLine = null;
    this.qPoint = null;
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

  /**
   * Fraction along the calibrated axes (or the plot box). Independent of the
   * numeric Vp/Ip maxima, so a guide stays on the datasheet when those change.
   */
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

  /** Volts/amps for a guide fraction: calibrated scale when set, else the live maxima. */
  unitToData(u, v) {
    const c = this.calib;
    const useScale = this.isCalibrated() && c.vpScale > 0 && c.ipScale > 0;
    const vpMax = useScale ? c.vpScale : c.vpMax;
    const ipMax = useScale ? c.ipScale : c.ipMax;
    return { vp: u * vpMax, ip: v * ipMax };
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

  draw() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(0, 0, w, h);

    if (this.image) {
      ctx.save();
      ctx.globalAlpha = this.imageOpacity;
      ctx.drawImage(this.image, 0, 0, w, h);
      ctx.restore();
    } else {
      this.drawGrid();
    }

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
    const divisions = 10;
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
    this.drawGridLabels(box, divisions);
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
      const positive = curve.vg > 0;
      ctx.strokeStyle = positive ? this.positiveColor : this.curveColor;
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
        fill: positive ? this.positiveColor : this.curveColor,
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

  drawSumCurves() {
    if (!this.sumCurves?.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#0f766e';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([6, 3]);
    for (const curve of this.sumCurves) {
      if (!curve.points.length) continue;
      this.strokePolyline(curve.points.map((pt) => this.dataToPx(pt.vp, pt.ip)));
    }
    ctx.restore();
  }

  drawIgCurves() {
    if (!this.igCurves?.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.25;
    ctx.setLineDash([1, 3]);
    for (const curve of this.igCurves) {
      if (!curve.points.length) continue;
      this.strokePolyline(curve.points.map((pt) => this.dataToPx(pt.vp, pt.ip)));
    }
    ctx.restore();
  }

  drawDissipation() {
    if (!this.dissip?.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#a16207';
    ctx.lineWidth = 1.25;
    this.strokePolyline(this.dissip.map((pt) => this.dataToPx(pt.vp, pt.ip)));
    ctx.restore();
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
    if (!this.qPoint) return;
    const p = this.dataToPx(this.qPoint.vp, this.qPoint.ip);
    ctx.save();
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawGuideSet(guides, style) {
    if (!guides?.length) return;
    const ctx = this.ctx;
    for (const g of guides) {
      const pts = g.points || [];
      if (!pts.length) continue;
      const px = pts.map((pt) => this.unitToPx(pt.u, pt.v));

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
