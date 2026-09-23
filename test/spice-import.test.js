import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultParams,
  generateSubckt,
  getModel,
  listModels,
  parseSpiceImport,
} from '../lib/tube.js';
import { parseSpiceNumber } from '../lib/spice-import.js';

function close(actual, expected) {
  const scale = Math.max(Math.abs(actual), Math.abs(expected), 1e-12);
  assert.ok(Math.abs(actual - expected) / scale < 1e-3, `${actual} vs ${expected}`);
}

describe('parseSpiceNumber', () => {
  it('reads engineering suffixes the way SPICE does', () => {
    assert.equal(parseSpiceNumber('1K'), 1000);
    assert.equal(parseSpiceNumber('1k'), 1000);
    assert.equal(parseSpiceNumber('2MEG'), 2e6);
    assert.equal(parseSpiceNumber('1M'), 1e-3);
    assert.equal(parseSpiceNumber('2.3P'), 2.3e-12);
    assert.equal(parseSpiceNumber('2.3pF'), 2.3e-12);
    assert.equal(parseSpiceNumber('1.4e-3'), 1.4e-3);
  });
});

describe('parseSpiceImport', () => {
  it('loads a Koren pentode PARAMS fragment', () => {
    const parsed = parseSpiceImport(`+ PARAMS: MU=29.568 EX=1.218 KG1=375.0 KG2=4200 KP=81
+ KVB=516.0 VCT=0.172 RGI=1K
+ CCG=2.3P CPG1=1.1P CCP=0.5P`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.modelId, 'koren');
    assert.equal(parsed.type, 'pentode');
    assert.equal(parsed.name, null);
    assert.equal(parsed.params.MU, 29.568);
    assert.equal(parsed.params.EX, 1.218);
    assert.equal(parsed.params.KG1, 375);
    assert.equal(parsed.params.KG2, 4200);
    assert.equal(parsed.params.KP, 81);
    assert.equal(parsed.params.KVB, 516);
    assert.equal(parsed.params.VCT, 0.172);
    assert.equal(parsed.params.RGI, 1000);
    assert.equal(parsed.params.CCG, 2.3);
    assert.equal(parsed.params.CGP, 1.1);
    assert.equal(parsed.params.CCP, 0.5);
  });

  it('reads a subckt name and .PARAM lines', () => {
    const parsed = parseSpiceImport(`* 6SN7
.SUBCKT 6SN7 P G K
.PARAM MU=20 EX=1.3 KG1=800 KP=400 KVB=200
.PARAM RGI=2k CCG=3.2P CGP=4P CCP=1.1P
.ENDS`);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.modelId, 'koren');
    assert.equal(parsed.type, 'triode');
    assert.equal(parsed.name, '6SN7');
    assert.equal(parsed.params.RGI, 2000);
    assert.equal(parsed.params.CCG, 3.2);
    assert.equal(parsed.params.CGP, 4);
  });

  it('round-trips every exported subckt', () => {
    for (const { id } of listModels()) {
      const model = getModel(id);
      for (const type of model.supports) {
        for (const knee of id === 'karpov' ? [0, 1] : [null]) {
          const params = { ...defaultParams(id, type) };
          if (knee != null) params.KNEE = knee;
          const text = generateSubckt({ modelId: id, name: 'TUBE_1', type, params });
          const parsed = parseSpiceImport(text);
          assert.equal(parsed.ok, true, text);
          assert.equal(parsed.modelId, id, id);
          assert.equal(parsed.type, type, `${id} ${type}`);
          assert.equal(parsed.name, 'TUBE_1');
          for (const key of [...model.paramKeys, 'RGI', 'CCG', 'CGP', 'CCP']) {
            if (params[key] == null) continue;
            if (id === 'ayumi' && type === 'triode' && key === 'RAD') continue;
            if (params[key] === 0 && parsed.params[key] == null) continue;
            assert.ok(parsed.params[key] != null, `${id} ${type} missing ${key}`);
            close(parsed.params[key], params[key]);
          }
        }
      }
    }
  });

  it('rejects text that is not a parameter block', () => {
    const parsed = parseSpiceImport('hello world\nMU is high');
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /No SPICE parameters/);
  });
});
