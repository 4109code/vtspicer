import {
  parseVgList,
  plateCurrent,
  screenCurrent,
  clampParams,
  getModel,
  defaultParams,
  modelSupports,
  listModels,
  generateSubckt,
  normalizeType,
  parseSpiceImport,
} from '/lib/tube.js';
import { Plot, formatMa } from './plot.js';
import { Calibrator } from './calibrate.js';
import {
  addGuidePoint,
  undoGuidePoint,
  fitParamsToGuides,
  countGuidePoints,
  hitGuideLayers,
  cloneGuides,
} from './draw-guides.js';
import { createParamSliders, readCaps, writeCaps, CAP_IDS } from './ui.js';
import {
  analyzeLoadLine,
  dissipationCurrent,
  screenVoltage,
  swingLevels,
  loadLineCurrent,
  swingSamples,
  VG_SEARCH_HI,
  VG_SEARCH_LO,
  vgAtCurrent,
  smallSignal,
  optimizeLoadLine,
} from '/lib/loadline.js';
import { CHILD_DEFAULTS, CHILD_KEYS, childLawIg, gridCurrent } from '/lib/models/math.js';

const STORAGE_KEY = 'koren-tube-modeler-v2';

const TYPE_ORDER = ['triode', 'pentode', 'diode'];
const TYPE_LABELS = {
  triode: 'Triode',
  pentode: 'Pentode',
  diode: 'Diode',
};

function modelOptionValue(type, modelId) {
  return `${type}:${modelId}`;
}

function parseModelOption(value) {
  const split = value.indexOf(':');
  return { type: value.slice(0, split), modelId: value.slice(split + 1) };
}

const state = {
  modelId: 'koren',
  type: 'triode',
  name: '12AX7',
  params: defaultParams('koren', 'triode'),
  guides: [],
  screenGuides: [],
  presets: [],
};

const canvas = document.getElementById('plot');
const plot = new Plot(canvas);
const calibrator = new Calibrator(plot, {
  statusEl: document.getElementById('calibStatus'),
  onChange: syncCalibUi,
});

let sliderApi = null;
let rafPending = false;
let paintOnly = false;
let persistTimer = 0;
let drag = null;
let skipDrawClick = false;
let loadPlaced = false;

function $(id) {
  return document.getElementById(id);
}

function setNotice(el, text, { error = false } = {}) {
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('error', error);
}

function hideNotice(el) {
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
  el.classList.remove('error');
}

function activeModel() {
  return getModel(state.modelId);
}

function syncCalibUi(cal) {
  const btn = $('btnCalibrate');
  btn.textContent = cal.active ? 'Cancel calibration' : 'Calibrate axes';
  btn.classList.toggle('primary', !cal.active);
  btn.classList.toggle('danger', cal.active);
}

/** Plate-axis defaults for a fresh tube of the selected formula. */
function defaultIpMaxMa(type) {
  return normalizeType(type) === 'pentode' ? 100 : 10;
}

/** UI stores Ip max in mA; plot/math use amperes. */
function readIpMaxA() {
  const ma = Number($('ipMax').value);
  return Number.isFinite(ma) && ma > 0 ? ma / 1000 : defaultIpMaxMa(state.type) / 1000;
}

function applyAxisDefaults({ keepMax = false } = {}) {
  if (!keepMax) {
    $('vpMax').value = 400;
    setIpMaxMa(defaultIpMaxMa(state.type));
  }
  centerLoadLine();
}

function applyFormulaAxes() {
  applyAxisDefaults({ keepMax: Boolean(plot.image) && plot.isCalibrated() });
}

/** Turn saved {vp, ip} points into axis fractions using the scale they were stored against. */
function migrateGuides(guides, vpMax, ipMax) {
  return (guides || []).map((g) => ({
    vg: g.vg,
    points: (g.points || []).map((p) => {
      if (Number.isFinite(p.u) && Number.isFinite(p.v)) return { u: p.u, v: p.v };
      return {
        u: vpMax > 0 ? p.vp / vpMax : 0,
        v: ipMax > 0 ? p.ip / ipMax : 0,
      };
    }),
  }));
}

function setIpMaxMa(ampsOrMa, { fromAmps = false } = {}) {
  const n = Number(ampsOrMa);
  if (!Number.isFinite(n)) return;
  $('ipMax').value = fromAmps ? formatMa(n) : n;
}

function guidesFor(layer) {
  return layer === 'screen' ? state.screenGuides : state.guides;
}

function assignGuides(layer, guides) {
  if (layer === 'screen') state.screenGuides = guides;
  else state.guides = guides;
}

function isMultiGrid() {
  return state.type === 'pentode';
}

function queueFrame() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const paint = paintOnly;
    paintOnly = false;
    if (paint) {
      plot.guides = state.guides;
      plot.screenGuides = state.screenGuides;
      plot.draw();
    } else {
      redraw();
    }
  });
}

function scheduleRedraw() {
  paintOnly = false;
  queueFrame();
}

function schedulePaint() {
  if (rafPending && !paintOnly) return;
  if (!rafPending) paintOnly = true;
  queueFrame();
}

