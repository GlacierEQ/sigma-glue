export class ApprovalBindingError extends Error {
  constructor(message, code = 'APPROVAL_BINDING_FAILED') {
    super(message);
    this.name = 'ApprovalBindingError';
    this.code = code;
  }
}

const BOUND_FIELDS = Object.freeze([
  'approvalId',
  'jobId',
  'planFingerprint',
  'componentRef',
  'method',
  'idempotencyKey',
  'policyVersion'
]);

/**
 * Verify that Gatekeeper approved this exact execution subject.
 * This function authorizes nothing and does not consume the approval; durable
 * single-use enforcement belongs to Gatekeeper or the idempotency ledger.
 */
export function assertApprovalBinding({ approval, expected, now = new Date() }) {
  if (!approval || approval.status !== 'approved') {
    throw new ApprovalBindingError('approval is not approved', 'APPROVAL_NOT_APPROVED');
  }
  if (!expected || typeof expected !== 'object') {
    throw new ApprovalBindingError('expected approval subject is missing', 'APPROVAL_EXPECTATION_MISSING');
  }

  for (const field of BOUND_FIELDS) {
    if (typeof approval[field] !== 'string' || approval[field] === '' || approval[field] !== expected[field]) {
      throw new ApprovalBindingError(`approval does not bind ${field}`, 'APPROVAL_SUBJECT_MISMATCH');
    }
  }

  const nowMs = validDate(now, 'current time', 'APPROVAL_TIME_INVALID');
  const issuedMs = validTimestamp(approval.issuedAt, 'approval issuance', 'APPROVAL_ISSUED_AT_INVALID');
  const expiresMs = validTimestamp(approval.expiresAt, 'approval expiry', 'APPROVAL_EXPIRY_INVALID');

  if (issuedMs >= expiresMs || issuedMs > nowMs) {
    throw new ApprovalBindingError('approval validity window is invalid', 'APPROVAL_WINDOW_INVALID');
  }
  if (expiresMs <= nowMs) {
    throw new ApprovalBindingError('approval has expired', 'APPROVAL_EXPIRED');
  }

  return Object.freeze({
    approvalId: approval.approvalId,
    planFingerprint: approval.planFingerprint,
    policyVersion: approval.policyVersion,
    expiresAt: new Date(expiresMs).toISOString(),
    bound: true
  });
}

function validTimestamp(value, label, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApprovalBindingError(`${label} is missing`, code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ApprovalBindingError(`${label} is invalid`, code);
  }
  return parsed;
}

function validDate(value, label, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ApprovalBindingError(`${label} is invalid`, code);
  }
  return value.getTime();
}
