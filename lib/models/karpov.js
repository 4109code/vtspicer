/**
 * Eugene Karpov pentode law.
 *
 * Plate drive is Koren's (screen is the reference anode, then a knee in Ep).
 * Two knees:
 *   atan:  ATAN(Ep/KVB)
 *   tanh:  1.57*TANH(2*Ep/(KVB*3.14159))   — same π/2 asymptote, sharper knee
 *
 * Screen current is whatever cathode current the plate did not take:
 *   Ik  = max(Eg2/MU + Eg, 0)^EX / KC
 *   Ig2 = max(0, Ik - Ip)
 * KC is not Koren's KG2. Ik has no PWR+PWRS factor of 2; KG1 on the plate does.
 * The EXP(EX*LN(...)) form of Ik is undefined in cutoff.
 * URAMP matches it wherever that expression is real, and is 0 in cutoff.
 */

import { pentodeDrive, spaceCharge } from './koren.js';
import {
  fmt,
  fmtCap,
  fmtOhm,
  PASSIVES,
  spiceSafeName,
  spiceComment,
  spiceTail,
} from './math.js';

export const id = 'karpov';
export const label = 'Karpov';
export const supports = ['pentode'];

export const paramKeys = ['MU', 'EX', 'KG1', 'KP', 'KVB', 'KC', 'KNEE', 'VCT'];
export const paramHints = {
  MU: 'Gain. Higher bunches the Vg curves',
  EX: 'Bend. Higher rises faster at the top',
  KG1: 'Plate scale. Higher lowers Ip',
  KP: 'Cutoff. Higher is sharper',
  KVB: 'Knee. Higher stretches the bend right',
  KC: 'Screen scale. Higher lowers Ig2',
  KNEE: 'Knee shape',
  VCT: 'Vg shift. Moves every curve',
};
export const logParams = ['MU', 'KG1', 'KP', 'KVB', 'KC'];
export const multiGridParams = [];

export const enumParams = {
  KNEE: [
    { value: 0, label: 'atan' },
    { value: 1, label: 'tanh' },
  ],
};

export const limits = {
  MU: { min: 1, max: 200 },
  EX: { min: 0.9, max: 2 },
  KG1: { min: 50, max: 20000 },
  KP: { min: 5, max: 10000 },
  KVB: { min: 1, max: 200 },
  KC: { min: 5, max: 5000 },
  KNEE: { min: 0, max: 1 },
  VCT: { min: -2, max: 2 },
};

export const defaults = {
  pentode: {
    MU: 35,
    EX: 1.47,
    KG1: 895,
    KP: 121.2,
    KVB: 37.8,
    KC: 318,
    KNEE: 0,
    VCT: 0,
    RGI: 1000,
    CCG: 11,
    CGP: 0.2,
    CCP: 7,
  },
};

export const inverseKeys = {
  pentode: ['MU', 'EX', 'KG1', 'KP', 'KVB'],
};

/** Published tanh constants, not a rounded π. */
export const TANH_ASYMP = 1.57;
export const TANH_PI = 3.14159;

export function kneeFactor(Ep, params) {
  const kvb = params.KVB;
  if (!(Ep > 0) || !(kvb > 0)) return 0;
  if ((params.KNEE ?? 0) >= 0.5) {
    return TANH_ASYMP * Math.tanh((2 * Ep) / (kvb * TANH_PI));
  }
  return Math.atan(Ep / kvb);
}

/** Cathode current the screen law is measured against. No factor of 2. */
export function cathodeRef(Eg, Eg2, params) {
  const { MU, EX, KC, VCT = 0 } = params;
  if (!(Eg2 > 0) || !(KC > 0) || !(MU > 0) || !(EX > 0)) return 0;
  const e = Eg + VCT + Eg2 / MU;
  if (e <= 0) return 0;
  return Math.pow(e, EX) / KC;
}

function currents(Eg, Ep, Eg2, params) {
  const ip =
    spaceCharge(pentodeDrive(Eg, Eg2, params), params.EX, params.KG1) *
    kneeFactor(Ep, params);
  const ig2 = Math.max(0, cathodeRef(Eg, Eg2, params) - ip);
  return { ip, ig2 };
}

export function screenCurrent(_type, Eg, Ep, Eg2, params) {
  return currents(Eg, Ep, Eg2, params).ig2;
}

export function plateCurrent(_type, Eg, Ep, Eg2, params) {
  return currents(Eg, Ep, Eg2, params).ip;
}

function kneeSpice(knee) {
  if ((knee ?? 0) >= 0.5) return '1.57*TANH(2*V(1,3)/(KVB*3.14159))';
  return 'ATAN(V(1,3)/KVB)';
}

export function generateSubckt({ name = 'TUBE', type = 'pentode', params, comment = '' }) {
  const safeName = spiceSafeName(name);
  const p = params;
  const note = spiceComment(comment);
  const pass = PASSIVES.pentode;
  const knee = kneeSpice(p.KNEE);
  const kneeName = (p.KNEE ?? 0) >= 0.5 ? 'tanh' : 'atan';
  return `${note}.SUBCKT ${safeName} 1 2 3 4 ; P G1 C G2 (Pentode / Karpov, ${kneeName} knee)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG1=${fmt(p.KG1)} KC=${fmt(p.KC)} KP=${fmt(p.KP)}
+ KVB=${fmt(p.KVB)} VCT=${fmt(p.VCT ?? 0)} RGI=${fmtOhm(p.RGI ?? pass.RGI)}
+ CCG=${fmtCap(p.CCG ?? pass.CCG)} CPG1=${fmtCap(p.CGP ?? pass.CGP)} CCP=${fmtCap(p.CCP ?? pass.CCP)}
RE1 7 0 1MEG
E1 7 0 VALUE={V(4,3)/KP*LOG(1+EXP(KP*(1/MU+(V(2,3)+VCT)/V(4,3))))}
G1 1 3 VALUE={(PWR(V(7),EX)+PWRS(V(7),EX))/KG1*${knee}}
G2 4 3 VALUE={URAMP(PWR(URAMP(V(4,3)/MU+V(2,3)+VCT),EX)/KC-(PWR(V(7),EX)+PWRS(V(7),EX))/KG1*${knee})}
RCP 1 3 1G
${spiceTail('pentode')}`;
}
