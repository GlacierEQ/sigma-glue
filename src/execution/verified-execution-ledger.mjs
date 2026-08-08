import { ExecutionLedgerError } from '../ledger/sqlite-execution-ledger.mjs';

/**
 * Supported execution-ledger boundary.
 *
 * The SQLite ledger is the append-only storage primitive. This facade binds
 * each evidence transition back to the immutable dispatch subject and prior
 * verified evidence before delegating the durable write.
 */
export class VerifiedExecutionLedger {
  #ledger;

  constructor({ ledger } = {}) {
    if (!ledger || typeof ledger.recordDispatched !== 'function' ||
        typeof ledger.recordAttempt !== 'function' ||
        typeof ledger.getOperation !== 'function' ||
        typeof ledger.getEvents !== 'function') {
      throw new ExecutionLedgerError('execution storage ledger is required', 'EXECUTION_STORAGE_LEDGER_INVALID');
    }
    this.#ledger = ledger;
  }

  recordDispatched(input) {
    return this.#ledger.recordDispatched(input);
  }

  recordAttempt({ operationId, attempt, transitionKey, now = new Date() }) {
    const operation = this.#requireOperation(operationId);
    if (!attempt || attempt.adapterId !== operation.resolvedAdapterId ||
        attempt.envelopeFingerprint !== operation.envelopeFingerprint) {
      throw new ExecutionLedgerError(
        'attempt evidence does not match the dispatched adapter and envelope',
        'EXECUTION_ATTEMPT_SUBJECT_MISMATCH'
      );
    }
    assertEvidenceTime({
      evidenceAt: attempt.startedAt,
      previousAt: operation.updatedAt,
      observedAt: now,
      code: 'EXECUTION_ATTEMPT_TIME_INVALID'
    });
    return this.#ledger.recordAttempt({ operationId, attempt, transitionKey, now });
  }

  recordProviderConfirmation({ operationId, confirmation, transitionKey, now = new Date() }) {
    const operation = this.#requireOperation(operationId);
    assertEvidenceTime({
      evidenceAt: confirmation?.confirmedAt,
      previousAt: operation.updatedAt,
      observedAt: now,
      code: 'PROVIDER_CONFIRMATION_TIME_INVALID'
    });
    return this.#ledger.recordProviderConfirmation({ operationId, confirmation, transitionKey, now });
  }

  startReconciliation({ operationId, reconciliation, transitionKey, now = new Date() }) {
    const operation = this.#requireOperation(operationId);
    assertEvidenceTime({
      evidenceAt: reconciliation?.startedAt,
      previousAt: operation.updatedAt,
      observedAt: now,
      code: 'RECONCILIATION_START_TIME_INVALID'
    });
    return this.#ledger.startReconciliation({ operationId, reconciliation, transitionKey, now });
  }

  completeReconciliation({ operationId, result, transitionKey, now = new Date() }) {
    const operation = this.#requireOperation(operationId);
    const events = this.#ledger.getEvents(operationId);
    const confirmation = [...events].reverse().find((event) => event.eventType === 'provider.confirmed');
    const started = [...events].reverse().find((event) => event.eventType === 'reconciliation.started');
    if (!confirmation || !started) {
      throw new ExecutionLedgerError(
        'reconciliation prerequisites are missing',
        'RECONCILIATION_EVIDENCE_MISSING'
      );
    }
    if (result?.expectedFingerprint !== confirmation.evidence.afterFingerprint) {
      throw new ExecutionLedgerError(
        'reconciliation expectation does not match the provider-confirmed after-state',
        'RECONCILIATION_EXPECTATION_MISMATCH'
      );
    }
    if (result?.observationMethod !== started.evidence.observationMethod) {
      throw new ExecutionLedgerError(
        'reconciliation observation method changed after reconciliation started',
        'RECONCILIATION_METHOD_MISMATCH'
      );
    }
    if (typeof result?.matchesExpected !== 'boolean' ||
        result.matchesExpected !== (result.observedFingerprint === result.expectedFingerprint)) {
      throw new ExecutionLedgerError(
        'reconciliation match claim does not equal the fingerprint comparison',
        'RECONCILIATION_MATCH_CLAIM_MISMATCH'
      );
    }
    assertEvidenceTime({
      evidenceAt: result?.observedAt,
      previousAt: operation.updatedAt,
      observedAt: now,
      code: 'RECONCILIATION_RESULT_TIME_INVALID'
    });
    return this.#ledger.completeReconciliation({ operationId, result, transitionKey, now });
  }

  getOperation(operationId) {
    return this.#ledger.getOperation(operationId);
  }

  getOperationByRequestId(requestId) {
    return this.#ledger.getOperationByRequestId(requestId);
  }

  getEvents(operationId) {
    return this.#ledger.getEvents(operationId);
  }

  verifyEventChain(operationId) {
    return this.#ledger.verifyEventChain(operationId);
  }

  close() {
    return this.#ledger.close();
  }

  #requireOperation(operationId) {
    const operation = this.#ledger.getOperation(operationId);
    if (!operation) {
      throw new ExecutionLedgerError('execution operation was not found', 'EXECUTION_OPERATION_NOT_FOUND');
    }
    return operation;
  }
}

function assertEvidenceTime({ evidenceAt, previousAt, observedAt, code }) {
  const evidenceMs = timestamp(evidenceAt, code);
  const previousMs = timestamp(previousAt, code);
  const observedMs = dateValue(observedAt, code);
  if (evidenceMs < previousMs || evidenceMs > observedMs) {
    throw new ExecutionLedgerError(
      'evidence timestamp is outside the allowed transition window',
      code
    );
  }
}

function timestamp(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExecutionLedgerError('evidence timestamp is missing', code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ExecutionLedgerError('evidence timestamp is invalid', code);
  }
  return parsed;
}

function dateValue(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ExecutionLedgerError('transition observation time is invalid', code);
  }
  return value.getTime();
}
