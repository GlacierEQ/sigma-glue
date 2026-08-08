import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GitHubContentsColossusTransport,
  GitHubContentsProviderError,
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
const BEFORE = 'before';
const AFTER = 'after';
const BASELINE = Object.freeze({
  exists: true,
  contentFingerprint: githubContentFingerprint(BEFORE),
  version: 'blob-before'
});

function envelope(payload) {
  const core = {
    protocolVersion: 'sigma-federation/v1',
    schemaVersion: 'colossus-dispatch/v1',
    requestId: 'request-hardening-1',
    traceId: 'trace-hardening-1',
    jobId: 'job-hardening-1',
    componentRef: 'github-contents@v1',
    resolvedAdapterId: 'github-contents-reference',
    method: 'execute',
    capability: 'github.contents.put',
    idempotencyKey: 'idem-hardening-1',
    planFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    policyVersion: 'policy-v1',
    scopedHandles: [],
    payload,
    authorization: {
      permitId: 'permit-hardening-1',
      permitFingerprint: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expiresAt: '2026-08-08T22:00:00.000Z'
    },
    createdAt: '2026-08-08T21:30:00.000Z'
  };
  return Object.freeze({ ...core, envelopeFingerprint: planFingerprint(core) });
}

function fileResponse(content = BEFORE, sha = 'blob-before') {
  return new Response(JSON.stringify({
    type: 'file',
    sha,
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64')
  }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-github-request-id': 'REQ-FILE' }
  });
}

function broker(handler) {
  return {
    supportsOpaqueHandles: true,
    authorizedFetch: handler
  };
}

test('malformed 2xx PUT success remains an ambiguous recoverable outcome', async () => {
  let calls = 0;
  const transport = new GitHubContentsColossusTransport({
    credentialBroker: broker(async ({ request }) => {
      calls += 1;
      if (request.method === 'GET') return fileResponse();
      return new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'x-github-request-id': 'REQ-PUT' }
      });
    }),
    credentialHandle: 'credh_hardening1',
    clock: () => new Date('2026-08-08T21:30:00.000Z')
  });
  const payload = githubContentsPayload({
    target: TARGET,
    desiredContent: AFTER,
    baseline: BASELINE,
    commitMessage: 'malformed success attack'
  });

  await assert.rejects(
    transport.dispatch(envelope(payload), { signal: new AbortController().signal }),
    (error) => error instanceof GitHubContentsProviderUncertainError &&
      error.uncertainty.desiredFingerprint === payload.desired.fingerprint
  );
  assert.equal(calls, 2);
});

test('5xx after mutation submission is ambiguous rather than a false failure', async () => {
  const transport = new GitHubContentsColossusTransport({
    credentialBroker: broker(async ({ request }) => request.method === 'GET'
      ? fileResponse()
      : new Response(JSON.stringify({ message: 'server error' }), {
          status: 502,
          headers: { 'content-type': 'application/json' }
        })),
    credentialHandle: 'credh_hardening2'
  });
  const payload = githubContentsPayload({
    target: TARGET,
    desiredContent: AFTER,
    baseline: BASELINE,
    commitMessage: '5xx ambiguity attack'
  });
  await assert.rejects(
    transport.dispatch(envelope(payload), { signal: new AbortController().signal }),
    (error) => error instanceof GitHubContentsProviderUncertainError
  );
});

