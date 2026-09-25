import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  harmonics,
  intersectLoadLine,
  outputPower,
  swingLevels,
  screenVoltage,
  analyzeLoadLine,
  loadLineScore,
  optimizeLoadLine,
  swingSamples,
} from '../lib/loadline.js';
import {
  plateCurrent,
  screenCurrent,
  defaultParams,
  generateSubckt,
  parseSpiceImport,
} from '../lib/tube.js';
import { gridCurrent, childLawIg } from '../lib/models/math.js';

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

  it('matches Vout rms times Iout rms, with Vin rms as peak over √2', () => {
    const levels = swingLevels(2, 40, 0.02);
    close(levels.vinRms, 2 / Math.SQRT2);
    close(levels.voutPp, 40);
    close(levels.voutRms * levels.ioutRms, outputPower(40, 0.02));
  });
});

describe('ultralinear screen', () => {
  it('matches Vg2 at the quiescent plate voltage and moves with Ep', () => {
    close(screenVoltage(250, 300, 0.43, 250), 300);
    close(screenVoltage(350, 300, 0.43, 250), 300 + 0.43 * 100);
    close(screenVoltage(350, 300, 0, 250), 300);
  });
});

describe('grid current', () => {
  it('is negligible below 0.3 V and positive above it', () => {
    assert.ok(gridCurrent(0.2, 2000) < 2e-5);
    assert.ok(gridCurrent(1.5, 2000) > 1e-4);
  });

  it('child-law current is zero below VGOFF and rises with Vg', () => {
    const p = { MU: 20, KG1: 1000, IGA: 0.001, IGB: 0.3, IGC: 8, IGEX: 2, VGOFF: -0.6 };
    assert.equal(childLawIg(-1, 100, p), 0);
    const mid = childLawIg(0.5, 100, p);
    const hi = childLawIg(1.5, 100, p);
    assert.ok(mid > 0);
    assert.ok(hi > mid);
  });

  it('writes the child-law source into a Koren subcircuit and reads it back', () => {
    const params = { ...defaultParams('koren', 'triode'), gridLaw: 'child', VGOFF: -0.6, IGA: 0.001 };
    const text = generateSubckt({ modelId: 'koren', name: 'T', type: 'triode', params });
    assert.match(text, /GG 2 3/);
    assert.doesNotMatch(text, /\nR1 /);
    const parsed = parseSpiceImport(text);
    assert.equal(parsed.params.gridLaw, 'child');
    assert.equal(parsed.params.VGOFF, -0.6);
  });
});

describe('Koren screen knee', () => {
  it('stays flat in Ep until KVC is set, then falls', () => {
    const p = defaultParams('koren', 'pentode');
    const a = screenCurrent('koren', 'pentode', -1, 40, 250, p);
    const b = screenCurrent('koren', 'pentode', -1, 400, 250, p);
    close(a, b, 1e-12);
    const g = { ...p, KVC: Math.atan(80 / p.KVB) };
    const atKnee = screenCurrent('koren', 'pentode', 0, 80, 250, g);
    const low = screenCurrent('koren', 'pentode', 0, 20, 250, g);
    const high = screenCurrent('koren', 'pentode', 0, 400, 250, g);
    assert.ok(Math.abs(atKnee) < 1e-9, `atKnee=${atKnee}`);
    assert.ok(low > high, `low=${low} high=${high}`);
    const text = generateSubckt({ modelId: 'koren', name: 'T', type: 'pentode', params: g });
    assert.match(text, /KVC-ATAN/);
    assert.match(text, /Triode-strapped KG1=/);
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
    assert.ok(op.eta >= 0);
  });
});

describe('load line score', () => {
  it('prefers lower THD even against more power, and more power at the same THD', () => {
    const cleanSmall = loadLineScore({ pout: 0.05, thd: 1 });
    const dirtyBig = loadLineScore({ pout: 0.4, thd: 8 });
    const cleanBig = loadLineScore({ pout: 0.2, thd: 1 });
    assert.ok(cleanSmall > dirtyBig);
    assert.ok(cleanBig > cleanSmall);
    assert.equal(loadLineScore({ pout: 0, thd: 0.1 }), 0);
  });
});

