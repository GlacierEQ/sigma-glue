import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderOutcomeRecoveryCoordinator } from '../src/recovery/provider-outcome-recovery.mjs';
import {
  DurableProviderOutcomeRecoveryCoordinator,
  ProviderRecoveryLedgerError,
  SqliteProviderRecoveryLedger
} from '../src/recovery/sqlite-provider-recovery-ledger.mjs';

const TARGET = Object.freeze({
  owner: 'GlacierEQ',
  repo: 'sigma-glue',
  branch: 'provider-canary',
  path: '.sigma-provider-canary/state.json'
});
const DESIRED = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BASELINE = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function uncertainty(overrides = {}) {
  return {
    provider: 'github-contents/v1',
    operation: 'put',
    idempotencyKey: 'idem-durable-recovery-1',
    requestId: 'request-durable-recovery-1',
    envelopeFingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    desiredFingerprint: DESIRED,
    target: TARGET,
    baseline: {
      exists: true,
      contentFingerprint: BASELINE,
      version: 'blob-baseline-1',
      versionSemantics: 'content_addressed'
    },
    ...overrides
  };
}

function classifier(observation) {
  return new ProviderOutcomeRecoveryCoordinator({
    observer: { inspectOutcome: async () => observation },
    clock: () => new Date('2026-08-08T20:30:00.000Z')
  });
}

async function withLedger(run) {
  const root = await mkdtemp(join(tmpdir(), 'sigma-provider-recovery-ledger-'));
  const path = join(root, 'recovery.sqlite');
  let ledger = new SqliteProviderRecoveryLedger(path);
  try {
    return await run({ ledger, path, reopen() {
      ledger.close();
      ledger = new SqliteProviderRecoveryLedger(path);
      return ledger;
    }});
  } finally {
    try { ledger.close(); } catch { /* already closed */ }
    await rm(root, { recursive: true, force: true });
  }
}

test('durable coordinator records confirmed applied evidence and survives restart', async () => {
  await withLedger(async ({ ledger, reopen }) => {
    const durable = new DurableProviderOutcomeRecoveryCoordinator({
      coordinator: classifier({
        target: TARGET,
        exists: true,
        contentFingerprint: DESIRED,
        version: 'blob-desired-1',
        versionSemantics: 'content_addressed',
        providerRequestId: 'REQ-DURABLE-1'
      }),
      ledger,
      clock: () => new Date('2026-08-08T20:30:01.000Z')
    });

    const { recovery, receipt } = await durable.recover({ uncertainty: uncertainty() });
    assert.equal(recovery.state, 'confirmed_applied');
    assert.equal(receipt.state, 'confirmed_applied');
    assert.equal(receipt.replayed, false);
    assert.match(receipt.recordFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.baselineVersionSemantics, 'content_addressed');
    assert.equal(receipt.observationVersionSemantics, 'content_addressed');

    const reopened = reopen();
    const stored = reopened.getByRequestId('request-durable-recovery-1');
    assert.equal(stored.state, 'confirmed_applied');
    assert.equal(stored.retryDisposition, 'do_not_retry_reconcile');
    assert.equal(stored.observationVersion, 'blob-desired-1');
    assert.equal(stored.baselineVersionSemantics, 'content_addressed');
    assert.equal(stored.observationVersionSemantics, 'content_addressed');
    assert.equal(stored.providerRequestId, 'REQ-DURABLE-1');
    assert.equal(stored.recordFingerprint, receipt.recordFingerprint);
  });
});