test('file 404 is absence only after repository and branch are independently resolved', async () => {
  const seen = [];
  const observer = new GitHubContentsProviderObserver({
    credentialBroker: broker(async ({ url }) => {
      const parsed = new URL(url);
      seen.push(parsed.pathname);
      if (parsed.pathname.includes('/contents/')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (parsed.pathname.endsWith('/git/ref/heads/provider-canary')) {
        return new Response(JSON.stringify({ ref: 'refs/heads/provider-canary' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ full_name: 'GlacierEQ/sigma-glue' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }),
    credentialHandle: 'credh_hardening3'
  });

  const observed = await observer.inspectOutcome({ uncertainty: { target: TARGET } });
  assert.equal(observed.exists, false);
  assert.equal(seen.length, 3);
});

test('repository-hidden 404 cannot become confirmed_not_applied evidence', async () => {
  const hiddenBroker = broker(async ({ url }) => {
    const parsed = new URL(url);
    return new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  });
  const observer = new GitHubContentsProviderObserver({
    credentialBroker: hiddenBroker,
    credentialHandle: 'credh_hardening4'
  });
  await assert.rejects(
    observer.inspectOutcome({ uncertainty: { target: TARGET } }),
    (error) => error instanceof GitHubContentsProviderError &&
      error.code === 'GITHUB_CONTENTS_TARGET_UNRESOLVED'
  );

  const recovery = await new ProviderOutcomeRecoveryCoordinator({ observer }).recover({
    uncertainty: {
      provider: 'github-contents/v1',
      operation: 'put',
      idempotencyKey: 'idem-hidden-1',
      requestId: 'request-hidden-1',
      envelopeFingerprint: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      desiredFingerprint: githubContentFingerprint(AFTER),
      target: TARGET,
      baseline: { exists: false, contentFingerprint: null, version: null }
    }
  });
  assert.equal(recovery.state, 'still_unknown');
  assert.equal(recovery.retryDisposition, 'forbidden_until_resolved');
});

test('recovery observer timeout freezes the operation even if observer ignores abort', async () => {
  let signal;
  const recovery = await new ProviderOutcomeRecoveryCoordinator({
    observer: {
      inspectOutcome: async ({ signal: suppliedSignal }) => {
        signal = suppliedSignal;
        return await new Promise(() => {});
      }
    },
    observationTimeoutMs: 15,
    clock: () => new Date('2026-08-08T21:30:00.000Z')
  }).recover({
    uncertainty: {
      provider: 'github-contents/v1',
      operation: 'put',
      idempotencyKey: 'idem-timeout-1',
      requestId: 'request-timeout-1',
      envelopeFingerprint: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      desiredFingerprint: githubContentFingerprint(AFTER),
      target: TARGET,
      baseline: BASELINE
    }
  });
  assert.equal(signal.aborted, true);
  assert.equal(recovery.state, 'still_unknown');
  assert.equal(recovery.reasonCode, 'PROVIDER_OBSERVATION_TIMEOUT');
  assert.equal(recovery.retryDisposition, 'forbidden_until_resolved');
});

test('valid state..json path is accepted consistently while traversal segments are rejected', async () => {
  const target = { ...TARGET, path: '.sigma-provider-canary/state..json' };
  const desired = githubContentFingerprint(AFTER);
  const recovery = await new ProviderOutcomeRecoveryCoordinator({
    observer: {
      inspectOutcome: async () => ({
        target,
        exists: true,
        contentFingerprint: desired,
        version: 'blob-state-dotdot-name'
      })
    }
  }).recover({
    uncertainty: {
      provider: 'github-contents/v1',
      operation: 'put',
      idempotencyKey: 'idem-state-dotdot-1',
      requestId: 'request-state-dotdot-1',
      envelopeFingerprint: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      desiredFingerprint: desired,
      target,
      baseline: BASELINE
    }
  });
  assert.equal(recovery.state, 'confirmed_applied');

  assert.throws(
    () => githubContentsPayload({
      target: { ...TARGET, path: 'a//b' },
      desiredContent: AFTER,
      baseline: BASELINE,
      commitMessage: 'reject empty segment'
    }),
    /target path is unsafe/
  );
  assert.throws(
    () => githubContentsPayload({
      target: { ...TARGET, path: 'a/../b' },
      desiredContent: AFTER,
      baseline: BASELINE,
      commitMessage: 'reject parent traversal'
    }),
    /target path is unsafe/
  );
});

test('API bases with path prefixes are rejected instead of silently truncated', () => {
  assert.throws(
    () => new GitHubContentsProviderObserver({
      credentialBroker: broker(async () => fileResponse()),
      credentialHandle: 'credh_hardening5',
      apiBase: 'https://ghe.example.com/api/v3'
    }),
    (error) => error instanceof GitHubContentsProviderError &&
      error.code === 'GITHUB_CONTENTS_API_BASE_INVALID'
  );
});
