import { getModel, plateFitKeys } from './models/registry.js';

export { parseVgList } from './models/math.js';
export {
  listModels,
  getModel,
  defaultParams,
  modelSupports,
  normalizeType,
  plateFitKeys,
} from './models/registry.js';

export function plateCurrent(modelId, type, Eg, Ep, Eg2, params) {
  return getModel(modelId).plateCurrent(type, Eg, Ep, Eg2, params);
}

export function screenCurrent(modelId, type, Eg, Ep, Eg2, params) {
  if (type === 'triode') return 0;
  return getModel(modelId).screenCurrent(type, Eg, Ep, Eg2, params);
}

export function clampParams(modelId, params) {
  const model = getModel(modelId);
  const lim = model.limits;
  const out = { ...params };
  for (const [key, range] of Object.entries(lim)) {
    if (out[key] == null || !Number.isFinite(out[key])) continue;
    out[key] = Math.min(range.max, Math.max(range.min, out[key]));
  }
  return out;
}

function sweepFamily(modelId, type, params, opts, currentFn) {
  const {
    vgList = [0, -1, -2],
    vpMin = 0,
    vpMax = 400,
    vpSteps = 80,
    eg2 = 300,
  } = opts;
  const dvs = (vpMax - vpMin) / Math.max(1, vpSteps - 1);
  const curves = [];
  for (const vg of vgList) {
    const points = [];
    for (let i = 0; i < vpSteps; i++) {
      const vp = vpMin + i * dvs;
      points.push({ vp, ip: currentFn(modelId, type, vg, vp, eg2, params) });
    }
    curves.push({ vg, points });
  }
  return curves;
}

export function curveFamily(modelId, type, params, opts) {
  return sweepFamily(modelId, type, params, opts, plateCurrent);
}

export function screenCurveFamily(modelId, type, params, opts) {
  if (type === 'triode') return [];
  return sweepFamily(modelId, type, params, opts, screenCurrent);
}

/** Solve A x = b (n×n) via Gaussian elimination with partial pivoting. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    if (piv !== col) {
      const tmp = M[col];
      M[col] = M[piv];
      M[piv] = tmp;
    }
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

export function targetCurrent(modelId, type, t, params) {
  const eg2 = t.Eg2 ?? 0;
  if (t.kind === 'screen') return screenCurrent(modelId, type, t.Eg, t.Ep, eg2, params);
  return plateCurrent(modelId, type, t.Eg, t.Ep, eg2, params);
}

function sumSquaredError(modelId, type, params, rows) {
  let err = 0;
  for (const t of rows) {
    const ip = targetCurrent(modelId, type, t, params);
    if (!Number.isFinite(ip)) return Infinity;
    const r = (t.w ?? 1) * (t.ip - ip);
    err += r * r;
  }
  return err;
}

/** Vg/Ep samples for the peak check. They depend only on the targets. */
function familyPeakSamples(targets) {
  const eg2 = targets[0]?.Eg2 ?? 0;
  const eps = targets.map((t) => t.Ep).filter((v) => Number.isFinite(v));
  if (!eps.length) return null;
  const hi = Math.max(400, ...eps);
  const egs = new Set([0, -1, -2, -3, -4]);
  for (const t of targets) {
    if (!Number.isFinite(t.Eg)) continue;
    egs.add(t.Eg);
    egs.add(t.Eg - 2);
    egs.add(t.Eg + 1);
  }
  const samples = [];
  for (const eg of egs) {
    for (const f of [0.15, 0.4, 0.7, 1]) samples.push([eg, hi * f, eg2]);
  }
  return samples;
}

/** Peak current across a full plate sweep, not only next to the guide points. */
function familyPeak(modelId, type, params, samples) {
  if (!samples) return { maxIp: 0, finite: true };
  let maxIp = 0;
  for (const [eg, ep, eg2] of samples) {
    const ip = plateCurrent(modelId, type, eg, ep, eg2, params);
    if (!Number.isFinite(ip)) return { maxIp, finite: false };
    if (ip > maxIp) maxIp = ip;
  }
  return { maxIp, finite: true };
}

