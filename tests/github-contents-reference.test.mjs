import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  GitHubContentsColossusTransport,
  GitHubContentsProviderObserver,
  GitHubContentsProviderUncertainError,
  githubContentFingerprint
} from '../examples/colossus/github-contents-reference.mjs';
import { githubContentsPayload } from '../examples/colossus/github-contents-payload.mjs';
import { ProviderOutcomeRecoveryCoordinator } from '../src/recovery/provider-outcome-recovery.mjs';
import { planFingerprint } from '../src/plan/fingerprint.mjs';

const TARGET = Object.freeze({
  owner: 'GlacierEQ',
  repo: 'sigma-glue',
  branch: 'provider-canary',
  path: '.sigma-provider-canary/state.json'
});
const NOW = new Date('2026-08-08T20:15:00.000Z');

function envelope(payload, overrides = {}) {
  const core = {
    protocolVersion: 'sigma-federation/v1',
    schemaVersion: 'colossus-dispatch/v1',
    requestId: 'request-github-provider-1',
    traceId: 'trace-github-provider-1',
    jobId: 'job-github-provider-1',
    componentRef: 'github-contents@v1',
    resolvedAdapterId: 'github-contents-reference',
    method: 'execute',
    capability: 'github.contents.put',
    idempotencyKey: 'idem-github-provider-1',
    planFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    policyVersion: 'policy-v1',
    scopedHandles: [],
    payload,
    authorization: {
      permitId: 'permit-github-provider-1',
      permitFingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expiresAt: '2026-08-08T20:30:00.000Z'
    },
    createdAt: NOW.toISOString(),
    ...overrides
  };
  return Object.freeze({ ...core, envelopeFingerprint: planFingerprint(core) });
}

function stateRecord(content = null) {
  return {
    content,
    sha: content === null ? null : blobSha(content),
    writes: 0,
    reads: 0,
    requestSequence: 0
  };
}

function blobSha(content) {
  return `blob-${createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 20)}`;
}

function fakeBroker(state, { loseNextPutResponse = false } = {}) {
  let lose = loseNextPutResponse;
  return {
    supportsOpaqueHandles: true,
    async authorizedFetch({ request }) {
      state.requestSequence += 1;
      const headers = { 'content-type': 'application/json', 'x-github-request-id': `REQ-${state.requestSequence}` };
      if (request.method === 'GET') {
        state.reads += 1;
        if (state.content === null) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers });
        return new Response(JSON.stringify({
          type: 'file',
          sha: state.sha,
          encoding: 'base64',
          content: Buffer.from(state.content, 'utf8').toString('base64')
        }), { status: 200, headers });
      }
      if (request.method !== 'PUT') throw new Error(`unexpected method ${request.method}`);
      const body = JSON.parse(request.body);
      const expectedSha = body.sha ?? null;
      if ((state.sha ?? null) !== expectedSha) {
        return new Response(JSON.stringify({ message: 'sha does not match' }), { status: 409, headers });
      }
      const desired = Buffer.from(body.content, 'base64').toString('utf8');
      state.content = desired;
      state.sha = blobSha(desired);
      state.writes += 1;
      if (lose) {
        lose = false;
        throw new Error('simulated lost provider response after commit');
      }
      return new Response(JSON.stringify({
        content: { sha: state.sha },
        commit: { sha: `commit-${state.writes}` }
      }), { status: 200, headers });
    }
  };
}

function baselineFor(state) {
  return state.content === null
    ? { exists: false, contentFingerprint: null, version: null }
    : { exists: true, contentFingerprint: githubContentFingerprint(state.content), version: state.sha };
}

test('conditional write mutates once and an identical replay performs no second PUT', async () => {
  const state = stateRecord('before');
  const broker = fakeBroker(state);
  const transport = new GitHubContentsColossusTransport({
    credentialBroker: broker,
    credentialHandle: 'credh_testgithub1',
    clock: () => NOW
  });
  const intent = githubContentsPayload({
    target: TARGET,
    desiredContent: 'after',
    baseline: baselineFor(state),
    commitMessage: 'provider canary update'
  });
  const first = await transport.dispatch(envelope(intent), { signal: new AbortController().signal });
  const second = await transport.dispatch(envelope(intent), { signal: new AbortController().signal });

  assert.equal(first.status, 'dispatched');
  assert.equal(second.status, 'dispatched');
  assert.equal(state.content, 'after');
  assert.equal(state.writes, 1);
  assert.deepEqual(second.redactedDiagnostics, ['github-contents-idempotent-replay']);
});

