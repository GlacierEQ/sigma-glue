import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GatekeeperTrustStore,
  signGatekeeperApproval
} from '../src/approval/gatekeeper-signatures.mjs';
import { ColossusDispatchAdapter } from '../src/dispatch/colossus-dispatch-adapter.mjs';
import { FencedSqliteClaimLedger } from '../src/ledger/fenced-sqlite-claim-ledger.mjs';
import { planFingerprint } from '../src/plan/fingerprint.mjs';
import { ProviderOutcomeRecoveryCoordinator } from '../src/recovery/provider-outcome-recovery.mjs';
import {
  DurableProviderOutcomeRecoveryCoordinator,
  SqliteProviderRecoveryLedger
} from '../src/recovery/sqlite-provider-recovery-ledger.mjs';
import {
  GitHubContentsColossusTransport,
  GitHubContentsProviderObserver
} from '../examples/colossus/github-contents-reference.mjs';
import { githubContentsPayload } from '../examples/colossus/github-contents-payload.mjs';

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const candidateSha = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID ?? 'local';
if (!token || !repository || !candidateSha) {
  throw new Error('GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_SHA are required');
}

const [owner, repo] = repository.split('/');
if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is invalid');

const target = Object.freeze({
  owner,
  repo,
  branch: 'provider-canary',
  path: '.sigma-provider-canary/state.json'
});
const credentialHandle = 'credh_githubactions';
const broker = liveBroker(token);
const observer = new GitHubContentsProviderObserver({
  credentialBroker: broker,
  credentialHandle
});
const root = await mkdtemp(join(tmpdir(), 'sigma-live-provider-'));
const recoveryLedgerPath = join(root, 'provider-recovery.sqlite');
let recoveryLedger = new SqliteProviderRecoveryLedger(recoveryLedgerPath);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const issuer = 'sigma-live-proof-gatekeeper';
const keyId = 'ephemeral-live-proof-key';
const trustStore = new GatekeeperTrustStore({
  keys: [{
    issuer,
    keyId,
    status: 'active',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z'
  }]
});
const ledger = new FencedSqliteClaimLedger(join(root, 'claims.sqlite'), {
  approvalVerifier: trustStore,
  permitTtlMs: 120_000
});

