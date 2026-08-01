import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteClaimLedger } from '../src/ledger/sqlite-claim-ledger.mjs';
import { planFingerprint } from '../src/plan/fingerprint.mjs';
import {
  ColossusDispatchAdapter,
  ColossusDispatchError
} from '../src/dispatch/colossus-dispatch-adapter.mjs';
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

function approval() {
  return signTestApproval({
    approvalId: 'approval-1',
    jobId: 'job-1',
    planFingerprint: 'sha256:plan-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-job-1',
    policyVersion: 'policy-v1',
    issuedAt: '2026-08-01T21:55:00.000Z',
    expiresAt: '2026-08-01T22:30:00.000Z',
    status: 'approved'
  });
}

function subject() {
  const value = approval();
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

function request(overrides = {}) {
  return {
    protocolVersion: 'sigma-federation/v1',
    schemaVersion: 'colossus-dispatch/v1',
    requestId: 'request-1',
    traceId: 'trace-1',
    jobId: 'job-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    capability: 'filesystem.move',
    idempotencyKey: 'idem-job-1',
    planFingerprint: 'sha256:plan-1',
    policyVersion: 'policy-v1',
    scopedHandles: [{
      type: 'filesystem-root',
      id: 'root-1',
      scope: 'move-within-root',
      expiresAt: '2026-08-01T22:00:30.000Z'
    }],
    payload: { sourceId: 'file-1', destinationId: 'folder-2' },
    ...overrides
  };
}

async function withPermit(run) {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-glue-colossus-'));
  const ledger = new SqliteClaimLedger(join(dir, 'claims.sqlite'), {
    approvalVerifier: createTestTrustStore()
  });
  try {
    ledger.registerApproval({ approval: approval(), now: NOW });
    const permit = ledger.claimDispatchPermit({ expected: subject(), now: NOW });
    return await run({ permit, ledger });
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function receiptFor(envelope, overrides = {}) {
  return {
    receiptId: 'receipt-1',
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
    redactedDiagnostics: [],
    ...overrides
  };
}

test('dispatches only a ledger-issued permit through the registered Colossus route', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let captured;
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: {
        supportsAbort: true,
        dispatch: async (envelope) => {
          captured = envelope;
          return receiptFor(envelope);
        }
      }
    });

    const receipt = await adapter.dispatch({ permit, request: request(), now: NOW });

    assert.equal(receipt.status, 'dispatched');
    assert.equal(captured.resolvedAdapterId, 'commander');
    assert.deepEqual(Object.keys(captured.authorization).sort(), ['expiresAt', 'permitFingerprint', 'permitId']);
    assert.ok(Object.isFrozen(captured));
    assert.ok(Object.isFrozen(captured.payload));
    assert.ok(Object.isFrozen(receipt));
  });
});

test('rejects permit or request substitution before transport', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => { calls += 1; } }
    });

    await assert.rejects(
      adapter.dispatch({ permit, request: request({ planFingerprint: 'sha256:changed' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_SUBJECT_MISMATCH'
    );
    await assert.rejects(
      adapter.dispatch({ permit: { ...permit, permitFingerprint: 'sha256:tampered' }, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_TAMPERED'
    );
    assert.equal(calls, 0);
  });
});

test('rejects expired permits before transport', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });
    await assert.rejects(
      adapter.dispatch({ permit, request: request(), now: new Date('2026-08-01T22:02:00.000Z') }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_EXPIRED'
    );
  });
});

test('resolves adapter and capability only from the registry', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });

    await assert.rejects(
      adapter.dispatch({ permit, request: request({ capability: 'filesystem.delete' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'CAPABILITY_SCOPE_MISMATCH'
    );
    await assert.rejects(
      adapter.dispatch({ permit, request: request({ adapterId: 'other' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_REQUEST_FIELD_FORBIDDEN'
    );
  });
});

test('rejects raw credential-shaped data', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });

    await assert.rejects(
      adapter.dispatch({ permit, request: request({ payload: { accessToken: 'secret-value' } }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'RAW_CREDENTIAL_FORBIDDEN'
    );
  });
});

test('rejects substituted or overclaimed Colossus receipts', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const substituted = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: {
        supportsAbort: true,
        dispatch: async (envelope) => receiptFor(envelope, { requestId: 'other-request' })
      }
    });
    await assert.rejects(
      substituted.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RECEIPT_SUBJECT_MISMATCH'
    );

    const overclaimed = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: {
        supportsAbort: true,
        dispatch: async (envelope) => receiptFor(envelope, { providerConfirmation: 'confirmed' })
      }
    });
    await assert.rejects(
      overclaimed.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RECEIPT_OVERCLAIMED'
    );
  });
});

test('rejects a self-consistent but unpersisted forged permit', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const forgedSubject = {
      approvalId: permit.approvalId,
      jobId: permit.jobId,
      planFingerprint: permit.planFingerprint,
      componentRef: permit.componentRef,
      method: permit.method,
      idempotencyKey: 'idem-forged',
      policyVersion: permit.policyVersion
    };
    const forgedCore = {
      permitId: 'permit-forged',
      claimId: 'claim-forged',
      ...forgedSubject,
      subjectFingerprint: planFingerprint(forgedSubject),
      issuedAt: permit.issuedAt,
      expiresAt: permit.expiresAt,
      status: 'issued'
    };
    const forged = { ...forgedCore, permitFingerprint: planFingerprint(forgedCore) };
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });

    await assert.rejects(
      adapter.dispatch({ permit: forged, request: request({ idempotencyKey: 'idem-forged' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_NOT_PERSISTED'
    );
  });
});

test('rejects incompatible versions and overlong handle authority', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });

    await assert.rejects(
      adapter.dispatch({ permit, request: request({ protocolVersion: 'sigma-federation/v2' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'PROTOCOL_VERSION_INCOMPATIBLE'
    );
    await assert.rejects(
      adapter.dispatch({
        permit,
        request: request({
          scopedHandles: [{
            type: 'filesystem-root',
            id: 'root-1',
            scope: 'move-within-root',
            expiresAt: '2026-08-01T23:00:00.000Z'
          }]
        }),
        now: NOW
      }),
      (error) => error instanceof ColossusDispatchError && error.code === 'SCOPED_HANDLE_EXPIRED'
    );
  });
});

test('times out once without a silent retry', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const adapter = new ColossusDispatchAdapter({
      registry: REGISTRY,
      permitStore: ledger,
      timeoutMs: 20,
      transport: {
        supportsAbort: true,
        dispatch: async (_envelope, { signal }) => {
          calls += 1;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 100);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            }, { once: true });
          });
          return null;
        }
      }
    });

    await assert.rejects(
      adapter.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_TIMEOUT'
    );
    assert.equal(calls, 1);
  });
});
