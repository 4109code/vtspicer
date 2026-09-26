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

import { pentodeDrive, spaceCharge, pentodeE1, PENTODE_PLATE } from './koren.js';
import {
  cutoffPower,
  shiftedRatio,
  fmt,
  fmtPassives,
  PASSIVES,
  spiceSafeName,
  spiceComment,
  spiceTail,
  resolvePins,
} from './math.js';

export const id = 'karpov';
export const label = 'Karpov';
export const supports = ['pentode'];

export const paramKeys = ['MU', 'EX', 'KG1', 'KP', 'KVB', 'KS', 'KB', 'KC', 'KNEE', 'VCT'];
export const paramHints = {
  MU: 'Gain. Higher bunches the Vg curves',
  EX: 'Bend. Higher rises faster at the top',
  KG1: 'Plate scale. Higher lowers Ip',
  KP: 'Cutoff. Higher is sharper',
  KVB: 'Knee. Higher stretches the bend right',
  KS: 'Knee sharpness. 1 is the published bend. Higher squares it off',
  KB: 'Knee shift. 0 is the published law. Higher moves the bend right as Vg goes more negative',
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
  KS: { min: 1, max: 8 },
  KB: { min: 0, max: 2.5 },
  KC: { min: 5, max: 5000 },
  KNEE: { min: 0, max: 1 },
  VCT: { min: -2, max: 2 },
};

export const paramFallback = { KS: 1, KB: 0 };

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
  pentode: ['MU', 'EX', 'KG1', 'KP', 'KVB', 'KS', 'KB', 'VCT'],
};

/** Ig2-only. KC scales the cathode reference and does not enter Ip. */
export const screenKeys = {
  pentode: ['KC'],
};

/** Published tanh constants, not a rounded π. */
export const TANH_ASYMP = 1.57;
export const TANH_PI = 3.14159;

export function kneeFactor(Ep, params, Eg = 0, Eg2 = 0) {
  const kvb0 = params.KVB;
  if (!(Ep > 0) || !(kvb0 > 0)) return 0;
  const kb = params.KB == null || !Number.isFinite(Number(params.KB)) ? 0 : Number(params.KB);
  const ks = params.KS == null || !Number.isFinite(Number(params.KS)) ? 1 : Math.max(Number(params.KS), 1e-3);
  let kvb = kvb0;
  if (kb > 0 && Eg2 > 0) {
    kvb = kvb0 * shiftedRatio(pentodeDrive(0, Eg2, params), pentodeDrive(Eg, Eg2, params), kb);
  }
  const x = ks === 1 ? Ep / kvb : (Ep / kvb) ** ks;
  if ((params.KNEE ?? 0) >= 0.5) {
    return TANH_ASYMP * Math.tanh((2 / TANH_PI) * x);
  }
  return Math.atan(x);
}

/** Cathode current the screen law is measured against. No factor of 2. */
export function cathodeRef(Eg, Eg2, params) {
  const { MU, EX, KC, VCT = 0 } = params;
  return cutoffPower(Eg, Eg2, MU, EX, KC, VCT);
}

function currents(Eg, Ep, Eg2, params) {
  const ip =
    spaceCharge(pentodeDrive(Eg, Eg2, params), params.EX, params.KG1) *
    kneeFactor(Ep, params, Eg, Eg2);
  const ig2 = Math.max(0, cathodeRef(Eg, Eg2, params) - ip);
  return { ip, ig2 };
}

export function screenCurrent(_type, Eg, Ep, Eg2, params) {
  return currents(Eg, Ep, Eg2, params).ig2;
}

export function plateCurrent(_type, Eg, Ep, Eg2, params) {
  return currents(Eg, Ep, Eg2, params).ip;
}

function kneeSpice(knee, n, kvb, sharp) {
  const vp = `V(${n.P},${n.C})`;
  const tanhOf = (x) => `${TANH_ASYMP}*TANH(${x})`;
  if (!sharp && kvb === 'KVB') {
    if ((knee ?? 0) >= 0.5) return tanhOf(`2*${vp}/(KVB*${TANH_PI})`);
    return `ATAN(${vp}/KVB)`;
  }
  const x = sharp ? `PWR(${vp}/${kvb},KS)` : `${vp}/${kvb}`;
  if ((knee ?? 0) >= 0.5) return tanhOf(`(2/${TANH_PI})*(${x})`);
  return `ATAN(${x})`;
}

export function generateSubckt({ name = 'TUBE', type = 'pentode', params, comment = '', pins } = {}) {
  const safeName = spiceSafeName(name);
  const p = params;
  const n = resolvePins('pentode', pins);
  const note = spiceComment(comment);
  const pass = fmtPassives(p, 'pentode');
  const kb = p.KB ?? 0;
  const ks = p.KS ?? 1;
  const shifted = kb > 0;
  const knee = kneeSpice(p.KNEE, n, shifted ? 'V(9)' : 'KVB', ks !== 1);
  const kneeName = (p.KNEE ?? 0) >= 0.5 ? 'tanh' : 'atan';
  const kbSpec = shifted ? ` KB=${fmt(kb)}` : '';
  const ksSpec = ks !== 1 ? ` KS=${fmt(ks)}` : '';
  const e0 = shifted
    ? `\nE0 8 0 VALUE={V(${n.G2},${n.C})/KP*LOG(1+EXP(KP*(1/MU+VCT/V(${n.G2},${n.C}))))}\nRE0 8 0 1G\nEK 9 0 VALUE={KVB*PWR(MAX(V(8),1E-9)/MAX(V(7),1E-6),KB)}\n`
    : '';
  return `${note}.SUBCKT ${safeName} ${n.list.join(' ')} ; P G1 C G2 (Pentode / Karpov, ${kneeName} knee)
+ PARAMS: MU=${fmt(p.MU)} EX=${fmt(p.EX)} KG1=${fmt(p.KG1)} KC=${fmt(p.KC)} KP=${fmt(p.KP)}
+ KVB=${fmt(p.KVB)}${ksSpec} VCT=${fmt(p.VCT ?? 0)}${kbSpec} ${pass.rgi}
+ ${pass.caps}
RE1 7 0 1MEG
${pentodeE1(pins)}${e0}
G1 ${n.P} ${n.C} VALUE={${PENTODE_PLATE}/KG1*${knee}}
G2 ${n.G2} ${n.C} VALUE={URAMP(PWR(URAMP(V(${n.G2},${n.C})/MU+V(${n.G},${n.C})+VCT),EX)/KC-${PENTODE_PLATE}/KG1*${knee})}
RCP ${n.P} ${n.C} 1G
${spiceTail('pentode', { pins })}`;
}
