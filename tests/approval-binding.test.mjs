import test from 'node:test';
import assert from 'node:assert/strict';
import { planFingerprint } from '../src/plan/fingerprint.mjs';
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

test('binds approval to the exact plan and execution subject', () => {
  assert.deepEqual(
    assertApprovalBinding({ approval, expected, now: new Date('2026-08-01T12:00:00Z') }),
    {
      approvalId: 'approval-1',
      planFingerprint: expected.planFingerprint,
      policyVersion: 'policy-v1',
      expiresAt: '2026-08-01T13:00:00.000Z',
      bound: true
    }
  );
});

test('rejects a changed plan even when the approval id is reused', () => {
  const changed = { ...expected, planFingerprint: planFingerprint({ ...plan, items: [] }) };
  assert.throws(
    () => assertApprovalBinding({ approval, expected: changed, now: new Date('2026-08-01T12:00:00Z') }),
    (error) => error instanceof ApprovalBindingError && error.code === 'APPROVAL_SUBJECT_MISMATCH'
  );
});

test('rejects an expired approval', () => {
  assert.throws(
    () => assertApprovalBinding({ approval, expected, now: new Date('2026-08-01T14:00:00Z') }),
    (error) => error instanceof ApprovalBindingError && error.code === 'APPROVAL_EXPIRED'
  );
});

test('canonical fingerprints are independent of object key order', () => {
  assert.equal(planFingerprint({ a: 1, b: { x: true, y: 2 } }), planFingerprint({ b: { y: 2, x: true }, a: 1 }));
});

test('fingerprints reject ambiguous non-plain objects', () => {
  assert.throws(() => planFingerprint(new Date('2026-08-01T00:00:00Z')), /non-plain object/);
  assert.throws(() => planFingerprint(new Map([['a', 1]])), /non-plain object/);
});

test('illegal state transitions fail closed', () => {
  const job = { state: 'received', history: [] };
  assert.throws(
    () => transition(job, 'dispatched', { actor: 'test', reasonCode: 'test', inputFingerprint: 'sha256:test', policyVersion: 'policy-v1' }),
    (error) => error instanceof StateTransitionError && error.code === 'ILLEGAL_STATE_TRANSITION'
  );
});
