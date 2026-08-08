import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { SqliteClaimLedger } from './sqlite-claim-ledger.mjs';

const RECEIPT_STATUSES = new Set(['dispatched', 'blocked', 'failed']);
const CURRENT_ATTEMPT_COLUMNS = Object.freeze([
  'attempt_id',
  'permit_id',
  'idempotency_key',
  'permit_fingerprint',
  'request_id',
  'envelope_fingerprint',
  'state',
  'started_at',
  'completed_at',
  'receipt_status',
  'receipt_fingerprint',
  'provider_received_at',
  'reason_code'
]);
const LEGACY_V1_ATTEMPT_COLUMNS = Object.freeze([
  'attempt_id',
  'permit_id',
  'idempotency_key',
  'permit_fingerprint',
  'state',
  'started_at',
  'accepted_at',
  'receipt_fingerprint'
]);

const CREATE_ATTEMPT_TABLE_SQL = `
  CREATE TABLE permit_dispatch_attempts (
    attempt_id TEXT PRIMARY KEY,
    permit_id TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL,
    permit_fingerprint TEXT NOT NULL,
    request_id TEXT,
    envelope_fingerprint TEXT,
    state TEXT NOT NULL CHECK (state IN ('started', 'accepted', 'rejected', 'legacy_uncertain')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    receipt_status TEXT CHECK (receipt_status IS NULL OR receipt_status IN ('dispatched', 'blocked', 'failed')),
    receipt_fingerprint TEXT,
    provider_received_at TEXT,
    reason_code TEXT,
    FOREIGN KEY (permit_id) REFERENCES dispatch_permits(permit_id),
    CHECK (
      (state = 'started'
        AND request_id IS NOT NULL
        AND envelope_fingerprint IS NOT NULL
        AND completed_at IS NULL
        AND receipt_status IS NULL
        AND receipt_fingerprint IS NULL
        AND provider_received_at IS NULL
        AND reason_code IS NULL)
      OR
      (state = 'accepted'
        AND request_id IS NOT NULL
        AND envelope_fingerprint IS NOT NULL
        AND completed_at IS NOT NULL
        AND receipt_status = 'dispatched'
        AND receipt_fingerprint IS NOT NULL
        AND provider_received_at IS NOT NULL)
      OR
      (state = 'rejected'
        AND request_id IS NOT NULL
        AND envelope_fingerprint IS NOT NULL
        AND completed_at IS NOT NULL
        AND receipt_status IN ('blocked', 'failed')
        AND receipt_fingerprint IS NOT NULL
        AND provider_received_at IS NOT NULL
        AND reason_code IS NOT NULL)
      OR
      (state = 'legacy_uncertain'
        AND request_id IS NULL
        AND envelope_fingerprint IS NULL
        AND receipt_status IS NULL
        AND provider_received_at IS NULL
        AND reason_code IS NULL
        AND (
          (completed_at IS NULL AND receipt_fingerprint IS NULL)
          OR
          (completed_at IS NOT NULL AND receipt_fingerprint IS NOT NULL)
        ))
    )
  ) STRICT;
`;

export class PermitDispatchFenceError extends Error {
  constructor(message, code = 'DISPATCH_ATTEMPT_FENCE_FAILED', options = undefined) {
    super(message, options);
    this.name = 'PermitDispatchFenceError';
    this.code = code;
  }
}

/**
 * Extends the signed approval / permit ledger with an exact one-shot transport
 * fence. The fence records which immutable envelope crossed the provider
 * boundary before transport is entered.
 *
 * A crash, timeout, malformed receipt, or lost response leaves the attempt in
 * `started`. That state is deliberately not replayable: recovery must determine
 * provider outcome instead of risking a duplicate external mutation.
 */
export class FencedSqliteClaimLedger extends SqliteClaimLedger {
  #fenceDb;
  #attemptIdFactory;

