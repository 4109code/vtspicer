/**
 * Duncan Munro rectifier law.
 *
 *   Ia = K * max(Vak, 0)^EX
 * which is the behavioral source
 *   K*(PWR(V(A,K),EX)+PWRS(V(A,K),EX))/2
 */

import { fmt, fmtCap, spiceSafeName, spiceComment } from './math.js';

export const id = 'duncan';
export const label = 'Duncan';
export const supports = ['diode'];

export const paramKeys = ['K', 'EX'];
export const logParams = ['K'];
export const multiGridParams = [];

export const limits = {
  K: { min: 1e-5, max: 0.05 },
  EX: { min: 1.1, max: 1.8 },
};

export const defaults = {
  diode: {
    K: 1.4e-3,
    EX: 1.5,
    CCP: 0,
  },
};

export const inverseKeys = {
  diode: ['K', 'EX'],
};

export function plateCurrent(_type, _Eg, Vak, _Eg2, params) {
  const { K, EX } = params;
  if (!(Vak > 0) || !(K > 0) || !(EX > 0)) return 0;
  return K * Math.pow(Vak, EX);
}

export function screenCurrent() {
  return 0;
}

export function generateSubckt({ name = 'RECT', type = 'diode', params, comment = '' }) {
  const safeName = spiceSafeName(name);
  const p = params;
  const note = spiceComment(comment);
  const cap = p.CCP > 0 ? `\nCP A K ${fmtCap(p.CCP)}` : '';
  return `${note}.SUBCKT ${safeName} A K ; anode cathode (Rectifier / Duncan)
+ PARAMS: K=${fmt(p.K, 6)} EX=${fmt(p.EX, 6)}
RCP A K 1G
GP A K VALUE={K*(PWR(V(A,K),EX)+PWRS(V(A,K),EX))/2}${cap}
.ENDS
`;
}
