import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nearestE,
  suggestWattage,
  cathodeBypassCap,
  couplingCap,
  stageParts,
  millerCap,
  highCorner,
  primaryInductance,
  lowCorner,
} from '../lib/stage.js';

function close(actual, expected, tol = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} vs ${expected}`);
}

describe('preferred values', () => {
  it('snaps to the nearer E24 mantissa and picks a wattage above twice the heat', () => {
    assert.equal(nearestE(100000, 'E24'), 100000);
    assert.equal(nearestE(47000, 'E12'), 47000);
    assert.equal(nearestE(50000, 'E24'), 51000);
    assert.equal(suggestWattage(0.4), 1);
    assert.equal(suggestWattage(0.1), 0.25);
  });
});

describe('coupling parts', () => {
  it('sizes the coupling cap from the following resistance and the cathode bypass from the paralleled cathode', () => {
    const f = 10;
    const rg = 100e3;
    close(couplingCap(rg, f), 1 / (2 * Math.PI * f * rg));
    const rk = 1000;
    const ra = 5000;
    const rac = 20000;
    const mu = 20;
    const prime = (ra + rac) / (mu + 1);
    const seen = 1 / (1 / rk + 1 / prime);
    close(cathodeBypassCap(rk, ra, rac, mu, f), 1 / (2 * Math.PI * f * seen));
  });

  it('offers a standard plate resistor and a bypass cap only while the cathode is bypassed', () => {
    const load = { purpose: 'preamp', topology: 'plate', bypassed: true, rp: 100000, rg: 100000 };
    const op = { vc: 300, ip: 0.001, rk: 1500, ra: 60000, mu: 100, rac: 50000 };
    const parts = stageParts(load, op, { series: 'E24', fLow: 10 });
    const rp = parts.find((part) => part.key === 'Rp');
    assert.equal(rp.snapped, 100000);
    assert.equal(rp.field, 'loadRp');
    assert.ok(parts.some((part) => part.key === 'Ck'));
    const open = stageParts({ ...load, bypassed: false }, op, { fLow: 10 });
    assert.equal(open.some((part) => part.key === 'Ck'), false);
  });

  it('sets the high corner from Miller capacitance and primary inductance from ra parallel to Zp', () => {
    const c = millerCap(2.3, 1.7, 50);
    close(c, (2.3 + 1.7 * 51) * 1e-12);
    const source = 10000;
    close(highCorner(source, c), 1 / (2 * Math.PI * source * c));
    const ra = 2000;
    const zp = 5000;
    const seen = 1 / (1 / ra + 1 / zp);
    close(primaryInductance(ra, zp, 20), seen / (2 * Math.PI * 20));
    close(lowCorner(couplingCap(100e3, 10), 100e3), 10, 1e-9);
  });
});
