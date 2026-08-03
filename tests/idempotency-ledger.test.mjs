import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableIdempotencyLedger } from '../src/persistence/idempotency-ledger.mjs';

function plan(overrides = {}) {
  return {
    idempotencyKey: 'idem-ledger-1', planFingerprint: 'sha256:plan-1',
    provider: { stableId: 'provider-1' }, operation: 'move', ...overrides
  };
}

test('claims are restart-readable and mismatched reuse fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-ledger-'));
  try {
    const ledger = new DurableIdempotencyLedger(root);
    const first = await ledger.claim(plan(), '2026-08-02T00:00:00.000Z');
    assert.equal(first.reused, false);
    const restarted = new DurableIdempotencyLedger(root);
    const second = await restarted.claim(plan(), '2026-08-02T00:01:00.000Z');
    assert.equal(second.reused, true);
    await assert.rejects(
      () => restarted.claim(plan({ planFingerprint: 'sha256:other' })),
      (error) => error.code === 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completion stores only bound evidence summaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-ledger-'));
  try {
    const ledger = new DurableIdempotencyLedger(root);
    const subject = plan();
    await ledger.claim(subject);
    const completed = await ledger.complete(subject, {
      receipt: { status: 'provider_confirmed', provider: 'provider-1', operation: 'move', planFingerprint: subject.planFingerprint, idempotencyKey: subject.idempotencyKey, source: 'private/path.txt' },
      reconciliation: { status: 'reconciled', provider: 'provider-1', operation: 'move', planFingerprint: subject.planFingerprint, idempotencyKey: subject.idempotencyKey },
      now: '2026-08-02T00:02:00.000Z'
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.receipt.source, undefined);
    const raw = await readFile(join(root, 'idem-ledger-1.json'), 'utf8');
    assert.equal(raw.includes('private/path.txt'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
