import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ComponentRegistry } from '../src/registry/component-registry.mjs';
import { SigmaOrchestrator } from '../src/orchestrator/orchestrator.mjs';
import { DurableIdempotencyLedger } from '../src/persistence/idempotency-ledger.mjs';
import { TestRootCommander } from '../src/runtime/test-root-commander.mjs';
import { VerifiedColossusGateway } from '../src/runtime/verified-colossus-gateway.mjs';
import { FencedSqliteClaimLedger } from '../src/ledger/fenced-sqlite-claim-ledger.mjs';
import { SqliteExecutionLedger } from '../src/ledger/sqlite-execution-ledger.mjs';
import { VerifiedExecutionLedger } from '../src/execution/verified-execution-ledger.mjs';
import { ColossusDispatchAdapter } from '../src/dispatch/colossus-dispatch-adapter.mjs';
import { DurableDispatchCoordinator } from '../src/execution/durable-dispatch-coordinator.mjs';
import { planFingerprint } from '../src/plan/fingerprint.mjs';
import {
  createTestTrustStore,
  signTestApproval
} from './helpers/gatekeeper-fixture.mjs';

const CLOCK_START = Date.parse('2026-08-08T16:30:00.000Z');
const COMPONENT = Object.freeze({
  name: 'commander-test-root',
  ref: 'commander-test-root@v1',
  protocolVersion: 'sigma-federation/v1',
  allowedOperations: ['inspect', 'plan', 'execute', 'reconcile', 'compensate'],
  supportedMethods: Object.freeze({
    initialize: true,
    health: true,
    capabilities: true,
    inspect: true,
    plan: true,
    execute: true,
    reconcile: true,
    rollback: false,
    compensate: true
  })
});
const DISPATCH_REGISTRY = Object.freeze({
  [COMPONENT.ref]: Object.freeze({
    adapterId: 'commander',
    methods: Object.freeze({
      execute: Object.freeze(['filesystem.move']),
      compensate: Object.freeze(['filesystem.move'])
    }),
    authority: Object.freeze({
      'filesystem.move': Object.freeze({
        minHandles: 1,
        maxHandles: 1,
        handles: Object.freeze([
          Object.freeze({ type: 'filesystem-root', scope: 'move-within-root' })
        ])
      })
    })
  })
});

function request(overrides = {}) {
  return {
    jobId: 'job-verified-gateway-1',
    componentRef: COMPONENT.ref,
    provider: { stableId: 'local-test-root' },
    items: [{
      stableId: 'file:inbox/note.txt',
      source: 'inbox/note.txt',
      destination: 'archive/note.txt'
    }],
    idempotencyKey: 'idem-verified-gateway-1',
    ...overrides
  };
}

function expectedBeforeFingerprint(plan) {
  return planFingerprint({
    provider: plan.provider.stableId,
    operation: plan.operation,
    items: plan.items.map((item) => ({ stableId: item.stableId, source: item.source }))
  });
}

function expectedAfterFingerprint(plan) {
  return planFingerprint({
    provider: plan.provider.stableId,
    operation: plan.operation,
    items: plan.items.map((item) => ({ stableId: item.stableId, destination: item.destination }))
  });
}

function requestIdFor({ jobId, idempotencyKey, planHash }) {
  return `request_${planFingerprint({
    jobId,
    componentRef: COMPONENT.ref,
    method: 'execute',
    operation: 'move',
    idempotencyKey,
    planFingerprint: planHash,
    policyVersion: 'policy-v1'
  }).slice('sha256:'.length)}`;
}

function advancingClock() {
  let nowMs = CLOCK_START;
  return () => {
    const value = new Date(nowMs);
    nowMs += 1_000;
    return value;
  };
}

