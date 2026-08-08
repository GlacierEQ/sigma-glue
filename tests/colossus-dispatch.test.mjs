import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FencedSqliteClaimLedger } from '../src/ledger/fenced-sqlite-claim-ledger.mjs';
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
const COMPLETED = new Date('2026-08-01T22:00:02.000Z');
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

function adapter({ permitStore, transport, timeoutMs = 10_000, clock = () => COMPLETED }) {
  return new ColossusDispatchAdapter({
    registry: REGISTRY,
    permitStore,
    transport,
    timeoutMs,
    clock
  });
}

test('dispatches one exact envelope and records locally observed acceptance evidence', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let captured;
    const colossus = adapter({
      permitStore: ledger,
      transport: {
        supportsAbort: true,
        dispatch: async (envelope) => {
          captured = envelope;
          return receiptFor(envelope);
        }
      }
    });

    const receipt = await colossus.dispatch({ permit, request: request(), now: NOW });
    const attempt = ledger.getDispatchAttemptByPermitId(permit.permitId);

    assert.equal(receipt.status, 'dispatched');
    assert.equal(captured.resolvedAdapterId, 'commander');
    assert.deepEqual(Object.keys(captured.authorization).sort(), ['expiresAt', 'permitFingerprint', 'permitId']);
    assert.ok(Object.isFrozen(captured));
    assert.ok(Object.isFrozen(captured.payload));
    assert.ok(Object.isFrozen(receipt));
    assert.equal(attempt.state, 'accepted');
    assert.equal(attempt.requestId, 'request-1');
    assert.equal(attempt.envelopeFingerprint, captured.envelopeFingerprint);
    assert.equal(attempt.receiptStatus, 'dispatched');
    assert.equal(attempt.receiptFingerprint, planFingerprint(receipt));
    assert.equal(attempt.providerReceivedAt, receipt.receivedAt);
    assert.equal(attempt.completedAt, COMPLETED.toISOString());
  });
});

test('records explicit blocked and failed receipts as rejected, never accepted', async () => {
  for (const status of ['blocked', 'failed']) {
    await withPermit(async ({ permit, ledger }) => {
      const colossus = adapter({
        permitStore: ledger,
        transport: {
          supportsAbort: true,
          dispatch: async (envelope) => receiptFor(envelope, {
            status,
            reasonCode: status === 'blocked' ? 'POLICY_BLOCKED' : 'ROUTE_FAILED'
          })
        }
      });

      const receipt = await colossus.dispatch({ permit, request: request(), now: NOW });
      const attempt = ledger.getDispatchAttemptByPermitId(permit.permitId);
      assert.equal(receipt.status, status);
      assert.equal(attempt.state, 'rejected');
      assert.equal(attempt.receiptStatus, status);
      assert.equal(attempt.reasonCode, receipt.reasonCode);
      assert.equal(attempt.receiptFingerprint, planFingerprint(receipt));
      assert.equal(attempt.completedAt, COMPLETED.toISOString());
    });
  }
});

test('rejects permit or request substitution before transport', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const colossus = adapter({
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => { calls += 1; } }
    });

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

test('rejects expired permits before transport', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter({
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });
    await assert.rejects(
      colossus.dispatch({ permit, request: request(), now: new Date('2026-08-01T22:02:00.000Z') }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_EXPIRED'
    );
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId), null);
  });
});

test('resolves adapter and capability only from the registry', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter({
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });

    await assert.rejects(
      colossus.dispatch({ permit, request: request({ capability: 'filesystem.delete' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'CAPABILITY_SCOPE_MISMATCH'
    );
    await assert.rejects(
      colossus.dispatch({ permit, request: request({ adapterId: 'other' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_REQUEST_FIELD_FORBIDDEN'
    );
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId), null);
  });
});

test('rejects raw credential-shaped data', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter({
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });

    await assert.rejects(
      colossus.dispatch({ permit, request: request({ payload: { accessToken: 'secret-value' } }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'RAW_CREDENTIAL_FORBIDDEN'
    );
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId), null);
  });
});

test('rejects a substituted Colossus receipt and preserves exact started-envelope recovery evidence', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let captured;
    const substituted = adapter({
      permitStore: ledger,
      transport: {
        supportsAbort: true,
        dispatch: async (envelope) => {
          captured = envelope;
          return receiptFor(envelope, { requestId: 'other-request' });
        }
      }
    });
    await assert.rejects(
      substituted.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_RECEIPT_SUBJECT_MISMATCH'
    );
    const attempt = ledger.getDispatchAttemptByPermitId(permit.permitId);
    assert.equal(attempt.state, 'started');
    assert.equal(attempt.requestId, 'request-1');
    assert.equal(attempt.envelopeFingerprint, captured.envelopeFingerprint);
  });
});

