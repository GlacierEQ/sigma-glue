import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProviderOutcomeRecoveryCoordinator,
  ProviderOutcomeRecoveryError,
  providerRecoveryFingerprint
} from '../src/recovery/provider-outcome-recovery.mjs';
import { planFingerprint } from '../src/plan/fingerprint.mjs';

const TARGET = Object.freeze({
  owner: 'GlacierEQ',
  repo: 'sigma-glue',
  branch: 'provider-canary',
  path: '.sigma-provider-canary/state.json'
});
const BASELINE = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DESIRED = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function uncertainty(overrides = {}) {
  return {
    provider: 'github-contents/v1',
    operation: 'put',
    idempotencyKey: 'idem-provider-recovery-1',
    requestId: 'request-provider-recovery-1',
    envelopeFingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    desiredFingerprint: DESIRED,
    target: TARGET,
    baseline: {
      exists: true,
      contentFingerprint: BASELINE,
      version: 'blob-baseline-1'
    },
    ...overrides
  };
}

function coordinator(observation) {
  return new ProviderOutcomeRecoveryCoordinator({
    observer: { inspectOutcome: async () => observation },
    clock: () => new Date('2026-08-08T20:00:00.000Z')
  });
}

test('desired provider fingerprint proves applied and forbids replay', async () => {
  const result = await coordinator({
    target: TARGET,
    exists: true,
    contentFingerprint: DESIRED,
    version: 'blob-desired-1',
    providerRequestId: 'req-provider-1'
  }).recover({ uncertainty: uncertainty() });

  assert.equal(result.state, 'confirmed_applied');
  assert.equal(result.retryDisposition, 'do_not_retry_reconcile');
  assert.equal(result.reasonCode, 'DESIRED_FINGERPRINT_OBSERVED');
  assert.match(providerRecoveryFingerprint(result), /^sha256:[0-9a-f]{64}$/);
});

test('exact baseline proves not applied but requires new authorization', async () => {
  const result = await coordinator({
    target: TARGET,
    exists: true,
    contentFingerprint: BASELINE,
    version: 'blob-baseline-1',
    providerRequestId: 'req-provider-2'
  }).recover({ uncertainty: uncertainty() });

  assert.equal(result.state, 'confirmed_not_applied');
  assert.equal(result.retryDisposition, 'requires_new_authorization');
  assert.equal(result.reasonCode, 'BASELINE_FINGERPRINT_OBSERVED');
});

test('missing target proves not applied when the approved baseline was missing', async () => {
  const result = await coordinator({
    target: TARGET,
    exists: false,
    contentFingerprint: null,
    version: null
  }).recover({
    uncertainty: uncertainty({
      baseline: { exists: false, contentFingerprint: null, version: null }
    })
  });

  assert.equal(result.state, 'confirmed_not_applied');
  assert.equal(result.retryDisposition, 'requires_new_authorization');
});

test('diverged provider state freezes recovery and forbids replay', async () => {
  const result = await coordinator({
    target: TARGET,
    exists: true,
    contentFingerprint: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    version: 'blob-third-party-1'
  }).recover({ uncertainty: uncertainty() });

  assert.equal(result.state, 'still_unknown');
  assert.equal(result.retryDisposition, 'forbidden_until_resolved');
  assert.equal(result.reasonCode, 'PROVIDER_STATE_DIVERGED');
});

test('observer failure becomes still_unknown without leaking the cause into evidence', async () => {
  const result = await new ProviderOutcomeRecoveryCoordinator({
    observer: {
      inspectOutcome: async () => {
        throw new Error('private broker details');
      }
    },
    clock: () => new Date('2026-08-08T20:00:00.000Z')
  }).recover({ uncertainty: uncertainty() });

  assert.equal(result.state, 'still_unknown');
  assert.equal(result.reasonCode, 'PROVIDER_OBSERVATION_FAILED');
  assert.equal(result.retryDisposition, 'forbidden_until_resolved');
  assert.equal(Object.keys(result).includes('cause'), false);
  assert.equal(result.cause.message, 'private broker details');
  assert.doesNotMatch(JSON.stringify(result), /private broker details/);
});

test('cross-target observation is rejected rather than misclassified', async () => {
  await assert.rejects(
    coordinator({
      target: { ...TARGET, path: '.sigma-provider-canary/other.json' },
      exists: true,
      contentFingerprint: DESIRED,
      version: 'blob-other-1'
    }).recover({ uncertainty: uncertainty() }),
    (error) => error instanceof ProviderOutcomeRecoveryError &&
      error.code === 'PROVIDER_OBSERVATION_TARGET_MISMATCH'
  );
});

test('recovery fingerprints are canonical and stable', async () => {
  const result = await coordinator({
    target: TARGET,
    exists: true,
    contentFingerprint: DESIRED,
    version: 'blob-desired-1'
  }).recover({ uncertainty: uncertainty() });

  assert.equal(providerRecoveryFingerprint(result), planFingerprint({
    state: result.state,
    reasonCode: result.reasonCode,
    retryDisposition: result.retryDisposition,
    uncertainty: result.uncertainty,
    observation: result.observation
  }));
});