try {
  const transport = new GitHubContentsColossusTransport({
    credentialBroker: broker,
    credentialHandle
  });
  const adapter = new ColossusDispatchAdapter({
    registry: {
      'github-contents@v1': {
        adapterId: 'github-contents-reference',
        methods: { execute: ['github.contents.put'] }
      }
    },
    transport,
    permitStore: ledger,
    timeoutMs: 30_000
  });

  const baseline1 = await inspectBaseline(observer, target);
  const desired1 = JSON.stringify({
    schema: 'sigma.provider-canary.v1',
    phase: 'confirmed-write',
    candidateSha,
    runId
  }, null, 2) + '\n';
  const payload1 = githubContentsPayload({
    target,
    desiredContent: desired1,
    baseline: baseline1,
    commitMessage: `Sigma provider canary ${runId}: confirmed write`
  });
  const first = await executeSignedDispatch({
    ledger,
    adapter,
    privateKey,
    issuer,
    keyId,
    payload: payload1,
    suffix: `confirmed-${runId}`
  });
  if (first.receipt.status !== 'dispatched') {
    throw new Error(`confirmed provider write was not dispatched: ${first.receipt.status}`);
  }
  const confirmedObservation = await observer.inspectOutcome({ uncertainty: { target } });
  if (!confirmedObservation.exists || confirmedObservation.contentFingerprint !== payload1.desired.fingerprint) {
    throw new Error('confirmed provider write did not read back the desired fingerprint');
  }

  const baseline2 = {
    exists: confirmedObservation.exists,
    contentFingerprint: confirmedObservation.contentFingerprint,
    version: confirmedObservation.version
  };
  const desired2 = JSON.stringify({
    schema: 'sigma.provider-canary.v1',
    phase: 'lost-response-recovered',
    candidateSha,
    runId
  }, null, 2) + '\n';
  const payload2 = githubContentsPayload({
    target,
    desiredContent: desired2,
    baseline: baseline2,
    commitMessage: `Sigma provider canary ${runId}: ambiguous write`
  });

  broker.dropNextSuccessfulPutResponse();
  const secondSubject = buildSubject(payload2, `ambiguous-${runId}`);
  const secondPermit = issuePermit({
    ledger,
    privateKey,
    issuer,
    keyId,
    subject: secondSubject
  });
  const secondRequest = dispatchRequest(secondSubject, payload2, secondPermit);

  let ambiguousError = null;
  try {
    await adapter.dispatch({ permit: secondPermit, request: secondRequest, now: new Date() });
  } catch (error) {
    ambiguousError = error;
  }
  if (!ambiguousError) throw new Error('ambiguous provider proof unexpectedly returned a normal receipt');

  const durableAttempt = ledger.getDispatchAttemptByPermitId(secondPermit.permitId);
  if (!durableAttempt || durableAttempt.state !== 'started') {
    throw new Error('ambiguous provider write did not preserve a durable started attempt');
  }

  const uncertainty = {
    provider: 'github-contents/v1',
    operation: 'put',
    idempotencyKey: secondSubject.idempotencyKey,
    requestId: durableAttempt.requestId,
    envelopeFingerprint: durableAttempt.envelopeFingerprint,
    desiredFingerprint: payload2.desired.fingerprint,
    target,
    baseline: payload2.baseline
  };
  const durableRecovery = new DurableProviderOutcomeRecoveryCoordinator({
    coordinator: new ProviderOutcomeRecoveryCoordinator({ observer }),
    ledger: recoveryLedger
  });
  const { recovery, receipt: recoveryReceipt } = await durableRecovery.recover({ uncertainty });
  if (recovery.state !== 'confirmed_applied' || recovery.retryDisposition !== 'do_not_retry_reconcile') {
    throw new Error(`ambiguous provider recovery did not prove applied: ${recovery.state}`);
  }

  recoveryLedger.close();
  recoveryLedger = new SqliteProviderRecoveryLedger(recoveryLedgerPath);
  const restartReceipt = recoveryLedger.getByRequestId(durableAttempt.requestId);
  if (!restartReceipt || restartReceipt.recordFingerprint !== recoveryReceipt.recordFingerprint ||
      restartReceipt.state !== 'confirmed_applied') {
    throw new Error('provider recovery evidence did not survive close/reopen');
  }

  const putsBeforeReplay = broker.putCalls;
  let replayBlocked = false;
  try {
    await adapter.dispatch({ permit: secondPermit, request: secondRequest, now: new Date() });
  } catch (error) {
    replayBlocked = error?.code === 'DISPATCH_PERMIT_ALREADY_ATTEMPTED';
  }
  if (!replayBlocked) throw new Error('automatic replay was not blocked after provider recovery');
  if (broker.putCalls !== putsBeforeReplay) throw new Error('replay reached the provider despite the one-shot fence');

  console.log(JSON.stringify({
    schema: 'sigma.github-provider-live-proof.v2',
    provider: 'github-contents/v1',
    target,
    candidateSha,
    confirmedWrite: {
      status: first.receipt.status,
      observedVersion: confirmedObservation.version,
      desiredFingerprint: payload1.desired.fingerprint
    },
    ambiguousWrite: {
      localAttemptState: durableAttempt.state,
      recoveryState: recovery.state,
      retryDisposition: recovery.retryDisposition,
      desiredFingerprint: payload2.desired.fingerprint,
      observedVersion: recovery.observation.version,
      recoveryRecordFingerprint: recoveryReceipt.recordFingerprint,
      recoveryRestartReadable: true,
      replayBlocked
    },
    providerCalls: {
      reads: broker.getCalls,
      writes: broker.putCalls
    }
  }, null, 2));
} finally {
  try { recoveryLedger.close(); } catch { /* already closed */ }
  ledger.close();
  await rm(root, { recursive: true, force: true });
}

