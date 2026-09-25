import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  listModels,
  getModel,
  defaultParams,
  plateCurrent,
  screenCurrent,
  screenCurveFamily,
  generateSubckt,
  clampParams,
  normalizeType,
} from '../lib/tube.js';
import { softplus } from '../lib/models/math.js';

describe('model registry', () => {
  it('lists koren, karpov, duncan, ridge', () => {
    const ids = listModels().map((m) => m.id);
    assert.deepEqual(ids, ['koren', 'karpov', 'duncan', 'ridge']);
  });
});

describe('koren screen family', () => {
  it('screen current is positive for a koren pentode', () => {
    const p = getModel('koren').defaults.pentode;
    const ig2 = screenCurrent('koren', 'pentode', 0, 200, 300, p);
    assert.ok(ig2 > 0, `ig2=${ig2}`);
  });

  it('screenCurveFamily matches vg list / vp steps', () => {
    const p = getModel('koren').defaults.pentode;
    const vgList = [0, -2, -4];
    const curves = screenCurveFamily('koren', 'pentode', p, {
      vgList,
      vpMax: 400,
      vpSteps: 10,
      eg2: 250,
    });
    assert.equal(curves.length, 3);
    assert.equal(curves[0].points.length, 10);
    assert.deepEqual(
      curves.map((c) => c.vg),
      vgList,
    );
    assert.equal(screenCurveFamily('koren', 'triode', p, { vgList }).length, 0);
  });
});

describe('multi-model curveFamily / spice', () => {
  it('exports a ridge pentode subckt with plate and screen sources', () => {
    const text = generateSubckt({
      modelId: 'ridge',
      name: 'T',
      type: 'pentode',
      params: getModel('ridge').defaults.pentode,
    });
    assert.match(text, /Ridge/);
    assert.match(text, /1 2 3 4/);
    assert.match(text, /G2 4 3/);
    assert.match(text, /ABS\(V\(13\)\)/);
  });
});

describe('ridge plate/screen split', () => {
  it('moves current between plate and screen without changing the cathode sum', () => {
    const base = { ...getModel('ridge').defaults.pentode, RS: 0.1, MU2: 30, KN: 25 };
    const hi = { ...base, RS: 0.3 };
    const eg = -4;
    const ep = 350;
    const eg2 = 250;
    const sum = (params) =>
      plateCurrent('ridge', 'pentode', eg, ep, eg2, params) +
      screenCurrent('ridge', 'pentode', eg, ep, eg2, params);
    assert.ok(Math.abs(sum(base) - sum(hi)) < 1e-12);

    const ip0 = plateCurrent('ridge', 'pentode', eg, ep, eg2, base);
    const ip1 = plateCurrent('ridge', 'pentode', eg, ep, eg2, hi);
    const ig0 = screenCurrent('ridge', 'pentode', eg, ep, eg2, base);
    const ig1 = screenCurrent('ridge', 'pentode', eg, ep, eg2, hi);
    assert.ok(ip1 < ip0);
    assert.ok(Math.abs(ip0 - ip1 - (ig1 - ig0)) < 1e-12);
  });

  it('hands plate current off from the screen as Ep rises', () => {
    const p = { ...getModel('ridge').defaults.pentode, MU2: 40, KN: 30, RS: 0.1 };
    const low = {
      ip: plateCurrent('ridge', 'pentode', -5, 40, 250, p),
      ig2: screenCurrent('ridge', 'pentode', -5, 40, 250, p),
    };
    const high = {
      ip: plateCurrent('ridge', 'pentode', -5, 250, 250, p),
      ig2: screenCurrent('ridge', 'pentode', -5, 250, 250, p),
    };
    assert.ok(high.ip > low.ip);
    assert.ok(high.ig2 < low.ig2);
    assert.ok(high.ip + high.ig2 >= low.ip + low.ig2 - 1e-12);
  });

  it('knee parameter bends low-Va triode current more than a pure scale', () => {
    const p = getModel('ridge').defaults.triode;
    const ratio = (kn) => {
      const q = { ...p, KN: kn };
      const low = plateCurrent('ridge', 'triode', 0, 30, 0, q);
      const high = plateCurrent('ridge', 'triode', 0, 300, 0, q);
      return low / high;
    };
    assert.ok(ratio(80) < ratio(5));
  });
});

