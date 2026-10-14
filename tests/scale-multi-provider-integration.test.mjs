import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProviderOutcomeRecoveryCoordinator,
  ProviderOutcomeRecoveryError
} from '../src/recovery/provider-outcome-recovery.mjs';
import {
  makeToolCallRecord,
  toolCallRecordFingerprint
} from '../src/integration/tool-call-record.mjs';

const BASELINE = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DESIRED = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ENVELOPE = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const targets = [
  {
    name: 'github',
    target: {
      owner: 'GlacierEQ',
      repo: 'sigma-glue',
      branch: 'provider-canary',
      path: '.sigma-provider-canary/state.json'
    }
  },
  {
    name: 'database',
    target: {
      kind: 'database',
      engine: 'postgres',
      project: 'scale-proof',
      resource: 'public.missions',
      primaryKey: { id: 'mission-1' }
    }
  },
  {
    name: 'filesystem',
    target: {
      kind: 'filesystem',
      root: 'mission-sandbox',
      path: 'receipts/result.json'
    }
  },
  {
    name: 'external-api',
    target: {
      kind: 'external_api',
      service: 'example-status',
      resource: '/v1/jobs/job-1'
    }
  },
  {
    name: 'deployment',
    target: {
      kind: 'deployment',
      provider: 'vercel',
      project: 'scale-fde-demo',
      environment: 'preview'
    }
  }
];

function uncertainty(target, provider) {
  return {
    provider,
    operation: 'put',
    idempotencyKey: `idem-${provider}`,
    requestId: `request-${provider}`,
    envelopeFingerprint: ENVELOPE,
    desiredFingerprint: DESIRED,
    target,
    baseline: {
      exists: true,
      contentFingerprint: BASELINE,
      version: 'revision-41',
      versionSemantics: 'monotonic_revision'
    }
  };
}

test('provider recovery preserves exact target identities across five independent tool classes', async () => {
  for (const fixture of targets) {
    const coordinator = new ProviderOutcomeRecoveryCoordinator({
      observer: {
        inspectOutcome: async ({ uncertainty: normalized }) => ({
          target: normalized.target,
          exists: true,
          contentFingerprint: BASELINE,
          version: 'revision-41',
          versionSemantics: 'monotonic_revision'
        })
      },
      clock: () => new Date('2026-10-04T20:00:00.000Z')
    });

    const result = await coordinator.recover({
      uncertainty: uncertainty(fixture.target, `${fixture.name}/v1`)
    });

    assert.equal(result.state, 'confirmed_not_applied', fixture.name);
    assert.equal(result.retryDisposition, 'requires_new_authorization', fixture.name);
    assert.deepEqual(result.uncertainty.target, fixture.target, fixture.name);
    assert.deepEqual(result.observation.target, fixture.target, fixture.name);
  }
});

test('provider recovery rejects credential-shaped data in provider-neutral target identities', async () => {
  const coordinator = new ProviderOutcomeRecoveryCoordinator({
    observer: { inspectOutcome: async () => { throw new Error('must not run'); } }
  });

  await assert.rejects(
    () => coordinator.recover({
      uncertainty: uncertainty({
        kind: 'external_api',
        service: 'example-status',
        resource: '/v1/jobs/job-1',
        authorization: 'Bearer should-never-be-persisted'
      }, 'external-api/v1')
    }),
    (error) => error instanceof ProviderOutcomeRecoveryError &&
      error.code === 'PROVIDER_TARGET_SECRET_FORBIDDEN'
  );
});

test('tool call records expose the mandatory Scale fields without retaining raw inputs', () => {
  const input = {
    componentRef: 'github-contents@v1',
    method: 'execute',
    capability: 'contents:write',
    payload: { path: '.sigma-provider-canary/state.json', desired: 'v2' }
  };
  const record = makeToolCallRecord({
    toolSelected: 'github-contents@v1',
    reason: 'registry exact component/method/capability match',
    input,
    attempt: 1,
    result: { status: 'provider_confirmed', reasonCode: null },
    verification: {
      state: 'verified',
      readbackFingerprint: DESIRED
    }
  });

  assert.deepEqual(Object.keys(record), [
    'tool_selected',
    'reason',
    'input_fingerprint',
    'attempt',
    'result',
    'verification'
  ]);
  assert.match(record.input_fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(record.tool_selected, 'github-contents@v1');
  assert.equal(record.attempt, 1);
  assert.equal(JSON.stringify(record).includes('.sigma-provider-canary/state.json'), false);
  assert.match(toolCallRecordFingerprint(record), /^sha256:[0-9a-f]{64}$/);
});

test('tool call records reject secret-shaped result or verification evidence', () => {
  assert.throws(
    () => makeToolCallRecord({
      toolSelected: 'database@v1',
      reason: 'exact registry route',
      input: { table: 'missions', id: 'mission-1' },
      attempt: 1,
      result: { status: 'provider_confirmed', access_token: 'forbidden' },
      verification: { state: 'verified' }
    }),
    /secret-shaped/i
  );
});
