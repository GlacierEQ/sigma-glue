import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GitHubContentsProviderObserver,
  githubContentFingerprint
} from '../examples/colossus/github-contents-reference.mjs';

const TARGET = Object.freeze({
  owner: 'GlacierEQ',
  repo: 'sigma-glue',
  branch: 'provider-canary',
  path: '.sigma-provider-canary/state.json'
});

function fileResponse(content, sha) {
  return new Response(JSON.stringify({
    type: 'file',
    sha,
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64')
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('target observation tolerates a stale first GET and converges on desired state', async () => {
  const desired = 'desired';
  const expectedFingerprint = githubContentFingerprint(desired);
  const methods = [];
  let reads = 0;
  const observer = new GitHubContentsProviderObserver({
    credentialBroker: {
      supportsOpaqueHandles: true,
      async authorizedFetch({ request }) {
        methods.push(request.method);
        reads += 1;
        return reads === 1
          ? fileResponse('stale', 'blob-stale')
          : fileResponse(desired, 'blob-desired');
      }
    },
    credentialHandle: 'credh_converge1',
    consistencyAttempts: 3,
    consistencyDelayMs: 0
  });

  const observed = await observer.inspectTarget({ target: TARGET, expectedFingerprint });
  assert.equal(observed.contentFingerprint, expectedFingerprint);
  assert.equal(observed.version, 'blob-desired');
  assert.equal(observed.versionSemantics, 'content_addressed');
  assert.equal(reads, 2);
  assert.deepEqual(new Set(methods), new Set(['GET']));
});

test('recovery observation uses desired fingerprint as its convergence target', async () => {
  const desired = 'desired-recovery';
  const expectedFingerprint = githubContentFingerprint(desired);
  let reads = 0;
  const observer = new GitHubContentsProviderObserver({
    credentialBroker: {
      supportsOpaqueHandles: true,
      async authorizedFetch() {
        reads += 1;
        return reads < 3
          ? fileResponse('old', 'blob-old')
          : fileResponse(desired, 'blob-desired-recovery');
      }
    },
    credentialHandle: 'credh_converge2',
    consistencyAttempts: 4,
    consistencyDelayMs: 0
  });

  const observed = await observer.inspectOutcome({
    uncertainty: {
      provider: 'github-contents/v1',
      operation: 'put',
      desiredFingerprint: expectedFingerprint,
      target: TARGET
    }
  });
  assert.equal(observed.contentFingerprint, expectedFingerprint);
  assert.equal(reads, 3);
});

test('exhausted observation budget returns the latest real mismatch without manufacturing success', async () => {
  let reads = 0;
  const observer = new GitHubContentsProviderObserver({
    credentialBroker: {
      supportsOpaqueHandles: true,
      async authorizedFetch() {
        reads += 1;
        return fileResponse(`state-${reads}`, `blob-${reads}`);
      }
    },
    credentialHandle: 'credh_converge3',
    consistencyAttempts: 3,
    consistencyDelayMs: 0
  });

  const expectedFingerprint = githubContentFingerprint('never-observed');
  const observed = await observer.inspectTarget({ target: TARGET, expectedFingerprint });
  assert.notEqual(observed.contentFingerprint, expectedFingerprint);
  assert.equal(observed.version, 'blob-3');
  assert.equal(reads, 3);
});

test('invalid convergence configuration fails before broker I/O', () => {
  let calls = 0;
  assert.throws(
    () => new GitHubContentsProviderObserver({
      credentialBroker: {
        supportsOpaqueHandles: true,
        async authorizedFetch() {
          calls += 1;
          return fileResponse('unused', 'blob-unused');
        }
      },
      credentialHandle: 'credh_converge4',
      consistencyAttempts: 0
    }),
    /consistencyAttempts/
  );
  assert.equal(calls, 0);
});
