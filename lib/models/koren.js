/**
 * Norman Koren phenomenological plate equations + PSpice .SUBCKT.
 * @see https://www.normankoren.com/Audio/Tubemodspice_article.html
 */

import { softplus, sgn, fmt, fmtCap, fmtOhm } from './math.js';

export const id = 'koren';
export const label = 'Koren';
export const supports = ['triode', 'pentode'];

export const paramKeys = ['MU', 'EX', 'KG1', 'KP', 'KVB', 'KG2', 'VCT'];
export const logParams = ['MU', 'KG1', 'KP', 'KVB', 'KG2'];
export const multiGridParams = ['KG2'];

export const limits = {
  MU: { min: 1, max: 200 },
  EX: { min: 1.0, max: 2.0 },
  KG1: { min: 50, max: 20000 },
  KP: { min: 5, max: 2000 },
  KVB: { min: 1, max: 2000 },
  KG2: { min: 100, max: 50000 },
  VCT: { min: -2, max: 2 },
};

export const defaults = {
  triode: {
    MU: 100,
    EX: 1.4,
    KG1: 1060,
    KP: 600,
    KVB: 300,
    VCT: 0,
    RGI: 2000,
    CCG: 2.3,
    CGP: 2.4,
    CCP: 0.9,
  },
  pentode: {
    MU: 7.9,
    EX: 1.35,
    KG1: 890,
    KG2: 4200,
    KP: 60,
    KVB: 24,
    VCT: 0,
    RGI: 1000,
    CCG: 14,
    CGP: 0.85,
    CCP: 12,
  },
};

export const inverseKeys = {
  triode: ['MU', 'EX', 'KG1', 'KP', 'KVB'],
  pentode: ['MU', 'EX', 'KG1', 'KP', 'KVB'],
};

export function triodeIp(Eg, Ep, params) {
  const { MU, EX, KG1, KP, KVB, VCT = 0 } = params;
  if (!(Ep > 0) || !(KG1 > 0) || !(KP > 0) || !(MU > 0)) return 0;
  const eg = Eg + VCT;
  const denom = Math.sqrt(KVB + Ep * Ep);
  const arg = KP * (1 / MU + eg / denom);
  const E1 = (Ep / KP) * softplus(arg);
  if (E1 <= 0) return 0;
  return (Math.pow(E1, EX) / KG1) * (1 + sgn(E1));
}

export function pentodeIp(Eg, Ep, Eg2, params) {
  const { MU, EX, KG1, KP, KVB, VCT = 0 } = params;
  if (!(Eg2 > 0) || !(Ep >= 0) || !(KG1 > 0) || !(KP > 0) || !(MU > 0)) return 0;
  const eg = Eg + VCT;
  const arg = KP * (1 / MU + eg / Eg2);
  const E1 = (Eg2 / KP) * softplus(arg);
  if (E1 <= 0) return 0;
  return (Math.pow(E1, EX) / KG1) * (1 + sgn(E1)) * Math.atan(Ep / KVB);
}

export function screenIg2(Eg, Eg2, params) {
  const { MU, KG2 = 4500, VCT = 0 } = params;
  if (!(Eg2 > 0) || !(KG2 > 0) || !(MU > 0)) return 0;
  const eg = Eg + VCT;
  const e = eg + Eg2 / MU;
  if (e <= 0) return 0;
  return Math.pow(e, 1.5) / KG2;
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
  const safeName = String(name).replace(/[^\w.-]/g, '_') || 'TUBE';
  const p = params;
  const note = comment ? `* ${comment}\n` : '';

  if (type === 'triode') {
    return `${note}.SUBCKT ${safeName} 1 2 3 ; P G C (Triode / Koren)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG1=${fmt(p.KG1)} KP=${fmt(p.KP)}
+ KVB=${fmt(p.KVB)} VCT=${fmt(p.VCT ?? 0)} RGI=${fmtOhm(p.RGI ?? 2000)}
+ CCG=${fmtCap(p.CCG ?? 2.3)} CGP=${fmtCap(p.CGP ?? 2.4)} CCP=${fmtCap(p.CCP ?? 0.9)}
E1 7 0 VALUE={V(1,3)/KP*LOG(1+EXP(KP*(1/MU+(V(2,3)+VCT)/SQRT(KVB+V(1,3)*V(1,3)))))}
RE1 7 0 1G
G1 1 3 VALUE={(PWR(V(7),EX)+PWRS(V(7),EX))/KG1}
RCP 1 3 1G
C1 2 3 {CCG}
C2 2 1 {CGP}
C3 1 3 {CCP}
R1 2 5 {RGI}
D3 5 3 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
.ENDS
`;
  }

  return `${note}.SUBCKT ${safeName} 1 2 3 4 ; P G1 C G2 (Pentode/tetrode / Koren)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG1=${fmt(p.KG1)} KG2=${fmt(p.KG2 ?? 4500)} KP=${fmt(p.KP)}
+ KVB=${fmt(p.KVB)} VCT=${fmt(p.VCT ?? 0)} RGI=${fmtOhm(p.RGI ?? 1000)}
+ CCG=${fmtCap(p.CCG ?? 14)} CPG1=${fmtCap(p.CGP ?? 0.85)} CCP=${fmtCap(p.CCP ?? 12)}
RE1 7 0 1MEG
E1 7 0 VALUE={V(4,3)/KP*LOG(1+EXP(KP*(1/MU+(V(2,3)+VCT)/V(4,3))))}
G1 1 3 VALUE={(PWR(V(7),EX)+PWRS(V(7),EX))/KG1*ATAN(V(1,3)/KVB)}
G2 4 3 VALUE={(EXP(EX*(LOG((V(4,3)/MU)+V(2,3)))))/KG2}
RCP 1 3 1G
C1 2 3 {CCG}
C2 1 2 {CPG1}
C3 1 3 {CCP}
R1 2 5 {RGI}
D3 5 3 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
.ENDS
`;
}
