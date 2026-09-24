/**
 * Ridge plate equations — original phenomenological model for datasheet fitting.
 *
 * A smooth control voltage (softplus ridge) feeds a space-charge law. Triode
 * plate current then rounds off at low Va. Pentode cathode current is set by
 * a virtual anode (screen, plus a little plate), then split: the plate takes
 * a rising share through the knee and the screen keeps the rest, so Ig2 falls
 * as Ep rises.
 *
 *   u   = softplus(KP * (Eg + Va/MU)) / KP
 *   Ik  = u^EX / KG
 *   triode:  Va = Ep,            Ip = Ik * Va/(Va+KN)
 *   pentode: Va = Eg2 + Ep/MU2,  fp = (1-RS) * Ep/(Ep+KN)
 *            Ip = Ik * fp,       Ig2 = Ik * (1-fp)
 *
 * JS uses the same stable softplus as the .SUBCKT:
 *   softplus(x) = max(x,0) + ln(1 + exp(-|x|))
 */

import {
  uramp,
  fmt,
  fmtCap,
  fmtOhm,
  PASSIVES,
  spiceSafeName,
  spiceComment,
  spiceTail,
} from './math.js';

export const id = 'ridge';
export const label = 'Ridge';
export const menuLabel = 'Ridge (new)';
export const supports = ['triode', 'pentode'];

export const paramKeys = ['MU', 'EX', 'KG', 'KP', 'KN', 'RS', 'MU2', 'VCT'];
export const paramHints = {
  MU: 'Gain. Higher bunches the Vg curves',
  EX: 'Bend. Higher rises faster at the top',
  KG: 'Current scale. Higher lowers Ia',
  KP: 'Cutoff. Higher is sharper',
  KN: {
    triode: 'Low-Vp knee. Higher is rounder',
    pentode: 'Knee width. Higher is softer',
  },
  RS: 'Screen left at high Vp. Higher raises Ig2',
  MU2: 'Plate slope. Higher stays flatter',
  VCT: 'Vg shift. Moves every curve',
};
export const logParams = ['MU', 'KG', 'KP', 'KN', 'MU2'];
export const multiGridParams = ['RS', 'MU2'];

export const limits = {
  MU: { min: 1, max: 200 },
  EX: { min: 1.1, max: 1.8 },
  KG: { min: 50, max: 50000 },
  KP: { min: 0.15, max: 12 },
  KN: { min: 1, max: 250 },
  RS: { min: 0.02, max: 0.55 },
  MU2: { min: 2, max: 80 },
  VCT: { min: -1, max: 2 },
};

export const defaults = {
  triode: {
    MU: 35,
    EX: 1.4,
    KG: 620,
    KP: 2.2,
    KN: 18,
    VCT: 0.15,
    ...PASSIVES.triode,
  },
  pentode: {
    MU: 35,
    EX: 1.35,
    KG: 300,
    KP: 1.6,
    KN: 28,
    RS: 0.14,
    MU2: 22,
    VCT: 0.1,
    ...PASSIVES.pentode,
  },
};

export const inverseKeys = {
  triode: ['MU', 'EX', 'KG', 'KP', 'KN'],
  pentode: ['MU', 'EX', 'KG', 'KP', 'KN', 'RS', 'MU2'],
};

/** RS is the high-Vp screen share. MU2 changes the shared cathode current. */
export const screenKeys = {
  pentode: ['RS', 'MU2'],
};

/** Stable softplus, identical to MAX(x,0)+LOG(1+EXP(-ABS(x))). */
function ridgeSoftplus(x) {
  const ax = Math.abs(x);
  const tail = ax > 40 ? 0 : Math.exp(-ax);
  return Math.max(x, 0) + Math.log1p(tail);
}

function cathode(eg, va, params) {
  const mu = Math.max(params.MU, 1e-9);
  const kp = Math.max(params.KP, 1e-9);
  const kg = Math.max(params.KG, 1e-9);
  const ex = params.EX;
  if (!(va >= 0) || !(ex > 0)) return 0;
  const u = ridgeSoftplus(kp * (eg + va / mu)) / kp;
  if (!(u > 0)) return 0;
  return Math.pow(u, ex) / kg;
}

