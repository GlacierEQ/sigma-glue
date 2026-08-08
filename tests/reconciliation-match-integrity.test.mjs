import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VerifiedExecutionLedger } from '../src/execution/verified-execution-ledger.mjs';
import {
  ExecutionLedgerError,
  SqliteExecutionLedger
} from '../src/ledger/sqlite-execution-ledger.mjs';
import { planFingerprint } from '../src/plan/fingerprint.mjs';

const ENVELOPE = planFingerprint({ envelope: 'match-integrity' });
const PERMIT = planFingerprint({ permit: 'match-integrity' });
const BEFORE = planFingerprint({ state: 'before' });
const AFTER = planFingerprint({ state: 'after' });
const OTHER = planFingerprint({ state: 'other' });

function receipt() {
  return {
    receiptId: 'receipt-match-integrity',
    requestId: 'request-match-integrity',
    envelopeFingerprint: ENVELOPE,
    permitFingerprint: PERMIT,
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-match-integrity',
    resolvedAdapterId: 'commander',
    capability: 'filesystem.move',
    status: 'dispatched',
    receivedAt: '2026-08-08T16:00:01.000Z',
    redactedDiagnostics: []
  };
}

async function withReconcilingLedger(run) {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-reconcile-match-'));
  const ledger = new VerifiedExecutionLedger({
    ledger: new SqliteExecutionLedger(join(dir, 'execution.sqlite'))
  });
  try {
    let operation = ledger.recordDispatched({
      receipt: receipt(),
      now: new Date('2026-08-08T16:00:01.000Z')
    });
    operation = ledger.recordAttempt({
      operationId: operation.operationId,
      attempt: {
        attemptId: 'attempt-match-integrity',
        adapterId: 'commander',
        envelopeFingerprint: ENVELOPE,
        startedAt: '2026-08-08T16:00:02.000Z'
      },
      transitionKey: 'attempt:match-integrity',
      now: new Date('2026-08-08T16:00:02.000Z')
    });
    operation = ledger.recordProviderConfirmation({
      operationId: operation.operationId,
      confirmation: {
        providerRequestId: 'providerref_match-integrity-001',
        confirmationMethod: 'provider-response',
        beforeFingerprint: BEFORE,
        afterFingerprint: AFTER,
        confirmedAt: '2026-08-08T16:00:03.000Z'
      },
      transitionKey: 'confirmation:match-integrity',
      now: new Date('2026-08-08T16:00:03.000Z')
    });
    operation = ledger.startReconciliation({
      operationId: operation.operationId,
      reconciliation: {
        observationMethod: 'provider-read-after-write',
        startedAt: '2026-08-08T16:00:04.000Z'
      },
      transitionKey: 'reconciliation:start:match-integrity',
      now: new Date('2026-08-08T16:00:04.000Z')
    });
    return await run({ ledger, operation });
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('cannot claim reconciliation matched when observed fingerprint differs', async () => {
  await withReconcilingLedger(({ ledger, operation }) => {
    assert.throws(
      () => ledger.completeReconciliation({
        operationId: operation.operationId,
        result: {
          observationMethod: 'provider-read-after-write',
          expectedFingerprint: AFTER,
          observedFingerprint: OTHER,
          matchesExpected: true,
          observedAt: '2026-08-08T16:00:05.000Z'
        },
        transitionKey: 'reconciliation:false-positive',
        now: new Date('2026-08-08T16:00:05.000Z')
      }),
      (error) => error instanceof ExecutionLedgerError &&
        error.code === 'RECONCILIATION_MATCH_CLAIM_MISMATCH'
    );
    assert.equal(ledger.getOperation(operation.operationId).state, 'reconciling');
  });
});

test('cannot claim reconciliation mismatch when fingerprints are equal', async () => {
  await withReconcilingLedger(({ ledger, operation }) => {
    assert.throws(
      () => ledger.completeReconciliation({
        operationId: operation.operationId,
        result: {
          observationMethod: 'provider-read-after-write',
          expectedFingerprint: AFTER,
          observedFingerprint: AFTER,
          matchesExpected: false,
          observedAt: '2026-08-08T16:00:05.000Z'
        },
        transitionKey: 'reconciliation:false-negative',
        now: new Date('2026-08-08T16:00:05.000Z')
      }),
      (error) => error instanceof ExecutionLedgerError &&
        error.code === 'RECONCILIATION_MATCH_CLAIM_MISMATCH'
    );
  });
});
