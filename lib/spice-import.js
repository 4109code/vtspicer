/**
 * Recognize a pasted SPICE .SUBCKT (or a + PARAMS: fragment) and map it
 * onto a model, tube type, and parameter set.
 */

import { CHILD_KEYS, PASSIVE_KEYS, PIN_ORDER } from './models/math.js';
import { getModel } from './models/registry.js';

const NUMBER =
  String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:MEG|MIL|PF|[TGMKUNPF])?`;
const ASSIGN_RE = new RegExp(
  String.raw`([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(${NUMBER})`,
  'gi',
);

const SUFFIX = {
  T: 1e12,
  G: 1e9,
  MEG: 1e6,
  K: 1e3,
  M: 1e-3,
  MIL: 25.4e-6,
  U: 1e-6,
  N: 1e-9,
  P: 1e-12,
  PF: 1e-12,
  F: 1e-15,
};

const CAP_KEYS = new Set(['CCG', 'CGP', 'CPG1', 'CCP', 'CP']);

/** First match wins. Keys here are the ones that are not shared across families. */
const FAMILIES = [
  { id: 'karpov', test: (keys) => keys.has('KC') },
  { id: 'ridge', test: (keys) => keys.has('KG') || keys.has('KN') || keys.has('RS') },
  { id: 'koren', test: (keys) => keys.has('KG1') || keys.has('KG2') || keys.has('KVB') },
  {
    id: 'duncan',
    test: (keys) => keys.has('K') && keys.has('EX') && !keys.has('MU') && !keys.has('KG1'),
  },
];

const MODEL_HINTS = [
  ['karpov', /\bkarpov\b/i],
  ['ridge', /\bridge\b/i],
  ['duncan', /\bduncan\b|\brectifier\b/i],
  ['koren', /\bkoren\b/i],
];

export function parseSpiceNumber(token) {
  const m = String(token)
    .trim()
    .match(new RegExp(`^(${NUMBER})$`, 'i'));
  if (!m) return null;
  const suffix = (m[1].match(/(MEG|MIL|PF|[TGMKUNPF])$/i)?.[1] || '').toUpperCase();
  const num = suffix ? m[1].slice(0, -suffix.length) : m[1];
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  return n * (SUFFIX[suffix] ?? 1);
}

function capToPf(value) {
  if (value < 1e-3) return value * 1e12;
  return value;
}

function splitComment(line) {
  const star = line.match(/^\s*\*(.*)$/);
  if (star) return { code: '', comment: star[1].trim() };
  const idx = line.indexOf(';');
  if (idx === -1) return { code: line, comment: '' };
  return { code: line.slice(0, idx), comment: line.slice(idx + 1).trim() };
}

function logicalLines(codeLines) {
  const out = [];
  for (const line of codeLines) {
    const cont = line.match(/^\s*\+(.*)$/);
    if (cont && out.length) {
      out[out.length - 1] += ` ${cont[1].trim()}`;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function isAssignmentOnly(body) {
  if (!body || /\bPARAMS\s*:/i.test(body) || body.startsWith('.')) return false;
  const parts = body.split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => new RegExp(`^[A-Za-z_]\\w*\\s*=\\s*${NUMBER}$`, 'i').test(part));
}

function assignmentsFrom(chunk, into) {
  for (const match of chunk.matchAll(ASSIGN_RE)) {
    const key = match[1].toUpperCase();
    const value = parseSpiceNumber(match[2]);
    if (value == null) continue;
    into[key] = CAP_KEYS.has(key) ? capToPf(value) : value;
  }
}

function identifyModel(keys, comment) {
  const hinted = MODEL_HINTS.find(([, re]) => re.test(comment))?.[0];
  const matched = FAMILIES.filter((family) => family.test(keys)).map((family) => family.id);
  if (hinted && matched.includes(hinted)) return hinted;
  if (matched.length === 1) return matched[0];
  if (hinted && matched.length === 0) return hinted;
  return matched[0] ?? null;
}

function detectType(model, keys, pins, comment) {
  const supports = model.supports;
  if (supports.length === 1) return supports[0];

  const pentodeKeys = keys.has('KG2') || keys.has('MU2') || keys.has('RAD') || keys.has('RS') || keys.has('CPG1');
  if (/\bpentode\b|\btetrode\b/i.test(comment) && supports.includes('pentode')) return 'pentode';
  if (/\btriode\b/i.test(comment) && supports.includes('triode') && !pentodeKeys) return 'triode';
  if (/\bdiode\b|\brectifier\b/i.test(comment) && supports.includes('diode')) return 'diode';
  if (pentodeKeys && supports.includes('pentode')) return 'pentode';
  if (pins.length >= 4 && supports.includes('pentode')) return 'pentode';
  if (pins.length === 2 && supports.includes('diode')) return 'diode';
  if (supports.includes('triode')) return 'triode';
  return supports[0];
}

export function parseSpiceImport(text) {
  const comments = [];
  const code = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const { code: src, comment } = splitComment(line);
    if (comment) comments.push(comment);
    if (src.trim()) code.push(src);
  }

  const logical = logicalLines(code);
  const found = {};
  let name = null;
  let pins = [];

  for (const line of logical) {
    const header = line.match(/^\.SUBCKT\s+(\S+)\s*([\s\S]*)$/i);
    if (header && !name) {
      name = header[1];
      const paramsAt = header[2].search(/\bPARAMS\s*:/i);
      const pinPart = paramsAt >= 0 ? header[2].slice(0, paramsAt) : header[2];
      pins = pinPart.split(/\s+/).filter((token) => token && !token.includes('='));
    }

    const paramsAt = line.search(/\bPARAMS\s*:/i);
    if (paramsAt >= 0) {
      assignmentsFrom(line.slice(paramsAt).replace(/^\s*PARAMS\s*:/i, ' '), found);
      continue;
    }
    const paramDir = line.match(/^\.PARAM\b(.*)$/i);
    if (paramDir) {
      assignmentsFrom(paramDir[1], found);
      continue;
    }
    const body = line.replace(/^\+\s*/, '').trim();
    if (isAssignmentOnly(body)) {
      assignmentsFrom(body, found);
      continue;
    }
    const parallel = body.match(/^CP\s+\S+\s+\S+\s+(\S+)/i);
    if (parallel && found.CCP == null) {
      const value = parseSpiceNumber(parallel[1]);
      if (value != null) found.CCP = capToPf(value);
    }
  }

  const keys = new Set(Object.keys(found));
  if (!keys.size) return { ok: false, reason: 'No SPICE parameters found.' };

  const comment = comments.join(' ');
  const modelId = identifyModel(keys, comment);
  if (!modelId) {
    return { ok: false, reason: 'Could not recognize a tube model from these parameters.' };
  }

  const model = getModel(modelId);
  const type = detectType(model, keys, pins, comment);
  if (found.CPG1 != null) found.CGP = found.CPG1;

  const keep = new Set([...model.paramKeys, ...PASSIVE_KEYS]);
  const params = {};
  for (const [key, value] of Object.entries(found)) {
    if (keep.has(key) && Number.isFinite(value)) params[key] = value;
  }

  if (modelId === 'karpov') {
    if (/TANH\s*\(/i.test(text)) params.KNEE = 1;
    else if (/ATAN\s*\(/i.test(text)) params.KNEE = 0;
  }

  if (modelId === 'koren' && CHILD_KEYS.some((key) => Number.isFinite(found[key]))) {
    for (const key of CHILD_KEYS) {
      if (Number.isFinite(found[key])) params[key] = found[key];
    }
    params.gridLaw = 'child';
  }

  if (!Object.keys(params).some((key) => model.paramKeys.includes(key))) {
    return { ok: false, reason: 'Could not recognize a tube model from these parameters.' };
  }

  const pinRoles = PIN_ORDER[type] || PIN_ORDER.triode;
  const pinMap = pins.length === pinRoles.length
    ? Object.fromEntries(pinRoles.map((role, i) => [role, pins[i]]))
    : null;

  return { ok: true, modelId, type, name, params, pins: pinMap };
}
