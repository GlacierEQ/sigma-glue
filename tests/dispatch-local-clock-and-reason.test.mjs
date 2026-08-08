import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ColossusDispatchAdapter,
  ColossusDispatchError
} from '../src/dispatch/colossus-dispatch-adapter.mjs';
import {
  FencedSqliteClaimLedger,
  PermitDispatchFenceError
} from '../src/ledger/fenced-sqlite-claim-ledger.mjs';
import {
  createTestTrustStore,
  signTestApproval
} from './helpers/gatekeeper-fixture.mjs';

const CLAIM_NOW = new Date('2026-08-01T22:00:00.000Z');
const REGISTRY = Object.freeze({
  'commander@ref-1': Object.freeze({
    adapterId: 'commander',
    methods: Object.freeze({ execute: Object.freeze(['filesystem.move']) })
  })
});

function approval() {
  return signTestApproval({
    approvalId: 'approval-local-clock-1',
    jobId: 'job-local-clock-1',
    planFingerprint: 'sha256:plan-local-clock-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-local-clock-1',
    policyVersion: 'policy-v1',
    issuedAt: '2026-08-01T21:55:00.000Z',
    expiresAt: '2026-08-01T22:30:00.000Z',
    status: 'approved'
  });
}

function subject(value = approval()) {
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

function request() {
  return {
    protocolVersion: 'sigma-federation/v1',
    schemaVersion: 'colossus-dispatch/v1',
    requestId: 'request-local-clock-1',
    traceId: 'trace-local-clock-1',
    jobId: 'job-local-clock-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    capability: 'filesystem.move',
    idempotencyKey: 'idem-local-clock-1',
    planFingerprint: 'sha256:plan-local-clock-1',
    policyVersion: 'policy-v1',
    scopedHandles: [{
      type: 'filesystem-root',
      id: 'root-local-clock-1',
      scope: 'move-within-root',
      expiresAt: '2026-08-01T22:00:30.000Z'
    }],
    payload: { sourceId: 'file-local-clock-1', destinationId: 'folder-local-clock-2' }
  };
}

function receiptFor(envelope, overrides = {}) {
  return {
    receiptId: 'receipt-local-clock-1',
    requestId: envelope.requestId,
    envelopeFingerprint: envelope.envelopeFingerprint,
    permitFingerprint: envelope.authorization.permitFingerprint,
    componentRef: envelope.componentRef,
    method: envelope.method,
    idempotencyKey: envelope.idempotencyKey,
    resolvedAdapterId: envelope.resolvedAdapterId,
    capability: envelope.capability,
    status: 'dispatched',
    receivedAt: '2026-08-01T22:00:11.000Z',
    redactedDiagnostics: [],
    ...overrides
  };
}

async function withPermit(run) {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-dispatch-clock-'));
  const ledger = new FencedSqliteClaimLedger(join(dir, 'claims.sqlite'), {
    approvalVerifier: createTestTrustStore()
  });
  try {
    const signed = approval();
    ledger.registerApproval({ approval: signed, now: CLAIM_NOW });
    const permit = ledger.claimDispatchPermit({ expected: subject(signed), now: CLAIM_NOW });
    return await run({ ledger, permit });
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('caller logical now cannot push durable attempt start ahead of the adapter clock', async () => {
  await withPermit(async ({ ledger, permit }) => {
    const ticks = [
      new Date('2026-08-01T22:00:03.000Z'),
      new Date('2026-08-01T22:00:04.000Z')
    ];
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      clock: () => ticks.shift(),
      transport: {
        supportsAbort: true,
        dispatch: async (envelope) => receiptFor(envelope)
      }
    });

    const receipt = await adapter.dispatch({
      permit,
      request: request(),
      now: new Date('2026-08-01T22:00:10.000Z')
    });
    const attempt = ledger.getDispatchAttemptByPermitId(permit.permitId);

    assert.equal(receipt.status, 'dispatched');
    assert.equal(attempt.state, 'accepted');
    assert.equal(attempt.startedAt, '2026-08-01T22:00:03.000Z');
    assert.equal(attempt.completedAt, '2026-08-01T22:00:04.000Z');
    assert.equal(attempt.providerReceivedAt, '2026-08-01T22:00:11.000Z');
  });
});

test('a dispatched receipt carrying a reason code is invalid and leaves exact uncertainty evidence', async () => {
  await withPermit(async ({ ledger, permit }) => {
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      clock: () => new Date('2026-08-01T22:00:03.000Z'),
      transport: {
        supportsAbort: true,
        dispatch: async (envelope) => receiptFor(envelope, { reasonCode: 'UNEXPECTED_REASON' })
      }
    });

    await assert.rejects(
      adapter.dispatch({ permit, request: request(), now: CLAIM_NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RECEIPT_INVALID'
    );

    const attempt = ledger.getDispatchAttemptByPermitId(permit.permitId);
    assert.equal(attempt.state, 'started');
    assert.equal(attempt.requestId, 'request-local-clock-1');
    assert.match(attempt.envelopeFingerprint, /^sha256:/);
    assert.equal(attempt.receiptStatus, null);
    assert.equal(attempt.reasonCode, null);
  });
});

test('ledger independently rejects a reason code for dispatched completion evidence', async () => {
  await withPermit(async ({ ledger, permit }) => {
    const attempt = ledger.beginDispatchAttempt({
      permit,
      requestId: 'request-local-clock-1',
      envelopeFingerprint: 'sha256:envelope-local-clock-1',
      now: new Date('2026-08-01T22:00:03.000Z')
    });

    assert.throws(
      () => ledger.completeDispatchAttempt({
        attemptId: attempt.attemptId,
        permit,
        requestId: 'request-local-clock-1',
        envelopeFingerprint: 'sha256:envelope-local-clock-1',
        receiptStatus: 'dispatched',
        receiptFingerprint: 'sha256:receipt-local-clock-1',
        providerReceivedAt: '2026-08-01T22:00:11.000Z',
        reasonCode: 'UNEXPECTED_REASON',
        now: new Date('2026-08-01T22:00:04.000Z')
      }),
      (error) => error instanceof PermitDispatchFenceError &&
        error.code === 'DISPATCH_RECEIPT_REASON_INVALID'
    );

    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId).state, 'started');
  });
});
