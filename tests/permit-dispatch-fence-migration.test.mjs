import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SqliteClaimLedger } from '../src/ledger/sqlite-claim-ledger.mjs';
import {
  FencedSqliteClaimLedger,
  PermitDispatchFenceError
} from '../src/ledger/fenced-sqlite-claim-ledger.mjs';
import {
  createTestTrustStore,
  signTestApproval
} from './helpers/gatekeeper-fixture.mjs';

const NOW = new Date('2026-08-01T22:00:00.000Z');

function approval() {
  return signTestApproval({
    approvalId: 'approval-migrate-1',
    jobId: 'job-migrate-1',
    planFingerprint: 'sha256:plan-migrate-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-migrate-1',
    policyVersion: 'policy-v1',
    issuedAt: '2026-08-01T21:55:00.000Z',
    expiresAt: '2026-08-01T22:30:00.000Z',
    status: 'approved'
  });
}

function subject(value) {
  return {
    approvalId: value.approvalId,
    jobId: value.jobId,
    planFingerprint: value.planFingerprint,
    componentRef: value.componentRef,
    method: value.method,
    idempotencyKey: value.idempotencyKey,
    policyVersion: value.policyVersion
  };
}

test('migrates PR10-era attempts conservatively and never replays their permits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-permit-migration-'));
  const dbPath = join(dir, 'claims.sqlite');
  const verifier = createTestTrustStore();
  let fenced;
  try {
    const base = new SqliteClaimLedger(dbPath, { approvalVerifier: verifier });
    const signed = approval();
    base.registerApproval({ approval: signed, now: NOW });
    const permit = base.claimDispatchPermit({ expected: subject(signed), now: NOW });
    base.close();

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE permit_dispatch_attempts (
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
    legacy.prepare(`
      INSERT INTO permit_dispatch_attempts (
        attempt_id, permit_id, idempotency_key, permit_fingerprint,
        state, started_at, accepted_at, receipt_fingerprint
      ) VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?)
    `).run(
      'legacy-attempt-1',
      permit.permitId,
      permit.idempotencyKey,
      permit.permitFingerprint,
      '2026-08-01T22:00:00.000Z',
      '2026-08-01T22:00:01.000Z',
      'sha256:legacy-receipt'
    );
    legacy.close();

    fenced = new FencedSqliteClaimLedger(dbPath, { approvalVerifier: verifier });
    const migrated = fenced.getDispatchAttemptByPermitId(permit.permitId);

    assert.equal(migrated.state, 'legacy_uncertain');
    assert.equal(migrated.requestId, null);
    assert.equal(migrated.envelopeFingerprint, null);
    assert.equal(migrated.startedAt, '2026-08-01T22:00:00.000Z');
    assert.equal(migrated.completedAt, '2026-08-01T22:00:01.000Z');
    assert.equal(migrated.receiptStatus, null);
    assert.equal(migrated.receiptFingerprint, 'sha256:legacy-receipt');
    assert.equal(migrated.providerReceivedAt, null);

    assert.throws(
      () => fenced.beginDispatchAttempt({
        permit,
        requestId: 'request-after-migration',
        envelopeFingerprint: 'sha256:envelope-after-migration',
        now: new Date('2026-08-01T22:00:02.000Z')
      }),
      (error) => error instanceof PermitDispatchFenceError &&
        error.code === 'DISPATCH_PERMIT_ALREADY_ATTEMPTED'
    );
  } finally {
    fenced?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects unknown attempt-table schemas instead of guessing a migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-permit-migration-unknown-'));
  const dbPath = join(dir, 'claims.sqlite');
  const verifier = createTestTrustStore();
  try {
    const base = new SqliteClaimLedger(dbPath, { approvalVerifier: verifier });
    base.close();

    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE permit_dispatch_attempts (attempt_id TEXT PRIMARY KEY, mystery TEXT) STRICT;`);
    db.close();

    assert.throws(
      () => new FencedSqliteClaimLedger(dbPath, { approvalVerifier: verifier }),
      (error) => error instanceof PermitDispatchFenceError &&
        error.code === 'DISPATCH_ATTEMPT_SCHEMA_UNSUPPORTED'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