  constructor(path, {
    timeoutMs = 5_000,
    dispatchAttemptIdFactory = () => `dispatch_attempt_${randomUUID()}`,
    ...options
  } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new PermitDispatchFenceError(
        'timeoutMs must be a positive safe integer',
        'DISPATCH_ATTEMPT_TIMEOUT_INVALID'
      );
    }
    if (typeof dispatchAttemptIdFactory !== 'function') {
      throw new PermitDispatchFenceError(
        'dispatchAttemptIdFactory must be a function',
        'DISPATCH_ATTEMPT_ID_FACTORY_INVALID'
      );
    }

    super(path, { timeoutMs, ...options });
    this.#attemptIdFactory = dispatchAttemptIdFactory;

    try {
      this.#fenceDb = new DatabaseSync(path, { timeout: timeoutMs });
      if (typeof this.#fenceDb.isTransaction !== 'boolean') {
        throw new PermitDispatchFenceError(
          'runtime does not expose required SQLite transaction state',
          'DISPATCH_ATTEMPT_RUNTIME_UNSUPPORTED'
        );
      }
      this.#initializeAttemptStore(timeoutMs);
    } catch (error) {
      try { this.#fenceDb?.close(); } catch { /* preserve initialization failure */ }
      try { super.close(); } catch { /* preserve initialization failure */ }
      if (error instanceof PermitDispatchFenceError) throw error;
      throw new PermitDispatchFenceError(
        'dispatch-attempt store initialization failed',
        'DISPATCH_ATTEMPT_STORE_INIT_FAILED',
        { cause: error }
      );
    }
  }

  close() {
    let fenceError = null;
    let baseError = null;
    try {
      this.#fenceDb.close();
    } catch (error) {
      fenceError = error;
    } finally {
      try {
        super.close();
      } catch (error) {
        baseError = error;
      }
    }
    if (fenceError || baseError) {
      throw new PermitDispatchFenceError(
        'dispatch-attempt store close failed',
        'DISPATCH_ATTEMPT_STORE_CLOSE_FAILED',
        { cause: fenceError ?? baseError }
      );
    }
  }

