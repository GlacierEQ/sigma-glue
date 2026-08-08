import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ComponentRegistry } from '../src/registry/component-registry.mjs';
import { SigmaOrchestrator } from '../src/orchestrator/orchestrator.mjs';
import {
  isProvablyPreProviderBoundary,
  markProvablyPreProviderBoundary
} from '../src/orchestrator/provider-boundary-proof.mjs';
import { DurableIdempotencyLedger } from '../src/persistence/idempotency-ledger.mjs';

const COMPONENT = {
  name: 'proof-fixture',
  ref: 'proof-fixture@v1',
  protocolVersion: 'sigma-federation/v1',
  allowedOperations: ['execute'],
  supportedMethods: { execute: true }
};

function registry() {
  const value = new ComponentRegistry();
  value.register(COMPONENT);
  return value;
}

function gatekeeper() {
  return {
    requestApproval: async ({ jobId, componentRef, method, policyVersion, plan }) => ({
      approvalId: `approval-${jobId}`,
      status: 'approved',
      jobId,
      componentRef,
      method,
      idempotencyKey: plan.idempotencyKey,
      planFingerprint: plan.planFingerprint,
      policyVersion,
      issuedAt: '2026-08-08T16:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z'
    })
  };
}

function request() {
  return {
    jobId: 'job-proof-1',
    componentRef: COMPONENT.ref,
    provider: { stableId: 'provider-proof-1' },
    items: [{ stableId: 'item-proof-1', source: 'a', destination: 'b' }],
    idempotencyKey: 'idem-proof-1'
  };
}

test('plain public properties cannot spoof a preprovider boundary proof', () => {
  const spoofed = Object.assign(new Error('spoofed'), {
    providerBoundaryEntered: false
  });
  assert.equal(isProvablyPreProviderBoundary(spoofed), false);

  const proven = markProvablyPreProviderBoundary(new Error('proven'));
  assert.equal(isProvablyPreProviderBoundary(proven), true);
});

test('spoofed gateway boundary flag cannot release the outer idempotency claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-boundary-proof-'));
  const ledger = new DurableIdempotencyLedger(root);
  let dispatches = 0;
  const spoofingGateway = {
    dispatch: async () => {
      dispatches += 1;
      const error = new Error('synthetic uncertain gateway failure');
      error.code = 'SYNTHETIC_GATEWAY_FAILURE';
      error.providerBoundaryEntered = false;
      throw error;
    },
    reconcile: async () => { throw new Error('not reached'); }
  };

  try {
    const orchestrator = new SigmaOrchestrator({
      registry: registry(),
      gatekeeper: gatekeeper(),
      colossus: spoofingGateway,
      ledger,
      now: () => new Date('2026-08-08T16:30:00.000Z')
    });

    await assert.rejects(
      orchestrator.move(request()),
      (error) => error.code === 'SYNTHETIC_GATEWAY_FAILURE' &&
        error.job?.state === 'recovery_required'
    );

    assert.equal(dispatches, 1);
    assert.equal((await ledger.read('idem-proof-1')).state, 'claimed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
