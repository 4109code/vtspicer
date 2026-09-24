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

export const paramKeys = ['MU', 'EX', 'KG1', 'KP', 'KVB', 'KG2', 'KVC', 'VCT'];
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
  KVC: 'Screen knee. 0 keeps Ig2 flat. Higher mirrors the plate knee',
  VCT: 'Vg shift. Moves every curve',
};
export const logParams = ['MU', 'KG1', 'KP', 'KVB', 'KG2'];
export const multiGridParams = ['KG2', 'KVC'];

export const limits = {
  MU: { min: 1, max: 600 },
  EX: { min: 1.0, max: 3.0 },
  KG1: { min: 10, max: 20000 },
  KP: { min: 5, max: 2000 },
  KVB: { min: 0.05, max: 5000 },
  KG2: { min: 50, max: 50000 },
  KVC: { min: 0, max: 4 },
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
    KVC: 0,
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

/** Ig2-only. KG2 does not enter the plate law. KVC joins only after it is turned on. */
export const screenKeys = {
  pentode: ['KG2'],
};

export function screenKeyList(type, params) {
  const keys = [...(screenKeys[type] || [])];
  if (type === 'pentode' && (params?.KVC ?? 0) > 0) keys.push('KVC');
  return keys;
}

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

export function screenIg2(Eg, Eg2, params, Ep = 0) {
  const { MU, EX = 1.5, KG2 = 4500, KVB, VCT = 0, KVC = 0 } = params;
  if (KVC > 0) {
    if (!(KG2 > 0) || !(KVB > 0)) return 0;
    const E1 = pentodeDrive(Eg, Eg2, params);
    return (E1 / KG2) * (KVC - Math.atan(Math.max(Ep, 0) / KVB));
  }
  if (!(Eg2 > 0) || !(KG2 > 0) || !(MU > 0) || !(EX > 0)) return 0;
  const eg = Eg + VCT;
  const e = eg + Eg2 / MU;
  if (e <= 0) return 0;
  return Math.pow(e, EX) / KG2;
}

/** Screen current vs plate voltage. Flat in Ep until KVC is above 0. */
export function screenCurrent(_type, Eg, Ep, Eg2, params) {
  return screenIg2(Eg, Eg2, params, Ep);
}

export const PENTODE_E1 =
  'E1 7 0 VALUE={V(4,3)/KP*LOG(1+EXP(KP*(1/MU+(V(2,3)+VCT)/V(4,3))))}';
export const PENTODE_PLATE = '(PWR(V(7),EX)+PWRS(V(7),EX))';

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
  const gurskii = type !== 'triode' && (p.KVC ?? 0) > 0;
  const gridSpec = child ? fmtChild(p) : pass.rgi;
  const kvcSpec = gurskii ? ` KVC=${fmt(p.KVC)}` : '';
  const strapped =
    gurskii && p.KG1 > 0 && p.KG2 > 0
      ? `* Triode-strapped KG1=${fmt(
          (4 * p.KG1 * p.KG2) / ((2 * p.KVC - Math.PI) * (2 * p.KG1 + Math.PI * p.KG2)),
        )}\n`
      : '';
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
+ KVB=${fmt(p.KVB)} VCT=${fmt(p.VCT ?? 0)} ${gridSpec}${kvcSpec}
+ ${pass.caps}
${strapped}RE1 7 0 1MEG
${PENTODE_E1}
G1 1 3 VALUE={${PENTODE_PLATE}/KG1*ATAN(V(1,3)/KVB)}
G2 4 3 VALUE={${
    gurskii
      ? 'V(7)/KG2*(KVC-ATAN(V(1,3)/KVB))'
      : '(EXP(EX*(LOG((V(4,3)/MU)+V(2,3)))))/KG2'
  }}
RCP 1 3 1G
${tail}`;
}
