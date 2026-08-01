import {
  cloneCanonical,
  ColossusDispatchError,
  deepFreeze,
  requireString,
  validDate,
  validTimestamp
} from './common.mjs';

const REQUEST_FIELDS = Object.freeze([
  'protocolVersion', 'schemaVersion', 'requestId', 'traceId', 'jobId',
  'componentRef', 'method', 'capability', 'idempotencyKey',
  'planFingerprint', 'policyVersion', 'scopedHandles', 'payload'
]);

export function normalizeRequest(request) {
  request = cloneCanonical(request);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ColossusDispatchError('dispatch request is required', 'DISPATCH_REQUEST_INVALID');
  }
  const unknown = Object.keys(request).filter((key) => !REQUEST_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new ColossusDispatchError(
      `dispatch request contains unsupported field: ${unknown[0]}`,
      'DISPATCH_REQUEST_FIELD_FORBIDDEN'
    );
  }

  const normalized = {};
  for (const field of REQUEST_FIELDS.slice(0, 11)) {
    normalized[field] = requireString(request[field], field, 'DISPATCH_REQUEST_INVALID');
  }
  if (!Array.isArray(request.scopedHandles)) {
    throw new ColossusDispatchError('scopedHandles must be an array', 'DISPATCH_REQUEST_INVALID');
  }
  if (!Object.hasOwn(request, 'payload')) {
    throw new ColossusDispatchError('payload is required', 'DISPATCH_REQUEST_INVALID');
  }
  normalized.scopedHandles = cloneCanonical(request.scopedHandles);
  normalized.payload = cloneCanonical(request.payload);
  return deepFreeze(normalized);
}

export function validateScopedHandles(handles, now, permitExpiresAt) {
  const nowMs = validDate(now, 'DISPATCH_TIME_INVALID');
  const permitExpiresMs = validTimestamp(permitExpiresAt, 'DISPATCH_PERMIT_INVALID');
  const ids = new Set();

  for (const [index, handle] of handles.entries()) {
    if (!handle || typeof handle !== 'object' || Array.isArray(handle)) {
      throw new ColossusDispatchError(`scoped handle ${index} is invalid`, 'SCOPED_HANDLE_INVALID');
    }
    const allowed = ['type', 'id', 'scope', 'expiresAt'];
    const unknown = Object.keys(handle).find((key) => !allowed.includes(key));
    if (unknown) {
      throw new ColossusDispatchError(
        `scoped handle contains unsupported field ${unknown}`,
        'SCOPED_HANDLE_INVALID'
      );
    }
    for (const field of allowed) requireString(handle[field], field, 'SCOPED_HANDLE_INVALID');
    const expiresMs = validTimestamp(handle.expiresAt, 'SCOPED_HANDLE_INVALID');
    if (expiresMs <= nowMs || expiresMs > permitExpiresMs) {
      throw new ColossusDispatchError('scoped handle expiry exceeds authority window', 'SCOPED_HANDLE_EXPIRED');
    }
    if (ids.has(handle.id)) {
      throw new ColossusDispatchError('duplicate scoped handle id', 'SCOPED_HANDLE_INVALID');
    }
    ids.add(handle.id);
  }
}
