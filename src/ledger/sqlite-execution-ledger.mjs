import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalize, planFingerprint } from '../plan/fingerprint.mjs';

const STATES = Object.freeze([
  'dispatched',
  'attempted',
  'provider_confirmed',
  'reconciling',
  'reconciled',
  'recovery_required',
  'failed'
]);
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROVIDER_REFERENCE_PATTERN = /^providerref_[A-Za-z0-9._~-]{8,256}$/;

export class ExecutionLedgerError extends Error {
  constructor(message, code = 'EXECUTION_LEDGER_FAILED', options = undefined) {
    super(message, options);
    this.name = 'ExecutionLedgerError';
    this.code = code;
  }
}

/**
 * Durable, append-only execution state ledger.
 *
 * Canonical path:
 * dispatched -> attempted -> provider_confirmed -> reconciling -> reconciled
 */
export class SqliteExecutionLedger {
  #db;
  #idFactory;

  constructor(path, { timeoutMs = 5_000, idFactory = defaultIdFactory } = {}) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ExecutionLedgerError('execution ledger path is required', 'EXECUTION_LEDGER_PATH_INVALID');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new ExecutionLedgerError('timeoutMs must be a non-negative safe integer', 'EXECUTION_LEDGER_TIMEOUT_INVALID');
    }
    if (typeof idFactory !== 'function') {
      throw new ExecutionLedgerError('idFactory must be a function', 'EXECUTION_ID_FACTORY_INVALID');
    }

    this.#idFactory = idFactory;
    this.#db = new DatabaseSync(path, { timeout: timeoutMs });
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = ${timeoutMs};

      CREATE TABLE IF NOT EXISTS execution_operations (
        operation_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        envelope_fingerprint TEXT NOT NULL UNIQUE,
        permit_fingerprint TEXT NOT NULL,
        component_ref TEXT NOT NULL,
        method TEXT NOT NULL,
        resolved_adapter_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        subject_fingerprint TEXT NOT NULL UNIQUE,
        receipt_fingerprint TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN (
          'dispatched', 'attempted', 'provider_confirmed', 'reconciling',
          'reconciled', 'recovery_required', 'failed'
        )),
        state_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_event_fingerprint TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS execution_events (
        event_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        transition_key TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        subject_fingerprint TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        previous_event_fingerprint TEXT,
        event_fingerprint TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES execution_operations(operation_id),
        UNIQUE (operation_id, sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS provider_confirmations (
        operation_id TEXT PRIMARY KEY,
        provider_request_id TEXT NOT NULL,
        confirmation_method TEXT NOT NULL,
        before_fingerprint TEXT NOT NULL,
        after_fingerprint TEXT NOT NULL,
        confirmation_fingerprint TEXT NOT NULL UNIQUE,
        confirmed_at TEXT NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES execution_operations(operation_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS reconciliation_results (
        operation_id TEXT PRIMARY KEY,
        observation_method TEXT NOT NULL,
        expected_fingerprint TEXT NOT NULL,
        observed_fingerprint TEXT NOT NULL,
        matches_expected INTEGER NOT NULL CHECK (matches_expected IN (0, 1)),
        result_fingerprint TEXT NOT NULL UNIQUE,
        observed_at TEXT NOT NULL,
        FOREIGN KEY (operation_id) REFERENCES execution_operations(operation_id)
      ) STRICT;
    `);
  }

  close() {
    this.#db.close();
  }

  recordDispatched({ receipt, transitionKey, now = new Date() }) {
    const normalized = normalizeDispatchReceipt(receipt);
    const occurredAt = canonicalDate(now, 'EXECUTION_EVENT_TIME_INVALID');
    const key = transitionKey ?? `dispatch:${normalized.receiptId}`;
    requireTransitionKey(key);

    const subject = Object.freeze({
      requestId: normalized.requestId,
      idempotencyKey: normalized.idempotencyKey,
      envelopeFingerprint: normalized.envelopeFingerprint,
      permitFingerprint: normalized.permitFingerprint,
      componentRef: normalized.componentRef,
      method: normalized.method,
      resolvedAdapterId: normalized.resolvedAdapterId,
      capability: normalized.capability
    });
    const subjectFingerprint = planFingerprint(subject);
    const receiptFingerprint = planFingerprint(normalized);
    const evidence = Object.freeze({
      receiptId: normalized.receiptId,
      receiptFingerprint,
      receivedAt: normalized.receivedAt,
      diagnosticsFingerprint: planFingerprint(normalized.redactedDiagnostics)
    });

    return this.#transaction(() => {
      const replay = this.#existingTransition(key, 'dispatch.accepted', subjectFingerprint, evidence);
      if (replay) return replay;

      const existing = this.#db.prepare(`
        SELECT * FROM execution_operations
        WHERE request_id = ? OR idempotency_key = ? OR envelope_fingerprint = ?
      `).get(normalized.requestId, normalized.idempotencyKey, normalized.envelopeFingerprint);
      if (existing) {
        if (existing.receipt_fingerprint !== receiptFingerprint || existing.subject_fingerprint !== subjectFingerprint) {
          throw new ExecutionLedgerError(
            'dispatch identity was reused with different content',
            'EXECUTION_DISPATCH_IDENTITY_CONFLICT'
          );
        }
        return freezeOperation(mapOperation(existing), true);
      }

      const operationId = this.#newId('operation');
      const event = buildEvent({
        eventId: this.#newId('event'),
        operationId,
        transitionKey: key,
        sequence: 1,
        eventType: 'dispatch.accepted',
        fromState: null,
        toState: 'dispatched',
        subjectFingerprint,
        evidence,
        previousEventFingerprint: null,
        occurredAt
      });

      this.#db.prepare(`
        INSERT INTO execution_operations (
          operation_id, request_id, idempotency_key, envelope_fingerprint,
          permit_fingerprint, component_ref, method, resolved_adapter_id,
          capability, subject_fingerprint, receipt_fingerprint, state,
          state_version, created_at, updated_at, last_event_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', 1, ?, ?, ?)
      `).run(
        operationId,
        normalized.requestId,
        normalized.idempotencyKey,
        normalized.envelopeFingerprint,
        normalized.permitFingerprint,
        normalized.componentRef,
        normalized.method,
        normalized.resolvedAdapterId,
        normalized.capability,
        subjectFingerprint,
        receiptFingerprint,
        occurredAt,
        occurredAt,
        event.eventFingerprint
      );
      this.#insertEvent(event);
      return freezeOperation(this.#operationById(operationId), false);
    });
  }

  recordAttempt({ operationId, attempt, transitionKey, now = new Date() }) {
    const evidence = normalizeAttempt(attempt);
    return this.#transition({
      operationId,
      transitionKey,
      eventType: 'execution.attempted',
      expectedState: 'dispatched',
      targetState: 'attempted',
      evidence,
      now
    });
  }

  recordProviderConfirmation({ operationId, confirmation, transitionKey, now = new Date() }) {
    const evidence = normalizeConfirmation(confirmation);
    return this.#transaction(() => {
      const result = this.#transitionInsideTransaction({
        operationId,
        transitionKey,
        eventType: 'provider.confirmed',
        expectedState: 'attempted',
        targetState: 'provider_confirmed',
        evidence,
        now
      });
      if (!result.replayed) {
        this.#db.prepare(`
          INSERT INTO provider_confirmations (
            operation_id, provider_request_id, confirmation_method,
            before_fingerprint, after_fingerprint, confirmation_fingerprint,
            confirmed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          operationId,
          evidence.providerRequestId,
          evidence.confirmationMethod,
          evidence.beforeFingerprint,
          evidence.afterFingerprint,
          planFingerprint(evidence),
          evidence.confirmedAt
        );
      }
      return result;
    });
  }

  startReconciliation({ operationId, reconciliation, transitionKey, now = new Date() }) {
    const evidence = normalizeReconciliationStart(reconciliation);
    return this.#transition({
      operationId,
      transitionKey,
      eventType: 'reconciliation.started',
      expectedState: 'provider_confirmed',
      targetState: 'reconciling',
      evidence,
      now
    });
  }

  completeReconciliation({ operationId, result, transitionKey, now = new Date() }) {
    const evidence = normalizeReconciliationResult(result);
    const targetState = evidence.matchesExpected ? 'reconciled' : 'recovery_required';
    return this.#transaction(() => {
      const transition = this.#transitionInsideTransaction({
        operationId,
        transitionKey,
        eventType: evidence.matchesExpected ? 'reconciliation.matched' : 'reconciliation.mismatch',
        expectedState: 'reconciling',
        targetState,
        evidence,
        now
      });
      if (!transition.replayed) {
        this.#db.prepare(`
          INSERT INTO reconciliation_results (
            operation_id, observation_method, expected_fingerprint,
            observed_fingerprint, matches_expected, result_fingerprint,
            observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          operationId,
          evidence.observationMethod,
          evidence.expectedFingerprint,
          evidence.observedFingerprint,
          evidence.matchesExpected ? 1 : 0,
          planFingerprint(evidence),
          evidence.observedAt
        );
      }
      return transition;
    });
  }

  getOperation(operationId) {
    const row = this.#db.prepare(`
      SELECT * FROM execution_operations WHERE operation_id = ?
    `).get(operationId);
    return row ? freezeOperation(mapOperation(row), false) : null;
  }

  getOperationByRequestId(requestId) {
    const row = this.#db.prepare(`
      SELECT * FROM execution_operations WHERE request_id = ?
    `).get(requestId);
    return row ? freezeOperation(mapOperation(row), false) : null;
  }

  getEvents(operationId) {
    const rows = this.#db.prepare(`
      SELECT * FROM execution_events
      WHERE operation_id = ? ORDER BY sequence ASC
    `).all(operationId);
    return Object.freeze(rows.map((row) => Object.freeze(mapEvent(row))));
  }

  verifyEventChain(operationId) {
    const operation = this.getOperation(operationId);
    if (!operation) {
      throw new ExecutionLedgerError('execution operation was not found', 'EXECUTION_OPERATION_NOT_FOUND');
    }
    const events = this.getEvents(operationId);
    let previous = null;
    for (const event of events) {
      if (event.previousEventFingerprint !== previous) {
        throw new ExecutionLedgerError('execution event chain predecessor mismatch', 'EXECUTION_EVENT_CHAIN_INVALID');
      }
      const rebuilt = buildEvent({
        eventId: event.eventId,
        operationId: event.operationId,
        transitionKey: event.transitionKey,
        sequence: event.sequence,
        eventType: event.eventType,
        fromState: event.fromState,
        toState: event.toState,
        subjectFingerprint: event.subjectFingerprint,
        evidence: event.evidence,
        previousEventFingerprint: event.previousEventFingerprint,
        occurredAt: event.occurredAt
      });
      if (rebuilt.eventFingerprint !== event.eventFingerprint) {
        throw new ExecutionLedgerError('execution event fingerprint mismatch', 'EXECUTION_EVENT_CHAIN_INVALID');
      }
      previous = event.eventFingerprint;
    }
    if (events.length !== operation.stateVersion || previous !== operation.lastEventFingerprint) {
      throw new ExecutionLedgerError('execution operation head does not match event chain', 'EXECUTION_EVENT_CHAIN_INVALID');
    }
    return Object.freeze({
      valid: true,
      operationId,
      eventCount: events.length,
      lastEventFingerprint: previous
    });
  }

  #transition(input) {
    return this.#transaction(() => this.#transitionInsideTransaction(input));
  }

  #transitionInsideTransaction({
    operationId,
    transitionKey,
    eventType,
    expectedState,
    targetState,
    evidence,
    now
  }) {
    requireString(operationId, 'operationId', 'EXECUTION_OPERATION_ID_INVALID');
    requireTransitionKey(transitionKey);
    const occurredAt = canonicalDate(now, 'EXECUTION_EVENT_TIME_INVALID');
    const operation = this.#operationById(operationId);
    if (!operation) {
      throw new ExecutionLedgerError('execution operation was not found', 'EXECUTION_OPERATION_NOT_FOUND');
    }

    const replay = this.#existingTransition(
      transitionKey,
      eventType,
      operation.subjectFingerprint,
      evidence,
      operationId
    );
    if (replay) return replay;
    if (operation.state !== expectedState) {
      throw new ExecutionLedgerError(
        `${operation.state} -> ${targetState} is not allowed`,
        'EXECUTION_STATE_TRANSITION_INVALID'
      );
    }
    if (!STATES.includes(targetState)) {
      throw new ExecutionLedgerError('target execution state is invalid', 'EXECUTION_STATE_INVALID');
    }

    const event = buildEvent({
      eventId: this.#newId('event'),
      operationId,
      transitionKey,
      sequence: operation.stateVersion + 1,
      eventType,
      fromState: operation.state,
      toState: targetState,
      subjectFingerprint: operation.subjectFingerprint,
      evidence,
      previousEventFingerprint: operation.lastEventFingerprint,
      occurredAt
    });

    const update = this.#db.prepare(`
      UPDATE execution_operations
      SET state = ?, state_version = state_version + 1,
          updated_at = ?, last_event_fingerprint = ?
      WHERE operation_id = ? AND state = ? AND state_version = ?
    `).run(
      targetState,
      occurredAt,
      event.eventFingerprint,
      operationId,
      expectedState,
      operation.stateVersion
    );
    if (update.changes !== 1) {
      throw new ExecutionLedgerError('execution state changed concurrently', 'EXECUTION_STATE_CONFLICT');
    }
    this.#insertEvent(event);
    return freezeOperation(this.#operationById(operationId), false);
  }

  #existingTransition(transitionKey, eventType, subjectFingerprint, evidence, operationId = undefined) {
    const row = this.#db.prepare(`
      SELECT * FROM execution_events WHERE transition_key = ?
    `).get(transitionKey);
    if (!row) return null;
    const event = mapEvent(row);
    const evidenceFingerprint = planFingerprint(evidence);
    if (
      event.eventType !== eventType ||
      event.subjectFingerprint !== subjectFingerprint ||
      event.evidenceFingerprint !== evidenceFingerprint ||
      (operationId !== undefined && event.operationId !== operationId)
    ) {
      throw new ExecutionLedgerError(
        'transition key was reused with different execution evidence',
        'EXECUTION_TRANSITION_KEY_REUSE_MISMATCH'
      );
    }
    return freezeOperation(this.#operationById(event.operationId), true);
  }

  #operationById(operationId) {
    const row = this.#db.prepare(`
      SELECT * FROM execution_operations WHERE operation_id = ?
    `).get(operationId);
    return row ? mapOperation(row) : null;
  }

  #insertEvent(event) {
    this.#db.prepare(`
      INSERT INTO execution_events (
        event_id, operation_id, transition_key, sequence, event_type,
        from_state, to_state, subject_fingerprint, evidence_fingerprint,
        evidence_json, previous_event_fingerprint, event_fingerprint,
        occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.operationId,
      event.transitionKey,
      event.sequence,
      event.eventType,
      event.fromState,
      event.toState,
      event.subjectFingerprint,
      event.evidenceFingerprint,
      canonicalize(event.evidence),
      event.previousEventFingerprint,
      event.eventFingerprint,
      event.occurredAt
    );
  }

  #newId(prefix) {
    const value = this.#idFactory(prefix);
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ExecutionLedgerError('idFactory returned an invalid identifier', 'EXECUTION_ID_FACTORY_RESULT_INVALID');
    }
    return value;
  }

  #transaction(operation) {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new ExecutionLedgerError(
        'could not acquire the execution ledger write lock',
        'EXECUTION_LEDGER_WRITE_LOCK_UNAVAILABLE',
        { cause: error }
      );
    }
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      if (error instanceof ExecutionLedgerError) throw error;
      throw new ExecutionLedgerError('execution ledger transaction failed', 'EXECUTION_LEDGER_TRANSACTION_FAILED', { cause: error });
    }
  }
}

function normalizeDispatchReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new ExecutionLedgerError('dispatch receipt is required', 'EXECUTION_DISPATCH_RECEIPT_INVALID');
  }
  const normalized = {
    receiptId: requireString(receipt.receiptId, 'receiptId', 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    requestId: requireString(receipt.requestId, 'requestId', 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    envelopeFingerprint: requireFingerprint(receipt.envelopeFingerprint, 'envelopeFingerprint'),
    permitFingerprint: requireFingerprint(receipt.permitFingerprint, 'permitFingerprint'),
    componentRef: requireString(receipt.componentRef, 'componentRef', 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    method: requireString(receipt.method, 'method', 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    idempotencyKey: requireString(receipt.idempotencyKey, 'idempotencyKey', 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    resolvedAdapterId: requireString(receipt.resolvedAdapterId, 'resolvedAdapterId', 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    capability: requireString(receipt.capability, 'capability', 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    status: requireString(receipt.status, 'status', 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    receivedAt: canonicalTimestamp(receipt.receivedAt, 'EXECUTION_DISPATCH_RECEIPT_INVALID'),
    redactedDiagnostics: normalizeDiagnostics(receipt.redactedDiagnostics)
  };
  if (normalized.status !== 'dispatched') {
    throw new ExecutionLedgerError('only dispatched receipts can create operations', 'EXECUTION_DISPATCH_RECEIPT_STATUS_INVALID');
  }
  return Object.freeze(normalized);
}

function normalizeAttempt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutionLedgerError('attempt evidence is required', 'EXECUTION_ATTEMPT_INVALID');
  }
  return Object.freeze({
    attemptId: requireString(value.attemptId, 'attemptId', 'EXECUTION_ATTEMPT_INVALID'),
    adapterId: requireString(value.adapterId, 'adapterId', 'EXECUTION_ATTEMPT_INVALID'),
    envelopeFingerprint: requireFingerprint(value.envelopeFingerprint, 'envelopeFingerprint'),
    startedAt: canonicalTimestamp(value.startedAt, 'EXECUTION_ATTEMPT_INVALID')
  });
}

function normalizeConfirmation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutionLedgerError('provider confirmation is required', 'PROVIDER_CONFIRMATION_INVALID');
  }
  const providerRequestId = requireString(value.providerRequestId, 'providerRequestId', 'PROVIDER_CONFIRMATION_INVALID');
  if (!PROVIDER_REFERENCE_PATTERN.test(providerRequestId)) {
    throw new ExecutionLedgerError('provider request reference must be opaque', 'PROVIDER_REFERENCE_INVALID');
  }
  return Object.freeze({
    providerRequestId,
    confirmationMethod: requireString(value.confirmationMethod, 'confirmationMethod', 'PROVIDER_CONFIRMATION_INVALID'),
    beforeFingerprint: requireFingerprint(value.beforeFingerprint, 'beforeFingerprint'),
    afterFingerprint: requireFingerprint(value.afterFingerprint, 'afterFingerprint'),
    confirmedAt: canonicalTimestamp(value.confirmedAt, 'PROVIDER_CONFIRMATION_INVALID')
  });
}

function normalizeReconciliationStart(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutionLedgerError('reconciliation start evidence is required', 'RECONCILIATION_START_INVALID');
  }
  return Object.freeze({
    observationMethod: requireString(value.observationMethod, 'observationMethod', 'RECONCILIATION_START_INVALID'),
    startedAt: canonicalTimestamp(value.startedAt, 'RECONCILIATION_START_INVALID')
  });
}

function normalizeReconciliationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.matchesExpected !== 'boolean') {
    throw new ExecutionLedgerError('reconciliation result is invalid', 'RECONCILIATION_RESULT_INVALID');
  }
  return Object.freeze({
    observationMethod: requireString(value.observationMethod, 'observationMethod', 'RECONCILIATION_RESULT_INVALID'),
    expectedFingerprint: requireFingerprint(value.expectedFingerprint, 'expectedFingerprint'),
    observedFingerprint: requireFingerprint(value.observedFingerprint, 'observedFingerprint'),
    matchesExpected: value.matchesExpected,
    observedAt: canonicalTimestamp(value.observedAt, 'RECONCILIATION_RESULT_INVALID')
  });
}

