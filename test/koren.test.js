import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  softplus,
  triodeIp,
  pentodeIp,
  screenIg2,
  parseVgList,
  curveFamily,
  clampParams,
  inverseFitStep,
} from '../lib/koren.js';
import { generateSubckt } from '../lib/spice.js';

describe('softplus', () => {
  it('matches log1p(exp(x)) in the middle range', () => {
    assert.ok(Math.abs(softplus(0) - Math.LN2) < 1e-12);
    assert.ok(Math.abs(softplus(2) - Math.log1p(Math.exp(2))) < 1e-12);
  });

  it('is asymptotically x for large x', () => {
    assert.equal(softplus(50), 50);
  });
});

describe('triodeIp (12AX7-like)', () => {
  const p = { MU: 100, EX: 1.4, KG1: 1060, KP: 600, KVB: 300, VCT: 0 };

  it('gives positive current near typical operating point', () => {
    const ip = triodeIp(-1, 250, p);
    assert.ok(ip > 0.0005 && ip < 0.005, `ip=${ip}`);
  });

  it('is near zero deep in cutoff', () => {
    const ip = triodeIp(-4, 100, p);
    assert.ok(ip < 1e-5, `ip=${ip}`);
  });

  it('increases with less negative Vg at fixed Vp', () => {
    const a = triodeIp(-2, 250, p);
    const b = triodeIp(-1, 250, p);
    assert.ok(b > a);
  });
});

describe('pentodeIp / screenIg2 (6550-like)', () => {
  const p = {
    MU: 7.9,
    EX: 1.35,
    KG1: 890,
    KG2: 4200,
    KP: 60,
    KVB: 24,
    VCT: 0,
  };

  it('shows knee behavior vs plate voltage', () => {
    const low = pentodeIp(0, 20, 300, p);
    const high = pentodeIp(0, 300, 300, p);
    assert.ok(high > low);
    assert.ok(high > 0.1, `high=${high}`);
  });

  it('screen current is positive when in conduction', () => {
    const ig2 = screenIg2(0, 300, p);
    assert.ok(ig2 > 0);
  });
});

describe('parseVgList', () => {
  it('parses colon ranges', () => {
    assert.deepEqual(parseVgList('0:-1:-3'), [0, -1, -2, -3]);
  });

  it('parses comma lists', () => {
    assert.deepEqual(parseVgList('0, -0.5, -1'), [0, -0.5, -1]);
  });
});

describe('curveFamily', () => {
  it('returns one curve per Vg', () => {
    const curves = curveFamily(
      'triode',
      { MU: 100, EX: 1.4, KG1: 1060, KP: 600, KVB: 300 },
      { vgList: [0, -1], vpMax: 100, vpSteps: 11 },
    );
    assert.equal(curves.length, 2);
    assert.equal(curves[0].points.length, 11);
  });
});

describe('inverseFitStep', () => {
  it('moves KG1 to reduce residual at a sample point', () => {
    const p0 = { MU: 100, EX: 1.4, KG1: 2000, KP: 600, KVB: 300, VCT: 0 };
    const eg = 0;
    const ep = 250;
    const target = triodeIp(eg, ep, { ...p0, KG1: 1060 });
    let p = { ...p0 };
    for (let i = 0; i < 40; i++) {
      p = inverseFitStep('triode', p, eg, ep, 0, target, ['KG1'], 0.8);
    }
    const ip = triodeIp(eg, ep, p);
    assert.ok(Math.abs(ip - target) / target < 0.05, `ip=${ip} target=${target} KG1=${p.KG1}`);
  });
});

describe('clampParams', () => {
  it('clamps out-of-range values', () => {
    const c = clampParams({ MU: 1000, EX: 0.5, KG1: 1060, KP: 600, KVB: 300 });
    assert.equal(c.MU, 200);
    assert.equal(c.EX, 1.0);
  });
});

describe('generateSubckt', () => {
  it('emits triode PARAMS and E1', () => {
    const text = generateSubckt({
      name: '12AX7',
      type: 'triode',
      params: { MU: 100, EX: 1.4, KG1: 1060, KP: 600, KVB: 300 },
    });
    assert.match(text, /\.SUBCKT 12AX7 1 2 3/);
    assert.match(text, /MU=100/);
    assert.match(text, /E1 7 0 VALUE=/);
    assert.match(text, /\.ENDS/);
  });

  it('emits pentode with G2 node', () => {
    const text = generateSubckt({
      name: '6550',
      type: 'pentode',
      params: { MU: 7.9, EX: 1.35, KG1: 890, KG2: 4200, KP: 60, KVB: 24 },
    });
    assert.match(text, /\.SUBCKT 6550 1 2 3 4/);
    assert.match(text, /KG2=/);
    assert.match(text, /ATAN/);
  });
});