test('changed provider baseline blocks before mutation', async () => {
  const state = stateRecord('actual-third-party-state');
  const broker = fakeBroker(state);
  const transport = new GitHubContentsColossusTransport({
    credentialBroker: broker,
    credentialHandle: 'credh_testgithub2',
    clock: () => NOW
  });
  const staleBaseline = {
    exists: true,
    contentFingerprint: githubContentFingerprint('old-state'),
    version: 'blob-old'
  };
  const result = await transport.dispatch(envelope(githubContentsPayload({
    target: TARGET,
    desiredContent: 'desired',
    baseline: staleBaseline,
    commitMessage: 'must not overwrite'
  })), { signal: new AbortController().signal });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'PROVIDER_CONDITIONAL_WRITE_CONFLICT');
  assert.equal(state.writes, 0);
  assert.equal(state.content, 'actual-third-party-state');
});

test('lost mutation response becomes recoverable confirmed_applied evidence', async () => {
  const state = stateRecord('before');
  const broker = fakeBroker(state, { loseNextPutResponse: true });
  const intent = githubContentsPayload({
    target: TARGET,
    desiredContent: 'after-lost-response',
    baseline: baselineFor(state),
    commitMessage: 'ambiguous provider mutation'
  });
  const requestEnvelope = envelope(intent, {
    requestId: 'request-github-provider-lost-1',
    idempotencyKey: 'idem-github-provider-lost-1'
  });
  const transport = new GitHubContentsColossusTransport({
    credentialBroker: broker,
    credentialHandle: 'credh_testgithub3',
    clock: () => NOW
  });

  let uncertainty;
  await assert.rejects(
    transport.dispatch(requestEnvelope, { signal: new AbortController().signal }),
    (error) => {
      assert.ok(error instanceof GitHubContentsProviderUncertainError);
      uncertainty = error.uncertainty;
      return true;
    }
  );
  assert.equal(state.writes, 1);
  assert.equal(state.content, 'after-lost-response');

  const observer = new GitHubContentsProviderObserver({
    credentialBroker: broker,
    credentialHandle: 'credh_testgithub3'
  });
  const recovery = await new ProviderOutcomeRecoveryCoordinator({
    observer,
    clock: () => new Date('2026-08-08T20:15:05.000Z')
  }).recover({ uncertainty });

  assert.equal(recovery.state, 'confirmed_applied');
  assert.equal(recovery.retryDisposition, 'do_not_retry_reconcile');
  assert.equal(state.writes, 1);
});

test('observation of unchanged baseline requires a new authorization rather than automatic retry', async () => {
  const state = stateRecord('before');
  const broker = fakeBroker(state);
  const intent = githubContentsPayload({
    target: TARGET,
    desiredContent: 'never-written',
    baseline: baselineFor(state),
    commitMessage: 'not executed'
  });
  const uncertainty = {
    provider: 'github-contents/v1',
    operation: 'put',
    idempotencyKey: 'idem-not-applied',
    requestId: 'request-not-applied',
    envelopeFingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    desiredFingerprint: intent.desired.fingerprint,
    target: TARGET,
    baseline: intent.baseline
  };
  const observer = new GitHubContentsProviderObserver({
    credentialBroker: broker,
    credentialHandle: 'credh_testgithub4'
  });
  const recovery = await new ProviderOutcomeRecoveryCoordinator({
    observer,
    clock: () => NOW
  }).recover({ uncertainty });

  assert.equal(recovery.state, 'confirmed_not_applied');
  assert.equal(recovery.retryDisposition, 'requires_new_authorization');
  assert.equal(state.writes, 0);
});

test('desired fingerprint exactly binds desired bytes', () => {
  const valid = githubContentsPayload({
    target: TARGET,
    desiredContent: 'desired',
    baseline: { exists: false, contentFingerprint: null, version: null },
    commitMessage: 'valid'
  });
  assert.equal(valid.desired.fingerprint, githubContentFingerprint('desired'));
});
