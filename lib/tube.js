import { getModel } from './models/registry.js';

export { softplus, parseVgList } from './models/math.js';
export {
  listModels,
  getModel,
  defaultParams,
  modelSupports,
  normalizeType,
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
  return typeof model.constrain === 'function' ? model.constrain(out) : out;
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

function parameterScales(model, keys, params) {
  return keys.map((k) => {
    const span = model.limits[k].max - model.limits[k].min;
    return Math.max(Math.abs(params[k]), span * 0.05, 1e-9);
  });
}

function sumSquaredError(modelId, type, params, rows) {
  let err = 0;
  for (const t of rows) {
    const ip = plateCurrent(modelId, type, t.Eg, t.Ep, t.Eg2 ?? 0, params);
    if (!Number.isFinite(ip)) return Infinity;
    const r = (t.w ?? 1) * (t.ip - ip);
    err += r * r;
  }
  return err;
}

/** Peak current across a full plate sweep, not only next to the guide points. */
function familyPeak(modelId, type, params, targets) {
  const eg2 = targets[0]?.Eg2 ?? 0;
  const eps = targets.map((t) => t.Ep).filter((v) => Number.isFinite(v));
  if (!eps.length) return { maxIp: 0, finite: true };
  const hi = Math.max(400, ...eps);
  const egs = new Set([0, -1, -2, -3, -4]);
  for (const t of targets) {
    if (!Number.isFinite(t.Eg)) continue;
    egs.add(t.Eg);
    egs.add(t.Eg - 2);
    egs.add(t.Eg + 1);
  }
  let maxIp = 0;
  for (const eg of egs) {
    for (const f of [0.15, 0.4, 0.7, 1]) {
      const ip = plateCurrent(modelId, type, eg, hi * f, eg2, params);
      if (!Number.isFinite(ip)) return { maxIp, finite: false };
      if (ip > maxIp) maxIp = ip;
    }
  }
  return { maxIp, finite: true };
}

/**
 * Soft anchors on the curve this fit started from. Real guide points stay
 * weight 1; these keep unguided Vg curves from flying onto an axis.
 */
function anchorRows(modelId, type, params, targets) {
  const eg2 = targets[0]?.Eg2 ?? 0;
  const hi = Math.max(400, ...targets.map((t) => (Number.isFinite(t.Ep) ? t.Ep : 0)));
  const egs = new Set([0, -1, -2, -3, -4]);
  for (const t of targets) {
    if (Number.isFinite(t.Eg)) egs.add(t.Eg);
  }
  const rows = [];
  for (const eg of egs) {
    for (const f of [0.25, 0.55, 0.9]) {
      const ep = hi * f;
      rows.push({
        Eg: eg,
        Ep: ep,
        Eg2: eg2,
        ip: plateCurrent(modelId, type, eg, ep, eg2, params),
        w: 0.03,
      });
    }
  }
  return rows;
}

/**
 * Fit params to many (Eg, Ep → Ip) targets.
 * Column-scaled Levenberg–Marquardt with a trust region. Steps that increase
 * the residual, or that pin the whole family to an axis, are rejected.
 * @param {{ Eg: number, Ep: number, Eg2?: number, ip: number, w?: number }[]} targets
 */
export function fitToTargets(modelId, type, params, targets, opts = {}) {
  const {
    iterations = 80,
    damping = 0.45,
    keys = null,
  } = opts;
  if (!targets?.length) return { ...params };

  const model = getModel(modelId);
  const active =
    keys ||
    model.inverseKeys?.[type] ||
    model.inverseKeys?.triode ||
    model.paramKeys;
  const fitKeys = active.filter((k) => params[k] != null && model.limits[k]);
  if (!fitKeys.length) return clampParams(modelId, { ...params });

  let p = clampParams(modelId, { ...params });
  const n = fitKeys.length;
  const scales = parameterScales(model, fitKeys, p);
  const rows = [...targets, ...anchorRows(modelId, type, p, targets)];
  const startPeak = familyPeak(modelId, type, p, targets);
  const maxTarget = Math.max(1e-9, ...targets.map((t) => (Number.isFinite(t.ip) ? t.ip : 0)));
  let lambda = 0.1;
  let err = sumSquaredError(modelId, type, p, rows);

  for (let iter = 0; iter < iterations; iter++) {
    if (err < 1e-18) break;

    const JTJ = Array.from({ length: n }, () => Array(n).fill(0));
    const JTr = Array(n).fill(0);

    for (const t of rows) {
      const eg2 = t.Eg2 ?? 0;
      const w = t.w ?? 1;
      const ip0 = plateCurrent(modelId, type, t.Eg, t.Ep, eg2, p);
      if (!Number.isFinite(ip0)) continue;
      const r = w * (t.ip - ip0);
      const J = [];
      for (let i = 0; i < n; i++) {
        const key = fitKeys[i];
        const lim = model.limits[key];
        const span = lim.max - lim.min;
        let h = Math.max(Math.abs(p[key]) * 1e-4, span * 1e-5, 1e-9);
        if (p[key] + h > lim.max) h = -h;
        const trial = clampParams(modelId, { ...p, [key]: p[key] + h });
        const ip1 = plateCurrent(modelId, type, t.Eg, t.Ep, eg2, trial);
        const slope = Number.isFinite(ip1) ? (ip1 - ip0) / h : 0;
        J.push(w * slope * scales[i]);
      }
      for (let i = 0; i < n; i++) {
        JTr[i] += J[i] * r;
        for (let j = 0; j < n; j++) JTJ[i][j] += J[i] * J[j];
      }
    }

    let accepted = false;
    let attemptLambda = lambda;
    for (let attempt = 0; attempt < 8; attempt++) {
      const A = JTJ.map((row) => row.slice());
      for (let i = 0; i < n; i++) {
        A[i][i] = A[i][i] * (1 + attemptLambda) + 1e-12;
      }
      const deltaScaled = solveLinear(A, JTr);
      if (!deltaScaled || deltaScaled.some((d) => !Number.isFinite(d))) {
        attemptLambda = Math.min(attemptLambda * 10, 1e8);
        continue;
      }

      const trial = { ...p };
      for (let i = 0; i < n; i++) {
        const cap = 0.45;
        const scaled = Math.max(-cap, Math.min(cap, deltaScaled[i]));
        trial[fitKeys[i]] = p[fitKeys[i]] + damping * scaled * scales[i];
      }
      const next = clampParams(modelId, trial);
      const err2 = sumSquaredError(modelId, type, next, rows);
      const peak = familyPeak(modelId, type, next, targets);
      const ceiling = Math.max(startPeak.maxIp, maxTarget, 1e-6) * 5;
      const collapsed =
        maxTarget > 1e-5 &&
        peak.maxIp < maxTarget * 1e-3 &&
        peak.maxIp < Math.max(startPeak.maxIp, maxTarget) * 0.05;
      if (!peak.finite || peak.maxIp > ceiling || collapsed || !(err2 < err)) {
        attemptLambda = Math.min(attemptLambda * 10, 1e8);
        continue;
      }

      p = next;
      err = err2;
      lambda = Math.max(attemptLambda / 3, 1e-4);
      accepted = true;
      break;
    }

    if (!accepted) break;
  }

  return p;
}

export function generateSubckt(opts) {
  const model = getModel(opts.modelId || 'koren');
  return model.generateSubckt(opts);
}
