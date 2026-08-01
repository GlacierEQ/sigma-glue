import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { planFingerprint } from '../src/plan/fingerprint.mjs';
import {
  ExecutionLedgerError,
  SqliteExecutionLedger
} from '../src/ledger/sqlite-execution-ledger.mjs';
import {
  DurableDispatchCoordinator,
  DurableDispatchCoordinatorError
} from '../src/execution/durable-dispatch-coordinator.mjs';

const execFileAsync = promisify(execFile);
const NOW = new Date('2026-08-01T22:00:00.000Z');
const ENVELOPE_FINGERPRINT = planFingerprint({ envelope: 'one' });
const PERMIT_FINGERPRINT = planFingerprint({ permit: 'one' });
const BEFORE_FINGERPRINT = planFingerprint({ provider: 'before' });
const AFTER_FINGERPRINT = planFingerprint({ provider: 'after' });

function receipt(overrides = {}) {
  return Object.freeze({
    receiptId: 'receipt-1',
    requestId: 'request-1',
    envelopeFingerprint: ENVELOPE_FINGERPRINT,
    permitFingerprint: PERMIT_FINGERPRINT,
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-job-1',
    resolvedAdapterId: 'commander',
    capability: 'filesystem.move',
    status: 'dispatched',
    reasonCode: null,
    receivedAt: '2026-08-01T22:00:01.000Z',
    redactedDiagnostics: [],
    ...overrides
  });
}

function attempt(overrides = {}) {
  return {
    attemptId: 'attempt-1',
    adapterId: 'commander',
    envelopeFingerprint: ENVELOPE_FINGERPRINT,
    startedAt: '2026-08-01T22:00:02.000Z',
    ...overrides
  };
}

function confirmation(overrides = {}) {
  return {
    providerRequestId: 'providerref_request-001',
    confirmationMethod: 'provider-response',
    beforeFingerprint: BEFORE_FINGERPRINT,
    afterFingerprint: AFTER_FINGERPRINT,
    confirmedAt: '2026-08-01T22:00:03.000Z',
    ...overrides
  };
}

function reconciliationStart(overrides = {}) {
  return {
    observationMethod: 'provider-read-after-write',
    startedAt: '2026-08-01T22:00:04.000Z',
    ...overrides
  };
}

function reconciliationResult(overrides = {}) {
  return {
    observationMethod: 'provider-read-after-write',
    expectedFingerprint: AFTER_FINGERPRINT,
    observedFingerprint: AFTER_FINGERPRINT,
    matchesExpected: true,
    observedAt: '2026-08-01T22:00:05.000Z',
    ...overrides
  };
}

