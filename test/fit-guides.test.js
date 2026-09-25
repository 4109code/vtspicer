import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitToTargets,
  plateCurrent,
  screenCurrent,
  getModel,
} from '../lib/tube.js';

describe('fitToTargets', () => {
  it('recovers KG1 from a few synthetic guide points', () => {
    const truth = { ...getModel('koren').defaults.triode, KG1: 1060 };
    const start = { ...truth, KG1: 2200 };
    const samples = [
      { Eg: 0, Ep: 100, ip: plateCurrent('koren', 'triode', 0, 100, 0, truth) },
      { Eg: 0, Ep: 250, ip: plateCurrent('koren', 'triode', 0, 250, 0, truth) },
      { Eg: -1, Ep: 200, ip: plateCurrent('koren', 'triode', -1, 200, 0, truth) },
      { Eg: -2, Ep: 300, ip: plateCurrent('koren', 'triode', -2, 300, 0, truth) },
    ];
    const fitted = fitToTargets('koren', 'triode', start, samples, {
      iterations: 100,
      damping: 0.5,
      keys: ['KG1', 'MU', 'EX'],
    });
    assert.ok(
      Math.abs(fitted.KG1 - truth.KG1) / truth.KG1 < 0.15,
      `KG1=${fitted.KG1}`,
    );
  });

  it('recovers a ridge knee that is coupled to the current scale', () => {
    const truth = { ...getModel('ridge').defaults.triode, KN: 40, KG: 700 };
    const start = { ...truth, KN: 12, KG: 400 };
    const samples = [];
    for (const eg of [0, -1, -2, -3]) {
      for (const ep of [40, 100, 180, 300]) {
        samples.push({
          Eg: eg,
          Ep: ep,
          ip: plateCurrent('ridge', 'triode', eg, ep, 0, truth),
        });
      }
    }
    const fitted = fitToTargets('ridge', 'triode', start, samples, {
      iterations: 80,
      damping: 0.45,
      keys: ['KN', 'KG', 'MU'],
    });
    assert.ok(Math.abs(fitted.KN - 40) < 2, `KN=${fitted.KN}`);
    assert.ok(Math.abs(fitted.KG - 700) / 700 < 0.05, `KG=${fitted.KG}`);
  });

  it('does not invent a ridge dip while a depth is still zero', () => {
    const truth = getModel('ridge').defaults.triode;
    const start = { ...truth, ND: 2, DD1: 0, VD1: 30, WD1: 20, DD2: 0, VD2: 120, WD2: 25, KN: 30 };
    const samples = [];
    for (const eg of [0, -2]) {
      for (const ep of [25, 60, 120, 250]) {
        samples.push({
          Eg: eg,
          Ep: ep,
          ip: plateCurrent('ridge', 'triode', eg, ep, 0, { ...truth, KN: 18 }),
        });
      }
    }
    const fitted = fitToTargets('ridge', 'triode', start, samples, { iterations: 40 });
    assert.equal(fitted.DD1, 0);
    assert.equal(fitted.DD2, 0);
    assert.equal(fitted.VD1, 30);
  });

  it('recovers Koren KG2 from screen targets and leaves the plate scale alone', () => {
    const truth = { ...getModel('koren').defaults.pentode, KG2: 8000 };
    const start = { ...truth, KG2: 2200 };
    const eg2 = 250;
    const samples = [];
    for (const eg of [0, -2, -4]) {
      samples.push({
        Eg: eg,
        Ep: 200,
        Eg2: eg2,
        ip: screenCurrent('koren', 'pentode', eg, 200, eg2, truth),
        kind: 'screen',
      });
    }
    const fitted = fitToTargets('koren', 'pentode', start, samples, {
      iterations: 80,
      damping: 0.45,
      keys: ['KG2'],
    });
    assert.ok(Math.abs(fitted.KG2 - 8000) / 8000 < 0.15, `KG2=${fitted.KG2}`);
    assert.equal(fitted.KG1, start.KG1);
    const ip0 = plateCurrent('koren', 'pentode', 0, 200, eg2, start);
    const ip1 = plateCurrent('koren', 'pentode', 0, 200, eg2, fitted);
    assert.ok(Math.abs(ip1 - ip0) < 1e-12);
  });

  it('moves ridge screen share toward the guides while plate targets hold Ip', () => {
    const truth = { ...getModel('ridge').defaults.pentode, RS: 0.28 };
    const start = { ...truth, RS: 0.08 };
    const eg2 = 250;
    const plate = [];
    const screen = [];
    for (const eg of [0, -2, -4]) {
      for (const ep of [40, 120, 250]) {
        plate.push({
          Eg: eg,
          Ep: ep,
          Eg2: eg2,
          ip: plateCurrent('ridge', 'pentode', eg, ep, eg2, truth),
        });
        screen.push({
          Eg: eg,
          Ep: ep,
          Eg2: eg2,
          ip: screenCurrent('ridge', 'pentode', eg, ep, eg2, truth),
          kind: 'screen',
        });
      }
    }
    const plateScale = Math.max(...plate.map((t) => t.ip));
    const screenScale = Math.max(...screen.map((t) => t.ip));
    for (const t of screen) t.w = plateScale / screenScale;

    function sse(params, rows) {
      let err = 0;
      for (const t of rows) {
        const pred =
          t.kind === 'screen'
            ? screenCurrent('ridge', 'pentode', t.Eg, t.Ep, t.Eg2, params)
            : plateCurrent('ridge', 'pentode', t.Eg, t.Ep, t.Eg2, params);
        err += (pred - t.ip) ** 2;
      }
      return err;
    }

    const fitted = fitToTargets('ridge', 'pentode', start, [...plate, ...screen], {
      iterations: 80,
      damping: 0.45,
      keys: ['RS', 'KG'],
    });
    assert.ok(Math.abs(fitted.RS - 0.28) < Math.abs(start.RS - 0.28), `RS=${fitted.RS}`);
    assert.ok(sse(fitted, plate) < sse(start, plate));
    assert.ok(sse(fitted, screen) < sse(start, screen) * 0.5);
  });

  it('places enabled ridge pentode dips on the guides and keeps them there', () => {
    const eg2 = 250;
    const truth = {
      ...getModel('ridge').defaults.pentode,
      ND: 2,
      DD1: 0.5,
      VD1: 36,
      WD1: 18,
      DD2: 0.3,
      VD2: 150,
      WD2: 28,
    };
    const start = {
      ...getModel('ridge').defaults.pentode,
      ND: 2,
      DD1: 0,
      VD1: 0,
      WD1: 45,
      DD2: 0,
      VD2: 70,
      WD2: 28,
    };
    const samples = [];
    for (const eg of [0, -3, -7]) {
      for (const ep of [15, 36, 70, 110, 150, 220, 320]) {
        samples.push({
          Eg: eg,
          Ep: ep,
          Eg2: eg2,
          ip: plateCurrent('ridge', 'pentode', eg, ep, eg2, truth),
        });
      }
    }
    const fitted = fitToTargets('ridge', 'pentode', start, samples, { iterations: 50 });
    assert.ok(Math.abs(fitted.VD1 - 36) < 18, `VD1=${fitted.VD1}`);
    assert.ok(Math.abs(fitted.VD2 - 150) < 30, `VD2=${fitted.VD2}`);
    assert.ok(fitted.DD1 > 0.15, `DD1=${fitted.DD1}`);
    assert.ok(fitted.DD2 > 0.08, `DD2=${fitted.DD2}`);
    assert.ok(fitted.VD2 < 360, `VD2=${fitted.VD2}`);
    assert.ok(fitted.WD1 > 8 && fitted.WD2 > 8, `WD=${fitted.WD1},${fitted.WD2}`);
    assert.ok(fitted.MU2 > 8 && fitted.MU2 < 60, `MU2=${fitted.MU2}`);

    const dragged = samples.map((t) => ({ ...t }));
    const hit = dragged.find((t) => t.Eg === -7 && t.Ep === 36);
    hit.ip *= 0.8;
    const again = fitToTargets('ridge', 'pentode', fitted, dragged, { iterations: 40 });
    assert.ok(again.VD1 > 5 && again.VD1 < 120, `drag VD1=${again.VD1}`);
    assert.ok(again.VD2 > 80 && again.VD2 < 280, `drag VD2=${again.VD2}`);
    assert.ok(again.WD1 > 8 && again.WD2 > 8, `drag WD=${again.WD1},${again.WD2}`);
    assert.ok(again.MU2 > 6 && again.MU2 < 70, `drag MU2=${again.MU2}`);
  });

  it('lands on sparse triode guides in one fit', () => {
    const truth = {
      ...getModel('koren').defaults.triode,
      MU: 70,
      EX: 1.5,
      KG1: 1500,
      KP: 180,
      KVB: 40,
    };
    const samples = [];
    for (const eg of [0, -2, -4, -6]) {
      for (const ep of [80, 160, 280, 400]) {
        const ip = plateCurrent('koren', 'triode', eg, ep, 0, truth);
        if (ip > 1e-6) samples.push({ Eg: eg, Ep: ep, ip });
      }
    }
    const once = fitToTargets('koren', 'triode', getModel('koren').defaults.triode, samples, {
      iterations: 90,
      keys: ['MU', 'EX', 'KG1', 'KP', 'KVB'],
    });
    const twice = fitToTargets('koren', 'triode', once, samples, {
      iterations: 90,
      keys: ['MU', 'EX', 'KG1', 'KP', 'KVB'],
    });
    let max1 = 0;
    let max2 = 0;
    for (const t of samples) {
      max1 = Math.max(max1, Math.abs(plateCurrent('koren', 'triode', t.Eg, t.Ep, 0, once) - t.ip));
      max2 = Math.max(max2, Math.abs(plateCurrent('koren', 'triode', t.Eg, t.Ep, 0, twice) - t.ip));
    }
    assert.ok(max1 < 1e-5, `first fit max ${max1 * 1000} mA`);
    assert.ok(max2 <= max1 + 1e-7, `second fit moved ${max2 * 1000} mA`);
  });

  it('sticks a 6H9C-style triode family without a second drag', () => {
    // Read off the 6Н9С plate family: Vg 0..-6, Ia in amps
    const sheet = [
      [0, 40, 0.35e-3], [0, 80, 1.05e-3], [0, 120, 1.9e-3], [0, 160, 3.0e-3],
      [0, 200, 4.3e-3], [0, 240, 5.8e-3], [0, 280, 7.4e-3],
      [-1, 120, 0.7e-3], [-1, 160, 1.5e-3], [-1, 200, 2.5e-3], [-1, 240, 3.7e-3],
      [-1, 280, 5.1e-3], [-1, 320, 6.6e-3],
      [-2, 160, 0.55e-3], [-2, 200, 1.2e-3], [-2, 240, 2.05e-3], [-2, 280, 3.1e-3],
      [-2, 320, 4.3e-3], [-2, 360, 5.6e-3], [-2, 400, 7.0e-3],
      [-3, 240, 0.95e-3], [-3, 280, 1.75e-3], [-3, 320, 2.7e-3], [-3, 360, 3.8e-3],
      [-3, 400, 5.0e-3], [-3, 440, 6.3e-3],
      [-4, 280, 0.7e-3], [-4, 320, 1.45e-3], [-4, 360, 2.35e-3], [-4, 400, 3.35e-3],
      [-4, 440, 4.5e-3],
      [-5, 320, 0.4e-3], [-5, 360, 1.15e-3], [-5, 400, 2.0e-3], [-5, 440, 3.0e-3],
      [-6, 400, 0.9e-3], [-6, 440, 1.7e-3],
    ].map(([Eg, Ep, ip]) => ({ Eg, Ep, ip }));

    function maxMa(params) {
      let max = 0;
      for (const t of sheet) {
        const d = Math.abs(plateCurrent('koren', 'triode', t.Eg, t.Ep, 0, params) - t.ip) * 1000;
        if (d > max) max = d;
      }
      return max;
    }

    const once = fitToTargets('koren', 'triode', getModel('koren').defaults.triode, sheet, {
      iterations: 90,
    });
    const twice = fitToTargets('koren', 'triode', once, sheet, { iterations: 90 });
    const first = maxMa(once);
    const second = maxMa(twice);
    assert.ok(first < 0.3, `6H9C max ${first.toFixed(3)} mA`);
    assert.ok(second > first - 0.01, `second fit jumped ${second.toFixed(3)} from ${first.toFixed(3)}`);
    assert.ok((first - second) / first < 0.02, `still creeping ${first.toFixed(3)} -> ${second.toFixed(3)}`);
  });

  it('fits a sharp pentode knee for ridge and karpov in one pass', () => {
    const eg2 = 250;
    const egs = [0, -5, -10, -15, -20];
    const eps = [40, 80, 140, 220, 320, 400];
    const cases = [
      {
        model: 'ridge',
        truth: {
          ...getModel('ridge').defaults.pentode,
          MU: 8,
          EX: 1.35,
          KG: 220,
          KP: 1.4,
          KN: 36,
          KS: 4.2,
          BK: 1.1,
          RS: 0.1,
          MU2: 20,
        },
      },
      {
        model: 'karpov',
        truth: {
          ...getModel('karpov').defaults.pentode,
          MU: 9,
          EX: 1.3,
          KG1: 260,
          KP: 40,
          KVB: 28,
          KS: 3,
          KB: 0.8,
          KNEE: 0,
        },
      },
    ];
    for (const { model, truth } of cases) {
      const samples = [];
      for (const eg of egs) {
        for (const ep of eps) {
          const ip = plateCurrent(model, 'pentode', eg, ep, eg2, truth);
          if (ip > 1e-5) samples.push({ Eg: eg, Ep: ep, Eg2: eg2, ip });
        }
      }
      const once = fitToTargets(model, 'pentode', getModel(model).defaults.pentode, samples, {
        iterations: 80,
      });
      const twice = fitToTargets(model, 'pentode', once, samples, { iterations: 40 });
      let max1 = 0;
      let max2 = 0;
      for (const t of samples) {
        max1 = Math.max(max1, Math.abs(plateCurrent(model, 'pentode', t.Eg, t.Ep, eg2, once) - t.ip));
        max2 = Math.max(max2, Math.abs(plateCurrent(model, 'pentode', t.Eg, t.Ep, eg2, twice) - t.ip));
      }
      assert.ok(max1 < 1e-4, `${model} first fit max ${max1 * 1000} mA`);
      assert.ok(max2 <= max1 * 1.01 + 1e-6, `${model} second fit moved`);
    }
  });
});
