import { planFingerprint } from '../plan/fingerprint.mjs';
import {
  cloneCanonical,
  ColossusDispatchError,
  requireString,
  validDate,
  validTimestamp
} from './common.mjs';

const PERMIT_FIELDS = Object.freeze([
  'permitId', 'claimId', 'approvalId', 'jobId', 'planFingerprint',
  'componentRef', 'method', 'idempotencyKey', 'policyVersion',
  'subjectFingerprint', 'issuedAt', 'expiresAt', 'status'
]);

export function validatePermit(permit, now) {
  permit = cloneCanonical(permit);
  if (!permit || typeof permit !== 'object' || Array.isArray(permit)) {
    throw new ColossusDispatchError('dispatch permit is required', 'DISPATCH_PERMIT_MISSING');
  }

  const normalized = {};
  for (const field of PERMIT_FIELDS) {
    normalized[field] = requireString(permit[field], field, 'DISPATCH_PERMIT_INVALID');
  }
  normalized.permitFingerprint = requireString(
    permit.permitFingerprint,
    'permitFingerprint',
    'DISPATCH_PERMIT_INVALID'
  );
  if (normalized.status !== 'issued') {
    throw new ColossusDispatchError('dispatch permit is not issued', 'DISPATCH_PERMIT_NOT_ACTIVE');
  }

  const nowMs = validDate(now, 'DISPATCH_TIME_INVALID');
  const issuedMs = validTimestamp(normalized.issuedAt, 'DISPATCH_PERMIT_INVALID');
  const expiresMs = validTimestamp(normalized.expiresAt, 'DISPATCH_PERMIT_INVALID');
  if (issuedMs >= expiresMs || issuedMs > nowMs || expiresMs <= nowMs) {
    throw new ColossusDispatchError('dispatch permit window is invalid or expired', 'DISPATCH_PERMIT_EXPIRED');
  }

  const subject = permitSubject(normalized);
  if (planFingerprint(subject) !== normalized.subjectFingerprint) {
    throw new ColossusDispatchError('dispatch permit subject fingerprint is invalid', 'DISPATCH_PERMIT_TAMPERED');
  }
  const permitCore = {};
  for (const field of PERMIT_FIELDS) permitCore[field] = normalized[field];
  if (planFingerprint(permitCore) !== normalized.permitFingerprint) {
    throw new ColossusDispatchError('dispatch permit fingerprint is invalid', 'DISPATCH_PERMIT_TAMPERED');
  }

  return Object.freeze({
    ...normalized,
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString()
  });
}

export function assertPersistedPermit(permitStore, permit) {
  let persisted;
  try {
    persisted = permitStore.getPermitByIdempotencyKey(permit.idempotencyKey);
  } catch (error) {
    throw new ColossusDispatchError(
      'dispatch permit store lookup failed',
      'DISPATCH_PERMIT_STORE_FAILED',
      { cause: error }
    );
  }
  if (!persisted) {
    throw new ColossusDispatchError('dispatch permit is not persisted', 'DISPATCH_PERMIT_NOT_PERSISTED');
  }
  for (const field of [...PERMIT_FIELDS, 'permitFingerprint']) {
    if (persisted[field] !== permit[field]) {
      throw new ColossusDispatchError(
        `persisted dispatch permit does not match ${field}`,
        'DISPATCH_PERMIT_STORE_MISMATCH'
      );
    }
  }
}

export function assertExactBinding(permit, request) {
  for (const field of ['jobId', 'planFingerprint', 'componentRef', 'method', 'idempotencyKey', 'policyVersion']) {
    if (permit[field] !== request[field]) {
      throw new ColossusDispatchError(
        `dispatch request does not match permit field ${field}`,
        'DISPATCH_PERMIT_SUBJECT_MISMATCH'
      );
    }
  }
}

function permitSubject(permit) {
  return {
    approvalId: permit.approvalId,
    jobId: permit.jobId,
    planFingerprint: permit.planFingerprint,
    componentRef: permit.componentRef,
    method: permit.method,
    idempotencyKey: permit.idempotencyKey,
    policyVersion: permit.policyVersion
  };
}
