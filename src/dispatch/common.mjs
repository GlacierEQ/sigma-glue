import { canonicalize } from '../plan/fingerprint.mjs';

const SECRET_KEY_PATTERN = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?url|cookie)/i;

export class ColossusDispatchError extends Error {
  constructor(message, code = 'COLOSSUS_DISPATCH_FAILED', options = undefined) {
    super(message, options);
    this.name = 'ColossusDispatchError';
    this.code = code;
  }
}

export function cloneCanonical(value) {
  return JSON.parse(canonicalize(value));
}

export function requireString(value, field, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ColossusDispatchError(`${field} must be a non-empty string`, code);
  }
  return value;
}

export function validTimestamp(value, code) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ColossusDispatchError('timestamp is invalid', code);
  return parsed;
}

export function validDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ColossusDispatchError('date is invalid', code);
  }
  return value.getTime();
}

export function canonicalDate(value, code) {
  return new Date(validDate(value, code)).toISOString();
}

export function rejectSecretShapedContent(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretShapedContent(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new ColossusDispatchError(
          `secret-shaped field is forbidden at ${path}.${key}`,
          'RAW_CREDENTIAL_FORBIDDEN'
        );
      }
      rejectSecretShapedContent(child, `${path}.${key}`);
    }
  }
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