function resolveFitKeys(model, type, params, keys) {
  const active = keys || plateFitKeys(model, type, params);
  return active.filter((k) => {
    if (!model.limits[k]) return false;
    if (params[k] != null && Number.isFinite(Number(params[k]))) return true;
    const fb = model.paramFallback?.[k];
    return fb != null && Number.isFinite(fb);
  });
}

function withFallbacks(model, params, keys) {
  const out = { ...params };
  for (const k of keys) {
    if (out[k] != null && Number.isFinite(Number(out[k]))) continue;
    const fb = model.paramFallback?.[k];
    if (fb != null) out[k] = fb;
  }
  return out;
}

function isLogKey(model, key, value) {
  return value > 0 && Array.isArray(model.logParams) && model.logParams.includes(key);
}

/** Step size in the coordinate the solver actually moves. Log keys move in ln. */
function parameterScales(model, keys, params) {
  return keys.map((k) => {
    if (isLogKey(model, k, params[k])) return 1;
    const span = model.limits[k].max - model.limits[k].min;
    return Math.max(Math.abs(params[k]), span * 0.05, 1e-9);
  });
}

function toCoord(model, key, value) {
  if (isLogKey(model, key, value)) return Math.log(value);
  return value;
}

function fromCoord(model, key, coord, current) {
  if (isLogKey(model, key, current)) return Math.exp(coord);
  return coord;
}

/**
 * Column-scaled Levenberg–Marquardt. Log-scaled formula parameters move in
 * ln so one fit can cross decades. `project` runs after the limit clamp.
 * `scaleOf(keys, params)` may replace the default step size per key.
 * Lambda damps flat directions. The solved step is applied in full, so the
 * fit reaches the guides in one call instead of creeping on the next drag
 */
