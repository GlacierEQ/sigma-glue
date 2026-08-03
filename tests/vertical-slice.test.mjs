import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComponentRegistry } from '../src/registry/component-registry.mjs';
import { normalizeMoveRequest } from '../src/protocol/request.mjs';
import { SigmaOrchestrator, OrchestratorError } from '../src/orchestrator/orchestrator.mjs';
import { TestRootCommander } from '../src/runtime/test-root-commander.mjs';
import { TestRootColossusGateway } from '../src/runtime/test-root-colossus.mjs';
import { planFingerprint } from '../src/plan/fingerprint.mjs';

const component = {
  name: 'commander-test-root', ref: 'commander-test-root@v1', protocolVersion: 'sigma-federation/v1',
  allowedOperations: ['inspect', 'plan', 'execute', 'reconcile', 'compensate'],
  supportedMethods: { initialize: true, health: true, capabilities: true, inspect: true, plan: true, execute: true, reconcile: true, rollback: false, compensate: true }
};

let root;
let outside;
let registry;
let commander;
let colossus;
let orchestrator;
let approvals;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sigma-glue-'));
  outside = await mkdtemp(join(tmpdir(), 'sigma-glue-outside-'));
  await mkdir(join(root, 'inbox'), { recursive: true });
  await writeFile(join(root, 'inbox', 'note.txt'), 'hello Sigma\n');
  approvals = [];
  registry = new ComponentRegistry();
  registry.register(component);
  const gatekeeper = { requestApproval: async ({ jobId, componentRef, method, plan }) => {
    const approval = { approvalId: `approval-${approvals.length + 1}`, status: 'approved', jobId, componentRef, method, idempotencyKey: plan.idempotencyKey, planFingerprint: plan.planFingerprint, expiresAt: '2099-01-01T00:00:00Z' };
    approvals.push(approval);
    return approval;
  }};
  commander = new TestRootCommander(root);
  colossus = new TestRootColossusGateway({ commander, componentRef: component.ref });
  orchestrator = new SigmaOrchestrator({ registry, gatekeeper, colossus });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function request(overrides = {}) {
  return { jobId: 'job-local-1', componentRef: component.ref, provider: { stableId: 'local-test-root' }, items: [{ stableId: 'file:inbox/note.txt', source: 'inbox/note.txt', destination: 'archive/note.txt' }], idempotencyKey: 'idem-local-1', ...overrides };
}

test('runs a local move through approval, Commander, and reconciliation', async () => {
  const result = await orchestrator.move(request());
  assert.equal(result.job.state, 'reconciled');
  assert.equal(await readFile(join(root, 'archive', 'note.txt'), 'utf8'), 'hello Sigma\n');
  await assert.rejects(() => readFile(join(root, 'inbox', 'note.txt')));
  assert.equal(result.receipt.status, 'provider_confirmed');
  assert.equal(result.reconciliation.status, 'reconciled');
  assert.deepEqual(result.job.history.map((entry) => entry.toState), ['normalized', 'capability_checked', 'planned', 'awaiting_approval', 'approved', 'dispatched', 'attempted', 'provider_confirmed', 'reconciling', 'reconciled']);
});

test('reuses the exact idempotency subject on a repeated execution', async () => {
  const first = await orchestrator.move(request());
  const second = await commander.execute(first.plan, { idempotencyKey: first.plan.idempotencyKey });
  assert.deepEqual(second, first.receipt);
});

test('rejects an approval bound to a changed plan', async () => {
  orchestrator.gatekeeper = { requestApproval: async ({ plan, jobId, componentRef, method }) => ({ approvalId: 'bad-approval', status: 'approved', jobId, componentRef, method, idempotencyKey: plan.idempotencyKey, planFingerprint: planFingerprint({ ...plan, items: [] }), expiresAt: '2099-01-01T00:00:00Z' }) };
  await assert.rejects(() => orchestrator.move(request()), (error) => error instanceof OrchestratorError && error.code === 'APPROVAL_SUBJECT_MISMATCH');
});

