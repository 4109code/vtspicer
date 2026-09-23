/**
 * Backward-compatible Koren entry + shared multi-model helpers.
 * New code should prefer `/lib/tube.js` and `/lib/models/*`.
 */

export {
  softplus,
  parseVgList,
} from './models/math.js';

export {
  triodeIp,
  pentodeIp,
  screenIg2,
  limits as PARAM_LIMITS,
} from './models/koren.js';
export {
  listModels,
  getModel,
  defaultParams,
  modelSupports,
} from './models/registry.js';

import * as korenModel from './models/koren.js';
import {
  plateCurrent as plateCurrentM,
  clampParams as clampParamsM,
  curveFamily as curveFamilyM,
  inverseFitStep as inverseFitStepM,
  generateSubckt as generateSubcktM,
} from './tube.js';

export function plateCurrent(type, Eg, Ep, Eg2, params) {
  return plateCurrentM('koren', type, Eg, Ep, Eg2, params);
}

export function clampParams(params) {
  return clampParamsM('koren', params);
}

export function curveFamily(type, params, opts) {
  return curveFamilyM('koren', type, params, opts);
}

export function inverseFitStep(type, params, Eg, Ep, Eg2, targetIp, activeKeys, damping = 0.5) {
  return inverseFitStepM('koren', type, params, Eg, Ep, Eg2, targetIp, activeKeys, damping);
}

export function generateSubckt(opts) {
  return generateSubcktM({ ...opts, modelId: opts.modelId || 'koren' });
}

export { korenModel };