function readLoadUi() {
  const num = (id, fallback) => {
    const n = Number($(id).value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    show: $('showLoadLine').checked,
    rp: Math.max(1, num('loadRp', 100000)),
    vp: num('loadVp', 250),
    vg: num('loadVg', -2),
    vin: Math.max(0, num('loadVin', 1)),
    pmax: Math.max(0, num('loadPmax', 1)),
    thdMax: Math.max(0, num('loadThd', 1)),
    vcMax: Math.max(0, num('loadVc', 400)),
    showPmax: $('showPmax').checked,
    showIg: $('showIg').checked,
    gridLaw: $('igMode').value === 'child' ? 'child' : 'diode',
    showSum: $('showSum').checked,
    ulOn: $('ulOn').checked,
    ul: Math.min(1, Math.max(0, num('ulTap', 0.43))),
  };
}

function plateAt(vg, vp, screen) {
  return plateCurrent(state.modelId, state.type, vg, vp, screen, state.params);
}

function screenAt(vg, vp, screen) {
  return screenCurrent(state.modelId, state.type, vg, vp, screen, state.params);
}

function addFamilies(plate, screen) {
  return plate.map((curve, i) => ({
    vg: curve.vg,
    points: curve.points.map((p, j) => ({
      vp: p.vp,
      ip: p.ip + screen[i].points[j].ip,
    })),
  }));
}

/** Line through the middle of the plot, with the quiescent point on a curve that conducts. */
function centerLoadLine() {
  const vpMax = Number($('vpMax').value) || 400;
  const ipMax = readIpMaxA();
  if (!(vpMax > 0) || !(ipMax > 0)) return;
  const midVp = vpMax / 2;
  const midIp = ipMax / 2;
  if (state.type === 'diode') {
    $('loadVg').value = '0';
    $('loadVin').value = '0';
    $('loadVp').value = String(Math.round(midVp));
    $('loadRp').value = String(Math.max(1, Math.round(vpMax / ipMax)));
    return;
  }
  const eg2 = Number($('eg2').value) || 300;
  const listed = parseVgList($('vgList').value);
  const vg = listed.length ? Math.max(...listed) : 0;
  $('loadVg').value = String(vg);
  const screenOf = (vp) => eg2For(vp, eg2, readLoadUi());
  const atMid = plateAt(vg, midVp, screenOf(midVp));
  let vp = midVp;
  let ip = atMid;
  let rp = vpMax / ipMax;
  if (atMid < midIp * 0.8) {
    vp = vpMax * 0.72;
    ip = plateAt(vg, vp, screenOf(vp));
    const den = midIp - ip;
    rp = Math.abs(den) > midIp * 0.05 ? (vp - midVp) / den : rp;
  } else if (atMid > midIp * 1.2) {
    const solved = vgAtCurrent(plateAt, midVp, midIp, screenOf(midVp));
    if (solved != null) $('loadVg').value = solved.toFixed(2);
    ip = midIp;
  }
  $('loadVp').value = String(Math.round(vp));
  $('loadRp').value = String(Math.max(1, Math.round(Math.abs(rp))));
  $('loadVin').value = visibleVin(vp, ip, eg2).toFixed(2);
}

function applyBestLoadLine() {
  if (state.type === 'diode') return;
  const load = readLoadUi();
  const eg2 = Number($('eg2').value) || 300;
  const vpMax = Number($('vpMax').value) || 400;
  const hint = $('loadOptHint');
  setNotice(hint, 'Searching�');
  const best = optimizeLoadLine({
    ipAt: plateAt,
    ig2At: isMultiGrid() ? screenAt : null,
    eg2,
    ul: isMultiGrid() && load.ulOn ? load.ul : 0,
    pmax: load.pmax,
    thdMax: load.thdMax,
    vcMax: load.vcMax,
    vpHi: vpMax,
  });
  if (!best) {
    setNotice(hint, 'No point under Pmax, THD, and Vc. Raise one of those limits', { error: true });
    return;
  }
  $('showLoadLine').checked = true;
  $('loadRp').value = String(Math.max(1, Math.round(best.rp)));
  $('loadVp').value = best.vp.toFixed(1);
  $('loadVg').value = best.vg.toFixed(2);
  $('loadVin').value = best.vin.toFixed(2);
  loadPlaced = true;
  setNotice(hint, 'Most output power at or below THD. Plate heat stays within Pmax. Supply stays at or below Vc');
  scheduleRedraw();
  persist();
}

function visibleVin(vp, ip, eg2) {
  const load = readLoadUi();
  const vpMax = Number($('vpMax').value) || 400;
  let chosen = 2;
  for (const vin of [1, 2, 5, 8, 12]) {
    const samples = swingSamples(plateAt, {
      vg: load.vg,
      vin,
      vq: vp,
      iq: ip,
      rp: load.rp,
      eg2,
      ul: isMultiGrid() && load.ulOn ? load.ul : 0,
      vpLo: 0,
      vpHi: Math.max(vpMax * 2, 1),
    });
    const a = samples[0];
    const b = samples[6];
    if (a?.vp == null || b?.vp == null) continue;
    chosen = vin;
    if (Math.abs(b.vp - a.vp) >= vpMax * 0.15) return vin;
  }
  return chosen;
}

function loadPointOnPlot() {
  const vpMax = Number($('vpMax').value) || 400;
  const ipMax = readIpMaxA();
  const load = readLoadUi();
  if (!(load.vp > vpMax * 0.04 && load.vp < vpMax * 0.96)) return false;
  const eg2 = Number($('eg2').value) || 300;
  const ip = plateAt(state.type === 'diode' ? 0 : load.vg, load.vp, eg2For(load.vp, eg2, load));
  return ip > ipMax * 0.04 && ip < ipMax * 0.96;
}

function placeLoadCenter(vp, ip) {
  $('loadVp').value = vp.toFixed(1);
  if (state.type === 'diode') return;
  const eg2 = Number($('eg2').value) || 300;
  const screen = eg2For(vp, eg2, readLoadUi());
  let target = Math.max(0, ip);
  let vg = vgAtCurrent(plateAt, vp, target, screen);
  if (vg == null) {
    const lo = plateAt(VG_SEARCH_LO, vp, screen);
    const hi = plateAt(VG_SEARCH_HI, vp, screen);
    target = Math.min(Math.max(target, Math.min(lo, hi)), Math.max(lo, hi));
    vg = vgAtCurrent(plateAt, vp, target, screen);
  }
  if (vg != null) $('loadVg').value = vg.toFixed(2);
}

function vinFromPoint(vp, ip) {
  const load = readLoadUi();
  const eg2 = Number($('eg2').value) || 300;
  const screen = eg2For(vp, eg2, load);
  const vg = vgAtCurrent(plateAt, vp, Math.max(0, ip), screen);
  if (vg == null) return null;
  return Math.abs(vg - load.vg);
}

/** Pivot the line around the quiescent point so it passes through this plate point. */
function tiltLoadLine(vp, ip) {
  const load = readLoadUi();
  const eg2 = Number($('eg2').value) || 300;
  const iq = plateAt(state.type === 'diode' ? 0 : load.vg, load.vp, eg2For(load.vp, eg2, load));
  const den = ip - iq;
  const num = load.vp - vp;
  if (Math.abs(num) < 1 || Math.abs(den) < 1e-7) return;
  const rp = num / den;
  if (!(rp > 50)) return;
  $('loadRp').value = String(Math.round(rp));
}

/** Keep a swing end on the visible load line when the curve meeting is off the plot. */
function swingMarker(sample, side, load, iq, vpMax, ipMax) {
  const onPlot =
    sample &&
    sample.vp != null &&
    sample.ip != null &&
    sample.vp >= 0 &&
    sample.vp <= vpMax &&
    sample.ip >= 0 &&
    sample.ip <= ipMax;
  if (onPlot) return { vp: sample.vp, ip: sample.ip };
  const rp = load.rp;
  const vq = load.vp;
  if (!(rp > 0) || !Number.isFinite(iq)) return null;
  if (side === 'high') {
    const vpTop = vq - rp * (ipMax - iq);
    if (vpTop >= 0 && vpTop <= vpMax) return { vp: vpTop, ip: ipMax };
    return { vp: 0, ip: Math.min(ipMax, Math.max(0, loadLineCurrent(0, vq, iq, rp))) };
  }
  const ipRight = loadLineCurrent(vpMax, vq, iq, rp);
  if (ipRight >= 0 && ipRight <= ipMax) return { vp: vpMax, ip: ipRight };
  const vc = vq + rp * iq;
  return { vp: Math.min(vpMax, Math.max(0, vc)), ip: 0 };
}

function hitLoadHandle(local) {
  if (!$('showLoadLine').checked) return null;
  const reach = 16 * 16;
  let best = null;
  let bestD = reach;
  const consider = (kind, pt) => {
    if (!pt || pt.vp == null || pt.ip == null) return;
    const p = plot.dataToPx(pt.vp, pt.ip);
    const d = (p.x - local.x) ** 2 + (p.y - local.y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = kind;
    }
  };
  if (state.type !== 'diode') {
    for (const pt of plot.swingPoints || []) consider('vin', pt);
  }
  if (plot.qPoint) {
    const p = plot.loadCenterPx();
    if (p) {
      const d = (p.x - local.x) ** 2 + (p.y - local.y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = 'center';
      }
    }
  }
  return best;
}

function eg2For(vp, eg2, load) {
  if (!isMultiGrid() || !load.ulOn) return eg2;
  return screenVoltage(vp, eg2, load.ul, load.vp);
}

function sweepCurves(vgList, vpMax, vpSteps, eg2, load, currentFn) {
  const steps = Math.max(2, vpSteps);
  const curves = [];
  for (const vg of vgList) {
    const points = [];
    for (let i = 0; i < steps; i++) {
      const vp = (vpMax * i) / (steps - 1);
      points.push({ vp, ip: currentFn(vg, vp, eg2For(vp, eg2, load)) });
    }
    curves.push({ vg, points });
  }
  return curves;
}

let curveKey = '';
let loadKey = '';
let spiceKey = '';
let lastOp = null;

function redraw() {
  const diode = state.type === 'diode';
  const vgList = diode ? [0] : parseVgList($('vgList').value);
  const load = readLoadUi();
  if (state.modelId === 'koren') state.params.gridLaw = load.gridLaw;
  else delete state.params.gridLaw;

  plot.calib.vpMax = Number($('vpMax').value) || 400;
  plot.calib.ipMax = readIpMaxA();
  plot.imageOpacity = Number($('imageOpacity').value) / 100;

  const eg2 = Number($('eg2').value) || 300;
  const vpSteps = Number($('vpSteps').value) || 120;
  const vpMax = plot.calib.vpMax;
  const ulTap = isMultiGrid() && load.ulOn ? [load.ul, load.vp] : null;
  const nextCurveKey = JSON.stringify([
    state.modelId, state.type, state.params, vgList, vpMax, vpSteps, eg2, ulTap,
    isMultiGrid() && $('showScreenCurves').checked, isMultiGrid() && load.showSum,
    !diode && load.showIg, load.gridLaw, load.showPmax, load.pmax,
  ]);
  if (nextCurveKey !== curveKey) {
    const showScreen = isMultiGrid() && $('showScreenCurves').checked;
    const showSum = isMultiGrid() && load.showSum;
    const plate = sweepCurves(vgList, vpMax, vpSteps, eg2, load, plateAt);
    const screen = showScreen || showSum
      ? sweepCurves(vgList, vpMax, vpSteps, eg2, load, screenAt)
      : [];
    plot.curves = plate;
    plot.showScreenCurves = showScreen;
    plot.screenCurves = showScreen ? screen : [];
    plot.sumCurves = showSum ? addFamilies(plate, screen) : [];
    plot.igCurves = !diode && load.showIg
      ? sweepCurves(vgList, vpMax, vpSteps, eg2, load, (vg, vp) => {
        if (state.modelId === 'koren' && load.gridLaw === 'child') {
          return childLawIg(vg, vp, state.params);
        }
        return gridCurrent(vg, state.params.RGI ?? 2000);
      })
      : [];
    plot.dissip = load.showPmax
      ? Array.from({ length: 80 }, (_, i) => {
        const vp = (vpMax * (i + 1)) / 80;
        return { vp, ip: dissipationCurrent(vp, load.pmax) };
      })
      : null;
    curveKey = nextCurveKey;
  }

  const nextLoadKey = JSON.stringify([
    state.modelId, state.type, state.params, diode, load, eg2, vpMax,
  ]);
  let op = lastOp;
  if (nextLoadKey !== loadKey || !op) {
    op = analyzeLoadLine({
      ipAt: plateAt,
      ig2At: isMultiGrid() ? screenAt : null,
      vg: diode ? 0 : load.vg,
      vp: load.vp,
      rp: load.rp,
      vin: diode ? 0 : load.vin,
      eg2,
      ul: isMultiGrid() && load.ulOn ? load.ul : 0,
      hasGrid: !diode,
      ccgPf: state.params.CCG,
      cgpPf: state.params.CGP,
      vpHi: Math.max(vpMax * 5, load.vp * 4, 2000),
    });
    lastOp = op;
    loadKey = nextLoadKey;
    updateLoadResults(op, load, diode);
    drawHarmonics(op.sweep);
  }
  plot.loadLine = load.show && op.vc > 0
    ? [
      { vp: 0, ip: op.vc / load.rp },
      { vp: op.vc, ip: 0 },
    ]
    : null;
  plot.qPoint = load.show ? { vp: load.vp, ip: op.ip } : null;
  const ipMax = plot.calib.ipMax;
  const ends = load.show && !diode && load.vin > 0 ? [op.samples?.[0], op.samples?.[6]] : [];
  plot.swingPoints = ends
    .map((pt, i) => swingMarker(pt, i === 0 ? 'low' : 'high', load, op.ip, vpMax, ipMax))
    .filter((pt) => pt && pt.vp != null && pt.ip != null);
  plot.guides = state.guides;
  plot.screenGuides = state.screenGuides;
  plot.draw();
  const nextSpiceKey = JSON.stringify([state.modelId, state.name, state.type, state.params, readCaps(), readPins()]);
  if (nextSpiceKey !== spiceKey) {
    updateSpice();
    spiceKey = nextSpiceKey;
  }
  updateDrawStatus();
}

function fmtOhm(r) {
  if (r == null || !Number.isFinite(r)) return '—';
  const a = Math.abs(r);
  if (a >= 1e6) return `${(r / 1e6).toFixed(2)} MΩ`;
  if (a >= 1e3) return `${(r / 1e3).toFixed(2)} kΩ`;
  return `${r.toFixed(0)} Ω`;
}

function fmtFix(n, digits, suffix = '') {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}${suffix}`;
}

function loadMetric(key, value, hint) {
  const row = document.createElement('div');
  row.className = 'load-metric';
  const name = document.createElement('span');
  name.className = 'param-key';
  name.textContent = key;
  const val = document.createElement('span');
  val.className = 'load-value';
  val.textContent = value;
  const note = document.createElement('span');
  note.className = 'param-hint';
  note.textContent = hint;
  row.append(name, val, note);
  return row;
}

function updateLoadResults(op, load, diode) {
  const box = $('loadResults');
  const levels = swingLevels(diode ? 0 : load.vin, op.vpp, op.ipp);
  const rows = [
    loadMetric(
      'Point',
      diode
        ? `${fmtFix(load.vp, 1, ' V')}, ${fmtFix(op.ip * 1000, 2, ' mA')}`
        : `${fmtFix(load.vp, 1, ' V')}, ${fmtFix(op.ip * 1000, 2, ' mA')}, Vg ${fmtFix(load.vg, 2, ' V')}`,
      'Quiescent point on the load line',
    ),
  ];
  if (!diode) {
    rows.push(loadMetric('Vc', fmtFix(op.vc, 1, ' V'), 'Supply the load line implies'));
    if (op.rk != null) rows.push(loadMetric('Rk', fmtOhm(op.rk), 'Cathode resistor for this Vg and Ip'));
    rows.push(loadMetric('Pdiss', fmtFix(op.plateDissipation, 2, ' W'), 'Plate heat. Vp times Ip'));
  }
  if (isMultiGrid()) {
    rows.push(loadMetric('Ig2', fmtFix(op.ig2 * 1000, 2, ' mA'), 'Screen current at this point'));
    rows.push(loadMetric('Pg2', fmtFix(op.screenDissipation, 2, ' W'), 'Screen heat. Vg2 times Ig2'));
  }
  if (diode) {
    rows.push(loadMetric('Ra', fmtOhm(op.ra), 'Plate resistance. How Ip moves with Vp'));
    rows.push(loadMetric('Zout', fmtOhm(op.zout), 'Rp in parallel with ra'));
  } else {
    rows.push(loadMetric('Gm', fmtFix(op.gm == null ? null : op.gm * 1000, 2, ' mA/V'), 'How Ip moves with Vg'));
    rows.push(loadMetric('Ra', fmtOhm(op.ra), 'Plate resistance. How Ip moves with Vp'));
    rows.push(loadMetric('Mu', fmtFix(op.mu, 1), 'Gain. Gm times ra'));
    rows.push(loadMetric('Zout', fmtOhm(op.zout), 'Rp in parallel with ra'));
    rows.push(loadMetric('Zin', fmtOhm(op.zin), 'Grid impedance at 10 kHz'));
    rows.push(loadMetric('Vin rms', fmtFix(levels.vinRms, 2, ' V'), 'Peak grid swing over ?2'));
    rows.push(loadMetric('Vout pp', fmtFix(levels.voutPp, 1, ' V'), 'Plate voltage from one swing end to the other'));
    rows.push(loadMetric('Vout rms', fmtFix(levels.voutRms, 2, ' V'), 'Sine equivalent of that plate swing'));
    rows.push(loadMetric('Iout rms', fmtFix(levels.ioutRms * 1000, 2, ' mA'), 'Sine equivalent of the plate-current swing'));
    rows.push(loadMetric('Pout', fmtFix(op.pout, 3, ' W'), 'Vout rms times Iout rms'));
    rows.push(loadMetric('THD', fmtFix(op.thd, 2, '%'), 'H2 through H5, combined'));
    rows.push(loadMetric('H2', fmtFix(op.h2, 2, '%'), 'Second harmonic'));
    rows.push(loadMetric('H3', fmtFix(op.h3, 2, '%'), 'Third harmonic'));
    rows.push(loadMetric('H4', fmtFix(op.h4, 2, '%'), 'Fourth harmonic'));
    rows.push(loadMetric('H5', fmtFix(op.h5, 2, '%'), 'Fifth harmonic'));
  }
  box.replaceChildren(...rows);
  $('harmHint').style.display = diode ? 'none' : '';
}

function drawHarmonics(sweep) {
  const canvas = $('harmPlot');
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!sweep?.length || state.type === 'diode') return;
  const series = [
    { key: 'h2', color: '#d97757' },
    { key: 'h3', color: '#7c3aed' },
    { key: 'h4', color: '#0f766e' },
    { key: 'h5', color: '#1d4ed8' },
  ];
  let max = 1;
  for (const row of sweep) {
    for (const s of series) max = Math.max(max, row[s.key] || 0);
  }
  const pad = 8;
  ctx.font = '10px sans-serif';
  series.forEach((s, n) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    sweep.forEach((row, i) => {
      const x = pad + (i / (sweep.length - 1)) * (w - pad * 2);
      const y = h - pad - ((row[s.key] || 0) / max) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = s.color;
    ctx.fillText(s.key.toUpperCase(), 4 + n * 28, 12);
  });
}

const PIN_INPUTS = {
  triode: { P: 'pinP', G: 'pinG', C: 'pinC' },
  pentode: { P: 'pinP', G1: 'pinG', C: 'pinC', G2: 'pinG2' },
  diode: { A: 'pinA', K: 'pinK' },
};

function readPins() {
  const fields = PIN_INPUTS[state.type] || PIN_INPUTS.triode;
  const pins = {};
  for (const [role, id] of Object.entries(fields)) pins[role] = $(id).value;
  return pins;
}

function writePins(pins) {
  if (!pins) return;
  const fields = { ...PIN_INPUTS.triode, ...PIN_INPUTS.pentode, ...PIN_INPUTS.diode };
  for (const [role, id] of Object.entries(fields)) {
    if (typeof pins[role] === 'string' && pins[role]) $(id).value = pins[role];
  }
}

function updateSpice() {
  const caps = readCaps();
  Object.assign(state.params, caps);
  const model = activeModel();
  const text = generateSubckt({
    modelId: state.modelId,
    name: state.name,
    type: state.type,
    params: state.params,
    pins: readPins(),
    comment: `${model.label} model — fitted ${new Date().toISOString().slice(0, 10)}`,
  });
  $('spiceOut').value = text;
}

function setParams(p, { syncSliders = true, clamp = true } = {}) {
  const merged = { ...state.params, ...p };
  state.params = clamp ? clampParams(state.modelId, merged) : merged;
  if (syncSliders && sliderApi) sliderApi.setParams(state.params);
  scheduleRedraw();
  persist();
}

function rebuildSliders() {
  sliderApi = createParamSliders(
    $('paramSliders'),
    activeModel(),
    state.params,
    (key, value) => {
      setParams({ [key]: value }, { syncSliders: false, clamp: false });
    },
    state.type,
  );
  updateMultiVisibility();
}

function guideLayer() {
  if (!isMultiGrid()) return 'plate';
  return $('guideLayerScreen')?.checked ? 'screen' : 'plate';
}

function guidePointCount() {
  return countGuidePoints(state.guides) + countGuidePoints(state.screenGuides);
}

function updateDrawStatus(extra = '', { error = false } = {}) {
  const el = $('drawStatus');
  if (!el) return;
  const plateN = countGuidePoints(state.guides);
  const screenN = countGuidePoints(state.screenGuides);
  let base;
  if (plateN + screenN === 0) {
    base =
      state.type === 'diode'
        ? 'Click the plot to place points along the anode curve, then Fit.'
        : isMultiGrid()
          ? 'Click the plot to place points. Plate follows Ip, Screen follows Ig2. Change Active Vg for the next curve, then Fit.'
          : 'Click the plot to place a few points along each datasheet Vg curve. Change Active Vg for the next curve, then Fit.';
  } else {
    const parts = [];
    if (plateN) parts.push(`plate ${state.guides.length} curve(s), ${plateN} pt`);
    if (screenN) parts.push(`screen ${state.screenGuides.length} curve(s), ${screenN} pt`);
    base = `${parts.join(' · ')}. Drag points to adjust.`;
  }
  el.textContent = extra ? `${base} ${extra}` : base;
  el.classList.toggle('error', error);
}

function runGuideFit() {
  const eg2 = Number($('eg2').value) || 300;
  const { params, meta } = fitParamsToGuides(
    state.modelId,
    state.type,
    state.params,
    state.guides,
    eg2,
    (u, v) => plot.unitToData(u, v),
    state.screenGuides,
  );
  if (!meta.ok) {
    updateDrawStatus(meta.reason || 'Need at least 2 guide points.', { error: true });
    return;
  }
  setParams(params);
  const bits = [`Fitted ${meta.points} points`];
  if (meta.plateRms != null) bits.push(`plate RMS ${formatMa(meta.plateRms)} mA`);
  if (meta.screenRms != null) bits.push(`screen RMS ${formatMa(meta.screenRms)} mA`);
  updateDrawStatus(`${bits.join(' · ')}.`);
}

function setGuideLayer(layer, guides, { fit = false } = {}) {
  assignGuides(layer, guides);
  scheduleRedraw();
  persist();
  if (fit && guidePointCount() >= 2 && $('drawAutoFit')?.checked) {
    runGuideFit();
  } else {
    updateDrawStatus();
  }
}

function updateMultiVisibility() {
  const multi = isMultiGrid();
  const diode = state.type === 'diode';
  $('eg2Row').style.display = multi ? '' : 'none';
  $('showScreenRow').style.display = multi ? '' : 'none';
  $('guideLayerRow').style.display = multi ? '' : 'none';
  if (!multi) $('guideLayerPlate').checked = true;
  $('vgRow').style.display = diode ? 'none' : '';
  $('capCCG').style.display = diode ? 'none' : '';
  $('capCGP').style.display = diode ? 'none' : '';
  $('capRGI').style.display = diode ? 'none' : '';
  $('capCCPLabel').textContent = diode ? 'CP (pF)' : 'CCP (pF)';
  const koren = state.modelId === 'koren';
  $('loadVgRow').style.display = diode ? 'none' : '';
  $('loadVinRow').style.display = diode ? 'none' : '';
  $('showIgRow').style.display = diode ? 'none' : '';
  $('igModeRow').style.display = !diode && koren ? '' : 'none';
  $('childLawRow').style.display = !diode && koren && $('igMode').value === 'child' ? '' : 'none';
  $('showSumRow').style.display = multi ? '' : 'none';
  $('ulRow').style.display = multi ? '' : 'none';
  $('ulTapRow').style.display = multi && $('ulOn').checked ? '' : 'none';
  $('harmPlot').style.display = diode ? 'none' : '';
  $('loadOpt').style.display = diode ? 'none' : '';
  $('pinAWrap').style.display = diode ? '' : 'none';
  $('pinKWrap').style.display = diode ? '' : 'none';
  $('pinPWrap').style.display = diode ? 'none' : '';
  $('pinGWrap').style.display = diode ? 'none' : '';
  $('pinCWrap').style.display = diode ? 'none' : '';
  $('pinG2Wrap').style.display = multi ? '' : 'none';
  $('pinGLabel').textContent = multi ? 'G1' : 'G';
  if (sliderApi) sliderApi.setMultiGrid(multi);
}

function fillModelOptions() {
  const sel = $('modelSelect');
  sel.replaceChildren();
  for (const type of TYPE_ORDER) {
    for (const model of listModels()) {
      if (!model.supports.includes(type)) continue;
      const opt = document.createElement('option');
      opt.value = modelOptionValue(type, model.id);
      opt.textContent = `${TYPE_LABELS[type]}: ${model.label}`;
      sel.appendChild(opt);
    }
  }
}

function syncModelSelect() {
  const sel = $('modelSelect');
  if (!modelSupports(state.modelId, state.type)) {
    state.type = activeModel().supports[0];
  }
  sel.value = modelOptionValue(state.type, state.modelId);
}

function switchModel(modelId, { resetParams = true } = {}) {
  state.modelId = modelId;
  syncModelSelect();
  if (resetParams) {
    const next = defaultParams(modelId, state.type);
    const caps = Object.fromEntries(CAP_IDS.map((id) => [id, state.params[id]]));
    state.params = { ...next, ...caps };
    writeCaps(state.params);
  } else {
    state.params = clampParams(modelId, {
      ...defaultParams(modelId, state.type),
      ...state.params,
    });
  }
  hideNotice($('modelNote'));
  rebuildSliders();
  refreshPresetOptions();
  if (!$('presetSelect').value) applyFormulaAxes();
  if (guidePointCount() >= 2) {
    runGuideFit();
  } else {
    scheduleRedraw();
    persist();
  }
}

function applyPreset(preset) {
  const modelId = preset.model || 'koren';
  state.modelId = modelId;
  state.name = preset.name;
  state.type = normalizeType(preset.type);
  $('tubeName').value = preset.name;
  syncModelSelect();
  if (preset.sweep) {
    if (preset.sweep.vgList) $('vgList').value = preset.sweep.vgList;
    if (preset.sweep.vpMax != null) $('vpMax').value = preset.sweep.vpMax;
    if (preset.sweep.ipMax != null) setIpMaxMa(preset.sweep.ipMax, { fromAmps: true });
    if (preset.sweep.eg2 != null) $('eg2').value = preset.sweep.eg2;
  }
  const note = $('modelNote');
  if (preset.comment) setNotice(note, preset.comment);
  else hideNotice(note);
  state.params = clampParams(modelId, {
    ...defaultParams(modelId, preset.type),
    ...preset.params,
  });
  writeCaps(state.params);
  rebuildSliders();
  setParams(state.params);
  updateMultiVisibility();
  refreshPresetOptions();
  centerLoadLine();
  scheduleRedraw();
  persist();
}

function resetToFormulaDefaults() {
  $('presetSelect').value = '';
  hideNotice($('modelNote'));
  state.params = defaultParams(state.modelId, state.type);
  writeCaps(state.params);
  applyAxisDefaults();
  state.guides = [];
  state.screenGuides = [];
  rebuildSliders();
  updateMultiVisibility();
  scheduleRedraw();
  persist();
}

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writePersist, 200);
}

function flushPersist() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = 0;
  writePersist();
}

function writePersist() {
  persistTimer = 0;
  try {
    const payload = {
      modelId: state.modelId,
      type: state.type,
      name: state.name,
      params: state.params,
      vgList: $('vgList').value,
      vpMax: $('vpMax').value,
      ipMax: $('ipMax').value,
      eg2: $('eg2').value,
      showScreenCurves: $('showScreenCurves').checked,
      load: { ...readLoadUi(), userPlaced: loadPlaced },
      child: Object.fromEntries(CHILD_KEYS.map((key) => [key, Number($(key).value)])),
      guides: state.guides,
      screenGuides: state.screenGuides,
      pins: {
        ...Object.fromEntries(Object.entries(PIN_INPUTS.triode).map(([role, id]) => [role, $(id).value])),
        G1: $('pinG').value,
        G2: $('pinG2').value,
        A: $('pinA').value,
        K: $('pinK').value,
      },
      calib: {
        origin: plot.calib.origin,
        vpMaxPx: plot.calib.vpMaxPx,
        ipMaxPx: plot.calib.ipMaxPx,
        vpScale: plot.calib.vpScale,
        ipScale: plot.calib.ipScale,
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota */
  }
}

/** Legacy sessions stored amperes (< 1); newer ones store milliamps. */
function storedAmps(raw, fallback) {
  const n = Number(raw);
  if (n > 0 && n < 1) return n;
  return Number.isFinite(n) ? n / 1000 : fallback;
}

function restore() {
  let data;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (data.modelId) state.modelId = data.modelId;
  if (!listModels().some((m) => m.id === state.modelId)) {
    state.modelId = 'koren';
  }
  if (data.name) {
    state.name = data.name;
    $('tubeName').value = data.name;
  }
  if (data.type) state.type = normalizeType(data.type);
  syncModelSelect();
  if (data.params) {
    const saved = {};
    for (const [key, value] of Object.entries(data.params)) {
      if (Number.isFinite(value)) saved[key] = value;
    }
    state.params = { ...defaultParams(state.modelId, state.type), ...saved };
    writeCaps(state.params);
  }
  if (data.vgList) $('vgList').value = data.vgList;
  if (data.vpMax) $('vpMax').value = data.vpMax;
  if (data.ipMax != null) {
    const n = Number(data.ipMax);
    setIpMaxMa(n, { fromAmps: n > 0 && n < 1 });
  }
  if (data.eg2) $('eg2').value = data.eg2;
  if (typeof data.showScreenCurves === 'boolean') {
    $('showScreenCurves').checked = data.showScreenCurves;
  }
  if (data.load) {
    const map = {
      show: 'showLoadLine',
      showPmax: 'showPmax',
      showIg: 'showIg',
      showSum: 'showSum',
      ulOn: 'ulOn',
    };
    for (const [key, id] of Object.entries(map)) {
      if (typeof data.load[key] === 'boolean') $(id).checked = data.load[key];
    }
    const fields = { rp: 'loadRp', vp: 'loadVp', vg: 'loadVg', vin: 'loadVin', pmax: 'loadPmax', thdMax: 'loadThd', vcMax: 'loadVc', ul: 'ulTap' };
    for (const [key, id] of Object.entries(fields)) {
      if (Number.isFinite(data.load[key])) $(id).value = data.load[key];
    }
    if (data.load.gridLaw === 'child' || data.load.gridLaw === 'diode') {
      $('igMode').value = data.load.gridLaw;
    }
    loadPlaced = data.load.userPlaced === true;
  }
  if (data.child) {
    for (const key of CHILD_KEYS) {
      if (Number.isFinite(data.child[key])) $(key).value = data.child[key];
    }
    Object.assign(state.params, data.child);
  }
  if (data.calib) {
    Object.assign(plot.calib, data.calib);
    if (plot.isCalibrated()) {
      if (!(plot.calib.vpScale > 0)) plot.calib.vpScale = Number(data.vpMax) || plot.calib.vpMax;
      if (!(plot.calib.ipScale > 0)) plot.calib.ipScale = storedAmps(data.ipMax, plot.calib.ipMax);
      $('calibStatus').textContent = 'Restored previous axis calibration.';
    }
  }
  const vpMax = plot.calib.vpScale > 0 ? plot.calib.vpScale : Number(data.vpMax) || 400;
  const ipMax = plot.calib.ipScale > 0 ? plot.calib.ipScale : storedAmps(data.ipMax, 0.01);
  if (data.pins) writePins(data.pins);
  if (Array.isArray(data.guides)) state.guides = migrateGuides(data.guides, vpMax, ipMax);
  if (Array.isArray(data.screenGuides)) {
    state.screenGuides = migrateGuides(data.screenGuides, vpMax, ipMax);
  }
}

function bindUi() {
  fillModelOptions();
  syncModelSelect();

  rebuildSliders();
  updateDrawStatus();

  $('modelSelect').addEventListener('change', () => {
    const next = parseModelOption($('modelSelect').value);
    if (next.modelId !== state.modelId) {
      state.type = next.type;
      switchModel(next.modelId, { resetParams: true });
      return;
    }
    if (next.type === state.type) return;
    state.type = next.type;
    state.params = clampParams(state.modelId, {
      ...defaultParams(state.modelId, state.type),
      ...state.params,
    });
    refreshPresetOptions();
    if (!$('presetSelect').value) applyFormulaAxes();
    rebuildSliders();
    updateMultiVisibility();
    scheduleRedraw();
    persist();
  });

  $('tubeName').addEventListener('input', () => {
    state.name = $('tubeName').value.trim() || 'TUBE';
    updateSpice();
    persist();
  });

  for (const id of [
    'vgList', 'vpMax', 'ipMax', 'eg2', 'vpSteps', 'imageOpacity',
    'loadRp', 'loadVp', 'loadVg', 'loadVin', 'loadPmax', 'loadThd', 'loadVc', 'ulTap',
    ...CHILD_KEYS,
  ]) {
    $(id).addEventListener('input', () => {
      if (CHILD_KEYS.includes(id)) {
        const n = Number($(id).value);
        if (Number.isFinite(n)) state.params[id] = n;
      }
      if (['loadRp', 'loadVp', 'loadVg', 'loadVin'].includes(id)) loadPlaced = true;
      if ((id === 'vpMax' || id === 'ipMax') && !loadPointOnPlot()) centerLoadLine();
      scheduleRedraw();
      persist();
    });
  }

  $('showScreenCurves').addEventListener('change', () => {
    scheduleRedraw();
    persist();
  });

  for (const id of ['showLoadLine', 'showPmax', 'showIg', 'showSum', 'ulOn', 'igMode']) {
    $(id).addEventListener('change', () => {
      if (id === 'igMode' && $('igMode').value === 'child') {
        state.params = { ...CHILD_DEFAULTS, ...state.params, gridLaw: 'child' };
        for (const key of Object.keys(CHILD_DEFAULTS)) {
          $(key).value = state.params[key];
        }
      }
      updateMultiVisibility();
      scheduleRedraw();
      persist();
    });
  }

  for (const id of CAP_IDS) {
    $(id).addEventListener('change', () => {
      updateSpice();
      persist();
    });
  }

  for (const id of ['pinA', 'pinK', 'pinP', 'pinG', 'pinC', 'pinG2']) {
    $(id).addEventListener('input', () => {
      updateSpice();
      persist();
    });
  }

  $('btnNewTube').addEventListener('click', () => resetToFormulaDefaults());
  $('btnBestLoad').addEventListener('click', () => applyBestLoadLine());

  $('btnFitGuides').addEventListener('click', () => runGuideFit());
  $('btnUndoGuide').addEventListener('click', () => undoActiveGuide());
  $('btnClearGuides').addEventListener('click', () => {
    setGuideLayer(guideLayer(), []);
  });

  $('btnCalibrate').addEventListener('click', () => {
    if (calibrator.active) calibrator.cancel();
    else calibrator.start();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && calibrator.active) calibrator.cancel();
    if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !calibrator.active) {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      undoActiveGuide();
    }
  });
  $('btnClearImage').addEventListener('click', () => {
    plot.clearImage();
  });

  function loadImageBlob(blob) {
    if (!blob || !blob.type.startsWith('image/')) return;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      plot.setImage(img);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  $('imageInput').addEventListener('change', (e) => {
    loadImageBlob(e.target.files?.[0]);
  });

  function isTypingTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    if (target instanceof HTMLTextAreaElement) return !target.readOnly;
    if (target instanceof HTMLInputElement) {
      return ['text', 'number', 'search', 'email', 'password'].includes(target.type);
    }
    return Boolean(target.isContentEditable);
  }

  function looksLikeSpice(text) {
    if (/\bPARAMS\s*:/i.test(text) || /\.SUBCKT\b/i.test(text) || /\.PARAM\b/i.test(text)) return true;
    return /[A-Za-z_]\w*\s*=\s*[+-]?\d/.test(text) && parseSpiceImport(text).ok;
  }

  function loadSpiceText(text) {
    const parsed = parseSpiceImport(text);
    const note = $('modelNote');
    if (!parsed.ok) {
      setNotice(note, parsed.reason, { error: true });
      return false;
    }
    const model = getModel(parsed.modelId);
    const merged = clampParams(parsed.modelId, {
      ...defaultParams(parsed.modelId, parsed.type),
      ...parsed.params,
    });
    const clamped = Object.keys(parsed.params).filter((key) => {
      if (model.limits?.[key] == null) return false;
      return merged[key] !== parsed.params[key];
    });
    const label = parsed.name ? `${parsed.name} as ${model.label}` : model.label;
    let comment = `Loaded ${label} ${parsed.type}.`;
    if (clamped.length) comment += ` Clamped ${clamped.join(', ')}.`;
    applyPreset({
      model: parsed.modelId,
      name: parsed.name || state.name,
      type: parsed.type,
      params: parsed.params,
      comment,
    });
    if (parsed.pins) {
      writePins(parsed.pins);
      updateSpice();
      persist();
    }
    $('presetSelect').value = '';
    return true;
  }

  $('btnPasteParams').addEventListener('click', async () => {
    const btn = $('btnPasteParams');
    try {
      const text = await navigator.clipboard.readText();
      if (!loadSpiceText(text)) return;
      btn.textContent = 'Loaded';
      setTimeout(() => {
        btn.textContent = 'Paste params';
      }, 1200);
    } catch {
      setNotice($('modelNote'), 'Could not read the clipboard. Click the page and press Ctrl+V.', { error: true });
    }
  });

  window.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find((i) => i.type.startsWith('image/'));
    const text = e.clipboardData?.getData('text/plain') || '';
    const typing = isTypingTarget(e.target);

    if (imageItem && !(typing && text)) {
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      if (plot.image && !confirm('Replace the current datasheet image?')) return;
      loadImageBlob(file);
      return;
    }

    if (!text || typing || !looksLikeSpice(text)) return;
    e.preventDefault();
    loadSpiceText(text);
  });

  $('btnCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('spiceOut').value);
      $('btnCopy').textContent = 'Copied';
      setTimeout(() => {
        $('btnCopy').textContent = 'Copy';
      }, 1200);
    } catch {
      $('spiceOut').select();
      document.execCommand('copy');
    }
  });

  $('btnDownload').addEventListener('click', () => {
    const blob = new Blob([$('spiceOut').value], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.name || 'tube'}.lib`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  window.addEventListener('pagehide', flushPersist);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerUp);
  canvas.addEventListener('click', onClick);
}

