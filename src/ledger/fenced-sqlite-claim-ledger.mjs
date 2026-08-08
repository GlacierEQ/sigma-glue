import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { SqliteClaimLedger } from './sqlite-claim-ledger.mjs';

export class PermitDispatchFenceError extends Error {
  constructor(message, code = 'DISPATCH_ATTEMPT_FENCE_FAILED', options = undefined) {
    super(message, options);
    this.name = 'PermitDispatchFenceError';
    this.code = code;
  }
}

/**
 * Extends the signed approval / permit ledger with a one-shot transport fence.
 *
 * Safety rule: once an exact persisted permit is reserved for transport, it is
 * never automatically reusable. A crash, timeout, malformed receipt, or lost
 * response leaves the attempt in `started` so recovery must determine provider
 * outcome instead of risking a duplicate external mutation.
 */
export class FencedSqliteClaimLedger extends SqliteClaimLedger {
  #fenceDb;
  #attemptIdFactory;

  constructor(path, {
    timeoutMs = 5_000,
    dispatchAttemptIdFactory = () => `dispatch_attempt_${randomUUID()}`,
    ...options
  } = {}) {
    super(path, { timeoutMs, ...options });
    if (typeof dispatchAttemptIdFactory !== 'function') {
      super.close();
      throw new PermitDispatchFenceError(
        'dispatchAttemptIdFactory must be a function',
        'DISPATCH_ATTEMPT_ID_FACTORY_INVALID'
      );
    }

    this.#attemptIdFactory = dispatchAttemptIdFactory;
    try {
      this.#fenceDb = new DatabaseSync(path, { timeout: timeoutMs });
      this.#fenceDb.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = ${timeoutMs};

        CREATE TABLE IF NOT EXISTS permit_dispatch_attempts (
          attempt_id TEXT PRIMARY KEY,
          permit_id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT NOT NULL UNIQUE,
          permit_fingerprint TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('started', 'accepted')),
          started_at TEXT NOT NULL,
          accepted_at TEXT,
          receipt_fingerprint TEXT,
          FOREIGN KEY (permit_id) REFERENCES dispatch_permits(permit_id),
          CHECK (
            (state = 'started' AND accepted_at IS NULL AND receipt_fingerprint IS NULL)
            OR
            (state = 'accepted' AND accepted_at IS NOT NULL AND receipt_fingerprint IS NOT NULL)
          )
        ) STRICT;
      `);
    } catch (error) {
      try { this.#fenceDb?.close(); } catch { /* preserve initialization failure */ }
      super.close();
      throw new PermitDispatchFenceError(
        'dispatch-attempt store initialization failed',
        'DISPATCH_ATTEMPT_STORE_INIT_FAILED',
        { cause: error }
      );
    }
  }

  close() {
    this.#fenceDb.close();
    return super.close();
  }

  beginDispatchAttempt({ permit, now = new Date() }) {
    const identity = permitIdentity(permit);
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

      const prior = this.#fenceDb.prepare(`
        SELECT
          attempt_id AS attemptId,
          permit_id AS permitId,
          idempotency_key AS idempotencyKey,
          permit_fingerprint AS permitFingerprint,
          state,
          started_at AS startedAt,
          accepted_at AS acceptedAt,
          receipt_fingerprint AS receiptFingerprint
        FROM permit_dispatch_attempts
        WHERE permit_id = ?
      `).get(identity.permitId);
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
          state, started_at
        ) VALUES (?, ?, ?, ?, 'started', ?)
      `).run(
        attemptId,
        identity.permitId,
        identity.idempotencyKey,
        identity.permitFingerprint,
        startedAt
      );

      return Object.freeze({
        attemptId,
        ...identity,
        state: 'started',
        startedAt,
        acceptedAt: null,
        receiptFingerprint: null,
        replayed: false
      });
    });
  }

  acceptDispatchAttempt({ attemptId, permit, receiptFingerprint, now = new Date() }) {
    requireString(attemptId, 'attemptId', 'DISPATCH_ATTEMPT_ID_INVALID');
    requireString(receiptFingerprint, 'receiptFingerprint', 'DISPATCH_RECEIPT_FINGERPRINT_INVALID');
    const identity = permitIdentity(permit);
    const acceptedAt = canonicalDate(now, 'DISPATCH_ATTEMPT_TIME_INVALID');

    return this.#transaction(() => {
      const existing = this.#attemptById(attemptId);
      if (!existing) {
        throw new PermitDispatchFenceError(
          'dispatch attempt was not found',
          'DISPATCH_ATTEMPT_NOT_FOUND'
        );
      }
      for (const field of ['permitId', 'idempotencyKey', 'permitFingerprint']) {
        if (existing[field] !== identity[field]) {
          throw new PermitDispatchFenceError(
            `dispatch attempt does not match ${field}`,
            'DISPATCH_ATTEMPT_SUBJECT_MISMATCH'
          );
        }
      }

      if (existing.state === 'accepted') {
        if (existing.receiptFingerprint !== receiptFingerprint) {
          throw new PermitDispatchFenceError(
            'accepted dispatch attempt was replayed with different receipt evidence',
            'DISPATCH_ATTEMPT_RECEIPT_MISMATCH'
          );
        }
        return Object.freeze({ ...existing, replayed: true });
      }
      if (existing.state !== 'started') {
        throw new PermitDispatchFenceError(
          'dispatch attempt is in an unsupported state',
          'DISPATCH_ATTEMPT_STATE_INVALID'
        );
      }

      const startedMs = Date.parse(existing.startedAt);
      const acceptedMs = Date.parse(acceptedAt);
      if (!Number.isFinite(startedMs) || !Number.isFinite(acceptedMs) || acceptedMs < startedMs) {
        throw new PermitDispatchFenceError(
          'accepted receipt evidence predates the durable dispatch attempt',
          'DISPATCH_ATTEMPT_TIME_INVALID'
        );
      }

      const updated = this.#fenceDb.prepare(`
        UPDATE permit_dispatch_attempts
        SET state = 'accepted', accepted_at = ?, receipt_fingerprint = ?
        WHERE attempt_id = ? AND state = 'started'
      `).run(acceptedAt, receiptFingerprint, attemptId);
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
    requireString(permitId, 'permitId', 'DISPATCH_PERMIT_ID_INVALID');
    const row = this.#fenceDb.prepare(`
      SELECT
        attempt_id AS attemptId,
        permit_id AS permitId,
        idempotency_key AS idempotencyKey,
        permit_fingerprint AS permitFingerprint,
        state,
        started_at AS startedAt,
        accepted_at AS acceptedAt,
        receipt_fingerprint AS receiptFingerprint
      FROM permit_dispatch_attempts
      WHERE permit_id = ?
    `).get(permitId);
    return row ? Object.freeze({ ...row }) : null;
  }

  #attemptById(attemptId) {
    return this.#fenceDb.prepare(`
      SELECT
        attempt_id AS attemptId,
        permit_id AS permitId,
        idempotency_key AS idempotencyKey,
        permit_fingerprint AS permitFingerprint,
        state,
        started_at AS startedAt,
        accepted_at AS acceptedAt,
        receipt_fingerprint AS receiptFingerprint
      FROM permit_dispatch_attempts
      WHERE attempt_id = ?
    `).get(attemptId) ?? null;
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

function requireString(value, field, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PermitDispatchFenceError(`${field} must be a non-empty string`, code);
  }
  return value;
}

function canonicalDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PermitDispatchFenceError('date is invalid', code);
  }
  return value.toISOString();
}