  beginDispatchAttempt({
    permit,
    requestId,
    envelopeFingerprint,
    now = new Date()
  }) {
    const identity = permitIdentity(permit);
    requestId = requireString(requestId, 'requestId', 'DISPATCH_REQUEST_ID_INVALID');
    envelopeFingerprint = requireString(
      envelopeFingerprint,
      'envelopeFingerprint',
      'DISPATCH_ENVELOPE_FINGERPRINT_INVALID'
    );
    const startedAt = canonicalDate(now, 'DISPATCH_ATTEMPT_TIME_INVALID');
    const nowMs = Date.parse(startedAt);

    return this.#transaction(() => {
      const persisted = this.#fenceDb.prepare(`
        SELECT
          permit_id AS permitId,
          idempotency_key AS idempotencyKey,
          permit_fingerprint AS permitFingerprint,
          issued_at AS issuedAt,
          expires_at AS expiresAt,
          status
        FROM dispatch_permits
        WHERE permit_id = ?
      `).get(identity.permitId);

      if (!persisted) {
        throw new PermitDispatchFenceError(
          'dispatch permit is not persisted',
          'DISPATCH_PERMIT_NOT_PERSISTED'
        );
      }
      for (const field of ['idempotencyKey', 'permitFingerprint']) {
        if (persisted[field] !== identity[field]) {
          throw new PermitDispatchFenceError(
            `persisted dispatch permit does not match ${field}`,
            'DISPATCH_PERMIT_STORE_MISMATCH'
          );
        }
      }
      if (persisted.status !== 'issued') {
        throw new PermitDispatchFenceError(
          'dispatch permit is not active',
          'DISPATCH_PERMIT_NOT_ACTIVE'
        );
      }
      const issuedMs = Date.parse(persisted.issuedAt);
      const expiresMs = Date.parse(persisted.expiresAt);
      if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || issuedMs > nowMs || expiresMs <= nowMs) {
        throw new PermitDispatchFenceError(
          'dispatch permit window is invalid or expired',
          'DISPATCH_PERMIT_EXPIRED'
        );
      }

      const prior = this.#attemptByPermitId(identity.permitId);
      if (prior) {
        throw new PermitDispatchFenceError(
          `dispatch permit already has a ${prior.state} transport attempt`,
          'DISPATCH_PERMIT_ALREADY_ATTEMPTED'
        );
      }

      const attemptId = this.#newAttemptId();
      this.#fenceDb.prepare(`
        INSERT INTO permit_dispatch_attempts (
          attempt_id, permit_id, idempotency_key, permit_fingerprint,
          request_id, envelope_fingerprint, state, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'started', ?)
      `).run(
        attemptId,
        identity.permitId,
        identity.idempotencyKey,
        identity.permitFingerprint,
        requestId,
        envelopeFingerprint,
        startedAt
      );

      return Object.freeze({
        attemptId,
        ...identity,
        requestId,
        envelopeFingerprint,
        state: 'started',
        startedAt,
        completedAt: null,
        receiptStatus: null,
        receiptFingerprint: null,
        providerReceivedAt: null,
        reasonCode: null,
        replayed: false
      });
    });
  }

  completeDispatchAttempt({
    attemptId,
    permit,
    requestId,
    envelopeFingerprint,
    receiptStatus,
    receiptFingerprint,
    providerReceivedAt,
    reasonCode = null,
    now = new Date()
  }) {
    attemptId = requireString(attemptId, 'attemptId', 'DISPATCH_ATTEMPT_ID_INVALID');
    requestId = requireString(requestId, 'requestId', 'DISPATCH_REQUEST_ID_INVALID');
    envelopeFingerprint = requireString(
      envelopeFingerprint,
      'envelopeFingerprint',
      'DISPATCH_ENVELOPE_FINGERPRINT_INVALID'
    );
    receiptFingerprint = requireString(
      receiptFingerprint,
      'receiptFingerprint',
      'DISPATCH_RECEIPT_FINGERPRINT_INVALID'
    );
    if (!RECEIPT_STATUSES.has(receiptStatus)) {
      throw new PermitDispatchFenceError(
        'receiptStatus is invalid',
        'DISPATCH_RECEIPT_STATUS_INVALID'
      );
    }
    const providerAt = canonicalTimestamp(
      providerReceivedAt,
      'DISPATCH_PROVIDER_TIMESTAMP_INVALID'
    );
    const normalizedReason = normalizeReasonCode(receiptStatus, reasonCode);
    const identity = permitIdentity(permit);
    const completedAt = canonicalDate(now, 'DISPATCH_ATTEMPT_TIME_INVALID');
    const nextState = receiptStatus === 'dispatched' ? 'accepted' : 'rejected';

    return this.#transaction(() => {
      const existing = this.#attemptById(attemptId);
      if (!existing) {
        throw new PermitDispatchFenceError(
          'dispatch attempt was not found',
          'DISPATCH_ATTEMPT_NOT_FOUND'
        );
      }
      assertAttemptBinding(existing, {
        ...identity,
        requestId,
        envelopeFingerprint
      });

      if (existing.state !== 'started') {
        const identical = existing.state === nextState &&
          existing.receiptStatus === receiptStatus &&
          existing.receiptFingerprint === receiptFingerprint &&
          existing.providerReceivedAt === providerAt &&
          existing.reasonCode === normalizedReason;
        if (!identical) {
          throw new PermitDispatchFenceError(
            'completed dispatch attempt was replayed with different outcome evidence',
            'DISPATCH_ATTEMPT_OUTCOME_MISMATCH'
          );
        }
        return Object.freeze({ ...existing, replayed: true });
      }

      const startedMs = Date.parse(existing.startedAt);
      const completedMs = Date.parse(completedAt);
      if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
        throw new PermitDispatchFenceError(
          'local completion time predates the durable dispatch attempt',
          'DISPATCH_ATTEMPT_TIME_INVALID'
        );
      }

      const updated = this.#fenceDb.prepare(`
        UPDATE permit_dispatch_attempts
        SET
          state = ?,
          completed_at = ?,
          receipt_status = ?,
          receipt_fingerprint = ?,
          provider_received_at = ?,
          reason_code = ?
        WHERE attempt_id = ? AND state = 'started'
      `).run(
        nextState,
        completedAt,
        receiptStatus,
        receiptFingerprint,
        providerAt,
        normalizedReason,
        attemptId
      );
      if (updated.changes !== 1) {
        throw new PermitDispatchFenceError(
          'dispatch attempt changed concurrently',
          'DISPATCH_ATTEMPT_STATE_CONFLICT'
        );
      }
      return Object.freeze({ ...this.#attemptById(attemptId), replayed: false });
    });
  }

  getDispatchAttemptByPermitId(permitId) {
    permitId = requireString(permitId, 'permitId', 'DISPATCH_PERMIT_ID_INVALID');
    const row = this.#attemptByPermitId(permitId);
    return row ? Object.freeze({ ...row }) : null;
  }

  #initializeAttemptStore(timeoutMs) {
    this.#fenceDb.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = ${timeoutMs};
    `);

