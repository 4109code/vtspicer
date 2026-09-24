/**
 * Adrian Immler–style interactive plate equations (simplified generic).
 * Steering voltage (soft + linear) + Langmuir–Child space charge + low-Va knee.
 * Pentode uses virtual anode Ahc = Eg2 + Ep/MU2.
 */

import {
  softplus,
  uramp,
  fmt,
  fmtCap,
  fmtOhm,
  PASSIVES,
  spiceSafeName,
  spiceComment,
  spiceTail,
} from './math.js';

export const id = 'immler';
export const label = 'Immler';
export const supports = ['triode', 'pentode'];

export const paramKeys = ['MU', 'XS', 'KS', 'KP', 'KB', 'VCT', 'MU2'];
export const paramHints = {
  MU: 'Gain. Higher bunches the Vg curves',
  XS: 'Bend. Higher rises faster at the top',
  KS: 'Current scale. Higher lowers Ia',
  KP: 'Cutoff. Higher is sharper',
  KB: {
    triode: 'Low-Vp knee. Higher is rounder',
    pentode: 'Knee and screen. Higher raises Ig2',
  },
  VCT: 'Vg shift. Moves every curve',
  MU2: 'Plate slope. Higher stays flatter',
};
export const logParams = ['MU', 'KS', 'KP', 'KB', 'MU2'];
export const multiGridParams = ['MU2'];

export const limits = {
  MU: { min: 1, max: 200 },
  XS: { min: 1.1, max: 1.8 },
  KS: { min: 50, max: 50000 },
  KP: { min: 5, max: 2000 },
  KB: { min: 0.5, max: 200 },
  VCT: { min: -1, max: 2 },
  MU2: { min: 1, max: 80 },
};

export const defaults = {
  triode: {
    MU: 35,
    XS: 1.4,
    KS: 1060,
    KP: 600,
    KB: 12,
    VCT: 0.2,
    ...PASSIVES.triode,
  },
  pentode: {
    MU: 35,
    XS: 1.35,
    KS: 900,
    KP: 55,
    KB: 10,
    MU2: 20,
    VCT: 0.2,
    ...PASSIVES.pentode,
  },
};

export const inverseKeys = {
  triode: ['MU', 'XS', 'KS', 'KP', 'KB'],
  pentode: ['MU', 'XS', 'KS', 'KP', 'KB', 'MU2'],
};

function spaceCharge(eg, ahc, params) {
  const { MU, XS, KS, KP } = params;
  if (!(ahc >= 0) || !(KS > 0) || !(MU > 0) || !(KP > 0)) return 0;
  const stLin = eg + ahc / MU;
  const stSoft = (ahc / KP) * softplus(KP * (1 / MU + eg / (1 + ahc)));
  const st = Math.max(stLin, stSoft);
  if (st <= 0) return 0;
  return Math.pow(st, XS) / KS;
}

function triodeIp(Eg, Ep, params) {
  const eg = Eg + (params.VCT ?? 0);
  const ahc = uramp(Ep);
  const is = spaceCharge(eg, ahc, params);
  const kb = Math.max(params.KB ?? 1, 1e-6);
  // Ia collapses as Va→0.
  return is * (ahc / (ahc + kb));
}

function pentodeCurrents(Eg, Ep, Eg2, params) {
  const eg = Eg + (params.VCT ?? 0);
  const eg2 = uramp(Eg2);
  const ep = uramp(Ep);
  const mu2 = Math.max(params.MU2 ?? 20, 1e-6);
  const ahc = eg2 + ep / mu2;
  const is = spaceCharge(eg, ahc, params);
  const kb = Math.max(params.KB ?? 1, 1e-6);
  const denom = ep + kb;
  return { ip: is * (ep / denom), ig2: is * (kb / denom) };
}

export function screenCurrent(_type, Eg, Ep, Eg2, params) {
  return pentodeCurrents(Eg, Ep, Eg2, params).ig2;
}

export function plateCurrent(type, Eg, Ep, Eg2, params) {
  if (type === 'triode') return triodeIp(Eg, Ep, params);
  return pentodeCurrents(Eg, Ep, Eg2, params).ip;
}

export function generateSubckt({ name = 'TUBE', type = 'triode', params, comment = '' }) {
  const safeName = spiceSafeName(name);
  const p = params;
  const note = spiceComment(comment);
  const pass = type === 'triode' ? PASSIVES.triode : PASSIVES.pentode;

  if (type === 'triode') {
    return `${note}.SUBCKT ${safeName} 1 2 3 ; P G C (Triode / Immler-generic)
+ PARAMS: MU=${fmt(p.MU)} XS=${fmt(p.XS)} KS=${fmt(p.KS)} KP=${fmt(p.KP)}
+ KB=${fmt(p.KB)} VCT=${fmt(p.VCT ?? 0)} RGI=${fmtOhm(p.RGI ?? pass.RGI)}
+ CCG=${fmtCap(p.CCG ?? pass.CCG)} CGP=${fmtCap(p.CGP ?? pass.CGP)} CCP=${fmtCap(p.CCP ?? pass.CCP)}
EGG 10 0 VALUE={V(2,3)+VCT}
AHC 11 0 VALUE={URAMP(V(1,3))}
STLIN 12 0 VALUE={V(10)+V(11)/MU}
STSOFT 13 0 VALUE={V(11)/KP*LOG(1+EXP(KP*(1/MU+V(10)/(1+V(11)))))}
ST 14 0 VALUE={MAX(V(12),V(13))}
IS 15 0 VALUE={PWR(URAMP(V(14)),XS)/KS}
G1 1 3 VALUE={V(15)*V(11)/(V(11)+KB)+1e-12*V(1,3)}
${spiceTail('triode')}`;
  }

  return `${note}.SUBCKT ${safeName} 1 2 3 4 ; P G1 C G2 (Pentode/tetrode / Immler-generic)
+ PARAMS: MU=${fmt(p.MU)} XS=${fmt(p.XS)} KS=${fmt(p.KS)} KP=${fmt(p.KP)}
+ KB=${fmt(p.KB)} MU2=${fmt(p.MU2 ?? 20)} VCT=${fmt(p.VCT ?? 0)} RGI=${fmtOhm(p.RGI ?? pass.RGI)}
+ CCG=${fmtCap(p.CCG ?? pass.CCG)} CPG1=${fmtCap(p.CGP ?? pass.CGP)} CCP=${fmtCap(p.CCP ?? pass.CCP)}
EGG 10 0 VALUE={V(2,3)+VCT}
AHC 11 0 VALUE={URAMP(V(4,3))+URAMP(V(1,3))/MU2}
STLIN 12 0 VALUE={V(10)+V(11)/MU}
STSOFT 13 0 VALUE={V(11)/KP*LOG(1+EXP(KP*(1/MU+V(10)/(1+V(11)))))}
ST 14 0 VALUE={MAX(V(12),V(13))}
IS 15 0 VALUE={PWR(URAMP(V(14)),XS)/KS}
G1 1 3 VALUE={V(15)*URAMP(V(1,3))/(URAMP(V(1,3))+KB)+1e-12*V(1,3)}
G2 4 3 VALUE={V(15)*KB/(URAMP(V(1,3))+KB)+1e-12*V(4,3)}
${spiceTail('pentode')}`;
}
