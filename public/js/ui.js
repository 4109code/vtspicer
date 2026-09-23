/**
 * Parameter sliders driven by the active model definition.
 *
 * Range: log-mapped for wide-span params.
 * Number: live input/wheel; click-drag scrub — near=coarse, away=fine.
 */

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

export function createParamSliders(container, model, params, onChange) {
  container.innerHTML = '';
  const controls = {};
  const limits = model.limits;
  const logSet = new Set(model.logParams || []);
  const multiSet = new Set(model.multiGridParams || []);
  const enums = model.enumParams || {};

  function usesLog(key) {
    return logSet.has(key) && limits[key].min > 0;
  }

  function clamp(key, v) {
    const lim = limits[key];
    return Math.min(lim.max, Math.max(lim.min, v));
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
    const v = clamp(key, value);
    if (!usesLog(key)) {
      return ((v - lim.min) / (lim.max - lim.min)) * SLIDER_MAX;
    }
    const t =
      (Math.log(v) - Math.log(lim.min)) / (Math.log(lim.max) - Math.log(lim.min));
    return t * SLIDER_MAX;
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
      const nearGain = 1 / (1 + dist / 28);
      const speedBoost = 1 + Math.min(4, Math.abs(dx) / 6);
      let pixelsForSpan = usesLog(key) ? 280 : 220;
      if (e.shiftKey) pixelsForSpan *= 10;
      if (e.altKey) pixelsForSpan /= 10;

      let next;
      if (usesLog(key)) {
        const v = Math.max(Number(num.value) || lim.min, lim.min * 1.0001);
        const logSpan = Math.log(lim.max) - Math.log(lim.min);
        const dLog = (dx / pixelsForSpan) * logSpan * nearGain * speedBoost;
        next = Math.exp(Math.log(v) + dLog);
      } else {
        next = Number(num.value) + (dx / pixelsForSpan) * span * nearGain * speedBoost;
      }
      apply(clamp(key, next));
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
    lab.textContent = key;

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
        onChange(key, snapEnum(key, Number(sel.value)));
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
    range.value = valueToSlider(key, params[key] ?? lim.min);
    range.title = usesLog(key) ? 'Log scale' : 'Linear';

    const num = document.createElement('input');
    num.type = 'number';
    num.min = lim.min;
    num.max = lim.max;
    num.step = stepHint(key);
    num.value = formatValue(key, params[key] ?? lim.min, lim);
    num.title = 'Drag sideways: near=coarse, away=fine · Shift finer · Alt coarser';

    const apply = (v) => {
      const n = clamp(key, Number(v));
      if (!Number.isFinite(n)) return;
      range.value = valueToSlider(key, n);
      num.value = formatValue(key, n, lim);
      onChange(key, n);
    };

    range.addEventListener('input', () => apply(sliderToValue(key, range.value)));
    num.addEventListener('input', () => {
      if (num.value === '') return;
      const n = Number(num.value);
      if (!Number.isFinite(n)) return;
      range.value = valueToSlider(key, clamp(key, n));
      onChange(key, clamp(key, n));
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

  return {
    controls,
    model,
    setParams(p) {
      for (const key of model.paramKeys) {
        if (p[key] == null || !controls[key]) continue;
        if (controls[key].select) {
          controls[key].select.value = String(snapEnum(key, p[key]));
          continue;
        }
        const v = clamp(key, p[key]);
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

export const CAP_IDS = ['CCG', 'CGP', 'CCP', 'RGI'];

export function readCaps() {
  return Object.fromEntries(CAP_IDS.map((id) => [id, Number(document.getElementById(id).value)]));
}

export function writeCaps(p) {
  for (const id of CAP_IDS) {
    if (p[id] != null) document.getElementById(id).value = p[id];
  }
}
