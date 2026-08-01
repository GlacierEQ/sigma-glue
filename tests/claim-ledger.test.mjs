import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SqliteClaimLedger, ClaimLedgerError } from '../src/ledger/sqlite-claim-ledger.mjs';
import {
  createTestTrustStore,
  signTestApproval
} from './helpers/gatekeeper-fixture.mjs';

const execFileAsync = promisify(execFile);
const NOW = new Date('2026-08-01T22:00:00.000Z');

function unsignedApproval(overrides = {}) {
  return {
    approvalId: 'approval-1',
    jobId: 'job-1',
    planFingerprint: 'sha256:plan-1',
    componentRef: 'commander@ref-1',
    method: 'execute',
    idempotencyKey: 'idem-job-1',
    policyVersion: 'policy-v1',
    issuedAt: '2026-08-01T21:55:00.000Z',
    expiresAt: '2026-08-01T22:30:00.000Z',
    status: 'approved',
    ...overrides
  };
}

function approval(overrides = {}) {
  return signTestApproval(unsignedApproval(overrides));
}

function expected(source = approval()) {
  const {
    approvalId, jobId, planFingerprint, componentRef,
    method, idempotencyKey, policyVersion
  } = source;
  return { approvalId, jobId, planFingerprint, componentRef, method, idempotencyKey, policyVersion };
}

async function withLedger(run, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-glue-ledger-'));
  const dbPath = join(dir, 'claims.sqlite');
  const baseOptions = { approvalVerifier: createTestTrustStore(), ...options };
  try {
    return await run({
      dbPath,
      open: (overrides = {}) => new SqliteClaimLedger(dbPath, { ...baseOptions, ...overrides })
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('requires a Gatekeeper approval verifier', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sigma-glue-ledger-verifier-'));
  try {
    assert.throws(
      () => new SqliteClaimLedger(join(dir, 'claims.sqlite')),
      (error) => error instanceof ClaimLedgerError && error.code === 'APPROVAL_VERIFIER_REQUIRED'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects unsigned and tampered approvals before persistence', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    assert.throws(
      () => ledger.registerApproval({ approval: unsignedApproval(), now: NOW }),
      (error) => error instanceof ClaimLedgerError && error.code === 'GATEKEEPER_APPROVAL_INVALID'
    );
    const signed = approval();
    assert.throws(
      () => ledger.registerApproval({ approval: { ...signed, jobId: 'job-tampered' }, now: NOW }),
      (error) => error instanceof ClaimLedgerError && error.code === 'GATEKEEPER_SIGNATURE_MISMATCH'
    );
    assert.equal(ledger.getApproval('approval-1'), null);
    ledger.close();
  });
});

test('persists signed approval authenticity and permits across reopen', async () => {
  await withLedger(({ open }) => {
    const first = open();
    first.registerApproval({ approval: approval(), now: NOW });
    const issued = first.claimDispatchPermit({ expected: expected(), now: NOW });
    first.close();

    const reopened = open();
    const stored = reopened.getApproval('approval-1');
    assert.equal(stored.status, 'consumed');
    assert.equal(stored.issuer, 'gatekeeper.test');
    assert.match(stored.keyFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(reopened.getPermitByIdempotencyKey('idem-job-1').permitId, issued.permitId);
    reopened.close();
  });
});

test('atomically consumes approval and issues an exact permit', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    ledger.registerApproval({ approval: approval(), now: NOW });
    const permit = ledger.claimDispatchPermit({ expected: expected(), now: NOW });

    assert.equal(permit.approvalId, 'approval-1');
    assert.equal(permit.idempotencyKey, 'idem-job-1');
    assert.equal(permit.status, 'issued');
    assert.equal(permit.replayed, false);
    assert.match(permit.permitFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(ledger.getApproval('approval-1').status, 'consumed');
    ledger.close();
  });
});

test('identical retry returns the original permit without a second claim', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    ledger.registerApproval({ approval: approval(), now: NOW });
    const first = ledger.claimDispatchPermit({ expected: expected(), now: NOW });
    const replay = ledger.claimDispatchPermit({ expected: expected(), now: new Date(NOW.getTime() + 1_000) });

    assert.equal(replay.permitId, first.permitId);
    assert.equal(replay.claimId, first.claimId);
    assert.equal(replay.replayed, true);
    ledger.close();
  });
});

