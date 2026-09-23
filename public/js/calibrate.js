/**
 * Click-to-calibrate datasheet axes: origin → Vp max → Ip max.
 */

const STEP_MSGS = [
  'Click on the graph 0 on the image',
  'Click on the Vpmax',
  'Click on the IpMax',
];

export class Calibrator {
  constructor(plot, { statusEl, onChange } = {}) {
    this.plot = plot;
    this.statusEl = statusEl;
    this.onChange = onChange || (() => {});
    this.active = false;
    this.step = 0;
    this.message = '';
  }

  start() {
    this.active = true;
    this.step = 0;
    this.plot.calib.origin = null;
    this.plot.calib.vpMaxPx = null;
    this.plot.calib.ipMaxPx = null;
    this._set(STEP_MSGS[0]);
  }

  cancel() {
    this.active = false;
    this.step = 0;
    this._set('Calibration cancelled.');
  }

  /**
   * @returns {boolean} true if click was consumed
   */
  onClick(local) {
    if (!this.active) return false;
    const c = this.plot.calib;
    if (this.step === 0) {
      c.origin = { x: local.x, y: local.y };
      this.step = 1;
      this._set(STEP_MSGS[1]);
    } else if (this.step === 1) {
      c.vpMaxPx = { x: local.x, y: local.y };
      this.step = 2;
      this._set(STEP_MSGS[2]);
    } else if (this.step === 2) {
      c.ipMaxPx = { x: local.x, y: local.y };
      this.active = false;
      this.step = 0;
      const ipMa = +(c.ipMax * 1000).toFixed(3);
      this._set(
        `Calibrated: origin→Vpmax→Ipmax. Vp max=${c.vpMax} V, Ip max=${ipMa} mA.`,
      );
    }
    return true;
  }

  _set(msg) {
    this.message = msg;
    this.plot.calibMode = this.active
      ? { step: this.step, message: msg }
      : null;
    if (this.statusEl) this.statusEl.textContent = msg;
    this.onChange(this);
    this.plot.draw();
  }
}
