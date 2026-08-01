export class ApprovalBindingError extends Error {
  constructor(message, code = 'APPROVAL_BINDING_FAILED') {
    super(message);
    this.name = 'ApprovalBindingError';
    this.code = code;
  }
}

/**
 * Verify that Gatekeeper approved this exact job, plan, component, method,
 * and idempotency subject. This function authorizes nothing by itself.
 */
export function assertApprovalBinding({ approval, expected, now = new Date() }) {
  if (!approval || approval.status !== 'approved') {
    throw new ApprovalBindingError('approval is not approved', 'APPROVAL_NOT_APPROVED');
  }
  const fields = ['approvalId', 'jobId', 'planFingerprint', 'componentRef', 'method', 'idempotencyKey'];
  for (const field of fields) {
    if (!approval[field] || approval[field] !== expected[field]) {
      throw new ApprovalBindingError(`approval does not bind ${field}`, 'APPROVAL_SUBJECT_MISMATCH');
    }
  }
  if (!approval.expiresAt || Number.isNaN(Date.parse(approval.expiresAt))) {
    throw new ApprovalBindingError('approval expiry is missing or invalid', 'APPROVAL_EXPIRY_INVALID');
  }
  if (new Date(approval.expiresAt) <= now) {
    throw new ApprovalBindingError('approval has expired', 'APPROVAL_EXPIRED');
  }
  return Object.freeze({ approvalId: approval.approvalId, bound: true });
}