function plateFraction(ep, params) {
  const kn = Math.max(params.KN ?? 1, 1e-9);
  const rs = Math.min(0.95, Math.max(0, params.RS ?? 0.14));
  return (1 - rs) * (ep / (ep + kn));
}

function triodeIp(Eg, Ep, params) {
  const eg = Eg + (params.VCT ?? 0);
  const va = uramp(Ep);
  if (!(va > 0)) return 0;
  const ik = cathode(eg, va, params);
  const kn = Math.max(params.KN ?? 1, 1e-9);
  return ik * (va / (va + kn));
}

function pentodeCurrents(Eg, Ep, Eg2, params) {
  const eg = Eg + (params.VCT ?? 0);
  const eg2 = uramp(Eg2);
  const ep = uramp(Ep);
  const mu2 = Math.max(params.MU2 ?? 20, 1e-9);
  const va = eg2 + ep / mu2;
  const ik = cathode(eg, va, params);
  const fp = plateFraction(ep, params);
  return { ip: ik * fp, ig2: ik * (1 - fp) };
}

export function screenCurrent(type, Eg, Ep, Eg2, params) {
  if (type === 'triode') return 0;
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
    return `${note}.SUBCKT ${safeName} 1 2 3 ; P G C (Triode / Ridge)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG=${fmt(p.KG)} KP=${fmt(p.KP)}
+ KN=${fmt(p.KN)} VCT=${fmt(p.VCT ?? 0)} RGI=${fmtOhm(p.RGI ?? pass.RGI)}
+ CCG=${fmtCap(p.CCG ?? pass.CCG)} CGP=${fmtCap(p.CGP ?? pass.CGP)} CCP=${fmtCap(p.CCP ?? pass.CCP)}
EGG 10 0 VALUE={V(2,3)+VCT}
VA 11 0 VALUE={URAMP(V(1,3))}
EL 12 0 VALUE={V(10)+V(11)/MU}
ARG 13 0 VALUE={KP*V(12)}
ST 14 0 VALUE={(MAX(V(13),0)+LOG(1+EXP(-ABS(V(13)))))/KP}
IK 15 0 VALUE={PWR(URAMP(V(14)),EX)/KG}
G1 1 3 VALUE={V(15)*V(11)/(V(11)+KN)+1e-12*V(1,3)}
${spiceTail('triode')}`;
  }

  return `${note}.SUBCKT ${safeName} 1 2 3 4 ; P G1 C G2 (Pentode/tetrode / Ridge)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG=${fmt(p.KG)} KP=${fmt(p.KP)}
+ KN=${fmt(p.KN)} RS=${fmt(p.RS ?? 0.14)} MU2=${fmt(p.MU2 ?? 22)} VCT=${fmt(p.VCT ?? 0)}
+ RGI=${fmtOhm(p.RGI ?? pass.RGI)}
+ CCG=${fmtCap(p.CCG ?? pass.CCG)} CPG1=${fmtCap(p.CGP ?? pass.CGP)} CCP=${fmtCap(p.CCP ?? pass.CCP)}
EGG 10 0 VALUE={V(2,3)+VCT}
VA 11 0 VALUE={URAMP(V(4,3))+URAMP(V(1,3))/MU2}
EL 12 0 VALUE={V(10)+V(11)/MU}
ARG 13 0 VALUE={KP*V(12)}
ST 14 0 VALUE={(MAX(V(13),0)+LOG(1+EXP(-ABS(V(13)))))/KP}
IK 15 0 VALUE={PWR(URAMP(V(14)),EX)/KG}
FP 16 0 VALUE={(1-RS)*URAMP(V(1,3))/(URAMP(V(1,3))+KN)}
G1 1 3 VALUE={V(15)*V(16)+1e-12*V(1,3)}
G2 4 3 VALUE={V(15)*(1-V(16))+1e-12*V(4,3)}
${spiceTail('pentode')}`;
}
