import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  harmonics,
  intersectLoadLine,
  outputPower,
  screenVoltage,
  analyzeLoadLine,
} from '../lib/loadline.js';
import { plateCurrent, defaultParams } from '../lib/tube.js';

function close(actual, expected, tol = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} vs ${expected}`);
}

describe('harmonics', () => {
  it('reads a square term as about 10% H2 and a cube as H3', () => {
    const xs = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
    const even = xs.map((x) => 1 + x + 0.2 * x * x);
    const odd = xs.map((x) => 1 + x + 0.2 * x ** 3);
    const hEven = harmonics(even);
    const hOdd = harmonics(odd);
    assert.ok(Math.abs(hEven.h2 - 10) < 0.5, `h2=${hEven.h2}`);
    assert.ok(hEven.h3 < 0.01, `h3=${hEven.h3}`);
    assert.ok(hOdd.h3 > 1, `h3=${hOdd.h3}`);
    assert.ok(hOdd.h2 < 0.01, `h2=${hOdd.h2}`);
  });
});

describe('load line intersection', () => {
  it('lands on the line for a monotonic plate law', () => {
    const ipAt = (_vg, vp) => 0.001 * vp + 0.002 * (_vg + 2);
    const vq = 100;
    const iq = ipAt(-2, vq);
    const rp = 1000;
    const vp = intersectLoadLine(ipAt, 0, { vq, iq, rp, eg2: 0, vpLo: 0, vpHi: 400 });
    const ip = ipAt(0, vp);
    close(ip, iq + (vq - vp) / rp, 1e-6);
    assert.ok(vp < vq);
  });
});

describe('output power', () => {
  it('is Vpp times Ipp over 8', () => {
    close(outputPower(40, 0.02), 0.1);
  });
});

describe('ultralinear screen', () => {
  it('matches Vg2 at the quiescent plate voltage and moves with Ep', () => {
    close(screenVoltage(250, 300, 0.43, 250), 300);
    close(screenVoltage(350, 300, 0.43, 250), 300 + 0.43 * 100);
    close(screenVoltage(350, 300, 0, 250), 300);
  });
});

describe('analyzeLoadLine', () => {
  it('reports ra for a Duncan diode and mu for a triode', () => {
    const diode = analyzeLoadLine({
      ipAt: (_g, vp) => 1e-4 * Math.max(vp, 0),
      vg: 0,
      vp: 40,
      rp: 5000,
      hasGrid: false,
      vpHi: 200,
    });
    assert.equal(diode.gm, null);
    assert.ok(diode.ra > 0 && Number.isFinite(diode.ra));

    const triode = defaultParams('koren', 'triode');
    const op = analyzeLoadLine({
      ipAt: (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, triode),
      vg: -2,
      vp: 250,
      rp: 100000,
      vin: 1,
      hasGrid: true,
      ccgPf: 2.3,
      cgpPf: 2.4,
      vpHi: 400,
    });
    assert.ok(op.mu > 1, `mu=${op.mu}`);
    assert.ok(op.pout >= 0);
    assert.equal(op.sweep.length, 10);
  });
});