function buildEvent({
  eventId,
  operationId,
  transitionKey,
  sequence,
  eventType,
  fromState,
  toState,
  subjectFingerprint,
  evidence,
  previousEventFingerprint,
  occurredAt
}) {
  const evidenceFingerprint = planFingerprint(evidence);
  const core = {
    eventId,
    operationId,
    transitionKey,
    sequence,
    eventType,
    fromState,
    toState,
    subjectFingerprint,
    evidenceFingerprint,
    evidence,
    previousEventFingerprint,
    occurredAt
  };
  return Object.freeze({ ...core, eventFingerprint: planFingerprint(core) });
}

function mapOperation(row) {
  return {
    operationId: row.operation_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    envelopeFingerprint: row.envelope_fingerprint,
    permitFingerprint: row.permit_fingerprint,
    componentRef: row.component_ref,
    method: row.method,
    resolvedAdapterId: row.resolved_adapter_id,
    capability: row.capability,
    subjectFingerprint: row.subject_fingerprint,
    receiptFingerprint: row.receipt_fingerprint,
    state: row.state,
    stateVersion: row.state_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventFingerprint: row.last_event_fingerprint
  };
}

function mapEvent(row) {
  return {
    eventId: row.event_id,
    operationId: row.operation_id,
    transitionKey: row.transition_key,
    sequence: row.sequence,
    eventType: row.event_type,
    fromState: row.from_state,
    toState: row.to_state,
    subjectFingerprint: row.subject_fingerprint,
    evidenceFingerprint: row.evidence_fingerprint,
    evidence: JSON.parse(row.evidence_json),
    previousEventFingerprint: row.previous_event_fingerprint,
    eventFingerprint: row.event_fingerprint,
    occurredAt: row.occurred_at
  };
}