function undoActiveGuide() {
  const vg = Number($('drawVg').value);
  const layer = guideLayer();
  setGuideLayer(layer, undoGuidePoint(guidesFor(layer), Number.isFinite(vg) ? vg : null));
}

function onClick(evt) {
  const local = plot.eventToLocal(evt);
  if (calibrator.onClick(local)) {
    persist();
    return;
  }
  if (skipDrawClick) {
    skipDrawClick = false;
    return;
  }

  const unit = plot.pxToUnit(local.x, local.y);
  const vg = Number($('drawVg').value);
  if (!Number.isFinite(vg)) return;
  const layer = guideLayer();
  setGuideLayer(layer, addGuidePoint(guidesFor(layer), vg, unit.u, Math.max(0, unit.v)), { fit: true });
}

function onPointerDown(evt) {
  if (calibrator.active) return;
  const local = plot.eventToLocal(evt);
  try {
    canvas.setPointerCapture(evt.pointerId);
  } catch {
    /* synthetic events have no pointer to capture */
  }

  const handle = hitLoadHandle(local);
  if (handle) {
    skipDrawClick = true;
    drag = { kind: handle, moved: false };
    return;
  }

  const hit = hitGuideLayers(
    plot,
    [
      { id: 'plate', guides: state.guides },
      { id: 'screen', guides: state.screenGuides },
    ],
    local.x,
    local.y,
    12,
  );
  if (hit) {
    skipDrawClick = true;
    drag = {
      layer: hit.layer,
      gi: hit.gi,
      pi: hit.pi,
      moved: false,
    };
  } else {
    skipDrawClick = false;
  }
}