function levenberg(modelId, type, params, rows, fitKeys, opts) {
  const {
    iterations = 80,
    project = null,
    scaleOf = null,
    peakSamples = null,
    startPeak = null,
    maxTarget = 1e-9,
  } = opts;
  if (!fitKeys.length) return { ...params };

  const model = getModel(modelId);
  let p = clampParams(modelId, params);
  if (project) p = clampParams(modelId, project(p));
  const n = fitKeys.length;
  let lambda = 1e-3;
  let err = sumSquaredError(modelId, type, p, rows);
  let stale = 0;
  const cap = 2;

  const probeAt = (base, key, coord) => {
    const value = fromCoord(model, key, coord, base[key]);
    return clampParams(modelId, { ...base, [key]: value });
  };

  for (let iter = 0; iter < iterations; iter++) {
    if (err < 1e-22) break;

    const custom = scaleOf ? scaleOf(fitKeys, p) : null;
    const scales = parameterScales(model, fitKeys, p).map((s, i) =>
      custom?.[i] > 0 ? custom[i] : s,
    );

    const JTJ = Array.from({ length: n }, () => Array(n).fill(0));
    const JTr = Array(n).fill(0);
    const probes = fitKeys.map((key, i) => {
      const lim = model.limits[key];
      const span = lim.max - lim.min;
      const x = toCoord(model, key, p[key]);
      const h = isLogKey(model, key, p[key])
        ? 1e-5
        : Math.max(Math.abs(p[key]) * 1e-6, span * 1e-6, 1e-9);
      const up = probeAt(p, key, x + h);
      const dn = probeAt(p, key, x - h);
      const upMoved = Math.abs(up[key] - p[key]) > 0;
      const dnMoved = Math.abs(dn[key] - p[key]) > 0;
      return { key, h, up, dn, upMoved, dnMoved, scale: scales[i], x };
    });

    for (const t of rows) {
      const w = t.w ?? 1;
      const ip0 = targetCurrent(modelId, type, t, p);
      if (!Number.isFinite(ip0)) continue;
      const r = w * (t.ip - ip0);
      const J = probes.map(({ h, up, dn, upMoved, dnMoved, scale }) => {
        const ipUp = upMoved ? targetCurrent(modelId, type, t, up) : ip0;
        const ipDn = dnMoved ? targetCurrent(modelId, type, t, dn) : ip0;
        let slope = 0;
        if (upMoved && dnMoved && Number.isFinite(ipUp) && Number.isFinite(ipDn)) {
          slope = (ipUp - ipDn) / (2 * h);
        } else if (upMoved && Number.isFinite(ipUp)) {
          slope = (ipUp - ip0) / h;
        } else if (dnMoved && Number.isFinite(ipDn)) {
          slope = (ip0 - ipDn) / h;
        }
        return w * slope * scale;
      });
      for (let i = 0; i < n; i++) {
        JTr[i] += J[i] * r;
        for (let j = 0; j < n; j++) JTJ[i][j] += J[i] * J[j];
      }
    }

    let accepted = false;
    let attemptLambda = lambda;
    for (let attempt = 0; attempt < 14; attempt++) {
      const A = JTJ.map((row) => row.slice());
      for (let i = 0; i < n; i++) {
        const diag = A[i][i];
        A[i][i] = diag + attemptLambda * (diag + 1);
      }
      const deltaScaled = solveLinear(A, JTr);
      if (!deltaScaled || deltaScaled.some((d) => !Number.isFinite(d))) {
        attemptLambda = Math.min(attemptLambda * 10, 1e12);
        continue;
      }
      const biggest = deltaScaled.reduce((m, d) => Math.max(m, Math.abs(d)), 0);
      if (biggest > cap) {
        attemptLambda = Math.min(attemptLambda * 10, 1e12);
        continue;
      }
      if (!(biggest > 1e-16)) break;

      const trial = { ...p };
      for (let i = 0; i < n; i++) {
        const key = fitKeys[i];
        const coord = probes[i].x + deltaScaled[i] * probes[i].scale;
        trial[key] = fromCoord(model, key, coord, p[key]);
      }
      let next = clampParams(modelId, trial);
      if (project) next = clampParams(modelId, project(next));
      const err2 = sumSquaredError(modelId, type, next, rows);
      if (!(err2 < err * (1 - 1e-16))) {
        attemptLambda = Math.min(attemptLambda * 10, 1e12);
        continue;
      }
      const peak = familyPeak(modelId, type, next, peakSamples);
      const ceiling = Math.max(startPeak.maxIp, maxTarget, 1e-6) * 5;
      const collapsed =
        maxTarget > 1e-5 &&
        peak.maxIp < maxTarget * 1e-3 &&
        peak.maxIp < Math.max(startPeak.maxIp, maxTarget) * 0.05;
      if (!peak.finite || peak.maxIp > ceiling || collapsed) {
        attemptLambda = Math.min(attemptLambda * 10, 1e12);
        continue;
      }

      const gained = (err - err2) / Math.max(err, 1e-30);
      p = next;
      err = err2;
      lambda = Math.max(attemptLambda / 4, 1e-10);
      accepted = true;
      stale = gained < 1e-14 ? stale + 1 : 0;
      break;
    }

    if (!accepted || stale >= 2) break;
  }

  return p;
}

/** Keep solving from the last point until another pass no longer moves the residual */
function solveToConvergence(modelId, type, params, rows, fitKeys, opts) {
  let p = levenberg(modelId, type, params, rows, fitKeys, opts);
  for (let pass = 0; pass < 6; pass++) {
    const err = sumSquaredError(modelId, type, p, rows);
    const next = levenberg(modelId, type, p, rows, fitKeys, opts);
    const err2 = sumSquaredError(modelId, type, next, rows);
    if (!(err2 < err * (1 - 1e-12))) return p;
    p = next;
  }
  return p;
}

function dipSlotKeys(model, fitKeys, params) {
  if (typeof model.dipSlot !== 'function') return [];
  const slots = new Set();
  for (const k of fitKeys) {
    const slot = model.dipSlot(k);
    if (slot > 0 && (params[`DD${slot}`] ?? 0) > 1e-4) slots.add(slot);
  }
  return fitKeys.filter((k) => {
    const slot = model.dipSlot(k);
    if (slot < 0) return slots.size > 0;
    return slots.has(slot);
  });
}

/**
 * Fit dips on the guide residual first, then the smooth law with those dips held.
 * Dip centers stay inside the guide voltage span.
 */
