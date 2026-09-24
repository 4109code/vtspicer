/**
 * Norman Koren phenomenological plate equations + PSpice .SUBCKT.
 * @see https://www.normankoren.com/Audio/Tubemodspice_article.html
 */

import {
  softplus,
  fmt,
  fmtPassives,
  fmtChild,
  childLawSources,
  PASSIVES,
  spiceSafeName,
  spiceComment,
  spiceTail,
} from './math.js';

export const id = 'koren';
export const label = 'Koren';
export const supports = ['triode', 'pentode'];

export const paramKeys = ['MU', 'EX', 'KG1', 'KP', 'KVB', 'KG2', 'VCT'];
export const paramHints = {
  MU: 'Gain. Higher bunches the Vg curves',
  EX: 'Bend. Higher rises faster at the top',
  KG1: 'Plate scale. Higher lowers Ip',
  KP: 'Cutoff. Higher is sharper',
  KVB: {
    triode: 'Knee. Higher rounds the low-Vp bend',
    pentode: 'Knee. Higher stretches the bend right',
  },
  KG2: 'Screen scale. Higher lowers Ig2',
  VCT: 'Vg shift. Moves every curve',
};
export const logParams = ['MU', 'KG1', 'KP', 'KVB', 'KG2'];
export const multiGridParams = ['KG2'];

export const limits = {
  MU: { min: 1, max: 600 },
  EX: { min: 1.0, max: 3.0 },
  KG1: { min: 10, max: 20000 },
  KP: { min: 5, max: 2000 },
  KVB: { min: 0.05, max: 5000 },
  KG2: { min: 50, max: 50000 },
  VCT: { min: -2, max: 2 },
};

export const defaults = {
  triode: {
    MU: 35,
    EX: 1.4,
    KG1: 1060,
    KP: 600,
    KVB: 300,
    VCT: 0,
    ...PASSIVES.triode,
  },
  pentode: {
    MU: 35,
    EX: 1.35,
    KG1: 890,
    KG2: 4200,
    KP: 60,
    KVB: 24,
    VCT: 0,
    ...PASSIVES.pentode,
  },
};

export const inverseKeys = {
  triode: ['MU', 'EX', 'KG1', 'KP', 'KVB'],
  pentode: ['MU', 'EX', 'KG1', 'KP', 'KVB'],
};

/** Ig2-only. KG2 does not enter the plate law. */
export const screenKeys = {
  pentode: ['KG2'],
};

/** (PWR(E1,EX)+PWRS(E1,EX))/KG1 — zero for a non-positive drive. */
export function spaceCharge(E1, EX, KG1) {
  if (E1 <= 0 || !(KG1 > 0)) return 0;
  return (2 * Math.pow(E1, EX)) / KG1;
}

/** Koren pentode effective voltage. Screen is the reference anode. */
export function pentodeDrive(Eg, Eg2, params) {
  const { MU, KP, VCT = 0 } = params;
  if (!(Eg2 > 0) || !(KP > 0) || !(MU > 0)) return 0;
  const eg = Eg + VCT;
  const arg = KP * (1 / MU + eg / Eg2);
  return (Eg2 / KP) * softplus(arg);
}

export function triodeIp(Eg, Ep, params) {
  const { MU, EX, KG1, KP, KVB, VCT = 0 } = params;
  if (!(Ep > 0) || !(KG1 > 0) || !(KP > 0) || !(MU > 0)) return 0;
  const eg = Eg + VCT;
  const denom = Math.sqrt(KVB + Ep * Ep);
  const arg = KP * (1 / MU + eg / denom);
  const E1 = (Ep / KP) * softplus(arg);
  return spaceCharge(E1, EX, KG1);
}

export function pentodeIp(Eg, Ep, Eg2, params) {
  const { EX, KG1, KVB } = params;
  if (!(Ep >= 0) || !(KVB > 0)) return 0;
  return spaceCharge(pentodeDrive(Eg, Eg2, params), EX, KG1) * Math.atan(Ep / KVB);
}

export function screenIg2(Eg, Eg2, params) {
  const { MU, EX = 1.5, KG2 = 4500, VCT = 0 } = params;
  if (!(Eg2 > 0) || !(KG2 > 0) || !(MU > 0) || !(EX > 0)) return 0;
  const eg = Eg + VCT;
  const e = eg + Eg2 / MU;
  if (e <= 0) return 0;
  return Math.pow(e, EX) / KG2;
}

/** Screen current vs plate voltage (Koren Ig2 is Ep-independent). */
export function screenCurrent(_type, Eg, _Ep, Eg2, params) {
  return screenIg2(Eg, Eg2, params);
}

export function plateCurrent(type, Eg, Ep, Eg2, params) {
  if (type === 'triode') return triodeIp(Eg, Ep, params);
  return pentodeIp(Eg, Ep, Eg2, params);
}

export function generateSubckt({ name = 'TUBE', type = 'triode', params, comment = '' }) {
  const safeName = spiceSafeName(name);
  const p = params;
  const note = spiceComment(comment);
  const pass = fmtPassives(p, type);
  const child = p.gridLaw === 'child';
  const gridSpec = child ? fmtChild(p) : pass.rgi;
  const tail = child
    ? spiceTail(type, { gridDiode: false }).replace('.ENDS\n', `${childLawSources()}\n.ENDS\n`)
    : spiceTail(type);

  if (type === 'triode') {
    return `${note}.SUBCKT ${safeName} 1 2 3 ; P G C (Triode / Koren)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG1=${fmt(p.KG1)} KP=${fmt(p.KP)}
+ KVB=${fmt(p.KVB)} VCT=${fmt(p.VCT ?? 0)} ${gridSpec}
+ ${pass.caps}
E1 7 0 VALUE={V(1,3)/KP*LOG(1+EXP(KP*(1/MU+(V(2,3)+VCT)/SQRT(KVB+V(1,3)*V(1,3)))))}
RE1 7 0 1G
G1 1 3 VALUE={(PWR(V(7),EX)+PWRS(V(7),EX))/KG1}
RCP 1 3 1G
${tail}`;
  }

  return `${note}.SUBCKT ${safeName} 1 2 3 4 ; P G1 C G2 (Pentode/tetrode / Koren)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG1=${fmt(p.KG1)} KG2=${fmt(p.KG2 ?? 4500)} KP=${fmt(p.KP)}
+ KVB=${fmt(p.KVB)} VCT=${fmt(p.VCT ?? 0)} ${gridSpec}
+ ${pass.caps}
RE1 7 0 1MEG
E1 7 0 VALUE={V(4,3)/KP*LOG(1+EXP(KP*(1/MU+(V(2,3)+VCT)/V(4,3))))}
G1 1 3 VALUE={(PWR(V(7),EX)+PWRS(V(7),EX))/KG1*ATAN(V(1,3)/KVB)}
G2 4 3 VALUE={(EXP(EX*(LOG((V(4,3)/MU)+V(2,3)))))/KG2}
RCP 1 3 1G
${tail}`;
}
