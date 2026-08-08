import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FencedSqliteClaimLedger } from '../src/ledger/fenced-sqlite-claim-ledger.mjs';
import { planFingerprint } from '../src/plan/fingerprint.mjs';
import { authorityBindingFingerprint } from '../src/dispatch/request.mjs';
import {
  ColossusDispatchAdapter,
  ColossusDispatchError
} from '../src/dispatch/colossus-dispatch-adapter.mjs';
import {
  createTestTrustStore,
  signTestApproval
} from './helpers/gatekeeper-fixture.mjs';
import {
  createScopedHandleTrustStore,
  signTestScopedHandle,
  TEST_SCOPED_HANDLE_AUTHORITY
} from './helpers/scoped-handle-fixture.mjs';

const NOW = new Date('2026-08-01T22:00:00.000Z');
const REGISTRY = Object.freeze({
  'commander@ref-1': Object.freeze({
    adapterId: 'commander',
    methods: Object.freeze({ execute: Object.freeze(['filesystem.move']) }),
    authority: Object.freeze({
      'filesystem.move': Object.freeze({
        minHandles: 1,
        maxHandles: 1,
        handles: Object.freeze([
          Object.freeze({ type: 'filesystem-root', scope: 'move-within-root' })
        ]),
        issuers: Object.freeze([Object.freeze({
          issuer: TEST_SCOPED_HANDLE_AUTHORITY.issuer,
          keyId: TEST_SCOPED_HANDLE_AUTHORITY.keyId
        })])
      })
    })
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
  const requestedHandles = overrides.scopedHandles ?? [{
    type: 'filesystem-root',
    id: 'root-1',
    scope: 'move-within-root',
    issuedAt: '2026-08-01T21:59:00.000Z',
    expiresAt: '2026-08-01T22:00:30.000Z'
  }];
  const base = {
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
    payload: { sourceId: 'file-1', destinationId: 'folder-2' },
    ...overrides
  };
  delete base.scopedHandles;
  const bindingFingerprint = authorityBindingFingerprint(base);
  return {
    ...base,
    scopedHandles: requestedHandles.map((handle) => handle.signature
      ? handle
      : signTestScopedHandle({
        issuedAt: '2026-08-01T21:59:00.000Z',
        ...handle,
        bindingFingerprint: handle.bindingFingerprint ?? bindingFingerprint
      }))
  };
}

async function withPermit(run) {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-glue-colossus-'));
  const ledger = new FencedSqliteClaimLedger(join(dir, 'claims.sqlite'), {
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

function adapter(ledger, transport, options = {}) {
  return new ColossusDispatchAdapter({
    registry: REGISTRY,
    permitStore: ledger,
    scopedHandleTrustStore: createScopedHandleTrustStore(),
    transport,
    ...options
  });
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

test('dispatches only a signed scoped handle and ledger-issued permit', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let captured;
    const colossus = adapter(ledger, {
      supportsAbort: true,
      dispatch: async (envelope) => {
        captured = envelope;
        return receiptFor(envelope);
      }
    });
    const receipt = await colossus.dispatch({ permit, request: request(), now: NOW });
    assert.equal(receipt.status, 'dispatched');
    assert.equal(captured.resolvedAdapterId, 'commander');
    assert.equal(captured.scopedHandles[0].bindingFingerprint, authorityBindingFingerprint(captured));
    assert.equal(captured.scopedHandles[0].issuer, TEST_SCOPED_HANDLE_AUTHORITY.issuer);
    assert.deepEqual(Object.keys(captured.authorization).sort(), ['expiresAt', 'permitFingerprint', 'permitId']);
    assert.ok(Object.isFrozen(captured));
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId).state, 'accepted');
  });
});

test('rejects permit or request substitution before transport', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => { calls += 1; } });
    await assert.rejects(
      colossus.dispatch({ permit, request: request({ planFingerprint: 'sha256:changed' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_SUBJECT_MISMATCH'
    );
    await assert.rejects(
      colossus.dispatch({ permit: { ...permit, permitFingerprint: 'sha256:tampered' }, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_TAMPERED'
    );
    assert.equal(calls, 0);
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId), null);
  });
});

test('rejects a signed handle reused across dispatch subjects', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const original = request();
    const reusedHandle = original.scopedHandles[0];
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => { calls += 1; } });
    const changedPayload = request({
      payload: { sourceId: 'file-1', destinationId: 'folder-other' },
      scopedHandles: [reusedHandle]
    });
    await assert.rejects(
      colossus.dispatch({ permit, request: changedPayload, now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'SCOPED_HANDLE_BINDING_MISMATCH'
    );
    assert.equal(calls, 0);
  });
});

test('cannot forge a new binding around a signed reused handle', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const original = request();
    const changed = request({ payload: { sourceId: 'file-1', destinationId: 'folder-other' } });
    const forged = {
      ...original.scopedHandles[0],
      bindingFingerprint: changed.scopedHandles[0].bindingFingerprint
    };
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => { calls += 1; } });
    await assert.rejects(
      colossus.dispatch({ permit, request: { ...changed, scopedHandles: [forged] }, now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'SCOPED_HANDLE_SIGNATURE_MISMATCH'
    );
    assert.equal(calls, 0);
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId), null);
  });
});

