/**
 * Drawn Vg guide polylines → multi-point parameter fit.
 * Plate guides match Ip. Screen guides match Ig2.
 */

import { fitToTargets, getModel, peakOf, plateCurrent, plateFitKeys, targetCurrent } from '/lib/tube.js';

/**
 * @typedef {{ vg: number, points: { vp: number, ip: number }[] }} GuideCurve
 */

export function countGuidePoints(guides) {
  return (guides || []).reduce((n, g) => n + (g.points?.length || 0), 0);
}

function guidesToTargets(guides, eg2, kind) {
  const targets = [];
  for (const g of guides || []) {
    for (const pt of g.points || []) {
      targets.push({
        Eg: g.vg,
        Ep: Math.max(0, pt.vp),
        Eg2: eg2,
        ip: Math.max(0, pt.ip),
        kind,
      });
    }
  }
  return targets;
}

/** Samples of the plate family this fit started from, so a screen-only fit cannot walk Ip off. */
function plateHoldTargets(modelId, type, params, screenTargets) {
  const eg2 = screenTargets[0]?.Eg2 ?? 0;
  const hi = Math.max(1, ...screenTargets.map((t) => t.Ep));
  const egs = [...new Set(screenTargets.map((t) => t.Eg))];
  const rows = [];
  for (const eg of egs) {
    for (const f of [0.3, 0.6, 0.9]) {
      const ep = hi * f;
      rows.push({
        Eg: eg,
        Ep: ep,
        Eg2: eg2,
        ip: plateCurrent(modelId, type, eg, ep, eg2, params),
        kind: 'plate',
      });
    }
  }
  return rows;
}

function fitKeys(modelId, type, params, hasPlate, hasScreen) {
  const model = getModel(modelId);
  const screenKeys =
    typeof model.screenKeyList === 'function'
      ? model.screenKeyList(type, params)
      : model.screenKeys?.[type] || [];
  if (hasScreen && !hasPlate) return screenKeys;
  if (hasPlate && hasScreen) {
    return [...new Set([...plateFitKeys(model, type, params), ...screenKeys])];
  }
  return null;
}

function rms(modelId, type, params, targets) {
  if (!targets.length) return null;
  let err = 0;
  for (const t of targets) {
    const pred = targetCurrent(modelId, type, t, params);
    err += (pred - t.ip) ** 2;
  }
  return Math.sqrt(err / targets.length);
}

export function fitParamsToGuides(
  modelId,
  type,
  params,
  guides,
  eg2 = 0,
  screenGuides = [],
) {
  const plate = guidesToTargets(guides, eg2, 'plate');
  const screen = guidesToTargets(screenGuides, eg2, 'screen');
  if (plate.length + screen.length < 2) {
    return { params, meta: { ok: false, reason: 'need ≥2 points' } };
  }

  const plateScale = peakOf(plate);
  const screenScale = peakOf(screen);
  if (plate.length && screen.length) {
    const w = plateScale / screenScale;
    for (const t of screen) t.w = w;
  }

  let holds = [];
  if (!plate.length && screen.length) {
    holds = plateHoldTargets(modelId, type, params, screen);
    const holdW = 0.35 * (screenScale / peakOf(holds));
    for (const t of holds) t.w = holdW;
  }

  const keys = fitKeys(modelId, type, params, plate.length > 0, screen.length > 0);
  if (screen.length && !plate.length && !keys?.length) {
    return { params, meta: { ok: false, reason: 'this formula has no screen parameters' } };
  }

  const next = fitToTargets(modelId, type, params, [...plate, ...screen, ...holds], {
    iterations: 90,
    keys,
  });
  return {
    params: next,
    meta: {
      ok: true,
      points: plate.length + screen.length,
      plateRms: rms(modelId, type, next, plate),
      screenRms: rms(modelId, type, next, screen),
    },
  };
}

export function cloneGuides(guides) {
  return (guides || []).map((g) => ({
    vg: g.vg,
    points: g.points.map((p) => ({ ...p })),
  }));
}

export function addGuidePoint(guides, vg, vp, ip) {
  const list = cloneGuides(guides);
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
  const list = cloneGuides(guides);
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

export function removeGuidePoint(guides, gi, pi) {
  const list = cloneGuides(guides);
  const curve = list[gi];
  if (!curve || pi < 0 || pi >= curve.points.length) {
    return list.filter((g) => g.points.length > 0);
  }
  curve.points.splice(pi, 1);
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
        best = { gi, pi, ...p, vg: g.vg, d };
      }
    });
  });
  return best;
}

export function hitGuideLayers(plot, layers, x, y, radius = 12) {
  let best = null;
  for (const layer of layers) {
    const hit = hitGuidePoint(plot, layer.guides, x, y, radius);
    if (!hit) continue;
    if (!best || hit.d < best.d) best = { ...hit, layer: layer.id };
  }
  return best;
}
