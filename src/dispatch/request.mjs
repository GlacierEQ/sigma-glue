import { planFingerprint } from '../plan/fingerprint.mjs';
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
const HANDLE_FIELDS = Object.freeze([
  'type',
  'id',
  'scope',
  'issuedAt',
  'expiresAt',
  'bindingFingerprint',
  'issuer',
  'keyId',
  'signatureAlgorithm',
  'signatureVersion',
  'signature'
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

export function authorityBindingFingerprint(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ColossusDispatchError('dispatch request is required', 'DISPATCH_REQUEST_INVALID');
  }
  const subject = {
    requestId: requireString(request.requestId, 'requestId', 'DISPATCH_REQUEST_INVALID'),
    jobId: requireString(request.jobId, 'jobId', 'DISPATCH_REQUEST_INVALID'),
    componentRef: requireString(request.componentRef, 'componentRef', 'DISPATCH_REQUEST_INVALID'),
    method: requireString(request.method, 'method', 'DISPATCH_REQUEST_INVALID'),
    capability: requireString(request.capability, 'capability', 'DISPATCH_REQUEST_INVALID'),
    idempotencyKey: requireString(request.idempotencyKey, 'idempotencyKey', 'DISPATCH_REQUEST_INVALID'),
    planFingerprint: requireString(request.planFingerprint, 'planFingerprint', 'DISPATCH_REQUEST_INVALID'),
    policyVersion: requireString(request.policyVersion, 'policyVersion', 'DISPATCH_REQUEST_INVALID'),
    payload: cloneCanonical(request.payload)
  };
  return planFingerprint(subject);
}

export function validateScopedHandles(
  handles,
  now,
  permitExpiresAt,
  request,
  authorityPolicy,
  verifiedAuthorities
) {
  const nowMs = validDate(now, 'DISPATCH_TIME_INVALID');
  const permitExpiresMs = validTimestamp(permitExpiresAt, 'DISPATCH_PERMIT_INVALID');
  const ids = new Set();
  if (!authorityPolicy || typeof authorityPolicy !== 'object') {
    throw new ColossusDispatchError('scoped handle policy is required', 'SCOPED_HANDLE_POLICY_MISSING');
  }
  if (!Array.isArray(verifiedAuthorities) || verifiedAuthorities.length !== handles.length) {
    throw new ColossusDispatchError(
      'scoped handle authenticity evidence is missing',
      'SCOPED_HANDLE_AUTHENTICITY_MISSING'
    );
  }
  if (handles.length < authorityPolicy.minHandles || handles.length > authorityPolicy.maxHandles) {
    throw new ColossusDispatchError(
      'scoped handle count violates capability authority policy',
      'SCOPED_HANDLE_POLICY_MISMATCH'
    );
  }
  const expectedBinding = authorityBindingFingerprint(request);

  for (const [index, handle] of handles.entries()) {
    if (!handle || typeof handle !== 'object' || Array.isArray(handle)) {
      throw new ColossusDispatchError(`scoped handle ${index} is invalid`, 'SCOPED_HANDLE_INVALID');
    }
    const unknown = Object.keys(handle).find((key) => !HANDLE_FIELDS.includes(key));
    if (unknown) {
      throw new ColossusDispatchError(
        `scoped handle contains unsupported field ${unknown}`,
        'SCOPED_HANDLE_INVALID'
      );
    }
    for (const field of HANDLE_FIELDS) requireString(handle[field], field, 'SCOPED_HANDLE_INVALID');
    const issuedMs = validTimestamp(handle.issuedAt, 'SCOPED_HANDLE_INVALID');
    const expiresMs = validTimestamp(handle.expiresAt, 'SCOPED_HANDLE_INVALID');
    if (issuedMs > nowMs || expiresMs <= nowMs || expiresMs > permitExpiresMs || issuedMs >= expiresMs) {
      throw new ColossusDispatchError('scoped handle validity exceeds authority window', 'SCOPED_HANDLE_EXPIRED');
    }
    if (handle.bindingFingerprint !== expectedBinding) {
      throw new ColossusDispatchError(
        'scoped handle is not bound to the exact dispatch subject',
        'SCOPED_HANDLE_BINDING_MISMATCH'
      );
    }
    if (!authorityPolicy.handles.some(
      (pattern) => pattern.type === handle.type && pattern.scope === handle.scope
    )) {
      throw new ColossusDispatchError(
        'scoped handle broadens capability authority',
        'SCOPED_HANDLE_POLICY_MISMATCH'
      );
    }

    const authenticity = verifiedAuthorities[index];
    if (!authenticity?.verified ||
        authenticity.issuer !== handle.issuer ||
        authenticity.keyId !== handle.keyId) {
      throw new ColossusDispatchError(
        'scoped handle authenticity does not match the signed envelope',
        'SCOPED_HANDLE_AUTHENTICITY_MISMATCH'
      );
    }
    if (!authorityPolicy.issuers.some(
      (allowed) => allowed.issuer === authenticity.issuer && allowed.keyId === authenticity.keyId
    )) {
      throw new ColossusDispatchError(
        'scoped handle issuer is not authorized for this capability',
        'SCOPED_HANDLE_ISSUER_NOT_ALLOWED'
      );
    }

    if (ids.has(handle.id)) {
      throw new ColossusDispatchError('duplicate scoped handle id', 'SCOPED_HANDLE_INVALID');
    }
    ids.add(handle.id);
  }
}