async function withLedger(run, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-glue-execution-'));
  const dbPath = join(dir, 'execution.sqlite');
  try {
    return await run({
      dbPath,
      open: () => new SqliteExecutionLedger(dbPath, options)
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createDispatched(ledger) {
  return ledger.recordDispatched({ receipt: receipt(), now: NOW });
}

test('persists the complete five-state execution and reconciliation chain', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    let operation = createDispatched(ledger);
    assert.equal(operation.state, 'dispatched');
    assert.equal(operation.stateVersion, 1);

    operation = ledger.recordAttempt({
      operationId: operation.operationId,
      attempt: attempt(),
      transitionKey: 'attempt:1',
      now: new Date('2026-08-01T22:00:02.000Z')
    });
    assert.equal(operation.state, 'attempted');

    operation = ledger.recordProviderConfirmation({
      operationId: operation.operationId,
      confirmation: confirmation(),
      transitionKey: 'confirmation:1',
      now: new Date('2026-08-01T22:00:03.000Z')
    });
    assert.equal(operation.state, 'provider_confirmed');

    operation = ledger.startReconciliation({
      operationId: operation.operationId,
      reconciliation: reconciliationStart(),
      transitionKey: 'reconciliation:start:1',
      now: new Date('2026-08-01T22:00:04.000Z')
    });
    assert.equal(operation.state, 'reconciling');

    operation = ledger.completeReconciliation({
      operationId: operation.operationId,
      result: reconciliationResult(),
      transitionKey: 'reconciliation:complete:1',
      now: new Date('2026-08-01T22:00:05.000Z')
    });
    assert.equal(operation.state, 'reconciled');
    assert.equal(operation.stateVersion, 5);

    assert.deepEqual(
      ledger.getEvents(operation.operationId).map((event) => event.toState),
      ['dispatched', 'attempted', 'provider_confirmed', 'reconciling', 'reconciled']
    );
    assert.deepEqual(ledger.verifyEventChain(operation.operationId), {
      valid: true,
      operationId: operation.operationId,
      eventCount: 5,
      lastEventFingerprint: operation.lastEventFingerprint
    });
    ledger.close();
  });
});

test('reconciliation mismatch ends in recovery_required, not reconciled', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    let operation = createDispatched(ledger);
    operation = ledger.recordAttempt({ operationId: operation.operationId, attempt: attempt(), transitionKey: 'a', now: NOW });
    operation = ledger.recordProviderConfirmation({ operationId: operation.operationId, confirmation: confirmation(), transitionKey: 'c', now: NOW });
    operation = ledger.startReconciliation({ operationId: operation.operationId, reconciliation: reconciliationStart(), transitionKey: 'r1', now: NOW });
    operation = ledger.completeReconciliation({
      operationId: operation.operationId,
      result: reconciliationResult({
        observedFingerprint: planFingerprint({ provider: 'unexpected' }),
        matchesExpected: false
      }),
      transitionKey: 'r2',
      now: NOW
    });
    assert.equal(operation.state, 'recovery_required');
    assert.equal(ledger.getEvents(operation.operationId).at(-1).eventType, 'reconciliation.mismatch');
    ledger.close();
  });
});

test('illegal ordering fails closed', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    const operation = createDispatched(ledger);
    assert.throws(
      () => ledger.recordProviderConfirmation({
        operationId: operation.operationId,
        confirmation: confirmation(),
        transitionKey: 'confirmation-too-early',
        now: NOW
      }),
      (error) => error instanceof ExecutionLedgerError && error.code === 'EXECUTION_STATE_TRANSITION_INVALID'
    );
    assert.equal(ledger.getOperation(operation.operationId).state, 'dispatched');
    ledger.close();
  });
});

test('identical transition replay returns the same durable state', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    const dispatched = createDispatched(ledger);
    const first = ledger.recordAttempt({
      operationId: dispatched.operationId,
      attempt: attempt(),
      transitionKey: 'attempt:replay',
      now: NOW
    });
    const replay = ledger.recordAttempt({
      operationId: dispatched.operationId,
      attempt: attempt(),
      transitionKey: 'attempt:replay',
      now: new Date(NOW.getTime() + 1_000)
    });
    assert.equal(first.stateVersion, 2);
    assert.equal(replay.stateVersion, 2);
    assert.equal(replay.replayed, true);
    assert.equal(ledger.getEvents(dispatched.operationId).length, 2);
    ledger.close();
  });
});

test('transition-key reuse with changed evidence is rejected', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    const dispatched = createDispatched(ledger);
    ledger.recordAttempt({ operationId: dispatched.operationId, attempt: attempt(), transitionKey: 'attempt:same', now: NOW });
    assert.throws(
      () => ledger.recordAttempt({
        operationId: dispatched.operationId,
        attempt: attempt({ attemptId: 'attempt-changed' }),
        transitionKey: 'attempt:same',
        now: NOW
      }),
      (error) => error instanceof ExecutionLedgerError && error.code === 'EXECUTION_TRANSITION_KEY_REUSE_MISMATCH'
    );
    ledger.close();
  });
});

test('execution state and hash chain survive close and reopen', async () => {
  await withLedger(({ open }) => {
    const first = open();
    const dispatched = createDispatched(first);
    const attempted = first.recordAttempt({
      operationId: dispatched.operationId,
      attempt: attempt(),
      transitionKey: 'attempt:persist',
      now: NOW
    });
    first.close();

    const reopened = open();
    assert.equal(reopened.getOperation(attempted.operationId).state, 'attempted');
    assert.equal(reopened.verifyEventChain(attempted.operationId).eventCount, 2);
    reopened.close();
  });
});