    try {
      this.#fenceDb.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new PermitDispatchFenceError(
        'could not acquire the dispatch-attempt schema lock',
        'DISPATCH_ATTEMPT_SCHEMA_LOCK_UNAVAILABLE',
        { cause: error }
      );
    }

    try {
      const columns = this.#attemptColumns();
      if (columns.length === 0) {
        this.#fenceDb.exec(CREATE_ATTEMPT_TABLE_SQL);
      } else if (sameColumns(columns, CURRENT_ATTEMPT_COLUMNS)) {
        // Current schema already installed.
      } else if (sameColumns(columns, LEGACY_V1_ATTEMPT_COLUMNS)) {
        this.#migrateLegacyV1AttemptStore();
      } else {
        throw new PermitDispatchFenceError(
          'dispatch-attempt schema is unsupported',
          'DISPATCH_ATTEMPT_SCHEMA_UNSUPPORTED'
        );
      }
      this.#fenceDb.exec('COMMIT');
    } catch (error) {
      let rollbackFailure = null;
      try {
        if (this.#fenceDb.isTransaction) this.#fenceDb.exec('ROLLBACK');
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
      if (rollbackFailure) {
        throw new PermitDispatchFenceError(
          'dispatch-attempt schema migration failed and rollback could not be verified',
          'DISPATCH_ATTEMPT_SCHEMA_ROLLBACK_FAILED',
          { cause: rollbackFailure }
        );
      }
      if (error instanceof PermitDispatchFenceError) throw error;
      throw new PermitDispatchFenceError(
        'dispatch-attempt schema initialization failed',
        'DISPATCH_ATTEMPT_SCHEMA_INIT_FAILED',
        { cause: error }
      );
    }
  }

  #attemptColumns() {
    return this.#fenceDb.prepare(`
      SELECT name
      FROM pragma_table_info('permit_dispatch_attempts')
      ORDER BY cid
    `).all().map((row) => row.name);
  }

  #migrateLegacyV1AttemptStore() {
    this.#fenceDb.exec(`
      ALTER TABLE permit_dispatch_attempts
      RENAME TO permit_dispatch_attempts_legacy_v1;
    `);
    this.#fenceDb.exec(CREATE_ATTEMPT_TABLE_SQL);
    this.#fenceDb.exec(`
      INSERT INTO permit_dispatch_attempts (
        attempt_id,
        permit_id,
        idempotency_key,
        permit_fingerprint,
        request_id,
        envelope_fingerprint,
        state,
        started_at,
        completed_at,
        receipt_status,
        receipt_fingerprint,
        provider_received_at,
        reason_code
      )
      SELECT
        attempt_id,
        permit_id,
        idempotency_key,
        permit_fingerprint,
        NULL,
        NULL,
        'legacy_uncertain',
        started_at,
        accepted_at,
        NULL,
        receipt_fingerprint,
        NULL,
        NULL
      FROM permit_dispatch_attempts_legacy_v1;

      DROP TABLE permit_dispatch_attempts_legacy_v1;
    `);
  }

  #attemptByPermitId(permitId) {
    return this.#fenceDb.prepare(`${ATTEMPT_SELECT}\nWHERE permit_id = ?`).get(permitId) ?? null;
  }

  #attemptById(attemptId) {
    return this.#fenceDb.prepare(`${ATTEMPT_SELECT}\nWHERE attempt_id = ?`).get(attemptId) ?? null;
  }

  #newAttemptId() {
    const value = this.#attemptIdFactory();
    return requireString(value, 'dispatch attempt id', 'DISPATCH_ATTEMPT_ID_FACTORY_RESULT_INVALID');
  }

  #transaction(operation) {
    try {
      this.#fenceDb.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new PermitDispatchFenceError(
        'could not acquire the dispatch-attempt write lock',
        'DISPATCH_ATTEMPT_LOCK_UNAVAILABLE',
        { cause: error }
      );
    }

    try {
      const result = operation();
      this.#fenceDb.exec('COMMIT');
      return result;
    } catch (error) {
      let rollbackFailure = null;
      try {
        if (this.#fenceDb.isTransaction) this.#fenceDb.exec('ROLLBACK');
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
      if (rollbackFailure) {
        throw new PermitDispatchFenceError(
          'dispatch-attempt transaction failed and rollback could not be verified',
          'DISPATCH_ATTEMPT_ROLLBACK_FAILED',
          { cause: rollbackFailure }
        );
      }
      if (error instanceof PermitDispatchFenceError) throw error;
      throw new PermitDispatchFenceError(
        'atomic dispatch-attempt transaction failed',
        'DISPATCH_ATTEMPT_TRANSACTION_FAILED',
        { cause: error }
      );
    }
  }
}

const ATTEMPT_SELECT = `
  SELECT
    attempt_id AS attemptId,
    permit_id AS permitId,
    idempotency_key AS idempotencyKey,
    permit_fingerprint AS permitFingerprint,
    request_id AS requestId,
    envelope_fingerprint AS envelopeFingerprint,
    state,
    started_at AS startedAt,
    completed_at AS completedAt,
    receipt_status AS receiptStatus,
    receipt_fingerprint AS receiptFingerprint,
    provider_received_at AS providerReceivedAt,
    reason_code AS reasonCode
  FROM permit_dispatch_attempts
`;

function assertAttemptBinding(existing, expected) {
  for (const field of [
    'permitId',
    'idempotencyKey',
    'permitFingerprint',
    'requestId',
    'envelopeFingerprint'
  ]) {
    if (existing[field] !== expected[field]) {
      throw new PermitDispatchFenceError(
        `dispatch attempt does not match ${field}`,
        'DISPATCH_ATTEMPT_SUBJECT_MISMATCH'
      );
    }
  }
}

function sameColumns(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return expected.every((column) => actualSet.has(column));
}

function permitIdentity(permit) {
  if (!permit || typeof permit !== 'object' || Array.isArray(permit)) {
    throw new PermitDispatchFenceError('dispatch permit is required', 'DISPATCH_PERMIT_INVALID');
  }
  return Object.freeze({
    permitId: requireString(permit.permitId, 'permitId', 'DISPATCH_PERMIT_INVALID'),
    idempotencyKey: requireString(permit.idempotencyKey, 'idempotencyKey', 'DISPATCH_PERMIT_INVALID'),
    permitFingerprint: requireString(permit.permitFingerprint, 'permitFingerprint', 'DISPATCH_PERMIT_INVALID')
  });
}

function normalizeReasonCode(receiptStatus, reasonCode) {
  if (receiptStatus === 'blocked' || receiptStatus === 'failed') {
    return requireString(reasonCode, 'reasonCode', 'DISPATCH_RECEIPT_REASON_INVALID');
  }
  if (reasonCode === null || reasonCode === undefined) return null;
  return requireString(reasonCode, 'reasonCode', 'DISPATCH_RECEIPT_REASON_INVALID');
}

function requireString(value, field, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PermitDispatchFenceError(`${field} must be a non-empty string`, code);
  }
  return value;
}

function canonicalTimestamp(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PermitDispatchFenceError('timestamp is missing', code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PermitDispatchFenceError('timestamp is invalid', code);
  }
  return new Date(parsed).toISOString();
}

function canonicalDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PermitDispatchFenceError('date is invalid', code);
  }
  return value.toISOString();
}