async function withSystem(run, {
  dishonestReconciliation = false,
  authorityExtra = null,
  authorityExtraFirstOnly = false,
  confirmationExtra = null
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sigma-verified-gateway-'));
  await mkdir(join(root, 'inbox'), { recursive: true });
  await writeFile(join(root, 'inbox', 'note.txt'), 'verified gateway\n');

  const clock = advancingClock();
  const permitLedger = new FencedSqliteClaimLedger(join(root, 'authority.sqlite'), {
    approvalVerifier: createTestTrustStore()
  });
  const executionLedger = new VerifiedExecutionLedger({
    ledger: new SqliteExecutionLedger(join(root, 'execution.sqlite'))
  });
  const outerLedger = new DurableIdempotencyLedger(join(root, 'outer-idempotency'));
  const commander = new TestRootCommander(root);
  const registry = new ComponentRegistry();
  registry.register(COMPONENT);
  const capturedEnvelopes = [];
  const durablePhasesObservedByBridge = [];
  let authorityCalls = 0;

  const gatekeeper = {
    requestApproval: async ({ jobId, componentRef, method, policyVersion, plan }) => signTestApproval({
      approvalId: `approval-${jobId}`,
      jobId,
      planFingerprint: plan.planFingerprint,
      componentRef,
      method,
      idempotencyKey: plan.idempotencyKey,
      policyVersion,
      issuedAt: '2026-08-08T16:29:00.000Z',
      expiresAt: '2026-08-08T16:50:00.000Z',
      status: 'approved'
    })
  };

  const transport = {
    supportsAbort: true,
    dispatch: async (envelope) => {
      capturedEnvelopes.push(envelope);
      return {
        receiptId: `receipt-${envelope.requestId}`,
        requestId: envelope.requestId,
        envelopeFingerprint: envelope.envelopeFingerprint,
        permitFingerprint: envelope.authorization.permitFingerprint,
        componentRef: envelope.componentRef,
        method: envelope.method,
        idempotencyKey: envelope.idempotencyKey,
        resolvedAdapterId: envelope.resolvedAdapterId,
        capability: envelope.capability,
        status: 'dispatched',
        receivedAt: envelope.createdAt,
        redactedDiagnostics: []
      };
    }
  };
  const dispatchAdapter = new ColossusDispatchAdapter({
    registry: DISPATCH_REGISTRY,
    transport,
    permitStore: permitLedger
  });
  const dispatchCoordinator = new DurableDispatchCoordinator({
    dispatchAdapter,
    executionLedger
  });

  const dispatchAuthority = ({ permit, now, authorityBindingForCapability }) => {
    authorityCalls += 1;
    const injectExtra = authorityExtra &&
      (!authorityExtraFirstOnly || authorityCalls === 1);
    const capability = 'filesystem.move';
    return {
      capability,
      scopedHandles: [{
        type: 'filesystem-root',
        id: 'test-root',
        scope: 'move-within-root',
        expiresAt: new Date(Math.min(
          Date.parse(permit.expiresAt),
          now.getTime() + 30_000
        )).toISOString(),
        bindingFingerprint: authorityBindingForCapability(capability)
      }],
      ...(injectExtra ? authorityExtra : {})
    };
  };

  const evidenceBridge = {
    observationMethod: 'test-root-read-after-write',
    awaitProviderConfirmation: async ({ plan, request, attempt, operation }) => {
      durablePhasesObservedByBridge.push(
        executionLedger.getOperation(operation.operationId).state
      );
      assert.equal(executionLedger.getOperation(operation.operationId).state, 'attempted');
      await commander[plan.operation === 'compensate' ? 'compensate' : 'execute'](
        plan,
        { idempotencyKey: plan.idempotencyKey }
      );
      return {
        requestId: request.requestId,
        operationId: operation.operationId,
        attemptId: attempt.attemptId,
        envelopeFingerprint: operation.envelopeFingerprint,
        providerRequestId: `providerref_${plan.idempotencyKey.replace(/[^A-Za-z0-9._~-]/g, '_')}`,
        confirmationMethod: 'test-root-commander',
        beforeFingerprint: expectedBeforeFingerprint(plan),
        afterFingerprint: expectedAfterFingerprint(plan),
        confirmedAt: clock().toISOString(),
        ...(confirmationExtra ?? {})
      };
    },
    reconcile: async ({ plan, confirmation, operation, reconciliationStart }) => {
      durablePhasesObservedByBridge.push(
        executionLedger.getOperation(operation.operationId).state
      );
      assert.equal(executionLedger.getOperation(operation.operationId).state, 'reconciling');
      await commander.reconcile(plan);
      const observed = dishonestReconciliation
        ? planFingerprint({ state: 'dishonest-substitution' })
        : confirmation.afterFingerprint;
      return {
        observationMethod: reconciliationStart.observationMethod,
        expectedFingerprint: confirmation.afterFingerprint,
        observedFingerprint: observed,
        matchesExpected: true,
        observedAt: clock().toISOString()
      };
    }
  };

  const colossus = new VerifiedColossusGateway({
    permitLedger,
    dispatchCoordinator,
    executionLedger,
    dispatchAuthority,
    evidenceBridge,
    now: clock
  });
  const orchestrator = new SigmaOrchestrator({
    registry,
    gatekeeper,
    colossus,
    ledger: outerLedger,
    now: clock
  });

  try {
    return await run({
      root,
      orchestrator,
      permitLedger,
      executionLedger,
      outerLedger,
      capturedEnvelopes,
      durablePhasesObservedByBridge
    });
  } finally {
    executionLedger.close();
    permitLedger.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('orchestrator mutation traverses signed permit dispatch and verified execution chain', async () => {
  await withSystem(async ({
    root,
    orchestrator,
    permitLedger,
    executionLedger,
    outerLedger,
    capturedEnvelopes,
    durablePhasesObservedByBridge
  }) => {
    const result = await orchestrator.move(request());

    assert.equal(result.job.state, 'reconciled');
    assert.equal(result.receipt.status, 'provider_confirmed');
    assert.equal(result.reconciliation.status, 'reconciled');
    assert.equal(await readFile(join(root, 'archive', 'note.txt'), 'utf8'), 'verified gateway\n');
    assert.deepEqual(durablePhasesObservedByBridge, ['attempted', 'reconciling']);

    assert.equal(capturedEnvelopes.length, 1);
    assert.deepEqual(capturedEnvelopes[0].payload, {
      operation: 'move',
      provider: { stableId: 'local-test-root' },
      items: [{
        stableId: 'file:inbox/note.txt',
        source: 'inbox/note.txt',
        destination: 'archive/note.txt'
      }]
    });

    const permit = permitLedger.getPermitByIdempotencyKey(result.plan.idempotencyKey);
    assert.ok(permit);
    assert.equal(permitLedger.getDispatchAttemptByPermitId(permit.permitId).state, 'accepted');

    const operation = executionLedger.getOperationByRequestId(result.receipt.requestId);
    assert.equal(operation.state, 'reconciled');
    const chain = executionLedger.verifyEventChain(operation.operationId);
    assert.equal(chain.valid, true);
    assert.equal(chain.eventCount, 5);

    const outer = await outerLedger.read(result.plan.idempotencyKey);
    assert.equal(outer.state, 'completed');
  });
});

test('pretransport authority rejection releases outer claim and reuses unattempted inner permit', async () => {
  await withSystem(async ({
    root,
    orchestrator,
    permitLedger,
    outerLedger,
    capturedEnvelopes
  }) => {
    const jobId = 'job-authority-smuggle';
    const idempotencyKey = 'idem-authority-smuggle';
    const operationRequest = request({ jobId, idempotencyKey });

    await assert.rejects(
      orchestrator.move(operationRequest),
      (error) => error.code === 'DISPATCH_AUTHORITY_FIELD_FORBIDDEN' &&
        error.job?.state === 'failed'
    );

    assert.equal(capturedEnvelopes.length, 0);
    const permitBeforeRetry = permitLedger.getPermitByIdempotencyKey(idempotencyKey);
    assert.ok(permitBeforeRetry);
    assert.equal(permitLedger.getDispatchAttemptByPermitId(permitBeforeRetry.permitId), null);
    assert.equal(await outerLedger.read(idempotencyKey), null);
    assert.equal(await readFile(join(root, 'inbox', 'note.txt'), 'utf8'), 'verified gateway\n');

    const retried = await orchestrator.move(operationRequest);
    const permitAfterRetry = permitLedger.getPermitByIdempotencyKey(idempotencyKey);
    assert.equal(permitAfterRetry.permitId, permitBeforeRetry.permitId);
    assert.equal(capturedEnvelopes.length, 1);
    assert.equal(retried.job.state, 'reconciled');
    assert.equal((await outerLedger.read(idempotencyKey)).state, 'completed');
    assert.equal(await readFile(join(root, 'archive', 'note.txt'), 'utf8'), 'verified gateway\n');
  }, {
    authorityExtra: {
      payload: { operation: 'delete-everything' }
    },
    authorityExtraFirstOnly: true
  });
});

test('cross-wired provider confirmation is rejected before provider-confirmed state', async () => {
  await withSystem(async ({ orchestrator, executionLedger, outerLedger }) => {
    const jobId = 'job-cross-wired-confirmation';
    const idempotencyKey = 'idem-cross-wired-confirmation';

    await assert.rejects(
      orchestrator.move(request({ jobId, idempotencyKey })),
      (error) => error.code === 'PROVIDER_CONFIRMATION_SUBJECT_MISMATCH' &&
        error.job?.state === 'recovery_required'
    );

    const outer = await outerLedger.read(idempotencyKey);
    assert.equal(outer.state, 'claimed');
    const operation = executionLedger.getOperationByRequestId(requestIdFor({
      jobId,
      idempotencyKey,
      planHash: outer.planFingerprint
    }));
    assert.equal(operation.state, 'attempted');
    assert.equal(
      executionLedger.getEvents(operation.operationId).some(
        (event) => event.toState === 'provider_confirmed'
      ),
      false
    );
  }, {
    confirmationExtra: { requestId: 'request_from_another_operation' }
  });
});

test('dishonest reconciliation match claim fails closed and preserves outer recovery state', async () => {
  await withSystem(async ({ orchestrator, executionLedger, outerLedger }) => {
    const jobId = 'job-verified-gateway-dishonest';
    const idempotencyKey = 'idem-verified-gateway-dishonest';

    await assert.rejects(
      orchestrator.move(request({ jobId, idempotencyKey })),
      (error) => error.code === 'RECONCILIATION_MATCH_CLAIM_MISMATCH' &&
        error.job?.state === 'recovery_required'
    );

    const outer = await outerLedger.read(idempotencyKey);
    assert.equal(outer.state, 'claimed');

    const operation = executionLedger.getOperationByRequestId(requestIdFor({
      jobId,
      idempotencyKey,
      planHash: outer.planFingerprint
    }));
    assert.ok(operation);
    assert.equal(operation.state, 'reconciling');
    const events = executionLedger.getEvents(operation.operationId);
    assert.equal(events.some((event) => event.toState === 'reconciled'), false);
    assert.equal(executionLedger.verifyEventChain(operation.operationId).valid, true);
  }, { dishonestReconciliation: true });
});
