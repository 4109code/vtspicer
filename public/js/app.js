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
} from '/lib/tube.js';
import { Plot } from './plot.js';
import { Calibrator } from './calibrate.js';
import {
  addGuidePoint,
  undoGuidePoint,
  fitParamsToGuides,
  countGuidePoints,
  hitGuidePoint,
  cloneGuides,
} from './draw-guides.js';
import { createParamSliders, readCaps, writeCaps, CAP_IDS } from './ui.js';

const STORAGE_KEY = 'koren-tube-modeler-v2';

const state = {
  modelId: 'koren',
  type: 'triode',
  name: '12AX7',
  params: defaultParams('koren', 'triode'),
  guides: [],
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
  document.body.classList.toggle('is-calibrating', cal.active);
  const btn = $('btnCalibrate');
  btn.textContent = cal.active ? 'Cancel calibration' : 'Calibrate axes';
  btn.classList.toggle('primary', !cal.active);
  btn.classList.toggle('danger', cal.active);
}

/** UI stores Ip max in mA; plot/math use amperes. */
function readIpMaxA() {
  const ma = Number($('ipMax').value);
  return Number.isFinite(ma) && ma > 0 ? ma / 1000 : 0.006;
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
  const vgList = parseVgList($('vgList').value);

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

function setParams(p, { syncSliders = true } = {}) {
  state.params = clampParams(state.modelId, { ...state.params, ...p });
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
      setParams({ [key]: value }, { syncSliders: false });
    },
  );
  updateMultiVisibility();
}

function updateDrawStatus(extra = '') {
  const el = $('drawStatus');
  if (!el) return;
  const nCurves = state.guides.length;
  const nPts = countGuidePoints(state.guides);
  const base =
    nPts === 0
      ? 'Click the plot to place a few points along each datasheet Vg curve. Change Active Vg for the next curve, then Fit.'
      : `${nCurves} guide curve(s), ${nPts} point(s). Drag points to adjust.`;
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
  );
  if (!meta.ok) {
    updateDrawStatus(meta.reason || 'Need at least 2 guide points.');
    return;
  }
  setParams(params);
  const rmsMa = (meta.rms * 1000).toFixed(3);
  updateDrawStatus(`Fitted ${meta.points} points · RMS ${rmsMa} mA.`);
}

function setGuides(guides, { fit = false } = {}) {
  state.guides = guides;
  plot.guides = guides;
  scheduleRedraw();
  persist();
  if (fit && countGuidePoints(guides) >= 2 && $('drawAutoFit')?.checked) {
    runGuideFit();
  } else {
    updateDrawStatus();
  }
}

function updateMultiVisibility() {
  const multi = isMultiGrid();
  $('eg2Row').style.display = multi ? '' : 'none';
  $('showScreenRow').style.display = multi ? '' : 'none';
  if (sliderApi) sliderApi.setMultiGrid(multi);
}

function updateTypeOptions() {
  const model = activeModel();
  const sel = $('tubeType');
  for (const opt of sel.options) {
    const ok = model.supports.includes(opt.value);
    opt.disabled = !ok;
    opt.hidden = !ok;
  }
  if (!modelSupports(state.modelId, state.type)) {
    state.type = model.supports[0];
    sel.value = state.type;
  }
  $('modelNote').hidden = true;
}

function switchModel(modelId, { resetParams = true } = {}) {
  state.modelId = modelId;
  $('modelSelect').value = modelId;
  updateTypeOptions();
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
  rebuildSliders();
  refreshPresetOptions();
  scheduleRedraw();
  persist();
}