function onPointerMove(evt) {
  const local = plot.eventToLocal(evt);
  const data = plot.pxToData(local.x, local.y);
  let cursor = `Vp=${data.vp.toFixed(1)} V, Ip=${(data.ip * 1000).toFixed(3)} mA`;
  if (state.type !== 'diode' && data.vp > 0 && data.ip >= 0) {
    const load = readLoadUi();
    const eg2 = Number($('eg2').value) || 300;
    const screen = eg2For(data.vp, eg2, load);
    const ipAt = (vg, vp, eg) => plateCurrent(state.modelId, state.type, vg, vp, eg, state.params);
    const vg = vgAtCurrent(ipAt, data.vp, data.ip, screen);
    if (vg != null) {
      const ss = smallSignal({
        ipAt,
        vg,
        vp: data.vp,
        eg2: screen,
        rp: load.rp,
        hasGrid: true,
        ccgPf: state.params.CCG,
        cgpPf: state.params.CGP,
      });
      cursor += `  Vg=${vg.toFixed(2)} V  Mu=${ss.mu == null || !Number.isFinite(ss.mu) ? '—' : ss.mu.toFixed(1)}`;
    }
  }
  $('cursorReadout').textContent = cursor;

  canvas.style.cursor = hitLoadHandle(local) || drag?.kind === 'vin' || drag?.kind === 'center' ? 'grab' : '';

  if (!drag) return;

  if (drag.kind === 'vin' || drag.kind === 'center') {
    drag.moved = true;
    if (!(data.vp > 0) || data.ip < 0) return;
    if (drag.kind === 'center') placeLoadCenter(data.vp, data.ip);
    else {
      tiltLoadLine(data.vp, data.ip);
      const vin = vinFromPoint(data.vp, data.ip);
      if (vin != null) $('loadVin').value = vin.toFixed(2);
    }
    loadPlaced = true;
    scheduleRedraw();
    return;
  }

  drag.moved = true;
  const unit = plot.pxToUnit(local.x, local.y);
  const source = guidesFor(drag.layer);
  const guides = cloneGuides(source);
  const curve = guides[drag.gi];
  if (!curve) return;
  curve.points[drag.pi] = { u: unit.u, v: Math.max(0, unit.v) };
  curve.points.sort((a, b) => a.u - b.u);
  let bestPi = 0;
  let bestD = Infinity;
  curve.points.forEach((pt, i) => {
    const d = (pt.u - unit.u) ** 2 + (pt.v - unit.v) ** 2;
    if (d < bestD) {
      bestD = d;
      bestPi = i;
    }
  });
  drag.pi = bestPi;
  assignGuides(drag.layer, guides);
  schedulePaint();
}

