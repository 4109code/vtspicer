/**
 * Canvas plot: datasheet image + calibrated axes + curve overlay.
 */

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
      ipMax: 0.006,
    };
    this.curves = [];
    this.screenCurves = [];
    this.showScreenCurves = true;
    this.screenCurveColor = '#1d4ed8';
    this.guides = [];
    this.hover = null;
    this.pad = { left: 56, right: 16, top: 16, bottom: 40 };
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
    if (this.isCalibrated()) {
      const b = this.calibBasis();
      const u = vp / b.vpMax;
      const v = ip / b.ipMax;
      return {
        x: b.ox + u * b.vx + v * b.ix,
        y: b.oy + u * b.vy + v * b.iy,
      };
    }
    const box = this.plotBox();
    const x = box.x + (vp / c.vpMax) * box.w;
    const y = box.y + box.h - (ip / c.ipMax) * box.h;
    return { x, y };
  }

  pxToData(x, y) {
    const c = this.calib;
    if (this.isCalibrated()) {
      const b = this.calibBasis();
      const dx = x - b.ox;
      const dy = y - b.oy;
      const det = b.vx * b.iy - b.vy * b.ix;
      if (Math.abs(det) < 1e-9) {
        return { vp: 0, ip: 0 };
      }
      const u = (dx * b.iy - dy * b.ix) / det;
      const v = (b.vx * dy - b.vy * dx) / det;
      return { vp: u * b.vpMax, ip: v * b.ipMax };
    }
    const box = this.plotBox();
    return {
      vp: ((x - box.x) / box.w) * c.vpMax,
      ip: ((box.y + box.h - y) / box.h) * c.ipMax,
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
    this.drawGuides();
    this.drawCalibMarkers();
    this.drawCalibModeChrome();
  }

  drawGrid() {
    const ctx = this.ctx;
    const box = this.plotBox();
    ctx.strokeStyle = '#d0cbc0';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = box.x + (i / 10) * box.w;
      const y = box.y + (i / 10) * box.h;
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
    const ipMa = +(c.ipMax * 1000).toFixed(3);
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

  drawCurves() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const margin = 8;
    const font = '16px sans-serif';
    ctx.lineWidth = 1.75;
    ctx.strokeStyle = this.curveColor;

    for (const curve of this.curves) {
      const pts = curve.points;
      if (!pts.length) continue;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = this.dataToPx(pts[i].vp, pts[i].ip);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

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

      let x = anchor.x + 5;
      let y = anchor.y - 5;
      x = Math.min(Math.max(margin, x), w - tw - margin);
      y = Math.min(Math.max(th + margin, y), h - margin);
      this.drawLabel(label, x, y, { fill: this.curveColor, font });
    }
  }

  drawScreenCurves() {
    if (!this.showScreenCurves || !this.screenCurves?.length) return;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
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
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const p = this.dataToPx(pts[i].vp, pts[i].ip);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();

      const label = `${curve.vg} Ig2`;
      const tw = this.measureLabel(label, font);
      const th = 15;
      const prefer = Math.floor(pts.length * 0.55);
      const mid = pts[prefer] || pts[pts.length - 1];
      if (!mid) continue;
      let { x, y } = this.dataToPx(mid.vp, mid.ip);
      x += 5;
      y -= 5;
      x = Math.min(Math.max(margin, x), w - tw - margin);
      y = Math.min(Math.max(th + margin, y), h - margin);
      this.drawLabel(label, x, y, { fill: color, font });
    }
    ctx.restore();
  }

  drawGuides() {
    if (!this.guides?.length) return;
    const ctx = this.ctx;
    const stroke = '#0284c7';
    const fill = '#38bdf8';

    for (const g of this.guides) {
      const pts = g.points || [];
      if (!pts.length) continue;
      const px = pts.map((pt) => this.dataToPx(pt.vp, pt.ip));

      ctx.save();
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2.25;
      ctx.beginPath();
      px.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      for (const p of px) {
        ctx.beginPath();
        ctx.fillStyle = fill;
        ctx.strokeStyle = '#0c4a6e';
        ctx.lineWidth = 2;
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      const anchor = px[Math.min(px.length - 1, Math.floor(px.length * 0.6))];
      this.drawLabel(`${g.vg} V`, anchor.x + 8, anchor.y - 10, {
        fill: '#0369a1',
        font: '15px sans-serif',
      });
      ctx.restore();
    }
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
    const msgs = [
      'Click on the graph 0 on the image',
      'Click on the Vpmax',
      'Click on the IpMax',
    ];
    const text = msgs[this.calibMode.step] || this.calibMode.message;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = 'bold 28px sans-serif';
    ctx.fillStyle = '#8b1a1a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2);
    ctx.restore();
  }
}
