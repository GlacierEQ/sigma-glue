import { canonicalize, deepFreeze, planFingerprint } from '../plan/fingerprint.mjs';

const SECRET_KEY_PATTERN = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?url|cookie)/i;

export class ToolCallRecordError extends Error {
  constructor(message, code = 'TOOL_CALL_RECORD_INVALID') {
    super(message);
    this.name = 'ToolCallRecordError';
    this.code = code;
  }
}

export function makeToolCallRecord({
  toolSelected,
  reason,
  input,
  attempt,
  result,
  verification
} = {}) {
  const safeInput = canonicalValue(input, 'input');
  const safeResult = canonicalObject(result, 'result');
  const safeVerification = canonicalObject(verification, 'verification');
  if (!Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new ToolCallRecordError('attempt must be a positive safe integer', 'TOOL_CALL_ATTEMPT_INVALID');
  }

  return deepFreeze({
    tool_selected: requiredString(toolSelected, 'toolSelected'),
    reason: requiredString(reason, 'reason'),
    input_fingerprint: planFingerprint(safeInput),
    attempt,
    result: safeResult,
    verification: safeVerification
  });
}

export function toolCallRecordFingerprint(record) {
  return planFingerprint(normalizeToolCallRecord(record));
}

function normalizeToolCallRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ToolCallRecordError('tool call record is required');
  }
  const exact = [
    'tool_selected',
    'reason',
    'input_fingerprint',
    'attempt',
    'result',
    'verification'
  ];
  const unknown = Object.keys(record).find((key) => !exact.includes(key));
  if (unknown || exact.some((key) => !(key in record))) {
    throw new ToolCallRecordError('tool call record fields are incomplete or unsupported');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(record.input_fingerprint)) {
    throw new ToolCallRecordError('input_fingerprint must be a sha256 fingerprint');
  }
  if (!Number.isSafeInteger(record.attempt) || record.attempt <= 0) {
    throw new ToolCallRecordError('attempt must be a positive safe integer', 'TOOL_CALL_ATTEMPT_INVALID');
  }
  return deepFreeze({
    tool_selected: requiredString(record.tool_selected, 'tool_selected'),
    reason: requiredString(record.reason, 'reason'),
    input_fingerprint: record.input_fingerprint,
    attempt: record.attempt,
    result: canonicalObject(record.result, 'result'),
    verification: canonicalObject(record.verification, 'verification')
  });
}

function canonicalObject(value, field) {
  const normalized = canonicalValue(value, field);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new ToolCallRecordError(`${field} must be a JSON object`);
  }
  return normalized;
}

function canonicalValue(value, field) {
  let normalized;
  try {
    normalized = JSON.parse(canonicalize(value, `$.${field}`));
  } catch (error) {
    throw new ToolCallRecordError(`${field} must be strict JSON-compatible data`, 'TOOL_CALL_DATA_INVALID');
  }
  rejectSecrets(normalized, field);
  return normalized;
}

function rejectSecrets(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new ToolCallRecordError(
          `secret-shaped field is forbidden at ${path}.${key}`,
          'TOOL_CALL_SECRET_FORBIDDEN'
        );
      }
      rejectSecrets(child, `${path}.${key}`);
    }
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new ToolCallRecordError(`${field} must be a non-empty safe string`);
  }
  return value;
}