function onPointerUp() {
  if (!drag) return;
  const moved = drag.moved;
  const kind = drag.kind;
  const layer = drag.layer;
  drag = null;
  canvas.style.cursor = '';
  if (kind === 'vin' || kind === 'center') {
    if (moved) flushPersist();
    return;
  }
  if (moved) {
    setGuideLayer(layer, guidesFor(layer), { fit: true });
  }
  flushPersist();
}

function refreshPresetOptions() {
  const sel = $('presetSelect');
  const current = sel.value;
  sel.innerHTML = '<option value="">— custom —</option>';
  for (const p of state.presets) {
    const modelId = p.model || 'koren';
    if (modelId !== state.modelId) continue;
    if (normalizeType(p.type) !== state.type) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  else {
    sel.value = '';
    if (current) hideNotice($('modelNote'));
  }
}

async function loadPresets() {
  const groups = await Promise.all(TYPE_ORDER.map(async (type) => {
    const res = await fetch(`/presets/tubes/${type}.json`);
    if (!res.ok) throw new Error(`Failed to load ${type} presets (${res.status})`);
    return res.json();
  }));
  state.presets = groups.flat();
  refreshPresetOptions();
  const sel = $('presetSelect');
  sel.addEventListener('change', () => {
    const preset = state.presets.find((p) => p.id === sel.value);
    if (preset) applyPreset(preset);
    else hideNotice($('modelNote'));
  });
}

restore();
if (!loadPlaced || !loadPointOnPlot()) centerLoadLine();
bindUi();
loadPresets().then(() => {
  scheduleRedraw();
});
scheduleRedraw();