test('rejects signed handle authority broader than capability policy', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => { calls += 1; } });
    await assert.rejects(
      colossus.dispatch({
        permit,
        request: request({ scopedHandles: [{
          type: 'filesystem-root', id: 'root-1', scope: 'root-admin',
          issuedAt: '2026-08-01T21:59:00.000Z', expiresAt: '2026-08-01T22:00:30.000Z'
        }] }),
        now: NOW
      }),
      (error) => error instanceof ColossusDispatchError && error.code === 'SCOPED_HANDLE_POLICY_MISMATCH'
    );
    assert.equal(calls, 0);
  });
});

test('rejects handle signed by an untrusted issuer before transport', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const base = request();
    const malicious = signTestScopedHandle({
      type: 'filesystem-root', id: 'root-evil', scope: 'move-within-root',
      issuedAt: '2026-08-01T21:59:00.000Z', expiresAt: '2026-08-01T22:00:30.000Z',
      bindingFingerprint: base.scopedHandles[0].bindingFingerprint
    }, { issuer: 'evil-authority.test', keyId: 'evil-key' });
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => { calls += 1; } });
    await assert.rejects(
      colossus.dispatch({ permit, request: { ...base, scopedHandles: [malicious] }, now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'SCOPED_HANDLE_KEY_UNKNOWN'
    );
    assert.equal(calls, 0);
  });
});

test('rejects expired permits before transport', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') });
    await assert.rejects(
      colossus.dispatch({ permit, request: request(), now: new Date('2026-08-01T22:02:00.000Z') }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_EXPIRED'
    );
  });
});

test('resolves adapter and capability only from the registry', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') });
    await assert.rejects(
      colossus.dispatch({ permit, request: request({ capability: 'filesystem.delete' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'CAPABILITY_SCOPE_MISMATCH'
    );
    await assert.rejects(
      colossus.dispatch({ permit, request: request({ adapterId: 'other' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_REQUEST_FIELD_FORBIDDEN'
    );
  });
});

test('rejects raw credential-shaped data', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') });
    await assert.rejects(
      colossus.dispatch({ permit, request: request({ payload: { accessToken: 'secret-value' } }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'RAW_CREDENTIAL_FORBIDDEN'
    );
  });
});

test('rejects substituted receipt and burns one-shot attempt', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter(ledger, {
      supportsAbort: true,
      dispatch: async (envelope) => receiptFor(envelope, { requestId: 'other-request' })
    });
    await assert.rejects(
      colossus.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RECEIPT_SUBJECT_MISMATCH'
    );
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId).state, 'started');
  });
});

test('rejects overclaimed receipt and burns one-shot attempt', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter(ledger, {
      supportsAbort: true,
      dispatch: async (envelope) => receiptFor(envelope, { providerConfirmation: 'confirmed' })
    });
    await assert.rejects(
      colossus.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RECEIPT_OVERCLAIMED'
    );
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId).state, 'started');
  });
});

test('rejects self-consistent but unpersisted forged permit', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const forgedSubject = {
      approvalId: permit.approvalId, jobId: permit.jobId,
      planFingerprint: permit.planFingerprint, componentRef: permit.componentRef,
      method: permit.method, idempotencyKey: 'idem-forged', policyVersion: permit.policyVersion
    };
    const forgedCore = {
      permitId: 'permit-forged', claimId: 'claim-forged', ...forgedSubject,
      subjectFingerprint: planFingerprint(forgedSubject),
      issuedAt: permit.issuedAt, expiresAt: permit.expiresAt, status: 'issued'
    };
    const forged = { ...forgedCore, permitFingerprint: planFingerprint(forgedCore) };
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') });
    await assert.rejects(
      colossus.dispatch({ permit: forged, request: request({ idempotencyKey: 'idem-forged' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_NOT_PERSISTED'
    );
  });
});

test('rejects incompatible versions and overlong handle authority', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter(ledger, { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') });
    await assert.rejects(
      colossus.dispatch({ permit, request: request({ protocolVersion: 'sigma-federation/v2' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'PROTOCOL_VERSION_INCOMPATIBLE'
    );
    await assert.rejects(
      colossus.dispatch({ permit, request: request({ scopedHandles: [{
        type: 'filesystem-root', id: 'root-1', scope: 'move-within-root',
        issuedAt: '2026-08-01T21:59:00.000Z', expiresAt: '2026-08-01T23:00:00.000Z'
      }] }), now: NOW }),
      (error) => error instanceof ColossusDispatchError &&
        ['SCOPED_HANDLE_TIME_INVALID', 'SCOPED_HANDLE_EXPIRED'].includes(error.code)
    );
  });
});

test('times out once without silent retry and leaves recovery evidence', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const colossus = adapter(ledger, {
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
    }, { timeoutMs: 20 });
    await assert.rejects(
      colossus.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_TIMEOUT'
    );
    assert.equal(calls, 1);
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId).state, 'started');
  });
});
