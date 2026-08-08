import { DatabaseSync } from 'node:sqlite';

import { planFingerprint } from '../plan/fingerprint.mjs';
import { providerRecoveryFingerprint } from './provider-outcome-recovery.mjs';

const STATES = new Set(['confirmed_applied', 'confirmed_not_applied', 'still_unknown']);
const VERSION_SEMANTICS = new Set(['monotonic_revision', 'content_addressed', 'unknown']);

export class ProviderRecoveryLedgerError extends Error {
  constructor(message, code = 'PROVIDER_RECOVERY_LEDGER_FAILED', options = undefined) {
    super(message, options);
    this.name = 'ProviderRecoveryLedgerError';
    this.code = code;
  }
}

/**
 * Restart-readable evidence ledger for provider outcome recovery.
 *
 * The ledger stores fingerprints and stable identities only. It does not store
 * provider credentials, desired content bytes, or raw mutation payloads.
 */
export class SqliteProviderRecoveryLedger {
  #db;

  constructor(path, { timeoutMs = 5_000 } = {}) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new ProviderRecoveryLedgerError('ledger path is required', 'PROVIDER_RECOVERY_LEDGER_PATH_INVALID');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ProviderRecoveryLedgerError('timeoutMs must be a positive safe integer', 'PROVIDER_RECOVERY_LEDGER_TIMEOUT_INVALID');
    }
    try {
      this.#db = new DatabaseSync(path, { timeout: timeoutMs });
      this.#db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = ${timeoutMs};

        CREATE TABLE IF NOT EXISTS provider_recovery_records (
          request_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          operation TEXT NOT NULL,
          envelope_fingerprint TEXT NOT NULL UNIQUE,
          desired_fingerprint TEXT NOT NULL,
          target_fingerprint TEXT NOT NULL,
          baseline_exists INTEGER NOT NULL CHECK (baseline_exists IN (0, 1)),
          baseline_content_fingerprint TEXT,
          baseline_version TEXT,
          baseline_version_semantics TEXT NOT NULL CHECK (
            baseline_version_semantics IN ('monotonic_revision', 'content_addressed', 'unknown')
          ),
          state TEXT NOT NULL CHECK (state IN ('confirmed_applied', 'confirmed_not_applied', 'still_unknown')),
          reason_code TEXT NOT NULL,
          retry_disposition TEXT NOT NULL,
          observation_exists INTEGER CHECK (observation_exists IS NULL OR observation_exists IN (0, 1)),
          observation_content_fingerprint TEXT,
          observation_version TEXT,
          observation_version_semantics TEXT CHECK (
            observation_version_semantics IS NULL OR
            observation_version_semantics IN ('monotonic_revision', 'content_addressed', 'unknown')
          ),
          provider_request_id TEXT,
          observation_time TEXT,
          recorded_at TEXT NOT NULL,
          record_fingerprint TEXT NOT NULL,
          CHECK (
            (baseline_exists = 0
              AND baseline_content_fingerprint IS NULL
              AND baseline_version IS NULL
              AND baseline_version_semantics = 'unknown')
            OR
            (baseline_exists = 1
              AND baseline_content_fingerprint IS NOT NULL
              AND baseline_version IS NOT NULL)
          ),
          CHECK (
            (observation_exists IS NULL
              AND observation_content_fingerprint IS NULL
              AND observation_version IS NULL
              AND observation_version_semantics IS NULL
              AND provider_request_id IS NULL
              AND observation_time IS NULL)
            OR
            (observation_exists = 0
              AND observation_content_fingerprint IS NULL
              AND observation_version IS NULL
              AND observation_version_semantics = 'unknown'
              AND observation_time IS NOT NULL)
            OR
            (observation_exists = 1
              AND observation_content_fingerprint IS NOT NULL
              AND observation_version IS NOT NULL
              AND observation_version_semantics IS NOT NULL
              AND observation_time IS NOT NULL)
          )
        ) STRICT;
      `);
    } catch (error) {
      try { this.#db?.close(); } catch { /* preserve initialization error */ }
      throw new ProviderRecoveryLedgerError(
        'provider recovery ledger initialization failed',
        'PROVIDER_RECOVERY_LEDGER_INIT_FAILED',
        { cause: error }
      );
    }
  }

  close() {
    this.#db.close();
  }

  record(recovery, { now = new Date() } = {}) {
    const normalized = normalizeRecovery(recovery);
    const recordedAt = dateIso(now, 'PROVIDER_RECOVERY_LEDGER_TIME_INVALID');
    const recordFingerprint = providerRecoveryFingerprint(recovery);
    const targetFingerprint = planFingerprint(normalized.uncertainty.target);
    const observation = normalized.observation;

    return this.#transaction(() => {
      const existing = this.#row(normalized.uncertainty.requestId);
      if (existing) {
        if (existing.recordFingerprint !== recordFingerprint) {
          throw new ProviderRecoveryLedgerError(
            'provider recovery request was reused with different evidence',
            'PROVIDER_RECOVERY_EVIDENCE_CONFLICT'
          );
        }
        return Object.freeze({ ...existing, replayed: true });
      }

      try {
        this.#db.prepare(`
          INSERT INTO provider_recovery_records (
            request_id, idempotency_key, provider, operation,
            envelope_fingerprint, desired_fingerprint, target_fingerprint,
            baseline_exists, baseline_content_fingerprint, baseline_version,
            baseline_version_semantics,
            state, reason_code, retry_disposition,
            observation_exists, observation_content_fingerprint,
            observation_version, observation_version_semantics,
            provider_request_id, observation_time,
            recorded_at, record_fingerprint
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalized.uncertainty.requestId,
          normalized.uncertainty.idempotencyKey,
          normalized.uncertainty.provider,
          normalized.uncertainty.operation,
          normalized.uncertainty.envelopeFingerprint,
          normalized.uncertainty.desiredFingerprint,
          targetFingerprint,
          normalized.uncertainty.baseline.exists ? 1 : 0,
          normalized.uncertainty.baseline.contentFingerprint,
          normalized.uncertainty.baseline.version,
          normalized.uncertainty.baseline.versionSemantics,
          normalized.state,
          normalized.reasonCode,
          normalized.retryDisposition,
          observation === null ? null : observation.exists ? 1 : 0,
          observation?.contentFingerprint ?? null,
          observation?.version ?? null,
          observation?.versionSemantics ?? null,
          observation?.providerRequestId ?? null,
          observation?.observedAt ?? null,
          recordedAt,
          recordFingerprint
        );
      } catch (error) {
        if (String(error?.message ?? '').includes('UNIQUE constraint failed')) {
          throw new ProviderRecoveryLedgerError(
            'provider recovery identity collides with existing evidence',
            'PROVIDER_RECOVERY_IDENTITY_CONFLICT',
            { cause: error }
          );
        }
        throw error;
      }

      return Object.freeze({ ...this.#row(normalized.uncertainty.requestId), replayed: false });
    });
  }

  getByRequestId(requestId) {
    requireString(requestId, 'requestId');
    const row = this.#row(requestId);
    return row ? Object.freeze({ ...row, replayed: false }) : null;
  }

  #row(requestId) {
    return this.#db.prepare(`
      SELECT
        request_id AS requestId,
        idempotency_key AS idempotencyKey,
        provider,
        operation,
        envelope_fingerprint AS envelopeFingerprint,
        desired_fingerprint AS desiredFingerprint,
        target_fingerprint AS targetFingerprint,
        baseline_exists AS baselineExists,
        baseline_content_fingerprint AS baselineContentFingerprint,
        baseline_version AS baselineVersion,
        baseline_version_semantics AS baselineVersionSemantics,
        state,
        reason_code AS reasonCode,
        retry_disposition AS retryDisposition,
        observation_exists AS observationExists,
        observation_content_fingerprint AS observationContentFingerprint,
        observation_version AS observationVersion,
        observation_version_semantics AS observationVersionSemantics,
        provider_request_id AS providerRequestId,
        observation_time AS observationTime,
        recorded_at AS recordedAt,
        record_fingerprint AS recordFingerprint
      FROM provider_recovery_records
      WHERE request_id = ?
    `).get(requestId) ?? null;
  }

  #transaction(operation) {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new ProviderRecoveryLedgerError(
          'provider recovery transaction failed and rollback could not be verified',
          'PROVIDER_RECOVERY_ROLLBACK_FAILED',
          { cause: rollbackError }
        );
      }
      if (error instanceof ProviderRecoveryLedgerError) throw error;
      throw new ProviderRecoveryLedgerError(
        'provider recovery transaction failed',
        'PROVIDER_RECOVERY_TRANSACTION_FAILED',
        { cause: error }
      );
    }
  }
}

export class DurableProviderOutcomeRecoveryCoordinator {
  #coordinator;
  #ledger;
  #clock;

  constructor({ coordinator, ledger, clock = () => new Date() } = {}) {
    if (!coordinator || typeof coordinator.recover !== 'function') {
      throw new ProviderRecoveryLedgerError('recovery coordinator is required', 'PROVIDER_RECOVERY_COORDINATOR_INVALID');
    }
    if (!ledger || typeof ledger.record !== 'function') {
      throw new ProviderRecoveryLedgerError('recovery ledger is required', 'PROVIDER_RECOVERY_LEDGER_INVALID');
    }
    if (typeof clock !== 'function') {
      throw new ProviderRecoveryLedgerError('clock must be a function', 'PROVIDER_RECOVERY_LEDGER_TIME_INVALID');
    }
    this.#coordinator = coordinator;
    this.#ledger = ledger;
    this.#clock = clock;
  }

  async recover({ uncertainty } = {}) {
    const recovery = await this.#coordinator.recover({ uncertainty });
    const receipt = this.#ledger.record(recovery, { now: this.#clock() });
    return Object.freeze({ recovery, receipt });
  }
}

function normalizeRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !STATES.has(value.state)) {
    throw new ProviderRecoveryLedgerError('recovery record is invalid', 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  if (!value.uncertainty || typeof value.uncertainty !== 'object' || Array.isArray(value.uncertainty)) {
    throw new ProviderRecoveryLedgerError('recovery uncertainty is invalid', 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  const uncertainty = value.uncertainty;
  requireString(uncertainty.requestId, 'requestId');
  requireString(uncertainty.idempotencyKey, 'idempotencyKey');
  requireString(uncertainty.provider, 'provider');
  requireString(uncertainty.operation, 'operation');
  requireFingerprint(uncertainty.envelopeFingerprint, 'envelopeFingerprint');
  requireFingerprint(uncertainty.desiredFingerprint, 'desiredFingerprint');
  if (!uncertainty.target || typeof uncertainty.target !== 'object' || Array.isArray(uncertainty.target)) {
    throw new ProviderRecoveryLedgerError('recovery target is invalid', 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  if (!uncertainty.baseline || typeof uncertainty.baseline.exists !== 'boolean') {
    throw new ProviderRecoveryLedgerError('recovery baseline is invalid', 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  requireVersionSemantics(uncertainty.baseline.versionSemantics, 'baseline.versionSemantics');
  if (uncertainty.baseline.exists) {
    requireFingerprint(uncertainty.baseline.contentFingerprint, 'baseline.contentFingerprint');
    requireString(uncertainty.baseline.version, 'baseline.version');
  } else if (uncertainty.baseline.versionSemantics !== 'unknown') {
    throw new ProviderRecoveryLedgerError('missing baseline must use unknown version semantics', 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  requireString(value.reasonCode, 'reasonCode');
  requireString(value.retryDisposition, 'retryDisposition');
  if (value.observation !== null && value.observation !== undefined) {
    if (typeof value.observation !== 'object' || Array.isArray(value.observation) || typeof value.observation.exists !== 'boolean') {
      throw new ProviderRecoveryLedgerError('recovery observation is invalid', 'PROVIDER_RECOVERY_RECORD_INVALID');
    }
    requireVersionSemantics(value.observation.versionSemantics, 'observation.versionSemantics');
    if (value.observation.exists) {
      requireFingerprint(value.observation.contentFingerprint, 'observation.contentFingerprint');
      requireString(value.observation.version, 'observation.version');
    } else if (value.observation.versionSemantics !== 'unknown') {
      throw new ProviderRecoveryLedgerError('missing observation must use unknown version semantics', 'PROVIDER_RECOVERY_RECORD_INVALID');
    }
    dateIso(new Date(value.observation.observedAt), 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  return value;
}

function requireVersionSemantics(value, field) {
  if (!VERSION_SEMANTICS.has(value)) {
    throw new ProviderRecoveryLedgerError(`${field} is invalid`, 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new ProviderRecoveryLedgerError(`${field} must be a non-empty safe string`, 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  return value;
}

function requireFingerprint(value, field) {
  requireString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ProviderRecoveryLedgerError(`${field} must be a sha256 fingerprint`, 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  return value;
}

function dateIso(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ProviderRecoveryLedgerError('recovery timestamp is invalid', code);
  }
  return value.toISOString();
}