async function inspectBaseline(providerObserver, providerTarget) {
  const observed = await providerObserver.inspectOutcome({ uncertainty: { target: providerTarget } });
  return observed.exists
    ? {
        exists: true,
        contentFingerprint: observed.contentFingerprint,
        version: observed.version
      }
    : { exists: false, contentFingerprint: null, version: null };
}

async function executeSignedDispatch({ ledger: claimLedger, adapter, privateKey: signingKey, issuer: signingIssuer, keyId: signingKeyId, payload, suffix }) {
  const subject = buildSubject(payload, suffix);
  const permit = issuePermit({
    ledger: claimLedger,
    privateKey: signingKey,
    issuer: signingIssuer,
    keyId: signingKeyId,
    subject
  });
  const request = dispatchRequest(subject, payload, permit);
  const receipt = await adapter.dispatch({ permit, request, now: new Date() });
  return { receipt, permit, request, subject };
}

function buildSubject(payload, suffix) {
  const safeSuffix = String(suffix).replace(/[^A-Za-z0-9._~-]/g, '_');
  return Object.freeze({
    approvalId: `approval-${safeSuffix}`,
    jobId: `job-${safeSuffix}`,
    planFingerprint: planFingerprint({ provider: 'github-contents/v1', payload }),
    componentRef: 'github-contents@v1',
    method: 'execute',
    idempotencyKey: `idem-${safeSuffix}`,
    policyVersion: 'provider-live-proof-v1'
  });
}

function issuePermit({ ledger: claimLedger, privateKey: signingKey, issuer: signingIssuer, keyId: signingKeyId, subject }) {
  const now = new Date();
  const approval = signGatekeeperApproval({
    approval: {
      ...subject,
      issuedAt: new Date(now.getTime() - 1_000).toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      status: 'approved'
    },
    issuer: signingIssuer,
    keyId: signingKeyId,
    privateKey: signingKey.export({ type: 'pkcs8', format: 'pem' })
  });
  claimLedger.registerApproval({ approval, now });
  return claimLedger.claimDispatchPermit({ expected: subject, now });
}

function dispatchRequest(subject, payload, permit) {
  const now = new Date();
  const handleExpiry = new Date(Math.min(
    Date.parse(permit.expiresAt),
    now.getTime() + 30_000
  )).toISOString();
  return Object.freeze({
    protocolVersion: 'sigma-federation/v1',
    schemaVersion: 'colossus-dispatch/v1',
    requestId: `request-${subject.idempotencyKey}`,
    traceId: `trace-${subject.idempotencyKey}`,
    jobId: subject.jobId,
    componentRef: subject.componentRef,
    method: subject.method,
    capability: 'github.contents.put',
    idempotencyKey: subject.idempotencyKey,
    planFingerprint: subject.planFingerprint,
    policyVersion: subject.policyVersion,
    scopedHandles: [{
      type: 'github-repository',
      id: `${owner}/${repo}`,
      scope: 'contents:write:provider-canary',
      expiresAt: handleExpiry
    }],
    payload
  });
}

function liveBroker(secretToken) {
  let dropNextPut = false;
  const state = {
    getCalls: 0,
    putCalls: 0,
    supportsOpaqueHandles: true,
    dropNextSuccessfulPutResponse() {
      dropNextPut = true;
    },
    async authorizedFetch({ credentialHandle: handle, url, request, signal }) {
      if (handle !== credentialHandleExpected()) throw new Error('credential handle mismatch');
      const headers = {
        ...request.headers,
        authorization: `Bearer ${secretToken}`,
        'user-agent': 'sigma-glue-provider-live-proof'
      };
      if (request.method === 'GET') state.getCalls += 1;
      if (request.method === 'PUT') state.putCalls += 1;
      const response = await fetch(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: request.redirect,
        cache: request.cache,
        signal
      });
      if (request.method === 'PUT' && dropNextPut && response.ok) {
        dropNextPut = false;
        await response.arrayBuffer();
        throw new Error('simulated provider response loss after successful mutation');
      }
      return response;
    }
  };
  return state;
}

function credentialHandleExpected() {
  return 'credh_githubactions';
}
