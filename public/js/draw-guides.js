/**
 * Drawn Vg guide polylines → multi-point parameter fit.
 */

import { fitToTargets, plateCurrent } from '/lib/tube.js';

/**
 * @typedef {{ vg: number, points: { vp: number, ip: number }[] }} GuideCurve
 */

export function countGuidePoints(guides) {
  return (guides || []).reduce((n, g) => n + (g.points?.length || 0), 0);
}

export function guidesToTargets(guides, eg2 = 0) {
  const targets = [];
  for (const g of guides || []) {
    for (const pt of g.points || []) {
      targets.push({
        Eg: g.vg,
        Ep: Math.max(0, pt.vp),
        Eg2: eg2,
        ip: Math.max(0, pt.ip),
      });
    }
  }
  return targets;
}

export function fitParamsToGuides(modelId, type, params, guides, eg2 = 0, opts = {}) {
  const targets = guidesToTargets(guides, eg2);
  if (targets.length < 2) return { ...params, _fitMeta: { ok: false, reason: 'need ≥2 points' } };
  const next = fitToTargets(modelId, type, params, targets, {
    iterations: opts.iterations ?? 90,
    damping: opts.damping ?? 0.45,
  });
  let err = 0;
  for (const t of targets) {
    const ip = plateCurrent(modelId, type, t.Eg, t.Ep, t.Eg2, next);
    err += (ip - t.ip) ** 2;
  }
  return {
    ...next,
    _fitMeta: {
      ok: true,
      points: targets.length,
      rms: Math.sqrt(err / targets.length),
    },
  };
}

export function addGuidePoint(guides, vg, vp, ip) {
  const list = (guides || []).map((g) => ({
    vg: g.vg,
    points: g.points.map((p) => ({ ...p })),
  }));
  let curve = list.find((g) => Math.abs(g.vg - vg) < 1e-9);
  if (!curve) {
    curve = { vg, points: [] };
    list.push(curve);
  }
  curve.points.push({ vp, ip });
  curve.points.sort((a, b) => a.vp - b.vp);
  list.sort((a, b) => b.vg - a.vg);
  return list;
}

export function undoGuidePoint(guides, activeVg = null) {
  const list = (guides || []).map((g) => ({
    vg: g.vg,
    points: g.points.map((p) => ({ ...p })),
  }));
  if (!list.length) return list;

  let curve =
    activeVg != null
      ? list.find((g) => Math.abs(g.vg - activeVg) < 1e-9)
      : null;
  if (!curve || !curve.points.length) {
    curve = list[list.length - 1];
  }
  if (!curve?.points.length) return list.filter((g) => g.points.length > 0);
  curve.points.pop();
  return list.filter((g) => g.points.length > 0);
}

export function hitGuidePoint(plot, guides, x, y, radius = 10) {
  const r2 = radius * radius;
  let best = null;
  let bestD = r2;
  (guides || []).forEach((g, gi) => {
    g.points.forEach((pt, pi) => {
      const p = plot.dataToPx(pt.vp, pt.ip);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = { gi, pi, ...p, vg: g.vg };
      }
    });
  });
  return best;
}