test('same idempotency key with changed subject fails closed', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    ledger.registerApproval({ approval: approval(), now: NOW });
    ledger.claimDispatchPermit({ expected: expected(), now: NOW });

    assert.throws(
      () => ledger.claimDispatchPermit({
        expected: expected(approval({ planFingerprint: 'sha256:changed' })),
        now: NOW
      }),
      (error) => error instanceof ClaimLedgerError && error.code === 'IDEMPOTENCY_KEY_REUSE_MISMATCH'
    );
    ledger.close();
  });
});

test('same approval cannot authorize a different idempotency key', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    ledger.registerApproval({ approval: approval(), now: NOW });
    ledger.claimDispatchPermit({ expected: expected(), now: NOW });

    assert.throws(
      () => ledger.claimDispatchPermit({
        expected: expected(approval({ idempotencyKey: 'idem-other' })),
        now: NOW
      }),
      (error) => error instanceof ClaimLedgerError && error.code === 'AUTHORIZATION_CONSUMED'
    );
    ledger.close();
  });
});

test('concurrent duplicate processes converge on one permit', async () => {
  await withLedger(async ({ dbPath, open }) => {
    const ledger = open();
    ledger.registerApproval({ approval: approval(), now: NOW });
    ledger.close();

    const worker = join(import.meta.dirname, 'helpers', 'claim-worker.mjs');
    const inputs = Array.from({ length: 8 }, () => execFileAsync(
      process.execPath,
      [worker, dbPath, JSON.stringify(expected()), NOW.toISOString()],
      { env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    ));
    const results = await Promise.all(inputs);
    const permits = results.map(({ stdout }) => JSON.parse(stdout.trim()).permit);

    assert.equal(new Set(permits.map((permit) => permit.permitId)).size, 1);
    assert.equal(new Set(permits.map((permit) => permit.claimId)).size, 1);
    assert.equal(permits.filter((permit) => permit.replayed === false).length, 1);
    assert.equal(permits.filter((permit) => permit.replayed === true).length, 7);

    const check = open();
    assert.equal(check.getApproval('approval-1').status, 'consumed');
    assert.equal(check.getPermitByIdempotencyKey('idem-job-1').permitId, permits[0].permitId);
    check.close();
  });
});

test('transaction rollback restores approval when permit insertion fails', async () => {
  const ids = ['claim-fixed', 'permit-fixed', 'claim-fixed-2', 'permit-fixed'];
  await withLedger(({ open }) => {
    const ledger = open();
    ledger.registerApproval({ approval: approval(), now: NOW });
    ledger.claimDispatchPermit({ expected: expected(), now: NOW });

    const second = approval({
      approvalId: 'approval-2',
      jobId: 'job-2',
      idempotencyKey: 'idem-job-2'
    });
    ledger.registerApproval({ approval: second, now: NOW });

    assert.throws(
      () => ledger.claimDispatchPermit({ expected: expected(second), now: NOW }),
      (error) => error instanceof ClaimLedgerError && error.code === 'CLAIM_TRANSACTION_FAILED'
    );
    assert.equal(ledger.getApproval('approval-2').status, 'approved');
    assert.equal(ledger.getPermitByIdempotencyKey('idem-job-2'), null);
    ledger.close();
  }, { idFactory: () => ids.shift() });
});

test('expired approval is rejected without consumption', async () => {
  await withLedger(({ open }) => {
    const ledger = open();
    const expiring = approval({ expiresAt: '2026-08-01T22:00:01.000Z' });
    ledger.registerApproval({ approval: expiring, now: NOW });

    assert.throws(
      () => ledger.claimDispatchPermit({
        expected: expected(expiring),
        now: new Date('2026-08-01T22:00:02.000Z')
      }),
      (error) => error instanceof ClaimLedgerError && error.code === 'APPROVAL_EXPIRED'
    );
    assert.equal(ledger.getApproval('approval-1').status, 'approved');
    ledger.close();
  });
});

test('key revocation is rechecked when claiming a stored approval', async () => {
  await withLedger(({ dbPath, open }) => {
    const initial = open();
    initial.registerApproval({ approval: approval(), now: NOW });
    initial.close();

    const revoked = new SqliteClaimLedger(dbPath, {
      approvalVerifier: createTestTrustStore({ status: 'revoked' })
    });
    assert.throws(
      () => revoked.claimDispatchPermit({ expected: expected(), now: NOW }),
      (error) => error instanceof ClaimLedgerError && error.code === 'GATEKEEPER_KEY_REVOKED'
    );
    assert.equal(revoked.getApproval('approval-1').status, 'approved');
    revoked.close();
  });
});