describe('ridge voltage dips', () => {
  const base = getModel('ridge').defaults.pentode;

  it('leaves the curve unchanged when the dip count is off', () => {
    const off = { ...base, ND: 0, DD1: 0.4, VD1: 40, WD1: 20 };
    const bare = { ...base };
    delete bare.ND;
    for (const ep of [20, 80, 250]) {
      const a = plateCurrent('ridge', 'pentode', -2, ep, 250, off);
      const b = plateCurrent('ridge', 'pentode', -2, ep, 250, bare);
      assert.ok(Math.abs(a - b) < 1e-12);
    }
  });

  it('cuts a low-current curve more than the Vg=0 curve and leaves the far plateau', () => {
    const dipped = { ...base, ND: 1, DD1: 0.55, VD1: 40, WD1: 28 };
    const eg2 = 250;
    const ep = 40;
    const frac = (eg) => {
      const plain = plateCurrent('ridge', 'pentode', eg, ep, eg2, base);
      const cut = plateCurrent('ridge', 'pentode', eg, ep, eg2, dipped);
      return 1 - cut / plain;
    };
    const top = frac(0);
    const low = frac(-8);
    assert.ok(top > 0.02, `top=${top}`);
    assert.ok(low > top * 2, `low=${low} top=${top}`);
    const flat = { ...dipped, DH: 1 };
    const gone = { ...dipped, DH: 0 };
    const fracAt = (p, eg) => {
      const plain = plateCurrent('ridge', 'pentode', eg, ep, eg2, base);
      return 1 - plateCurrent('ridge', 'pentode', eg, ep, eg2, p) / plain;
    };
    assert.ok(Math.abs(fracAt(flat, 0) - fracAt(flat, -8)) < 0.05);
    assert.ok(fracAt(gone, 0) < 0.02, `high=${fracAt(gone, 0)}`);
    assert.ok(fracAt(gone, -8) > 0.2);
    const far = plateCurrent('ridge', 'pentode', 0, 300, eg2, dipped);
    const far0 = plateCurrent('ridge', 'pentode', 0, 300, eg2, base);
    assert.ok(Math.abs(far - far0) / far0 < 0.02);
  });

  it('places a second dip in the middle while the first stays at the start', () => {
    const dipped = {
      ...base,
      ND: 2,
      DD1: 0.5,
      VD1: 0,
      WD1: 18,
      DD2: 0.25,
      VD2: 90,
      WD2: 16,
    };
    const at = (ep) => plateCurrent('ridge', 'pentode', -4, ep, 250, dipped);
    const plain = (ep) => plateCurrent('ridge', 'pentode', -4, ep, 250, base);
    const startCut = plain(8) - at(8);
    const midCut = plain(90) - at(90);
    const tailCut = plain(280) - at(280);
    assert.ok(startCut > 0);
    assert.ok(midCut > tailCut * 5);
    assert.ok(midCut > plain(90) * 0.1);
  });

  it('returns dipped plate current to the screen', () => {
    const dipped = { ...base, ND: 1, DD1: 0.3, VD1: 60, WD1: 25 };
    const eg = -3;
    const ep = 60;
    const eg2 = 200;
    const sum = (p) =>
      plateCurrent('ridge', 'pentode', eg, ep, eg2, p) +
      screenCurrent('ridge', 'pentode', eg, ep, eg2, p);
    assert.ok(Math.abs(sum(base) - sum(dipped)) < 1e-9);
    assert.ok(plateCurrent('ridge', 'pentode', eg, ep, eg2, dipped) < plateCurrent('ridge', 'pentode', eg, ep, eg2, base));
    assert.ok(screenCurrent('ridge', 'pentode', eg, ep, eg2, dipped) > screenCurrent('ridge', 'pentode', eg, ep, eg2, base));
  });

  it('omits the notch from spice until a depth is set', () => {
    const plain = generateSubckt({
      modelId: 'ridge',
      name: 'T',
      type: 'pentode',
      params: base,
    });
    assert.doesNotMatch(plain, /DD1/);
    const dipped = generateSubckt({
      modelId: 'ridge',
      name: 'T',
      type: 'pentode',
      params: { ...base, ND: 2, DD1: 0.2, VD1: 0, WD1: 40, DD2: 0.15, VD2: 80, WD2: 25 },
    });
    assert.match(dipped, /DD1=0\.2/);
    assert.match(dipped, /DD2=0\.15/);
    assert.match(dipped, /DH=0\.25/);
    assert.match(dipped, /1-DD1\*EXP\(-PWR\(\(URAMP\(V\(1,3\)\)-VD1\)\/WD1,2\)\)\*\(DH\+\(1-DH\)\*URAMP\(2\/\(1\+PWR\(V\(14\)\/MAX\(V\(17\),1E-9\),EX\)\)-1\)\)/);
    assert.match(dipped, /1-DD2\*EXP/);
  });
});

