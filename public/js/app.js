import {
  parseVgList,
  curveFamily,
  screenCurveFamily,
  clampParams,
  getModel,
  defaultParams,
  modelSupports,
  listModels,
  generateSubckt,
  normalizeType,
  parseSpiceImport,
} from '/lib/tube.js';
import { Plot } from './plot.js';
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

function $(id) {
  return document.getElementById(id);
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

function applyAxisDefaults() {
  $('vpMax').value = 400;
  setIpMaxMa(defaultIpMaxMa(state.type));
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
  $('ipMax').value = fromAmps ? +(n * 1000).toFixed(3) : n;
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

function redraw() {
  const vgList = state.type === 'diode' ? [0] : parseVgList($('vgList').value);

  plot.calib.vpMax = Number($('vpMax').value) || 400;
  plot.calib.ipMax = readIpMaxA();
  plot.imageOpacity = Number($('imageOpacity').value) / 100;
  plot.curveColor = $('curveColor').value;

  const eg2 = Number($('eg2').value) || 300;
  const vpSteps = Number($('vpSteps').value) || 120;
  const sweepOpts = {
    vgList,
    vpMin: 0,
    vpMax: plot.calib.vpMax,
    vpSteps,
    eg2,
  };

  plot.curves = curveFamily(state.modelId, state.type, state.params, sweepOpts);
  plot.showScreenCurves = isMultiGrid() && $('showScreenCurves').checked;
  plot.screenCurves = plot.showScreenCurves
    ? screenCurveFamily(state.modelId, state.type, state.params, sweepOpts)
    : [];
  plot.guides = state.guides;
  plot.screenGuides = state.screenGuides;
  plot.draw();
  updateSpice();
  updateDrawStatus();
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

function updateDrawStatus(extra = '') {
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
    updateDrawStatus(meta.reason || 'Need at least 2 guide points.');
    return;
  }
  setParams(params);
  const bits = [`Fitted ${meta.points} points`];
  if (meta.plateRms != null) bits.push(`plate RMS ${(meta.plateRms * 1000).toFixed(3)} mA`);
  if (meta.screenRms != null) bits.push(`screen RMS ${(meta.screenRms * 1000).toFixed(3)} mA`);
  if (meta.plateRms == null && meta.screenRms == null) {
    bits.push(`RMS ${(meta.rms * 1000).toFixed(3)} mA`);
  }
  updateDrawStatus(`${bits.join(' · ')}.`);
}

function setGuideLayer(layer, guides, { fit = false } = {}) {
  if (layer === 'screen') state.screenGuides = guides;
  else state.guides = guides;
  plot.guides = state.guides;
  plot.screenGuides = state.screenGuides;
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
  $('modelNote').hidden = true;
  rebuildSliders();
  refreshPresetOptions();
  if (!$('presetSelect').value) applyAxisDefaults();
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
  if (preset.comment) {
    note.hidden = false;
    note.textContent = preset.comment;
  } else {
    note.hidden = true;
    note.textContent = '';
  }
  state.params = clampParams(modelId, {
    ...defaultParams(modelId, preset.type),
    ...preset.params,
  });
  writeCaps(state.params);
  rebuildSliders();
  setParams(state.params);
  updateMultiVisibility();
  refreshPresetOptions();
}

function resetToFormulaDefaults() {
  $('presetSelect').value = '';
  const note = $('modelNote');
  note.hidden = true;
  note.textContent = '';
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
      guides: state.guides,
      screenGuides: state.screenGuides,
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

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
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
      // Legacy sessions stored amperes (< 1); new UI stores mA.
      setIpMaxMa(n, { fromAmps: n > 0 && n < 1 });
    }
    if (data.eg2) $('eg2').value = data.eg2;
    if (typeof data.showScreenCurves === 'boolean') {
      $('showScreenCurves').checked = data.showScreenCurves;
    }
    if (data.calib) {
      Object.assign(plot.calib, data.calib);
      if (plot.isCalibrated()) {
        if (!(plot.calib.vpScale > 0)) plot.calib.vpScale = Number(data.vpMax) || plot.calib.vpMax;
        if (!(plot.calib.ipScale > 0)) {
          const n = Number(data.ipMax);
          plot.calib.ipScale = n > 0 && n < 1 ? n : (Number.isFinite(n) ? n / 1000 : plot.calib.ipMax);
        }
        $('calibStatus').textContent = 'Restored previous axis calibration.';
      }
    }
    if (Array.isArray(data.guides)) {
      const vpMax = plot.calib.vpScale > 0 ? plot.calib.vpScale : Number(data.vpMax) || 400;
      const ipRaw = Number(data.ipMax);
      const ipMax = plot.calib.ipScale > 0
        ? plot.calib.ipScale
        : ipRaw > 0 && ipRaw < 1
          ? ipRaw
          : (Number.isFinite(ipRaw) ? ipRaw / 1000 : 0.01);
      state.guides = migrateGuides(data.guides, vpMax, ipMax);
      plot.guides = state.guides;
    }
    if (Array.isArray(data.screenGuides)) {
      const vpMax = plot.calib.vpScale > 0 ? plot.calib.vpScale : Number(data.vpMax) || 400;
      const ipRaw = Number(data.ipMax);
      const ipMax = plot.calib.ipScale > 0
        ? plot.calib.ipScale
        : ipRaw > 0 && ipRaw < 1
          ? ipRaw
          : (Number.isFinite(ipRaw) ? ipRaw / 1000 : 0.01);
      state.screenGuides = migrateGuides(data.screenGuides, vpMax, ipMax);
      plot.screenGuides = state.screenGuides;
    }
  } catch {
    /* ignore */
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
    if (!$('presetSelect').value) applyAxisDefaults();
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

  for (const id of ['vgList', 'vpMax', 'ipMax', 'eg2', 'vpSteps', 'curveColor', 'imageOpacity']) {
    $(id).addEventListener('input', () => {
      scheduleRedraw();
      persist();
    });
  }

  $('showScreenCurves').addEventListener('change', () => {
    scheduleRedraw();
    persist();
  });

  for (const id of CAP_IDS) {
    $(id).addEventListener('change', () => {
      updateSpice();
      persist();
    });
  }

  $('btnNewTube').addEventListener('click', () => resetToFormulaDefaults());

  $('btnFitGuides').addEventListener('click', () => runGuideFit());
  $('btnUndoGuide').addEventListener('click', () => {
    const vg = Number($('drawVg').value);
    const layer = guideLayer();
    const list = layer === 'screen' ? state.screenGuides : state.guides;
    setGuideLayer(layer, undoGuidePoint(list, Number.isFinite(vg) ? vg : null));
  });
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
      const vg = Number($('drawVg').value);
      const layer = guideLayer();
      const list = layer === 'screen' ? state.screenGuides : state.guides;
      setGuideLayer(layer, undoGuidePoint(list, Number.isFinite(vg) ? vg : null));
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
      note.hidden = false;
      note.textContent = parsed.reason;
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
      const note = $('modelNote');
      note.hidden = false;
      note.textContent = 'Could not read the clipboard. Click the page and press Ctrl+V.';
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
  const list = layer === 'screen' ? state.screenGuides : state.guides;
  setGuideLayer(layer, addGuidePoint(list, vg, unit.u, Math.max(0, unit.v)), { fit: true });
}

function onPointerDown(evt) {
  if (calibrator.active) return;
  const local = plot.eventToLocal(evt);
  canvas.setPointerCapture(evt.pointerId);

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
  $('cursorReadout').textContent = `Vp=${data.vp.toFixed(1)} V, Ip=${(data.ip * 1000).toFixed(3)} mA`;

  if (!drag) return;

  drag.moved = true;
  const unit = plot.pxToUnit(local.x, local.y);
  const source = drag.layer === 'screen' ? state.screenGuides : state.guides;
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
  if (drag.layer === 'screen') state.screenGuides = guides;
  else state.guides = guides;
  plot.guides = state.guides;
  plot.screenGuides = state.screenGuides;
  schedulePaint();
}

function onPointerUp() {
  if (!drag) return;
  const moved = drag.moved;
  const layer = drag.layer;
  drag = null;
  if (moved) {
    const guides = layer === 'screen' ? state.screenGuides : state.guides;
    setGuideLayer(layer, guides, { fit: true });
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
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.type})`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
  else sel.value = '';
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
    else $('modelNote').hidden = true;
  });
}

restore();
bindUi();
loadPresets().then(() => {
  scheduleRedraw();
});
scheduleRedraw();