test('concurrent duplicate attempts converge on one transition', async () => {
  await withLedger(async ({ dbPath, open }) => {
    const ledger = open();
    const dispatched = createDispatched(ledger);
    ledger.close();

    const worker = join(import.meta.dirname, 'helpers', 'execution-worker.mjs');
    const inputs = Array.from({ length: 8 }, () => execFileAsync(
      process.execPath,
      [worker, dbPath, dispatched.operationId, 'attempt:concurrent', ENVELOPE_FINGERPRINT, NOW.toISOString()],
      { env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    ));
    const results = await Promise.all(inputs);
    const operations = results.map(({ stdout }) => JSON.parse(stdout.trim()).operation);

    assert.equal(new Set(operations.map((operation) => operation.stateVersion)).size, 1);
    assert.equal(operations[0].state, 'attempted');
    assert.equal(operations.filter((operation) => operation.replayed === false).length, 1);
    assert.equal(operations.filter((operation) => operation.replayed === true).length, 7);

    const check = open();
    assert.equal(check.getEvents(dispatched.operationId).length, 2);
    check.close();
  });
});

test('dispatch identity reuse with changed receipt fails closed', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    createDispatched(ledger);
    assert.throws(
      () => ledger.recordDispatched({
        receipt: receipt({ permitFingerprint: planFingerprint({ permit: 'changed' }) }),
        transitionKey: 'dispatch:changed',
        now: NOW
      }),
      (error) => error instanceof ExecutionLedgerError && error.code === 'EXECUTION_DISPATCH_IDENTITY_CONFLICT'
    );
    ledger.close();
  });
});

test('provider request identifiers must remain opaque references', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    let operation = createDispatched(ledger);
    operation = ledger.recordAttempt({ operationId: operation.operationId, attempt: attempt(), transitionKey: 'attempt', now: NOW });
    assert.throws(
      () => ledger.recordProviderConfirmation({
        operationId: operation.operationId,
        confirmation: confirmation({ providerRequestId: 'https://provider.test/raw?id=secret' }),
        transitionKey: 'confirmation',
        now: NOW
      }),
      (error) => error instanceof ExecutionLedgerError && error.code === 'PROVIDER_REFERENCE_INVALID'
    );
    ledger.close();
  });
});

test('durable coordinator persists a validated dispatched receipt', async () => {
  await withLedger(async ({ open }) => {
    const ledger = open();
    const coordinator = new DurableDispatchCoordinator({
      dispatchAdapter: { dispatch: async () => receipt() },
      executionLedger: ledger
    });
    const result = await coordinator.dispatchAndRecord({ permit: {}, request: {}, now: NOW });
    assert.equal(result.operation.state, 'dispatched');
    assert.equal(ledger.getOperationByRequestId('request-1').operationId, result.operation.operationId);
    ledger.close();
  });
});

test('coordinator distinguishes non-acceptance and post-acceptance persistence failure', async () => {
  const rejected = new DurableDispatchCoordinator({
    dispatchAdapter: { dispatch: async () => receipt({ status: 'blocked' }) },
    executionLedger: { recordDispatched: () => assert.fail('must not persist blocked receipt') }
  });
  await assert.rejects(
    rejected.dispatchAndRecord({ permit: {}, request: {}, now: NOW }),
    (error) => error instanceof DurableDispatchCoordinatorError && error.code === 'DISPATCH_NOT_ACCEPTED'
  );

  const failedPersistence = new DurableDispatchCoordinator({
    dispatchAdapter: { dispatch: async () => receipt() },
    executionLedger: {
      recordDispatched: () => { throw new ExecutionLedgerError('disk unavailable', 'EXECUTION_LEDGER_WRITE_LOCK_UNAVAILABLE'); }
    }
  });
  await assert.rejects(
    failedPersistence.dispatchAndRecord({ permit: {}, request: {}, now: NOW }),
    (error) => error instanceof DurableDispatchCoordinatorError &&
      error.code === 'DISPATCH_RECEIPT_PERSISTENCE_FAILED' &&
      /^sha256:[0-9a-f]{64}$/.test(error.receiptFingerprint) &&
      !error.message.includes('disk unavailable')
  );
});
