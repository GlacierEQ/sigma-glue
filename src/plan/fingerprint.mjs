import { createHash } from 'node:crypto';

export class CanonicalizationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

/**
 * Produce a deterministic JSON representation for JSON-compatible plans.
 * Ambiguous or stateful JavaScript values fail closed instead of being
 * silently omitted or evaluated during approval fingerprinting.
 */
export function canonicalize(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalizationError(`non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (['undefined', 'bigint', 'symbol', 'function'].includes(typeof value)) {
    throw new CanonicalizationError(`unsupported ${typeof value} at ${path}`);
  }
  if (typeof value !== 'object') {
    throw new CanonicalizationError(`unsupported value at ${path}`);
  }
  if (ancestors.has(value)) throw new CanonicalizationError(`cyclic value at ${path}`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      rejectSymbolKeys(value, path);
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalizationError(`sparse array entry at ${path}[${index}]`);
        }
        entries.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
      }
      const extra = Object.keys(value).find((key) => !isCanonicalArrayIndex(key, value.length));
      if (extra !== undefined) {
        throw new CanonicalizationError(`unexpected array property at ${path}.${extra}`);
      }
      return `[${entries.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(`non-plain object at ${path}`);
    }

    rejectSymbolKeys(value, path);
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new CanonicalizationError(`accessor property at ${path}.${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalize(descriptor.value, `${path}.${key}`, ancestors)}`;
    }).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function planFingerprint(plan) {
  const canonical = canonicalize(plan);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function rejectSymbolKeys(value, path) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalizationError(`symbol-keyed property at ${path}`);
  }
}

function isCanonicalArrayIndex(key, length) {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
