/**
 * Parameter sliders driven by the active model definition.
 *
 * Range: log-mapped across the suggested limits; drag past either end to go further.
 * Number: live input/wheel and click-drag scrub are unbounded.
 */

import { PASSIVE_KEYS } from '/lib/models/math.js';

const SLIDER_MAX = 1000;

function decimalsFor(key, lim) {
  if (key === 'G' || key === 'GLIM' || key === 'K') return 6;
  if (key === 'KP' || (lim && lim.max <= 5)) return 6;
  return 2;
}

function formatValue(key, v, lim) {
  const d = decimalsFor(key, lim);
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return String(Number(n.toFixed(d)));
}

function paramHint(model, key, type) {
  const hint = model.paramHints?.[key];
  if (!hint) return '';
  if (typeof hint === 'string') return hint;
  return hint[type] || '';
}

export function createParamSliders(container, model, params, onChange, type) {
  container.innerHTML = '';
  const controls = {};
  const limits = model.limits;
  const logSet = new Set(model.logParams || []);
  const multiSet = new Set(model.multiGridParams || []);
  const enums = model.enumParams || {};
  const live = { ...params };
  const dipOf = typeof model.dipSlot === 'function' ? model.dipSlot : null;

  function shown(key, source) {
    const v = source[key];
    if (v != null && Number.isFinite(Number(v))) return Number(v);
    const fb = model.paramFallback?.[key];
    if (fb != null && Number.isFinite(fb)) return fb;
    return limits[key].min;
  }

  function syncDips(source) {
    if (!dipOf) return;
    const n = Math.round(Number(source.ND ?? 0));
    for (const key of model.paramKeys) {
      const slot = dipOf(key);
      if (!slot || !controls[key]) continue;
      controls[key].row.hidden = slot > n;
    }
  }

  function emit(key, value) {
    live[key] = value;
    onChange(key, value);
    syncDips(live);
  }

  function usesLog(key) {
    return logSet.has(key) && limits[key].min > 0;
  }

  function clamp(key, v) {
    const lim = limits[key];
    return Math.min(lim.max, Math.max(lim.min, v));
  }

  function inRange(key, v) {
    const lim = limits[key];
    return v >= lim.min && v <= lim.max;
  }

  function snapEnum(key, v) {
    const options = enums[key];
    if (!options?.length) return clamp(key, v);
    let best = options[0].value;
    let bestD = Infinity;
    for (const opt of options) {
      const d = Math.abs(opt.value - v);
      if (d < bestD) {
        bestD = d;
        best = opt.value;
      }
    }
    return best;
  }

  function valueToSlider(key, value) {
    const lim = limits[key];
    const v = Number(value);
    if (!Number.isFinite(v)) return 0;
    let t;
    if (!usesLog(key)) {
      t = (v - lim.min) / (lim.max - lim.min);
    } else {
      t =
        (Math.log(Math.max(v, Number.MIN_VALUE)) - Math.log(lim.min)) /
        (Math.log(lim.max) - Math.log(lim.min));
    }
    return Math.min(SLIDER_MAX, Math.max(0, t * SLIDER_MAX));
  }

  function sliderToValue(key, sliderPos) {
    const lim = limits[key];
    const t = Number(sliderPos) / SLIDER_MAX;
    if (!usesLog(key)) {
      return lim.min + t * (lim.max - lim.min);
    }
    return Math.exp(Math.log(lim.min) + t * (Math.log(lim.max) - Math.log(lim.min)));
  }

  function stepHint(key) {
    const lim = limits[key];
    const span = lim.max - lim.min;
    if (usesLog(key)) return lim.min * 0.01;
    return Math.max(span / 1000, 1e-6);
  }

  function attachScrub(num, key, apply) {
    let pointerId = null;
    let lastX = 0;
    let originX = 0;
    let originY = 0;
    let scrubbing = false;

    num.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      lastX = originX = e.clientX;
      originY = e.clientY;
      scrubbing = false;
      num.setPointerCapture(e.pointerId);
    });

    num.addEventListener('pointermove', (e) => {
      if (pointerId !== e.pointerId) return;
      const totalDx = e.clientX - originX;
      const totalDy = e.clientY - originY;
      if (!scrubbing) {
        if (totalDx * totalDx + totalDy * totalDy < 9) return;
        scrubbing = true;
        num.classList.add('scrubbing');
        num.blur();
      }

      const dx = e.clientX - lastX;
      lastX = e.clientX;
      if (dx === 0) return;

      const lim = limits[key];
      const span = lim.max - lim.min;
      const dist = Math.abs(e.clientY - originY);
      // Stay on the row for fine steps; pull up or down to sweep faster.
      const t = Math.min(1, dist / 160);
      const s = t * t * (3 - 2 * t);
      const gain = 0.08 + 0.92 * s;
      const speedBoost = 1 + Math.min(4, Math.abs(dx) / 6);
      let pixelsForSpan = usesLog(key) ? 280 : 220;
      if (e.shiftKey) pixelsForSpan *= 10;
      if (e.altKey) pixelsForSpan /= 10;

      let next;
      if (usesLog(key)) {
        const raw = Number(num.value);
        const v = raw > 0 ? raw : lim.min;
        const logSpan = Math.log(lim.max) - Math.log(lim.min);
        const dLog = (dx / pixelsForSpan) * logSpan * gain * speedBoost;
        next = Math.exp(Math.log(v) + dLog);
      } else {
        next = Number(num.value) + (dx / pixelsForSpan) * span * gain * speedBoost;
      }
      apply(next);
    });

    const end = (e) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      if (scrubbing) {
        scrubbing = false;
        num.classList.remove('scrubbing');
      }
      try {
        num.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    num.addEventListener('pointerup', end);
    num.addEventListener('pointercancel', end);
  }

  for (const key of model.paramKeys) {
    const lim = limits[key];
    if (!lim) continue;
    const row = document.createElement('div');
    row.className = 'param-row';
    row.dataset.param = key;
    if (multiSet.has(key)) row.dataset.multi = '1';

    const lab = document.createElement('span');
    lab.className = 'param-name';
    const keyEl = document.createElement('span');
    keyEl.className = 'param-key';
    keyEl.textContent = key;
    lab.append(keyEl);
    const hint = paramHint(model, key, type);
    if (hint) {
      const hintEl = document.createElement('span');
      hintEl.className = 'param-hint';
      hintEl.textContent = hint;
      lab.append(hintEl);
      lab.title = hint;
    }

    if (enums[key]) {
      const sel = document.createElement('select');
      sel.title = 'Plate knee shape';
      for (const opt of enums[key]) {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.label;
        sel.appendChild(o);
      }
      sel.value = String(snapEnum(key, params[key] ?? enums[key][0].value));
      sel.addEventListener('change', () => {
        emit(key, snapEnum(key, Number(sel.value)));
      });
      row.append(lab, sel);
      container.appendChild(row);
      controls[key] = { row, select: sel };
      continue;
    }

    const range = document.createElement('input');
    range.type = 'range';
    range.min = 0;
    range.max = SLIDER_MAX;
    range.step = 1;
    range.value = valueToSlider(key, shown(key, live));
    range.title = usesLog(key) ? 'Log scale' : 'Linear';

    const num = document.createElement('input');
    num.type = 'number';
    num.step = stepHint(key);
    num.value = formatValue(key, shown(key, live), lim);
    num.title = 'Drag sideways: near=fine, away=coarse · Shift finer · Alt coarser';

    const apply = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      range.value = valueToSlider(key, n);
      num.value = formatValue(key, n, lim);
      emit(key, n);
    };

    // Track position is the suggested range. Pointer past either end keeps going.
    let rangeDrag = null;
    const pointerT = (e) => {
      const rect = range.getBoundingClientRect();
      return rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    };
    const valueFromDrag = (t) => {
      if (!rangeDrag.relative) return sliderToValue(key, t * SLIDER_MAX);
      const from = sliderToValue(key, rangeDrag.t0 * SLIDER_MAX);
      const to = sliderToValue(key, t * SLIDER_MAX);
      if (usesLog(key) && rangeDrag.v0 > 0 && from > 0) return rangeDrag.v0 * (to / from);
      return rangeDrag.v0 + (to - from);
    };

    range.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const v0 = Number(num.value);
      rangeDrag = {
        id: e.pointerId,
        t0: pointerT(e),
        v0: Number.isFinite(v0) ? v0 : lim.min,
        relative: Number.isFinite(v0) && !inRange(key, v0),
        overflow: false,
      };
    });
    range.addEventListener('pointermove', (e) => {
      if (!rangeDrag || rangeDrag.id !== e.pointerId) return;
      const t = pointerT(e);
      rangeDrag.overflow = t < 0 || t > 1;
      if (rangeDrag.overflow) apply(valueFromDrag(t));
    });
    const endRangeDrag = (e) => {
      if (!rangeDrag || rangeDrag.id !== e.pointerId) return;
      rangeDrag = null;
    };
    range.addEventListener('pointerup', endRangeDrag);
    range.addEventListener('pointercancel', endRangeDrag);

    range.addEventListener('input', () => {
      if (rangeDrag?.overflow) return;
      const t = Number(range.value) / SLIDER_MAX;
      apply(rangeDrag ? valueFromDrag(t) : sliderToValue(key, range.value));
    });
    num.addEventListener('input', () => {
      if (num.value === '' || num.value === '-' || num.value === '.' || num.value === '-.') return;
      const n = Number(num.value);
      if (!Number.isFinite(n)) return;
      range.value = valueToSlider(key, n);
      emit(key, n);
    });
    num.addEventListener('change', () => apply(num.value));
    num.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const cur = Number(num.value);
        if (!Number.isFinite(cur)) return;
        const dir = e.deltaY < 0 ? 1 : -1;
        let next;
        if (usesLog(key)) {
          const factor = e.shiftKey ? 1.01 : e.altKey ? 1.12 : 1.04;
          next = dir > 0 ? cur * factor : cur / factor;
        } else {
          const step = Number(num.step) || stepHint(key);
          const mult = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
          next = cur + dir * step * mult;
        }
        apply(next);
      },
      { passive: false },
    );
    attachScrub(num, key, apply);

    row.append(lab, range, num);
    container.appendChild(row);
    controls[key] = { row, range, num };
  }

  syncDips(live);

  return {
    controls,
    model,
    setParams(p) {
      Object.assign(live, p);
      syncDips(live);
      for (const key of model.paramKeys) {
        if (p[key] == null || !controls[key]) continue;
        if (controls[key].select) {
          controls[key].select.value = String(snapEnum(key, p[key]));
          continue;
        }
        const v = Number(p[key]);
        if (!Number.isFinite(v)) continue;
        controls[key].range.value = valueToSlider(key, v);
        controls[key].num.value = formatValue(key, v, limits[key]);
      }
    },
    setMultiGrid(visible) {
      for (const key of multiSet) {
        if (controls[key]) {
          controls[key].row.style.display = visible ? '' : 'none';
        }
      }
    },
  };
}

export const CAP_IDS = PASSIVE_KEYS;

export function readCaps() {
  return Object.fromEntries(CAP_IDS.map((id) => [id, Number(document.getElementById(id).value)]));
}

export function writeCaps(p) {
  for (const id of CAP_IDS) {
    if (p[id] != null) document.getElementById(id).value = p[id];
  }
}
