import { createHash } from 'node:crypto';

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Produce a deterministic JSON representation for strict JSON-compatible
 * values. Non-plain objects are rejected rather than silently collapsing into
 * an ambiguous object representation.
 */
export function canonicalize(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    if (!isPlainObject(value)) throw new TypeError(`non-plain object at ${path}`);
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      const item = value[key];
      if (item === undefined) throw new TypeError(`undefined value at ${path}.${key}`);
      return `${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`)}`;
    }).join(',')}}`;
  }
  throw new TypeError(`unsupported value at ${path}`);
}

/** Deep-freeze a JSON-compatible value before it crosses a trust boundary. */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

export function planFingerprint(plan) {
  const canonical = canonicalize(plan);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
