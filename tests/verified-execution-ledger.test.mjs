import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFingerprint } from '../src/plan/fingerprint.mjs';
import {
  ExecutionLedgerError,
  SqliteExecutionLedger
} from '../src/ledger/sqlite-execution-ledger.mjs';
import { VerifiedExecutionLedger } from '../src/execution/verified-execution-ledger.mjs';

const ENVELOPE_FINGERPRINT = planFingerprint({ envelope: 'verified' });
const PERMIT_FINGERPRINT = planFingerprint({ permit: 'verified' });
const BEFORE_FINGERPRINT = planFingerprint({ state: 'before' });
const AFTER_FINGERPRINT = planFingerprint({ state: 'after' });

function receipt() {
  return {
    receiptId: 'receipt-verified',
    requestId: 'request-verified',
    envelopeFingerprint: ENVELOPE_FINGERPRINT,
    permitFingerprint: PERMIT_FINGERPRINT,
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-verified',
    resolvedAdapterId: 'commander',
    capability: 'filesystem.move',
    status: 'dispatched',
    receivedAt: '2026-08-01T22:00:01.000Z',
    redactedDiagnostics: []
  };
}

async function withLedger(run) {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-glue-verified-execution-'));
  const raw = new SqliteExecutionLedger(join(dir, 'execution.sqlite'));
  const ledger = new VerifiedExecutionLedger({ ledger: raw });
  try {
    return await run(ledger);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function createDispatched(ledger) {
  return ledger.recordDispatched({
    receipt: receipt(),
    now: new Date('2026-08-01T22:00:01.000Z')
  });
}

function advanceToReconciling(ledger) {
  let operation = createDispatched(ledger);
  operation = ledger.recordAttempt({
    operationId: operation.operationId,
    attempt: {
      attemptId: 'attempt-verified',
      adapterId: 'commander',
      envelopeFingerprint: ENVELOPE_FINGERPRINT,
      startedAt: '2026-08-01T22:00:02.000Z'
    },
    transitionKey: 'attempt:verified',
    now: new Date('2026-08-01T22:00:02.000Z')
  });
  operation = ledger.recordProviderConfirmation({
    operationId: operation.operationId,
    confirmation: {
      providerRequestId: 'providerref_verified-001',
      confirmationMethod: 'provider-response',
      beforeFingerprint: BEFORE_FINGERPRINT,
      afterFingerprint: AFTER_FINGERPRINT,
      confirmedAt: '2026-08-01T22:00:03.000Z'
    },
    transitionKey: 'confirmation:verified',
    now: new Date('2026-08-01T22:00:03.000Z')
  });
  return ledger.startReconciliation({
    operationId: operation.operationId,
    reconciliation: {
      observationMethod: 'provider-read-after-write',
      startedAt: '2026-08-01T22:00:04.000Z'
    },
    transitionKey: 'reconciliation:start:verified',
    now: new Date('2026-08-01T22:00:04.000Z')
  });
}

test('accepts evidence bound to the dispatched adapter and envelope', async () => {
  await withLedger((ledger) => {
    const operation = createDispatched(ledger);
    const attempted = ledger.recordAttempt({
      operationId: operation.operationId,
      attempt: {
        attemptId: 'attempt-verified',
        adapterId: 'commander',
        envelopeFingerprint: ENVELOPE_FINGERPRINT,
        startedAt: '2026-08-01T22:00:02.000Z'
      },
      transitionKey: 'attempt:verified',
      now: new Date('2026-08-01T22:00:02.000Z')
    });
    assert.equal(attempted.state, 'attempted');
  });
});

test('rejects substituted adapter or envelope attempt evidence', async () => {
  await withLedger((ledger) => {
    const operation = createDispatched(ledger);
    for (const attempt of [
      {
        attemptId: 'attempt-wrong-adapter',
        adapterId: 'other-adapter',
        envelopeFingerprint: ENVELOPE_FINGERPRINT,
        startedAt: '2026-08-01T22:00:02.000Z'
      },
      {
        attemptId: 'attempt-wrong-envelope',
        adapterId: 'commander',
        envelopeFingerprint: planFingerprint({ envelope: 'substituted' }),
        startedAt: '2026-08-01T22:00:02.000Z'
      }
    ]) {
      assert.throws(
        () => ledger.recordAttempt({
          operationId: operation.operationId,
          attempt,
          transitionKey: attempt.attemptId,
          now: new Date('2026-08-01T22:00:02.000Z')
        }),
        (error) => error instanceof ExecutionLedgerError && error.code === 'EXECUTION_ATTEMPT_SUBJECT_MISMATCH'
      );
    }
    assert.equal(ledger.getOperation(operation.operationId).state, 'dispatched');
  });
});

test('rejects evidence timestamps before prior durable state or after observation', async () => {
  await withLedger((ledger) => {
    const operation = createDispatched(ledger);
    assert.throws(
      () => ledger.recordAttempt({
        operationId: operation.operationId,
        attempt: {
          attemptId: 'attempt-stale',
          adapterId: 'commander',
          envelopeFingerprint: ENVELOPE_FINGERPRINT,
          startedAt: '2026-08-01T21:59:59.000Z'
        },
        transitionKey: 'attempt:stale',
        now: new Date('2026-08-01T22:00:02.000Z')
      }),
      (error) => error instanceof ExecutionLedgerError && error.code === 'EXECUTION_ATTEMPT_TIME_INVALID'
    );
    assert.throws(
      () => ledger.recordAttempt({
        operationId: operation.operationId,
        attempt: {
          attemptId: 'attempt-future',
          adapterId: 'commander',
          envelopeFingerprint: ENVELOPE_FINGERPRINT,
          startedAt: '2026-08-01T22:00:03.000Z'
        },
        transitionKey: 'attempt:future',
        now: new Date('2026-08-01T22:00:02.000Z')
      }),
      (error) => error instanceof ExecutionLedgerError && error.code === 'EXECUTION_ATTEMPT_TIME_INVALID'
    );
  });
});

test('binds reconciliation expectation to the provider-confirmed after-state', async () => {
  await withLedger((ledger) => {
    const operation = advanceToReconciling(ledger);
    assert.throws(
      () => ledger.completeReconciliation({
        operationId: operation.operationId,
        result: {
          observationMethod: 'provider-read-after-write',
          expectedFingerprint: planFingerprint({ state: 'substituted' }),
          observedFingerprint: AFTER_FINGERPRINT,
          matchesExpected: true,
          observedAt: '2026-08-01T22:00:05.000Z'
        },
        transitionKey: 'reconciliation:wrong-expectation',
        now: new Date('2026-08-01T22:00:05.000Z')
      }),
      (error) => error instanceof ExecutionLedgerError && error.code === 'RECONCILIATION_EXPECTATION_MISMATCH'
    );
    assert.equal(ledger.getOperation(operation.operationId).state, 'reconciling');
  });
});

test('binds reconciliation completion to the observation method selected at start', async () => {
  await withLedger((ledger) => {
    const operation = advanceToReconciling(ledger);
    assert.throws(
      () => ledger.completeReconciliation({
        operationId: operation.operationId,
        result: {
          observationMethod: 'different-observation-method',
          expectedFingerprint: AFTER_FINGERPRINT,
          observedFingerprint: AFTER_FINGERPRINT,
          matchesExpected: true,
          observedAt: '2026-08-01T22:00:05.000Z'
        },
        transitionKey: 'reconciliation:wrong-method',
        now: new Date('2026-08-01T22:00:05.000Z')
      }),
      (error) => error instanceof ExecutionLedgerError && error.code === 'RECONCILIATION_METHOD_MISMATCH'
    );
    assert.equal(ledger.getOperation(operation.operationId).state, 'reconciling');
  });
});
