/**
 * Click-to-calibrate datasheet axes: origin → Vp max → Ip max.
 */

import { formatMa } from './plot.js';

const STEP_MSGS = [
  'Click on the graph 0',
  'Click on the Vpmax (end of X axis)',
  'Click on the Ipmax (end of Y axis)',
];

export class Calibrator {
  constructor(plot, { statusEl, onChange } = {}) {
    this.plot = plot;
    this.statusEl = statusEl;
    this.onChange = onChange || (() => {});
    this.active = false;
    this.step = 0;
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
    this._set('Calibration cancelled');
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
      c.vpScale = c.vpMax;
      c.ipScale = c.ipMax;
      this.active = false;
      this.step = 0;
      const ipMa = formatMa(c.ipMax);
      this._set(
        `Calibrated: Origin → Vpmax → Ipmax. Vp max=${c.vpMax} V, Ip max=${ipMa} mA.`,
      );
    }
    return true;
  }

  _set(msg) {
    this.plot.calibMode = this.active
      ? { step: this.step, message: msg }
      : null;
    if (this.statusEl) this.statusEl.textContent = msg;
    this.onChange(this);
    this.plot.draw();
  }
}
