import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ComponentRegistry } from '../src/registry/component-registry.mjs';
import { SigmaOrchestrator } from '../src/orchestrator/orchestrator.mjs';
import { DurableIdempotencyLedger } from '../src/persistence/idempotency-ledger.mjs';

const component = {
  name: 'recovery-fixture',
  ref: 'recovery-fixture@v1',
  protocolVersion: 'sigma-federation/v1',
  allowedOperations: ['execute'],
  supportedMethods: { execute: true }
};

function request(overrides = {}) {
  return {
    jobId: 'job-recovery-1',
    componentRef: component.ref,
    provider: { stableId: 'provider-recovery-1' },
    items: [{ stableId: 'item-1', source: 'a', destination: 'b' }],
    idempotencyKey: 'idem-recovery-1',
    ...overrides
  };
}

function gatekeeper() {
  let sequence = 0;
  return {
    requestApproval: async ({ jobId, componentRef, method, policyVersion, plan }) => ({
      approvalId: `approval-${++sequence}`,
      status: 'approved',
      jobId,
      componentRef,
      method,
      idempotencyKey: plan.idempotencyKey,
      planFingerprint: plan.planFingerprint,
      policyVersion,
      issuedAt: '2026-08-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z'
    })
  };
}

function registry() {
  const result = new ComponentRegistry();
  result.register(component);
  return result;
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

function successfulColossus(counter) {
  return {
    dispatch: async ({ plan }) => {
      counter.count += 1;
      return evidence('provider_confirmed', plan);
    },
    reconcile: async ({ plan }) => evidence('reconciled', plan)
  };
}

test('malformed fresh claim fails closed before Colossus', async () => {
  const counter = { count: 0 };
  const orchestrator = new SigmaOrchestrator({
    registry: registry(),
    gatekeeper: gatekeeper(),
    colossus: successfulColossus(counter),
    ledger: { claim: async () => undefined }
  });

  await assert.rejects(
    () => orchestrator.move(request()),
    (error) => error.code === 'IDEMPOTENCY_LEDGER_STATE_INVALID'
  );
  assert.equal(counter.count, 0);
});

test('provable pre-dispatch failure releases claim and permits a safe retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-idem-release-'));
  const ledger = new DurableIdempotencyLedger(root);
  const approvals = gatekeeper();
  const counter = { count: 0 };
  let failApprovedTransition = true;
  const failingStore = {
    recordTransition: async (job) => {
      if (job.state === 'approved' && failApprovedTransition) {
        failApprovedTransition = false;
        throw new Error('synthetic pre-dispatch persistence failure');
      }
    }
  };

  try {
    const first = new SigmaOrchestrator({
      registry: registry(),
      gatekeeper: approvals,
      colossus: successfulColossus(counter),
      ledger,
      store: failingStore
    });
    await assert.rejects(() => first.move(request()), /synthetic pre-dispatch persistence failure/);
    assert.equal(counter.count, 0);
    assert.equal(await ledger.read('idem-recovery-1'), null);

    const retry = new SigmaOrchestrator({
      registry: registry(),
      gatekeeper: approvals,
      colossus: successfulColossus(counter),
      ledger
    });
    const result = await retry.move(request());
    assert.equal(result.job.state, 'reconciled');
    assert.equal(counter.count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider-boundary failure remains claimed and becomes recovery required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-idem-uncertain-'));
  const ledger = new DurableIdempotencyLedger(root);
  const approvals = gatekeeper();
  let dispatches = 0;
  const transitions = [];
  const store = {
    recordTransition: async (job) => { transitions.push(job.state); },
    recordFailure: async () => {}
  };
  const uncertainColossus = {
    dispatch: async () => {
      dispatches += 1;
      throw new Error('synthetic connection loss after provider boundary');
    },
    reconcile: async () => { throw new Error('not reached'); }
  };

  try {
    const first = new SigmaOrchestrator({
      registry: registry(),
      gatekeeper: approvals,
      colossus: uncertainColossus,
      ledger,
      store
    });
    await assert.rejects(
      () => first.move(request()),
      (error) => error.job?.state === 'recovery_required'
    );
    assert.equal(dispatches, 1);
    assert.equal((await ledger.read('idem-recovery-1'))?.state, 'claimed');
    assert.equal(transitions.at(-1), 'recovery_required');

    const second = new SigmaOrchestrator({
      registry: registry(),
      gatekeeper: approvals,
      colossus: uncertainColossus,
      ledger,
      store
    });
    await assert.rejects(
      () => second.move(request()),
      (error) => error.code === 'IDEMPOTENCY_RECOVERY_REQUIRED' && error.job?.state === 'recovery_required'
    );
    assert.equal(dispatches, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completed claims cannot be released or completed twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-idem-terminal-'));
  const ledger = new DurableIdempotencyLedger(root);
  const plan = {
    idempotencyKey: 'idem-terminal-1',
    planFingerprint: 'sha256:terminal',
    provider: { stableId: 'provider-terminal' },
    operation: 'move'
  };

  try {
    await ledger.claim(plan);
    await ledger.complete(plan, {
      receipt: {
        status: 'provider_confirmed', provider: 'provider-terminal', operation: 'move',
        planFingerprint: plan.planFingerprint, idempotencyKey: plan.idempotencyKey
      },
      reconciliation: {
        status: 'reconciled', provider: 'provider-terminal', operation: 'move',
        planFingerprint: plan.planFingerprint, idempotencyKey: plan.idempotencyKey
      }
    });
    await assert.rejects(
      () => ledger.release(plan),
      (error) => error.code === 'IDEMPOTENCY_RELEASE_NOT_ALLOWED'
    );
    await assert.rejects(
      () => ledger.complete(plan),
      (error) => error.code === 'IDEMPOTENCY_CLAIM_NOT_ACTIVE'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
