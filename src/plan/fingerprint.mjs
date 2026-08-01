import { createHash } from 'node:crypto';

/**
 * Produce a deterministic JSON representation for JSON-compatible plans.
 * Undefined, non-finite, and non-JSON values are rejected rather than
 * silently changing the approval subject.
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
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      const item = value[key];
      if (item === undefined) throw new TypeError(`undefined value at ${path}.${key}`);
      return `${JSON.stringify(key)}:${canonicalize(item, `${path}.${key}`)}`;
    }).join(',')}}`;
  }
  throw new TypeError(`unsupported value at ${path}`);
}

export function planFingerprint(plan) {
  const canonical = canonicalize(plan);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