test('rejects an overclaimed Colossus receipt and burns the one-shot attempt', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const overclaimed = adapter({
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
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId).state, 'started');
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
    const colossus = adapter({
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });

    await assert.rejects(
      colossus.dispatch({ permit: forged, request: request({ idempotencyKey: 'idem-forged' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'DISPATCH_PERMIT_NOT_PERSISTED'
    );
  });
});

test('rejects incompatible versions and overlong handle authority', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const colossus = adapter({
      permitStore: ledger,
      transport: { supportsAbort: true, dispatch: async () => assert.fail('transport must not run') }
    });

    await assert.rejects(
      colossus.dispatch({ permit, request: request({ protocolVersion: 'sigma-federation/v2' }), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'PROTOCOL_VERSION_INCOMPATIBLE'
    );
    await assert.rejects(
      colossus.dispatch({
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
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId), null);
  });
});

test('times out once without a silent retry and preserves exact envelope recovery evidence', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    let captured;
    const colossus = adapter({
      permitStore: ledger,
      timeoutMs: 20,
      transport: {
        supportsAbort: true,
        dispatch: async (envelope, { signal }) => {
          captured = envelope;
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
      colossus.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError && error.code === 'COLOSSUS_TIMEOUT'
    );
    const attempt = ledger.getDispatchAttemptByPermitId(permit.permitId);
    assert.equal(calls, 1);
    assert.equal(attempt.state, 'started');
    assert.equal(attempt.requestId, captured.requestId);
    assert.equal(attempt.envelopeFingerprint, captured.envelopeFingerprint);
  });
});

test('completion persistence failure returns validated recovery evidence and leaves started state', async () => {
  await withPermit(async ({ permit, ledger }) => {
    const failingStore = {
      getPermitByIdempotencyKey: (key) => ledger.getPermitByIdempotencyKey(key),
      beginDispatchAttempt: (input) => ledger.beginDispatchAttempt(input),
      completeDispatchAttempt: () => {
        throw new Error('simulated completion persistence failure');
      }
    };
    const colossus = adapter({
      permitStore: failingStore,
      transport: {
        supportsAbort: true,
        dispatch: async (envelope) => receiptFor(envelope)
      }
    });

    await assert.rejects(
      colossus.dispatch({ permit, request: request(), now: NOW }),
      (error) => {
        assert.ok(error instanceof ColossusDispatchError);
        assert.equal(error.code, 'DISPATCH_ATTEMPT_COMPLETION_FAILED');
        assert.equal(error.receipt?.status, 'dispatched');
        assert.match(error.attemptId, /^dispatch_attempt_/);
        assert.match(error.envelopeFingerprint, /^sha256:/);
        return true;
      }
    );
    assert.equal(ledger.getDispatchAttemptByPermitId(permit.permitId).state, 'started');
  });
});

test('arbitrary permit-store failures do not leak internal messages or codes', async () => {
  await withPermit(async ({ permit, ledger }) => {
    let calls = 0;
    const failingStore = {
      getPermitByIdempotencyKey: (key) => ledger.getPermitByIdempotencyKey(key),
      beginDispatchAttempt: () => {
        const error = new Error('sensitive sqlite path /srv/private/claims.sqlite');
        error.code = 'SQLITE_CANTOPEN';
        throw error;
      },
      completeDispatchAttempt: () => assert.fail('completion must not run')
    };
    const colossus = adapter({
      permitStore: failingStore,
      transport: { supportsAbort: true, dispatch: async () => { calls += 1; } }
    });

    await assert.rejects(
      colossus.dispatch({ permit, request: request(), now: NOW }),
      (error) => error instanceof ColossusDispatchError &&
        error.code === 'DISPATCH_ATTEMPT_FENCE_FAILED' &&
        error.message === 'dispatch-attempt fence rejected the request' &&
        !error.message.includes('/srv/private')
    );
    assert.equal(calls, 0);
  });
});