function applyPreset(preset) {
  const modelId = preset.model || 'koren';
  state.modelId = modelId;
  $('modelSelect').value = modelId;
  state.name = preset.name;
  state.type = normalizeType(preset.type);
  $('tubeName').value = preset.name;
  updateTypeOptions();
  $('tubeType').value = preset.type;
  if (preset.sweep) {
    if (preset.sweep.vgList) $('vgList').value = preset.sweep.vgList;
    if (preset.sweep.vpMax != null) $('vpMax').value = preset.sweep.vpMax;
    if (preset.sweep.ipMax != null) setIpMaxMa(preset.sweep.ipMax, { fromAmps: true });
    if (preset.sweep.eg2 != null) $('eg2').value = preset.sweep.eg2;
  }
  writeCaps(preset.params);
  state.params = clampParams(modelId, {
    ...defaultParams(modelId, preset.type),
    ...preset.params,
  });
  rebuildSliders();
  setParams(state.params);
  updateMultiVisibility();
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
      calib: {
        origin: plot.calib.origin,
        vpMaxPx: plot.calib.vpMaxPx,
        ipMaxPx: plot.calib.ipMaxPx,
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
    $('modelSelect').value = state.modelId;
    updateTypeOptions();
    $('tubeType').value = state.type;
    if (data.params) {
      state.params = clampParams(state.modelId, {
        ...defaultParams(state.modelId, state.type),
        ...data.params,
      });
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
    if (Array.isArray(data.guides)) {
      state.guides = data.guides;
      plot.guides = state.guides;
    }
    if (data.calib) {
      Object.assign(plot.calib, data.calib);
      if (plot.isCalibrated()) {
        $('calibStatus').textContent = 'Restored previous axis calibration.';
      }
    }
  } catch {
    /* ignore */
  }
}

function bindUi() {
  const modelSel = $('modelSelect');
  for (const m of listModels()) {
    let opt = [...modelSel.options].find((o) => o.value === m.id);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = m.id;
      modelSel.appendChild(opt);
    }
    opt.textContent = m.label;
  }

  rebuildSliders();
  updateTypeOptions();
  updateDrawStatus();

  $('modelSelect').addEventListener('change', () => {
    switchModel($('modelSelect').value, { resetParams: true });
  });

  $('tubeName').addEventListener('input', () => {
    state.name = $('tubeName').value.trim() || 'TUBE';
    updateSpice();
    persist();
  });

  $('tubeType').addEventListener('change', () => {
    if (!modelSupports(state.modelId, $('tubeType').value)) {
      $('tubeType').value = state.type;
      return;
    }
    state.type = $('tubeType').value;
    state.params = clampParams(state.modelId, {
      ...defaultParams(state.modelId, state.type),
      ...state.params,
    });
    rebuildSliders();
    updateMultiVisibility();
    scheduleRedraw();
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

  $('btnFitGuides').addEventListener('click', () => runGuideFit());
  $('btnUndoGuide').addEventListener('click', () => {
    const vg = Number($('drawVg').value);
    setGuides(undoGuidePoint(state.guides, Number.isFinite(vg) ? vg : null));
  });
  $('btnClearGuides').addEventListener('click', () => {
    setGuides([]);
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
      setGuides(undoGuidePoint(state.guides, Number.isFinite(vg) ? vg : null));
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

  window.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find((i) => i.type.startsWith('image/'));
    if (!imageItem) return;

    const t = e.target;
    const inEditable =
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      Boolean(t?.isContentEditable);
    if (inEditable && items.some((i) => i.type === 'text/plain')) return;

    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    if (plot.image && !confirm('Replace the current datasheet image?')) return;
    loadImageBlob(file);
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

  const data = plot.pxToData(local.x, local.y);
  const vg = Number($('drawVg').value);
  if (!Number.isFinite(vg)) return;
  setGuides(
    addGuidePoint(state.guides, vg, data.vp, Math.max(0, data.ip)),
    { fit: true },
  );
}

function onPointerDown(evt) {
  if (calibrator.active) return;
  const local = plot.eventToLocal(evt);
  canvas.setPointerCapture(evt.pointerId);

  const hit = hitGuidePoint(plot, state.guides, local.x, local.y, 12);
  if (hit) {
    skipDrawClick = true;
    drag = {
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
  const guides = cloneGuides(state.guides);
  const curve = guides[drag.gi];
  if (!curve) return;
  curve.points[drag.pi] = { vp: data.vp, ip: Math.max(0, data.ip) };
  curve.points.sort((a, b) => a.vp - b.vp);
  let bestPi = 0;
  let bestD = Infinity;
  curve.points.forEach((pt, i) => {
    const d = (pt.vp - data.vp) ** 2 + (pt.ip - data.ip) ** 2;
    if (d < bestD) {
      bestD = d;
      bestPi = i;
    }
  });
  drag.pi = bestPi;
  state.guides = guides;
  plot.guides = guides;
  schedulePaint();
}

function onPointerUp() {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  if (moved) setGuides(state.guides, { fit: true });
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
  const res = await fetch('/presets/tubes.json');
  state.presets = await res.json();
  refreshPresetOptions();
  const sel = $('presetSelect');
  sel.addEventListener('change', () => {
    const preset = state.presets.find((p) => p.id === sel.value);
    if (preset) applyPreset(preset);
  });
}

restore();
bindUi();
loadPresets().then(() => {
  scheduleRedraw();
});
scheduleRedraw();
