import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FencedSqliteClaimLedger,
  PermitDispatchFenceError
} from '../src/ledger/fenced-sqlite-claim-ledger.mjs';
import {
  createTestTrustStore,
  signTestApproval
} from './helpers/gatekeeper-fixture.mjs';

const START = new Date('2026-08-01T22:00:05.000Z');

function approval() {
  return signTestApproval({
    approvalId: 'approval-time-1',
    jobId: 'job-time-1',
    planFingerprint: 'sha256:plan-time-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-time-1',
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

test('local completion evidence cannot predate the durable transport attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-permit-time-'));
  const ledger = new FencedSqliteClaimLedger(join(dir, 'claims.sqlite'), {
    approvalVerifier: createTestTrustStore()
  });
  try {
    const signed = approval();
    ledger.registerApproval({ approval: signed, now: START });
    const permit = ledger.claimDispatchPermit({ expected: subject(signed), now: START });
    const attempt = ledger.beginDispatchAttempt({
      permit,
      requestId: 'request-time-1',
      envelopeFingerprint: 'sha256:envelope-time-1',
      now: START
    });

    assert.throws(
      () => ledger.completeDispatchAttempt({
        attemptId: attempt.attemptId,
        permit,
        requestId: 'request-time-1',
        envelopeFingerprint: 'sha256:envelope-time-1',
        receiptStatus: 'dispatched',
        receiptFingerprint: 'sha256:receipt-time-1',
        providerReceivedAt: '2035-01-01T00:00:00.000Z',
        now: new Date('2026-08-01T22:00:04.999Z')
      }),
      (error) => error instanceof PermitDispatchFenceError &&
        error.code === 'DISPATCH_ATTEMPT_TIME_INVALID'
    );

    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId).state, 'started');

    const completed = ledger.completeDispatchAttempt({
      attemptId: attempt.attemptId,
      permit,
      requestId: 'request-time-1',
      envelopeFingerprint: 'sha256:envelope-time-1',
      receiptStatus: 'dispatched',
      receiptFingerprint: 'sha256:receipt-time-1',
      providerReceivedAt: '2035-01-01T00:00:00.000Z',
      now: new Date('2026-08-01T22:00:06.000Z')
    });

    assert.equal(completed.state, 'accepted');
    assert.equal(completed.startedAt, START.toISOString());
    assert.equal(completed.completedAt, '2026-08-01T22:00:06.000Z');
    assert.equal(completed.providerReceivedAt, '2035-01-01T00:00:00.000Z');
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('fenced ledger rejects zero timeout before opening SQLite state', () => {
  assert.throws(
    () => new FencedSqliteClaimLedger('unused.sqlite', {
      timeoutMs: 0,
      approvalVerifier: createTestTrustStore()
    }),
    (error) => error instanceof PermitDispatchFenceError &&
      error.code === 'DISPATCH_ATTEMPT_TIMEOUT_INVALID'
  );
});
