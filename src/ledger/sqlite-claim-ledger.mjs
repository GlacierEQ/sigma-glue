import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertApprovalBinding, ApprovalBindingError } from '../approval/approval-binding.mjs';
import { planFingerprint } from '../plan/fingerprint.mjs';

const SUBJECT_FIELDS = Object.freeze([
  'approvalId',
  'jobId',
  'planFingerprint',
  'componentRef',
  'method',
  'idempotencyKey',
  'policyVersion'
]);

export class ClaimLedgerError extends Error {
  constructor(message, code = 'CLAIM_LEDGER_FAILED', options = undefined) {
    super(message, options);
    this.name = 'ClaimLedgerError';
    this.code = code;
  }
}

/**
 * File-backed, single-writer claim ledger.
 *
 * Atomic unit:
 * validate exact approval -> claim idempotency key -> consume approval
 * -> issue exact dispatch permit. BEGIN IMMEDIATE prevents two writers from
 * independently succeeding against the same approval or idempotency key.
 */
export class SqliteClaimLedger {
  #db;
  #idFactory;
  #permitTtlMs;

  constructor(path, { timeoutMs = 5_000, permitTtlMs = 60_000, idFactory = defaultIdFactory } = {}) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ClaimLedgerError('ledger path is required', 'LEDGER_PATH_INVALID');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new ClaimLedgerError('timeoutMs must be a non-negative safe integer', 'LEDGER_TIMEOUT_INVALID');
    }
    if (!Number.isSafeInteger(permitTtlMs) || permitTtlMs <= 0) {
      throw new ClaimLedgerError('permitTtlMs must be a positive safe integer', 'PERMIT_TTL_INVALID');
    }
    if (typeof idFactory !== 'function') {
      throw new ClaimLedgerError('idFactory must be a function', 'ID_FACTORY_INVALID');
    }

    this.#idFactory = idFactory;
    this.#permitTtlMs = permitTtlMs;
    this.#db = new DatabaseSync(path, { timeout: timeoutMs });
    this.#db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = ${timeoutMs};

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        component_ref TEXT NOT NULL,
        method TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('approved', 'consumed', 'revoked', 'expired')),
        approval_fingerprint TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_claim_id TEXT,
        CHECK (
          (status = 'consumed' AND consumed_at IS NOT NULL AND consumed_by_claim_id IS NOT NULL)
          OR
          (status <> 'consumed' AND consumed_at IS NULL AND consumed_by_claim_id IS NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS idempotency_claims (
        claim_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        approval_id TEXT NOT NULL UNIQUE,
        subject_fingerprint TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        FOREIGN KEY (approval_id) REFERENCES approvals(approval_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS dispatch_permits (
        permit_id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL UNIQUE,
        approval_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        component_ref TEXT NOT NULL,
        method TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        subject_fingerprint TEXT NOT NULL,
        permit_fingerprint TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('issued', 'expired', 'revoked')),
        FOREIGN KEY (claim_id) REFERENCES idempotency_claims(claim_id),
        FOREIGN KEY (approval_id) REFERENCES approvals(approval_id)
      ) STRICT;
    `);
  }

  close() {
    this.#db.close();
  }

  registerApproval({ approval, now = new Date() }) {
    const expected = exactSubject(approval);
    assertApprovalBinding({ approval, expected, now });
    const approvalFingerprint = planFingerprint({
      ...expected,
      issuedAt: canonicalTimestamp(approval.issuedAt, 'APPROVAL_ISSUED_AT_INVALID'),
      expiresAt: canonicalTimestamp(approval.expiresAt, 'APPROVAL_EXPIRY_INVALID'),
      status: approval.status
    });

    return this.#transaction(() => {
      const existing = this.#db.prepare(`
        SELECT approval_fingerprint AS approvalFingerprint
        FROM approvals
        WHERE approval_id = ?
      `).get(approval.approvalId);

      if (existing) {
        if (existing.approvalFingerprint !== approvalFingerprint) {
          throw new ClaimLedgerError(
            'approval id was reused with different content',
            'APPROVAL_ID_REUSE_MISMATCH'
          );
        }
        return Object.freeze({ approvalId: approval.approvalId, recorded: false });
      }

      this.#db.prepare(`
        INSERT INTO approvals (
          approval_id, job_id, plan_fingerprint, component_ref, method,
          idempotency_key, policy_version, issued_at, expires_at, status,
          approval_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)
      `).run(
        approval.approvalId,
        approval.jobId,
        approval.planFingerprint,
        approval.componentRef,
        approval.method,
        approval.idempotencyKey,
        approval.policyVersion,
        canonicalTimestamp(approval.issuedAt, 'APPROVAL_ISSUED_AT_INVALID'),
        canonicalTimestamp(approval.expiresAt, 'APPROVAL_EXPIRY_INVALID'),
        approvalFingerprint
      );

      return Object.freeze({ approvalId: approval.approvalId, recorded: true });
    });
  }

  claimDispatchPermit({ expected, now = new Date() }) {
    const subject = exactSubject(expected);
    const nowIso = canonicalDate(now, 'CLAIM_TIME_INVALID');
    const nowMs = Date.parse(nowIso);
    const subjectFingerprint = planFingerprint(subject);

    return this.#transaction(() => {
      const priorClaim = this.#db.prepare(`
        SELECT claim_id AS claimId, subject_fingerprint AS subjectFingerprint
        FROM idempotency_claims
        WHERE idempotency_key = ?
      `).get(subject.idempotencyKey);

      if (priorClaim) {
        if (priorClaim.subjectFingerprint !== subjectFingerprint) {
          throw new ClaimLedgerError(
            'idempotency key was reused with a different execution subject',
            'IDEMPOTENCY_KEY_REUSE_MISMATCH'
          );
        }
        return freezePermit(this.#permitByClaimId(priorClaim.claimId), true);
      }

      const approvalRow = this.#db.prepare(`
        SELECT
          approval_id AS approvalId,
          job_id AS jobId,
          plan_fingerprint AS planFingerprint,
          component_ref AS componentRef,
          method,
          idempotency_key AS idempotencyKey,
          policy_version AS policyVersion,
          issued_at AS issuedAt,
          expires_at AS expiresAt,
          status
        FROM approvals
        WHERE approval_id = ?
      `).get(subject.approvalId);

      if (!approvalRow) {
        throw new ClaimLedgerError('approval was not recorded', 'AUTHORIZATION_MISSING');
      }
      if (approvalRow.status === 'consumed') {
        throw new ClaimLedgerError('approval was already consumed', 'AUTHORIZATION_CONSUMED');
      }

      try {
        assertApprovalBinding({ approval: approvalRow, expected: subject, now });
      } catch (error) {
        if (error instanceof ApprovalBindingError) {
          throw new ClaimLedgerError(error.message, error.code, { cause: error });
        }
        throw error;
      }

      const claimId = this.#newId('claim');
      const permitId = this.#newId('permit');
      const approvalExpiresMs = Date.parse(approvalRow.expiresAt);
      const permitExpiresAt = new Date(Math.min(approvalExpiresMs, nowMs + this.#permitTtlMs)).toISOString();

      const consume = this.#db.prepare(`
        UPDATE approvals
        SET status = 'consumed', consumed_at = ?, consumed_by_claim_id = ?
        WHERE approval_id = ? AND status = 'approved'
      `).run(nowIso, claimId, subject.approvalId);

      if (consume.changes !== 1) {
        throw new ClaimLedgerError('approval was already consumed or unavailable', 'AUTHORIZATION_CONSUMED');
      }

      this.#db.prepare(`
        INSERT INTO idempotency_claims (
          claim_id, idempotency_key, approval_id, subject_fingerprint, claimed_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(claimId, subject.idempotencyKey, subject.approvalId, subjectFingerprint, nowIso);

      const permitCore = {
        permitId,
        claimId,
        ...subject,
        subjectFingerprint,
        issuedAt: nowIso,
        expiresAt: permitExpiresAt,
        status: 'issued'
      };
      const permitFingerprint = planFingerprint(permitCore);

      this.#db.prepare(`
        INSERT INTO dispatch_permits (
          permit_id, claim_id, approval_id, idempotency_key, job_id,
          plan_fingerprint, component_ref, method, policy_version,
          subject_fingerprint, permit_fingerprint, issued_at, expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')
      `).run(
        permitId,
        claimId,
        subject.approvalId,
        subject.idempotencyKey,
        subject.jobId,
        subject.planFingerprint,
        subject.componentRef,
        subject.method,
        subject.policyVersion,
        subjectFingerprint,
        permitFingerprint,
        nowIso,
        permitExpiresAt
      );

      return freezePermit({ ...permitCore, permitFingerprint }, false);
    });
  }

  getApproval(approvalId) {
    const row = this.#db.prepare(`
      SELECT
        approval_id AS approvalId,
        status,
        consumed_at AS consumedAt,
        consumed_by_claim_id AS consumedByClaimId
      FROM approvals
      WHERE approval_id = ?
    `).get(approvalId);
    return row ? Object.freeze({ ...row }) : null;
  }

  getPermitByIdempotencyKey(idempotencyKey) {
    const row = this.#db.prepare(`
      SELECT claim_id AS claimId
      FROM idempotency_claims
      WHERE idempotency_key = ?
    `).get(idempotencyKey);
    return row ? freezePermit(this.#permitByClaimId(row.claimId), false) : null;
  }

  #permitByClaimId(claimId) {
    const row = this.#db.prepare(`
      SELECT
        permit_id AS permitId,
        claim_id AS claimId,
        approval_id AS approvalId,
        job_id AS jobId,
        plan_fingerprint AS planFingerprint,
        component_ref AS componentRef,
        method,
        idempotency_key AS idempotencyKey,
        policy_version AS policyVersion,
        subject_fingerprint AS subjectFingerprint,
        permit_fingerprint AS permitFingerprint,
        issued_at AS issuedAt,
        expires_at AS expiresAt,
        status
      FROM dispatch_permits
      WHERE claim_id = ?
    `).get(claimId);

    if (!row) {
      throw new ClaimLedgerError('claim exists without a dispatch permit', 'LEDGER_INVARIANT_BROKEN');
    }
    return row;
  }

  #newId(prefix) {
    const value = this.#idFactory(prefix);
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ClaimLedgerError('idFactory returned an invalid identifier', 'ID_FACTORY_RESULT_INVALID');
    }
    return value;
  }

  #transaction(operation) {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw new ClaimLedgerError(
        'could not acquire the ledger write lock',
        'LEDGER_WRITE_LOCK_UNAVAILABLE',
        { cause: error }
      );
    }

    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      if (error instanceof ClaimLedgerError || error instanceof ApprovalBindingError) throw error;
      throw new ClaimLedgerError('atomic claim transaction failed', 'CLAIM_TRANSACTION_FAILED', { cause: error });
    }
  }
}

function exactSubject(value) {
  if (!value || typeof value !== 'object') {
    throw new ClaimLedgerError('execution subject is required', 'EXECUTION_SUBJECT_INVALID');
  }
  const subject = {};
  for (const field of SUBJECT_FIELDS) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      throw new ClaimLedgerError(`execution subject is missing ${field}`, 'EXECUTION_SUBJECT_INVALID');
    }
    subject[field] = value[field];
  }
  return Object.freeze(subject);
}

function canonicalTimestamp(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClaimLedgerError('timestamp is missing', code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ClaimLedgerError('timestamp is invalid', code);
  return new Date(parsed).toISOString();
}

function canonicalDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ClaimLedgerError('date is invalid', code);
  }
  return value.toISOString();
}

function freezePermit(row, replayed) {
  return Object.freeze({ ...row, replayed });
}

function defaultIdFactory(prefix) {
  return `${prefix}_${randomUUID()}`;
}
