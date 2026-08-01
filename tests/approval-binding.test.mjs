import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalizationError, planFingerprint } from '../src/plan/fingerprint.mjs';
import { assertApprovalBinding, ApprovalBindingError } from '../src/approval/approval-binding.mjs';
import { transition, StateTransitionError } from '../src/state/state-machine.mjs';

const plan = {
  operation: 'move',
  provider: { stableId: 'onedrive:drive-1' },
  items: [{ stableId: 'item-7', destinationStableId: 'folder-2' }]
};
const expected = {
  approvalId: 'approval-1',
  jobId: 'job-1',
  planFingerprint: planFingerprint(plan),
  componentRef: 'commander@ref-1',
  method: 'execute',
  idempotencyKey: 'idem-job-1',
  policyVersion: 'policy-v1'
};
const approval = {
  ...expected,
  status: 'approved',
  issuedAt: '2026-08-01T11:59:00Z',
  expiresAt: '2026-08-01T13:00:00Z'
};
const now = new Date('2026-08-01T12:00:00Z');

test('binds approval to the exact plan, policy, and execution subject', () => {
  assert.deepEqual(assertApprovalBinding({ approval, expected, now }), {
    approvalId: 'approval-1',
    planFingerprint: expected.planFingerprint,
    policyVersion: 'policy-v1',
    expiresAt: '2026-08-01T13:00:00.000Z',
    bound: true
  });
});

test('rejects changed plan or policy under a reused approval id', () => {
  const changedPlan = { ...expected, planFingerprint: planFingerprint({ ...plan, items: [] }) };
  assert.throws(
    () => assertApprovalBinding({ approval, expected: changedPlan, now }),
    (error) => error instanceof ApprovalBindingError && error.code === 'APPROVAL_SUBJECT_MISMATCH'
  );
  assert.throws(
    () => assertApprovalBinding({ approval, expected: { ...expected, policyVersion: 'policy-v2' }, now }),
    (error) => error instanceof ApprovalBindingError && error.code === 'APPROVAL_SUBJECT_MISMATCH'
  );
});

test('rejects expired, future-issued, inverted, and consumed approvals', () => {
  assert.throws(
    () => assertApprovalBinding({ approval, expected, now: new Date('2026-08-01T14:00:00Z') }),
    (error) => error instanceof ApprovalBindingError && error.code === 'APPROVAL_EXPIRED'
  );
  assert.throws(
    () => assertApprovalBinding({ approval: { ...approval, issuedAt: '2026-08-01T12:01:00Z' }, expected, now }),
    (error) => error instanceof ApprovalBindingError && error.code === 'APPROVAL_WINDOW_INVALID'
  );
  assert.throws(
    () => assertApprovalBinding({ approval: { ...approval, issuedAt: approval.expiresAt }, expected, now }),
    (error) => error instanceof ApprovalBindingError && error.code === 'APPROVAL_WINDOW_INVALID'
  );
  assert.throws(
    () => assertApprovalBinding({ approval: { ...approval, status: 'consumed' }, expected, now }),
    (error) => error instanceof ApprovalBindingError && error.code === 'APPROVAL_NOT_APPROVED'
  );
});

test('canonical fingerprints are key-order independent and array-order sensitive', () => {
  assert.equal(planFingerprint({ a: 1, b: { x: true, y: 2 } }), planFingerprint({ b: { y: 2, x: true }, a: 1 }));
  assert.notEqual(planFingerprint({ items: ['a', 'b'] }), planFingerprint({ items: ['b', 'a'] }));
});

test('canonicalization rejects ambiguous JavaScript values', () => {
  assert.throws(() => planFingerprint({ value: undefined }), CanonicalizationError);
  assert.throws(() => planFingerprint({ value: Number.NaN }), CanonicalizationError);
  assert.throws(() => planFingerprint(new Date()), CanonicalizationError);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => planFingerprint(cyclic), CanonicalizationError);

  const sparse = new Array(2);
  sparse[1] = 'present';
  assert.throws(() => planFingerprint(sparse), CanonicalizationError);

  const symbolKeyed = { visible: true, [Symbol('hidden')]: 'value' };
  assert.throws(() => planFingerprint(symbolKeyed), CanonicalizationError);

  const accessor = Object.defineProperty({}, 'dynamic', { enumerable: true, get: () => 1 });
  assert.throws(() => planFingerprint(accessor), CanonicalizationError);
});

test('legal transitions are immutable and policy-bound', () => {
  const job = { state: 'received', policyVersion: 'policy-v1', history: [] };
  const next = transition(job, 'normalized', {
    actor: 'test',
    reasonCode: 'NORMALIZED',
    inputFingerprint: 'sha256:test',
    policyVersion: 'policy-v1',
    at: '2026-08-01T12:00:00Z'
  });

  assert.equal(next.state, 'normalized');
  assert.equal(next.updatedAt, '2026-08-01T12:00:00.000Z');
  assert.equal(job.state, 'received');
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.history));
  assert.ok(Object.isFrozen(next.history[0]));
});

test('illegal and policy-mismatched transitions fail closed', () => {
  const job = { state: 'received', policyVersion: 'policy-v1', history: [] };
  const metadata = { actor: 'test', reasonCode: 'test', inputFingerprint: 'sha256:test', policyVersion: 'policy-v1' };
  assert.throws(
    () => transition(job, 'dispatched', metadata),
    (error) => error instanceof StateTransitionError && error.code === 'ILLEGAL_STATE_TRANSITION'
  );
  assert.throws(
    () => transition(job, 'normalized', { ...metadata, policyVersion: 'policy-v2' }),
    (error) => error instanceof StateTransitionError && error.code === 'POLICY_VERSION_MISMATCH'
  );
});

test('pre-dispatch exclusions can become skipped while post-attempt blocked is rejected', () => {
  const normalized = { state: 'normalized', policyVersion: 'policy-v1', history: [] };
  const metadata = { actor: 'test', reasonCode: 'POLICY_EXCLUDED', inputFingerprint: 'sha256:test', policyVersion: 'policy-v1' };
  assert.equal(transition(normalized, 'skipped', metadata).state, 'skipped');

  const attempted = { state: 'attempted', policyVersion: 'policy-v1', history: [] };
  assert.throws(
    () => transition(attempted, 'blocked', metadata),
    (error) => error instanceof StateTransitionError && error.code === 'ILLEGAL_STATE_TRANSITION'
  );
});

test('provider confirmation and reconciliation remain separate states', () => {
  const metadata = { actor: 'test', reasonCode: 'CONFIRMED', inputFingerprint: 'sha256:test', policyVersion: 'policy-v1' };
  const attempted = { state: 'attempted', policyVersion: 'policy-v1', history: [] };
  const confirmed = transition(attempted, 'provider_confirmed', metadata);
  const reconciling = transition(confirmed, 'reconciling', { ...metadata, reasonCode: 'RECONCILING' });
  const reconciled = transition(reconciling, 'reconciled', { ...metadata, reasonCode: 'RECONCILED' });

  assert.equal(confirmed.state, 'provider_confirmed');
  assert.equal(reconciling.state, 'reconciling');
  assert.equal(reconciled.state, 'reconciled');
});
