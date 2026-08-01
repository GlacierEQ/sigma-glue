import {
  cloneCanonical,
  ColossusDispatchError,
  deepFreeze,
  requireString,
  validTimestamp
} from './common.mjs';

const RECEIPT_STATUSES = Object.freeze(['dispatched', 'blocked', 'failed']);
const RECEIPT_FIELDS = Object.freeze([
  'receiptId', 'requestId', 'envelopeFingerprint', 'permitFingerprint',
  'componentRef', 'method', 'idempotencyKey', 'resolvedAdapterId',
  'capability', 'status', 'reasonCode', 'receivedAt', 'redactedDiagnostics'
]);

export function validateReceipt(receipt, { request, permit, route, envelopeFingerprint }) {
  receipt = cloneCanonical(receipt);
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new ColossusDispatchError('Colossus receipt is missing', 'COLOSSUS_RECEIPT_INVALID');
  }
  if (receipt.providerConfirmation !== undefined) {
    throw new ColossusDispatchError(
      'dispatch receipt cannot claim provider confirmation',
      'COLOSSUS_RECEIPT_OVERCLAIMED'
    );
  }
  const unknown = Object.keys(receipt).find((key) => !RECEIPT_FIELDS.includes(key));
  if (unknown) {
    throw new ColossusDispatchError(
      `Colossus receipt contains unsupported field ${unknown}`,
      'COLOSSUS_RECEIPT_FIELD_FORBIDDEN'
    );
  }

  const exact = {
    requestId: request.requestId,
    envelopeFingerprint,
    permitFingerprint: permit.permitFingerprint,
    componentRef: request.componentRef,
    method: request.method,
    idempotencyKey: request.idempotencyKey,
    resolvedAdapterId: route.adapterId,
    capability: request.capability
  };
  for (const [field, value] of Object.entries(exact)) {
    if (receipt[field] !== value) {
      throw new ColossusDispatchError(
        `Colossus receipt does not bind ${field}`,
        'COLOSSUS_RECEIPT_SUBJECT_MISMATCH'
      );
    }
  }

  requireString(receipt.receiptId, 'receiptId', 'COLOSSUS_RECEIPT_INVALID');
  if (!RECEIPT_STATUSES.includes(receipt.status)) {
    throw new ColossusDispatchError('Colossus receipt status is invalid', 'COLOSSUS_RECEIPT_INVALID');
  }
  const receivedAt = new Date(validTimestamp(receipt.receivedAt, 'COLOSSUS_RECEIPT_INVALID')).toISOString();
  if ((receipt.status === 'blocked' || receipt.status === 'failed') &&
      (typeof receipt.reasonCode !== 'string' || receipt.reasonCode.trim() === '')) {
    throw new ColossusDispatchError('blocked or failed receipt requires reasonCode', 'COLOSSUS_RECEIPT_INVALID');
  }
  const diagnostics = receipt.redactedDiagnostics ?? [];
  if (!Array.isArray(diagnostics) || diagnostics.some((item) => typeof item !== 'string')) {
    throw new ColossusDispatchError('receipt diagnostics must be redacted strings', 'COLOSSUS_RECEIPT_INVALID');
  }

  return deepFreeze({
    receiptId: receipt.receiptId,
    ...exact,
    status: receipt.status,
    reasonCode: receipt.reasonCode ?? null,
    receivedAt,
    redactedDiagnostics: [...diagnostics]
  });
}
