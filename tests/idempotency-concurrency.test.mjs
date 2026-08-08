import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ComponentRegistry } from '../src/registry/component-registry.mjs';
import { SigmaOrchestrator } from '../src/orchestrator/orchestrator.mjs';
import { DurableIdempotencyLedger } from '../src/persistence/idempotency-ledger.mjs';

const component = {
  name: 'concurrency-fixture',
  ref: 'concurrency-fixture@v1',
  protocolVersion: 'sigma-federation/v1',
  allowedOperations: ['execute'],
  supportedMethods: { execute: true }
};

function request() {
  return {
    jobId: 'job-race-1',
    componentRef: component.ref,
    provider: { stableId: 'provider-race-1' },
    items: [{ stableId: 'item-1', source: 'a', destination: 'b' }],
    idempotencyKey: 'idem-race-1'
  };
}

function gatekeeper() {
  let sequence = 0;
  return {
    requestApproval: async ({ jobId, componentRef, method, plan }) => ({
      approvalId: `approval-${++sequence}`,
      status: 'approved',
      jobId,
      componentRef,
      method,
      idempotencyKey: plan.idempotencyKey,
      planFingerprint: plan.planFingerprint,
      expiresAt: '2099-01-01T00:00:00Z'
    })
  };
}

function evidence(status, plan) {
  return {
    status,
    provider: plan.provider.stableId,
    operation: plan.operation,
    planFingerprint: plan.planFingerprint,
    idempotencyKey: plan.idempotencyKey
  };
}

test('concurrent orchestrators sharing one ledger cross the mutation boundary once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-idem-race-'));
  let dispatches = 0;
  let releaseDispatch;
  let enteredDispatch;
  const dispatchEntered = new Promise((resolve) => { enteredDispatch = resolve; });
  const dispatchRelease = new Promise((resolve) => { releaseDispatch = resolve; });

  const colossus = {
    dispatch: async ({ plan }) => {
      dispatches += 1;
      enteredDispatch();
      await dispatchRelease;
      return evidence('provider_confirmed', plan);
    },
    reconcile: async ({ plan }) => evidence('reconciled', plan)
  };

  const registry = new ComponentRegistry();
  registry.register(component);
  const approvals = gatekeeper();
  const first = new SigmaOrchestrator({
    registry,
    gatekeeper: approvals,
    colossus,
    ledger: new DurableIdempotencyLedger(root)
  });
  const second = new SigmaOrchestrator({
    registry,
    gatekeeper: approvals,
    colossus,
    ledger: new DurableIdempotencyLedger(root)
  });

  try {
    const firstRun = first.move(request());
    await dispatchEntered;

    await assert.rejects(
      () => second.move(request()),
      (error) => error.code === 'IDEMPOTENCY_RECOVERY_REQUIRED'
    );
    assert.equal(dispatches, 1);

    releaseDispatch();
    const completed = await firstRun;
    assert.equal(completed.job.state, 'reconciled');
    assert.equal(dispatches, 1);

    await assert.rejects(
      () => second.move(request()),
      (error) => error.code === 'IDEMPOTENCY_ALREADY_COMPLETED'
    );
    assert.equal(dispatches, 1);
  } finally {
    releaseDispatch?.();
    await rm(root, { recursive: true, force: true });
  }
});