describe('karpov residual screen', () => {
  const p = {
    MU: 21,
    EX: 1.47,
    KG1: 895,
    KP: 121.2,
    KC: 318,
    KVB: 37.8,
    VCT: 0,
    KNEE: 0,
  };

  function expected(Eg, Ep, Eg2, params, knee) {
    const eg = Eg + (params.VCT ?? 0);
    const arg = params.KP * (1 / params.MU + eg / Eg2);
    const E1 = (Eg2 / params.KP) * softplus(arg);
    const ip = ((2 * Math.pow(Math.max(E1, 0), params.EX)) / params.KG1) * knee;
    const drive = eg + Eg2 / params.MU;
    const ik = drive > 0 ? Math.pow(drive, params.EX) / params.KC : 0;
    return { ip, ig2: Math.max(0, ik - ip) };
  }

  it('matches the atan residual-screen expression', () => {
    const Eg = -4;
    const Ep = 200;
    const Eg2 = 250;
    const want = expected(Eg, Ep, Eg2, p, Math.atan(Ep / p.KVB));
    const ip = plateCurrent('karpov', 'pentode', Eg, Ep, Eg2, p);
    const ig2 = screenCurrent('karpov', 'pentode', Eg, Ep, Eg2, p);
    assert.ok(Math.abs(ip - want.ip) < 1e-12, `ip ${ip} vs ${want.ip}`);
    assert.ok(Math.abs(ig2 - want.ig2) < 1e-12, `ig2 ${ig2} vs ${want.ig2}`);
  });

  it('gives the screen the current the plate has not taken', () => {
    const eg2 = 250;
    const low = screenCurrent('karpov', 'pentode', -2, 5, eg2, p);
    const high = screenCurrent('karpov', 'pentode', -2, 400, eg2, p);
    const ip = plateCurrent('karpov', 'pentode', -2, 400, eg2, p);
    assert.ok(low > high);
    assert.ok(ip > 0);
    assert.ok(low > 0);
  });

  it('uses the library tanh knee when KNEE is set', () => {
    const tanh = { ...p, KNEE: 1 };
    const Ep = 80;
    const Eg2 = 250;
    const knee = 1.57 * Math.tanh((2 * Ep) / (p.KVB * 3.14159));
    const want = expected(0, Ep, Eg2, tanh, knee);
    const ip = plateCurrent('karpov', 'pentode', 0, Ep, Eg2, tanh);
    assert.ok(Math.abs(ip - want.ip) < 1e-12);
    assert.ok(Math.abs(ip - plateCurrent('karpov', 'pentode', 0, Ep, Eg2, p)) > 1e-6);
    const text = generateSubckt({
      modelId: 'karpov',
      name: '6E5P',
      type: 'pentode',
      params: tanh,
    });
    assert.match(text, /TANH\(2\*V\(1,3\)\/\(KVB\*3\.14159\)\)/);
    assert.match(text, /URAMP\(PWR\(URAMP/);
  });
});

describe('duncan rectifier', () => {
  it('is K times Vak to the EX, and zero when reverse biased', () => {
    const p = { K: 1.4e-3, EX: 1.5 };
    const ia = plateCurrent('duncan', 'diode', 0, 40, 0, p);
    assert.ok(Math.abs(ia - p.K * Math.pow(40, p.EX)) < 1e-15);
    assert.equal(plateCurrent('duncan', 'diode', 0, -10, 0, p), 0);
  });

  it('exports a two-pin subckt and omits a zero parallel cap', () => {
    const text = generateSubckt({
      modelId: 'duncan',
      name: '5V4GA',
      type: 'diode',
      params: { K: 1.4e-3, EX: 1.5, CCP: 0 },
    });
    assert.match(text, /\.SUBCKT 5V4GA A K/);
    assert.match(text, /PWR\(V\(A,K\),EX\)\+PWRS\(V\(A,K\),EX\)\)\/2/);
    assert.doesNotMatch(text, /\nCP /);
  });
});

describe('tube presets', () => {
  const dir = new URL('../presets/tubes/', import.meta.url);
  const presets = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const type = name.slice(0, -'.json'.length);
      return JSON.parse(readFileSync(new URL(name, dir), 'utf8')).map((preset) => ({
        preset,
        fileType: type,
      }));
    });

  it('keeps every published parameter inside the model limits', () => {
    const ids = new Set();
    for (const { preset, fileType } of presets) {
      assert.equal(preset.type, fileType, `${preset.id} filed under ${fileType}.json`);
      assert.ok(!ids.has(preset.id), `duplicate ${preset.id}`);
      ids.add(preset.id);
      const type = normalizeType(preset.type);
      assert.ok(getModel(preset.model).supports.includes(type), preset.id);
      const params = clampParams(preset.model, {
        ...defaultParams(preset.model, type),
        ...preset.params,
      });
      for (const [key, value] of Object.entries(preset.params)) {
        if (getModel(preset.model).limits?.[key] == null) continue;
        assert.ok(
          Math.abs(params[key] - value) < 1e-9,
          `${preset.id} ${key} clamped from ${value} to ${params[key]}`,
        );
      }
      const ep = (preset.sweep?.vpMax ?? 200) * 0.5;
      const ip = plateCurrent(preset.model, type, 0, ep, preset.sweep?.eg2 ?? 200, params);
      assert.ok(Number.isFinite(ip) && ip > 0, `${preset.id} ip=${ip}`);
    }
  });
});
