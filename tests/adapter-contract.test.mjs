import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterContractError, assertDispatchEnvelope } from '../src/adapters/adapter-contract.mjs';
import { SigmaOrchestrator } from '../src/orchestrator/orchestrator.mjs';
import { ComponentRegistry } from '../src/registry/component-registry.mjs';
import { TestRootColossusGateway } from '../src/runtime/test-root-colossus.mjs';

const component = {
  name: 'fixture', ref: 'fixture@v1', protocolVersion: 'sigma-federation/v1',
  allowedOperations: ['execute', 'reconcile'], supportedMethods: { execute: true, reconcile: true }
};

function envelope(overrides = {}) {
  const plan = {
    protocolVersion: 'sigma-federation/v1', componentRef: component.ref,
    provider: { stableId: 'fixture-provider' }, planFingerprint: 'sha256:plan',
    idempotencyKey: 'idem-1', ...overrides.plan
  };
  const approval = {
    status: 'approved', jobId: 'job-1', planFingerprint: plan.planFingerprint,
    idempotencyKey: plan.idempotencyKey, ...overrides.approval
  };
  return { plan, approval, method: overrides.method || 'execute', jobId: 'job-1' };
}

test('orchestrator refuses to construct without a Colossus gateway', () => {
  const registry = new ComponentRegistry();
  registry.register(component);
  assert.throws(() => new SigmaOrchestrator({ registry, gatekeeper: {}, commander: {} }), TypeError);
});

test('adapter envelope rejects raw credential fields', () => {
  assert.throws(() => assertDispatchEnvelope(envelope({ plan: { accessToken: 'never-here' } })), (error) =>
    error instanceof AdapterContractError && error.code === 'RAW_CREDENTIALS_FORBIDDEN');
});

test('adapter envelope binds job, plan, and idempotency subjects', () => {
  assert.throws(() => assertDispatchEnvelope(envelope({ approval: { jobId: 'other-job' } })), (error) =>
    error instanceof AdapterContractError && error.code === 'APPROVAL_BINDING_INVALID');
  assert.throws(() => assertDispatchEnvelope(envelope({ approval: { planFingerprint: 'sha256:other' } })), (error) =>
    error instanceof AdapterContractError && error.code === 'APPROVAL_BINDING_INVALID');
});

test('fixture gateway routes dispatch and reconciliation to the Commander boundary', async () => {
  const calls = [];
  const gateway = new TestRootColossusGateway({
    componentRef: component.ref,
    commander: {
      execute: async () => { calls.push('execute'); return { status: 'provider_confirmed' }; },
      reconcile: async () => { calls.push('reconcile'); return { status: 'reconciled' }; }
    }
  });
  const input = envelope();
  assert.deepEqual(await gateway.dispatch(input), { status: 'provider_confirmed' });
  assert.deepEqual(await gateway.reconcile(input), { status: 'reconciled' });
  assert.deepEqual(calls, ['execute', 'reconcile']);
});
