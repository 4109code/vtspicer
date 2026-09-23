/**
 * Adrian Immler–style interactive plate equations (simplified generic).
 * Steering voltage (soft + linear) + Langmuir–Child space charge + low-Va knee.
 * Pentode uses virtual anode Ahc = Eg2 + Ep/MU2.
 * @see https://adrianimmler.simplesite.com/
 */

import { softplus, uramp, fmt, fmtCap, fmtOhm } from './math.js';

export const id = 'immler';
export const label = 'Immler';
export const supports = ['triode', 'pentode'];

export const paramKeys = ['MU', 'XS', 'KS', 'KP', 'KB', 'VCT', 'MU2'];
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
    MU: 100,
    XS: 1.4,
    KS: 1060,
    KP: 600,
    KB: 12,
    VCT: 0.2,
    RGI: 2000,
    CCG: 2.3,
    CGP: 2.4,
    CCP: 0.9,
  },
  pentode: {
    MU: 8,
    XS: 1.35,
    KS: 900,
    KP: 55,
    KB: 10,
    MU2: 20,
    VCT: 0.2,
    RGI: 1000,
    CCG: 14,
    CGP: 0.85,
    CCP: 12,
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

export function triodeIp(Eg, Ep, params) {
  const eg = Eg + (params.VCT ?? 0);
  const ahc = uramp(Ep);
  const is = spaceCharge(eg, ahc, params);
  const kb = Math.max(params.KB ?? 1, 1e-6);
  // Immler-like Ia collapse as Va→0
  return is * (ahc / (ahc + kb));
}

export function pentodeIp(Eg, Ep, Eg2, params) {
  const eg = Eg + (params.VCT ?? 0);
  const eg2 = uramp(Eg2);
  const ep = uramp(Ep);
  const mu2 = Math.max(params.MU2 ?? 20, 1e-6);
  const ahc = eg2 + ep / mu2;
  const is = spaceCharge(eg, ahc, params);
  const kb = Math.max(params.KB ?? 1, 1e-6);
  return is * (ep / (ep + kb));
}

export function screenCurrent(_type, Eg, Ep, Eg2, params) {
  const eg = Eg + (params.VCT ?? 0);
  const eg2 = uramp(Eg2);
  const ep = uramp(Ep);
  const mu2 = Math.max(params.MU2 ?? 20, 1e-6);
  const ahc = eg2 + ep / mu2;
  const is = spaceCharge(eg, ahc, params);
  const kb = Math.max(params.KB ?? 1, 1e-6);
  return is * (kb / (ep + kb));
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
    return `${note}.SUBCKT ${safeName} 1 2 3 ; P G C (Triode / Immler-generic)
+ PARAMS: MU=${fmt(p.MU)} XS=${fmt(p.XS)} KS=${fmt(p.KS)} KP=${fmt(p.KP)}
+ KB=${fmt(p.KB)} VCT=${fmt(p.VCT ?? 0)} RGI=${fmtOhm(p.RGI ?? 2000)}
+ CCG=${fmtCap(p.CCG ?? 2.3)} CGP=${fmtCap(p.CGP ?? 2.4)} CCP=${fmtCap(p.CCP ?? 0.9)}
EGG 10 0 VALUE={V(2,3)+VCT}
AHC 11 0 VALUE={URAMP(V(1,3))}
STLIN 12 0 VALUE={V(10)+V(11)/MU}
STSOFT 13 0 VALUE={V(11)/KP*LOG(1+EXP(KP*(1/MU+V(10)/(1+V(11)))))}
ST 14 0 VALUE={MAX(V(12),V(13))}
IS 15 0 VALUE={PWR(URAMP(V(14)),XS)/KS}
G1 1 3 VALUE={V(15)*V(11)/(V(11)+KB)+1e-12*V(1,3)}
C1 2 3 {CCG}
C2 2 1 {CGP}
C3 1 3 {CCP}
R1 2 5 {RGI}
D3 5 3 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
.ENDS
`;
  }

  return `${note}.SUBCKT ${safeName} 1 2 3 4 ; P G1 C G2 (Pentode/tetrode / Immler-generic)
+ PARAMS: MU=${fmt(p.MU)} XS=${fmt(p.XS)} KS=${fmt(p.KS)} KP=${fmt(p.KP)}
+ KB=${fmt(p.KB)} MU2=${fmt(p.MU2 ?? 20)} VCT=${fmt(p.VCT ?? 0)} RGI=${fmtOhm(p.RGI ?? 1000)}
+ CCG=${fmtCap(p.CCG ?? 14)} CPG1=${fmtCap(p.CGP ?? 0.85)} CCP=${fmtCap(p.CCP ?? 12)}
EGG 10 0 VALUE={V(2,3)+VCT}
AHC 11 0 VALUE={URAMP(V(4,3))+URAMP(V(1,3))/MU2}
STLIN 12 0 VALUE={V(10)+V(11)/MU}
STSOFT 13 0 VALUE={V(11)/KP*LOG(1+EXP(KP*(1/MU+V(10)/(1+V(11)))))}
ST 14 0 VALUE={MAX(V(12),V(13))}
IS 15 0 VALUE={PWR(URAMP(V(14)),XS)/KS}
G1 1 3 VALUE={V(15)*URAMP(V(1,3))/(URAMP(V(1,3))+KB)+1e-12*V(1,3)}
G2 4 3 VALUE={V(15)*KB/(URAMP(V(1,3))+KB)+1e-12*V(4,3)}
C1 2 3 {CCG}
C2 1 2 {CPG1}
C3 1 3 {CCP}
R1 2 5 {RGI}
D3 5 3 DX
.MODEL DX D(IS=1N RS=1 CJO=10PF TT=1N)
.ENDS
`;
}
