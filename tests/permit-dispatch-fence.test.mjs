import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ColossusDispatchAdapter,
  ColossusDispatchError
} from '../src/dispatch/colossus-dispatch-adapter.mjs';
import { FencedSqliteClaimLedger } from '../src/ledger/fenced-sqlite-claim-ledger.mjs';
import {
  createTestTrustStore,
  signTestApproval
} from './helpers/gatekeeper-fixture.mjs';

const NOW = new Date('2026-08-01T22:00:00.000Z');
const REGISTRY = Object.freeze({
  'commander@ref-1': Object.freeze({
    adapterId: 'commander',
    methods: Object.freeze({ execute: Object.freeze(['filesystem.move']) })
  })
});

function signedApproval() {
  return signTestApproval({
    approvalId: 'approval-fence-1',
    jobId: 'job-fence-1',
    planFingerprint: 'sha256:plan-fence-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-fence-1',
    policyVersion: 'policy-v1',
    issuedAt: '2026-08-01T21:55:00.000Z',
    expiresAt: '2026-08-01T22:30:00.000Z',
    status: 'approved'
  });
}

function executionSubject(approval = signedApproval()) {
  return {
    approvalId: approval.approvalId,
    jobId: approval.jobId,
    planFingerprint: approval.planFingerprint,
    componentRef: approval.componentRef,
    method: approval.method,
    idempotencyKey: approval.idempotencyKey,
    policyVersion: approval.policyVersion
  };
}

function dispatchRequest(overrides = {}) {
  return {
    protocolVersion: 'sigma-federation/v1',
    schemaVersion: 'colossus-dispatch/v1',
    requestId: 'request-fence-1',
    traceId: 'trace-fence-1',
    jobId: 'job-fence-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    capability: 'filesystem.move',
    idempotencyKey: 'idem-fence-1',
    planFingerprint: 'sha256:plan-fence-1',
    policyVersion: 'policy-v1',
    scopedHandles: [{
      type: 'filesystem-root',
      id: 'root-fence-1',
      scope: 'move-within-root',
      expiresAt: '2026-08-01T22:00:30.000Z'
    }],
    payload: { sourceId: 'file-fence-1', destinationId: 'folder-fence-2' },
    ...overrides
  };
}

function receiptFor(envelope) {
  return {
    receiptId: 'receipt-fence-1',
    requestId: envelope.requestId,
    envelopeFingerprint: envelope.envelopeFingerprint,
    permitFingerprint: envelope.authorization.permitFingerprint,
    componentRef: envelope.componentRef,
    method: envelope.method,
    idempotencyKey: envelope.idempotencyKey,
    resolvedAdapterId: envelope.resolvedAdapterId,
    capability: envelope.capability,
    status: 'dispatched',
    receivedAt: '2026-08-01T22:00:01.000Z',
    redactedDiagnostics: []
  };
}

async function withSharedLedger(run) {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-permit-fence-'));
  const dbPath = join(dir, 'claims.sqlite');
  const options = { approvalVerifier: createTestTrustStore() };
  const first = new FencedSqliteClaimLedger(dbPath, options);
  let second;
  try {
    const approval = signedApproval();
    first.registerApproval({ approval, now: NOW });
    const permit = first.claimDispatchPermit({ expected: executionSubject(approval), now: NOW });
    second = new FencedSqliteClaimLedger(dbPath, options);
    return await run({ first, second, permit });
  } finally {
    second?.close();
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function adapter(permitStore, transport, timeoutMs = 10_000) {
  return new ColossusDispatchAdapter({
    registry: REGISTRY,
    permitStore,
    transport,
    timeoutMs
  });
}

test('sequential replay of one persisted permit never re-enters transport', async () => {
  await withSharedLedger(async ({ first, permit }) => {
    let calls = 0;
    const colossus = adapter(first, {
      supportsAbort: true,
      dispatch: async (envelope) => {
        calls += 1;
        return receiptFor(envelope);
      }
    });

    await colossus.dispatch({ permit, request: dispatchRequest(), now: NOW });
    await assert.rejects(
      colossus.dispatch({ permit, request: dispatchRequest(), now: NOW }),
      (error) => error instanceof ColossusDispatchError &&
        error.code === 'DISPATCH_PERMIT_ALREADY_ATTEMPTED'
    );

    assert.equal(calls, 1);
    assert.equal(first.getDispatchAttemptByPermitId(permit.permitId).state, 'accepted');
  });
});

test('concurrent adapters on independent ledger connections cross transport once', async () => {
  await withSharedLedger(async ({ first, second, permit }) => {
    let calls = 0;
    let releaseFirst;
    let enteredFirst;
    const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
    const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });

    const transport = {
      supportsAbort: true,
      dispatch: async (envelope) => {
        calls += 1;
        if (calls === 1) {
          enteredFirst();
          await firstRelease;
        }
        return receiptFor(envelope);
      }
    };
    const a = adapter(first, transport);
    const b = adapter(second, transport);

    const firstDispatch = a.dispatch({ permit, request: dispatchRequest(), now: NOW });
    await firstEntered;
    await assert.rejects(
      b.dispatch({ permit, request: dispatchRequest(), now: NOW }),
      (error) => error instanceof ColossusDispatchError &&
        error.code === 'DISPATCH_PERMIT_ALREADY_ATTEMPTED'
    );
    releaseFirst();
    await firstDispatch;

    assert.equal(calls, 1);
    assert.equal(second.getDispatchAttemptByPermitId(permit.permitId).state, 'accepted');
  });
});

test('timeout leaves a started attempt and blocks automatic replay', async () => {
  await withSharedLedger(async ({ first, second, permit }) => {
    let calls = 0;
    const transport = {
      supportsAbort: true,
      dispatch: async (_envelope, { signal }) => {
        calls += 1;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        });
        return null;
      }
    };
    const firstAdapter = adapter(first, transport, 20);
    const retryAdapter = adapter(second, transport, 20);

    await assert.rejects(
      firstAdapter.dispatch({ permit, request: dispatchRequest(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_TIMEOUT'
    );
    assert.equal(first.getDispatchAttemptByPermitId(permit.permitId).state, 'started');

    await assert.rejects(
      retryAdapter.dispatch({ permit, request: dispatchRequest(), now: NOW }),
      (error) => error instanceof ColossusDispatchError &&
        error.code === 'DISPATCH_PERMIT_ALREADY_ATTEMPTED'
    );
    assert.equal(calls, 1);
  });
});

test('pre-transport validation failure does not consume the permit attempt', async () => {
  await withSharedLedger(async ({ first, permit }) => {
    let calls = 0;
    const colossus = adapter(first, {
      supportsAbort: true,
      dispatch: async (envelope) => {
        calls += 1;
        return receiptFor(envelope);
      }
    });

    await assert.rejects(
      colossus.dispatch({
        permit,
        request: dispatchRequest({ capability: 'filesystem.delete' }),
        now: NOW
      }),
      (error) => error instanceof ColossusDispatchError && error.code === 'CAPABILITY_SCOPE_MISMATCH'
    );
    assert.equal(first.getDispatchAttemptByPermitId(permit.permitId), null);

    await colossus.dispatch({ permit, request: dispatchRequest(), now: NOW });
    assert.equal(calls, 1);
    assert.equal(first.getDispatchAttemptByPermitId(permit.permitId).state, 'accepted');
  });
});