function fitWithDips(modelId, type, params, targets, fitKeys, opts) {
  const { iterations = 80, damping = 0.45 } = opts;
  const model = getModel(modelId);
  const rows = targets;
  const peakSamples = familyPeakSamples(targets);
  const startPeak = familyPeak(modelId, type, params, peakSamples);
  const maxTarget = Math.max(1e-9, ...targets.map((t) => (Number.isFinite(t.ip) ? t.ip : 0)));
  const smoothKeys = fitKeys.filter((k) => !(model.dipSlot(k) > 0));
  const project = (p) => model.clampDipFit(p, targets);
  const scaleOf = (keys) => model.dipStepScales(keys, targets);
  const shared = { damping, peakSamples, startPeak, maxTarget };

  const runDip = (start, dipIters) => {
    const keys = dipSlotKeys(model, fitKeys, start);
    if (!keys.length) return start;
    return solveToConvergence(modelId, type, start, rows, keys, {
      ...shared,
      iterations: dipIters,
      project,
      scaleOf,
    });
  };

  let placed = params;
  if (typeof model.placeDips === 'function') {
    const seeded = clampParams(modelId, model.placeDips(type, params, targets));
    const fromSeed = runDip(seeded, 36);
    const fromHere = runDip(params, 36);
    const errSeed = sumSquaredError(modelId, type, fromSeed, rows);
    const errHere = sumSquaredError(modelId, type, fromHere, rows);
    placed = errSeed < errHere ? fromSeed : fromHere;
  } else {
    placed = runDip(params, 36);
  }

  let p = solveToConvergence(modelId, type, placed, rows, smoothKeys, {
    ...shared,
    iterations,
  });
  p = runDip(p, 24);
  p = solveToConvergence(modelId, type, p, rows, smoothKeys, {
    ...shared,
    iterations: Math.min(30, iterations),
  });
  return p;
}

/**
 * Fit params to many (Eg, Ep → Ip) targets.
 * Column-scaled Levenberg–Marquardt with a trust region. Steps that increase
 * the residual, or that pin the whole family to an axis, are rejected.
 * Screen targets (`kind: 'screen'`) match screenCurrent. Plate targets match plateCurrent.
 * @param {{ Eg: number, Ep: number, Eg2?: number, ip: number, w?: number, kind?: 'plate'|'screen' }[]} targets
 */
export function fitToTargets(modelId, type, params, targets, opts = {}) {
  const {
    iterations = 80,
    damping = 0.45,
    keys = null,
  } = opts;
  if (!targets?.length) return { ...params };

  const model = getModel(modelId);
  const seeded = withFallbacks(model, params, keys || plateFitKeys(model, type, params));
  const fitKeys = resolveFitKeys(model, type, seeded, keys);
  if (!fitKeys.length) return clampParams(modelId, { ...seeded });

  const hasDips = fitKeys.some((k) => model.dipSlot?.(k) > 0);
  if (hasDips && typeof model.clampDipFit === 'function') {
    return fitWithDips(modelId, type, seeded, targets, fitKeys, { iterations, damping });
  }

  const rows = targets;
  if (model.enumParams?.KNEE && !fitKeys.includes('KNEE')) {
    let best = null;
    let bestErr = Infinity;
    for (const knee of [0, 1]) {
      const start = clampParams(modelId, { ...seeded, KNEE: knee });
      const peakSamples = familyPeakSamples(targets);
      const next = solveToConvergence(modelId, type, start, rows, fitKeys, {
        iterations,
        damping,
        peakSamples,
        startPeak: familyPeak(modelId, type, start, peakSamples),
        maxTarget: Math.max(1e-9, ...targets.map((t) => (Number.isFinite(t.ip) ? t.ip : 0))),
      });
      const err = sumSquaredError(modelId, type, next, rows);
      if (err < bestErr) {
        best = next;
        bestErr = err;
      }
    }
    return best;
  }

  const peakSamples = familyPeakSamples(targets);
  return solveToConvergence(modelId, type, seeded, rows, fitKeys, {
    iterations,
    damping,
    peakSamples,
    startPeak: familyPeak(modelId, type, seeded, peakSamples),
    maxTarget: Math.max(1e-9, ...targets.map((t) => (Number.isFinite(t.ip) ? t.ip : 0))),
  });
}

export function generateSubckt(opts) {
  const model = getModel(opts.modelId || 'koren');
  return model.generateSubckt(opts);
}

export { parseSpiceImport } from './spice-import.js';