function freezeOperation(operation, replayed) {
  return Object.freeze({ ...operation, replayed });
}

function normalizeDiagnostics(value) {
  const diagnostics = value ?? [];
  if (!Array.isArray(diagnostics) || diagnostics.some((item) => typeof item !== 'string')) {
    throw new ExecutionLedgerError('dispatch diagnostics must be redacted strings', 'EXECUTION_DISPATCH_RECEIPT_INVALID');
  }
  return Object.freeze([...diagnostics]);
}

function requireFingerprint(value, field) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw new ExecutionLedgerError(`${field} must be a SHA-256 fingerprint`, 'EXECUTION_FINGERPRINT_INVALID');
  }
  return value;
}

function requireTransitionKey(value) {
  return requireString(value, 'transitionKey', 'EXECUTION_TRANSITION_KEY_INVALID');
}

function requireString(value, field, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExecutionLedgerError(`${field} must be a non-empty string`, code);
  }
  return value;
}

function canonicalTimestamp(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExecutionLedgerError('timestamp is missing', code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ExecutionLedgerError('timestamp is invalid', code);
  return new Date(parsed).toISOString();
}

function canonicalDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ExecutionLedgerError('date is invalid', code);
  }
  return value.toISOString();
}

function defaultIdFactory(prefix) {
  return `${prefix}_${randomUUID()}`;
}