test('rejects paths outside the test root before any approval or mutation', async () => {
  await assert.rejects(() => orchestrator.move(request({ items: [{ stableId: 'escape', source: '../secret.txt', destination: 'archive/secret.txt' }] })), (error) => error.code === 'PATH_OUTSIDE_SCOPE');
  assert.equal(approvals.length, 0);
});

test('compensates a reconciled move with a separately approved recovery plan', async () => {
  const result = await orchestrator.move(request());
  const recovery = await orchestrator.compensate(result);
  assert.equal(recovery.job.state, 'reconciled');
  assert.deepEqual(recovery.job.history.slice(-10).map((entry) => entry.toState), ['recovery_required', 'capability_checked', 'planned', 'awaiting_approval', 'approved', 'dispatched', 'attempted', 'provider_confirmed', 'reconciling', 'reconciled']);
  assert.equal(recovery.plan.operation, 'compensate');
  assert.equal(await readFile(join(root, 'inbox', 'note.txt'), 'utf8'), 'hello Sigma\n');
  await assert.rejects(() => readFile(join(root, 'archive', 'note.txt')));
  assert.equal(approvals.length, 2);
});

test('freezes normalized requests and rejects duplicate or overlapping items', () => {
  const normalized = normalizeMoveRequest(request());
  assert.throws(() => { normalized.items[0].destination = 'tampered.txt'; }, TypeError);
  assert.throws(() => normalizeMoveRequest(request({
    items: [
      { stableId: 'a', source: 'inbox/a.txt', destination: 'archive/a.txt' },
      { stableId: 'b', source: 'archive/a.txt', destination: 'archive/b.txt' }
    ]
  })), (error) => error.code === 'ITEM_CONFLICT');
});

test('component capability snapshots cannot be broadened after registration', () => {
  assert.throws(() => registry.resolve(component.ref).allowedOperations.push('danger'), TypeError);
  assert.throws(() => { registry.resolve(component.ref).supportedMethods.execute = false; }, TypeError);
  assert.doesNotThrow(() => registry.assertSupports(component.ref, { operation: 'execute', method: 'execute' }));
});

test('rejects a Commander receipt bound to another plan', async () => {
  orchestrator.colossus.commander = {
    execute: async (plan) => ({ status: 'provider_confirmed', provider: plan.provider.stableId, operation: plan.operation, idempotencyKey: plan.idempotencyKey, planFingerprint: 'sha256:other' }),
    reconcile: async () => { throw new Error('reconcile must not run'); }
  };
  await assert.rejects(() => orchestrator.move(request()), (error) => error instanceof OrchestratorError && error.code === 'PROVIDER_RESULT_UNCONFIRMED');
});

test('rejects reconciliation evidence bound to another plan', async () => {
  orchestrator.colossus.commander = {
    execute: async (plan) => ({ status: 'provider_confirmed', provider: plan.provider.stableId, operation: plan.operation, idempotencyKey: plan.idempotencyKey, planFingerprint: plan.planFingerprint }),
    reconcile: async (plan) => ({ status: 'reconciled', provider: plan.provider.stableId, operation: plan.operation, idempotencyKey: plan.idempotencyKey, planFingerprint: 'sha256:other' })
  };
  await assert.rejects(() => orchestrator.move(request()), (error) => error instanceof OrchestratorError && error.code === 'RECONCILIATION_FAILED');
});

test('rejects idempotency-key reuse with a different payload', async () => {
  const first = await orchestrator.move(request());
  const changed = { ...first.plan, planFingerprint: 'sha256:different' };
  await assert.rejects(() => commander.execute(changed, { idempotencyKey: first.plan.idempotencyKey }), (error) => error.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');
});

test('rejects a symlinked path escaping the test root without mutating', async () => {
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(outside, join(root, 'linked'), 'dir');
  await assert.rejects(() => orchestrator.move(request({
    items: [{ stableId: 'escape', source: 'linked/secret.txt', destination: 'archive/secret.txt' }]
  })), (error) => error.code === 'SYMLINK_NOT_ALLOWED');
  assert.equal(approvals.length, 1);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside');
  await assert.rejects(() => readFile(join(root, 'archive', 'secret.txt')));
});