describe('optimizeLoadLine', () => {
  it('stays inside Pmax and beats a starved bias on THD-first score', () => {
    const params = defaultParams('koren', 'triode');
    const ipAt = (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, params);
    const pmax = 0.8;
    const best = optimizeLoadLine({ ipAt, pmax, vpHi: 400 });
    assert.ok(best, 'expected a point');
    assert.ok(best.plateDissipation <= pmax * 1.002, `pdiss=${best.plateDissipation}`);
    assert.ok(best.pout > 0);
    assert.ok(best.thd < 15, `thd=${best.thd}`);

    const starved = analyzeLoadLine({
      ipAt,
      vg: -3.5,
      vp: 180,
      rp: 470000,
      vin: 0.4,
      vpHi: 1600,
    });
    assert.ok(starved.plateDissipation <= pmax);
    assert.ok(best.score >= loadLineScore(starved) * 0.98, `best=${best.score} starved=${loadLineScore(starved)}`);

    const tight = optimizeLoadLine({ ipAt, pmax: 0.25, vpHi: 400 });
    assert.ok(tight.plateDissipation <= 0.25 * 1.002);
    assert.ok(tight.plateDissipation <= best.plateDissipation + 1e-9);
  });

  it('keeps both swing peaks inside Vp > 0 and Ip > 0', () => {
    const ipAt = (_vg, vp) => Math.max(0, 0.0004 * (vp - 30) + 0.003 * (_vg + 4));
    const best = optimizeLoadLine({ ipAt, pmax: 2, vpHi: 400 });
    assert.ok(best, 'expected a point');
    const samples = swingSamples(ipAt, {
      vg: best.vg,
      vin: best.vin,
      vq: best.vp,
      iq: best.iq,
      rp: best.rp,
      eg2: 0,
      ul: 0,
      vpLo: -200,
      vpHi: 2000,
    });
    assert.ok(samples.every((s) => s.vp > 0 && s.ip > 0));
    const clipped = swingSamples(ipAt, {
      vg: best.vg,
      vin: Math.max(best.vin * 4, -best.vg),
      vq: best.vp,
      iq: best.iq,
      rp: best.rp,
      eg2: 0,
      ul: 0,
      vpLo: -200,
      vpHi: 2000,
    });
    assert.ok(clipped.some((s) => !(s.vp > 0) || !(s.ip > 0) || s.vp == null));
  });

  it('keeps the implied supply at or below Vc and uses a higher cap for more power', () => {
    const params = defaultParams('koren', 'triode');
    const ipAt = (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, params);
    const tight = optimizeLoadLine({ ipAt, pmax: 1, thdMax: 5, vpHi: 400, vcMax: 200 });
    const loose = optimizeLoadLine({ ipAt, pmax: 1, thdMax: 5, vpHi: 400, vcMax: 400 });
    assert.ok(tight && loose);
    assert.ok(tight.vc <= 200 * 1.002, `vc=${tight.vc}`);
    assert.ok(loose.vc <= 400 * 1.002, `vc=${loose.vc}`);
    assert.ok(loose.pout + 1e-9 >= tight.pout);
  });

  it('stays at or below Acceptable THD and uses a looser limit for more power', () => {
    const params = defaultParams('koren', 'triode');
    const ipAt = (vg, vp, eg2) => plateCurrent('koren', 'triode', vg, vp, eg2, params);
    const tight = optimizeLoadLine({ ipAt, pmax: 1, thdMax: 1, vpHi: 400 });
    const loose = optimizeLoadLine({ ipAt, pmax: 1, thdMax: 5, vpHi: 400 });
    assert.ok(tight && loose);
    assert.ok(tight.thd <= 1.001, `thd=${tight.thd}`);
    assert.ok(loose.thd <= 5.001, `thd=${loose.thd}`);
    assert.ok(loose.pout + 1e-9 >= tight.pout);
  });
});
