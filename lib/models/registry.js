import * as koren from './koren.js';
import * as ayumi from './ayumi.js';
import * as immler from './immler.js';
import * as ridge from './ridge.js';

const MODELS = [koren, ayumi, immler, ridge];
const BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));

export function listModels() {
  return MODELS.map((m) => ({
    id: m.id,
    label: m.menuLabel || m.label,
    supports: [...m.supports],
  }));
}

export function getModel(id) {
  return BY_ID[id] || koren;
}

export function defaultParams(modelId, type) {
  const m = getModel(modelId);
  const normalized = type === 'tetrode' ? 'pentode' : type;
  const t = m.supports.includes(normalized) ? normalized : m.supports[0];
  return { ...(m.defaults[t] || m.defaults.triode || {}) };
}

export function modelSupports(modelId, type) {
  const normalized = type === 'tetrode' ? 'pentode' : type;
  return getModel(modelId).supports.includes(normalized);
}

export { MODELS };