test('monotonic non-application proof is preserved as durable evidence', async () => {
  await withLedger(async ({ ledger, reopen }) => {
    const monotonicBaseline = {
      exists: true,
      contentFingerprint: BASELINE,
      version: 'revision-17',
      versionSemantics: 'monotonic_revision'
    };
    const recovery = await classifier({
      target: TARGET,
      exists: true,
      contentFingerprint: BASELINE,
      version: 'revision-17',
      versionSemantics: 'monotonic_revision',
      providerRequestId: 'REQ-MONOTONIC-1'
    }).recover({
      uncertainty: uncertainty({
        provider: 'monotonic-provider/v1',
        baseline: monotonicBaseline
      })
    });

    const receipt = ledger.record(recovery);
    assert.equal(receipt.state, 'confirmed_not_applied');
    assert.equal(receipt.retryDisposition, 'requires_new_authorization');
    assert.equal(receipt.baselineVersionSemantics, 'monotonic_revision');
    assert.equal(receipt.observationVersionSemantics, 'monotonic_revision');

    const reopened = reopen();
    assert.equal(reopened.getByRequestId('request-durable-recovery-1').state, 'confirmed_not_applied');
  });
});

test('identical recovery evidence is idempotent', async () => {
  await withLedger(async ({ ledger }) => {
    const recovery = await classifier({
      target: TARGET,
      exists: true,
      contentFingerprint: DESIRED,
      version: 'blob-desired-1',
      versionSemantics: 'content_addressed'
    }).recover({ uncertainty: uncertainty() });

    const first = ledger.record(recovery, { now: new Date('2026-08-08T20:30:01.000Z') });
    const second = ledger.record(recovery, { now: new Date('2026-08-08T20:31:01.000Z') });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.recordFingerprint, first.recordFingerprint);
    assert.equal(second.recordedAt, first.recordedAt);
  });
});

test('changed evidence for the same request fails closed', async () => {
  await withLedger(async ({ ledger }) => {
    const applied = await classifier({
      target: TARGET,
      exists: true,
      contentFingerprint: DESIRED,
      version: 'blob-desired-1',
      versionSemantics: 'content_addressed'
    }).recover({ uncertainty: uncertainty() });
    ledger.record(applied);

    const diverged = await classifier({
      target: TARGET,
      exists: true,
      contentFingerprint: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      version: 'blob-third-party-1',
      versionSemantics: 'content_addressed'
    }).recover({ uncertainty: uncertainty() });

    assert.throws(
      () => ledger.record(diverged),
      (error) => error instanceof ProviderRecoveryLedgerError &&
        error.code === 'PROVIDER_RECOVERY_EVIDENCE_CONFLICT'
    );
  });
});

test('two independent ledger connections converge on one exact recovery record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-provider-recovery-concurrency-'));
  const path = join(root, 'recovery.sqlite');
  const first = new SqliteProviderRecoveryLedger(path);
  const second = new SqliteProviderRecoveryLedger(path);
  try {
    const recovery = await classifier({
      target: TARGET,
      exists: true,
      contentFingerprint: DESIRED,
      version: 'blob-desired-1',
      versionSemantics: 'content_addressed'
    }).recover({ uncertainty: uncertainty() });
    const one = first.record(recovery);
    const two = second.record(recovery);
    assert.equal(one.replayed, false);
    assert.equal(two.replayed, true);
    assert.equal(one.recordFingerprint, two.recordFingerprint);
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('ledger stores fingerprints and identities rather than desired content bytes', async () => {
  await withLedger(async ({ ledger }) => {
    const recovery = await classifier({
      target: TARGET,
      exists: false,
      contentFingerprint: null,
      version: null,
      versionSemantics: 'unknown'
    }).recover({
      uncertainty: uncertainty({
        baseline: {
          exists: false,
          contentFingerprint: null,
          version: null,
          versionSemantics: 'unknown'
        }
      })
    });
    const receipt = ledger.record(recovery);
    assert.equal(receipt.state, 'still_unknown');
    assert.equal(receipt.reasonCode, 'ABSENCE_HISTORY_UNPROVEN');
    assert.equal(Object.hasOwn(receipt, 'desiredContent'), false);
    assert.equal(Object.hasOwn(receipt, 'path'), false);
    assert.match(receipt.targetFingerprint, /^sha256:[0-9a-f]{64}$/);
  });
});
