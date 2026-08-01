import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  GatekeeperSignatureError,
  GatekeeperTrustStore,
  gatekeeperApprovalFingerprint,
  signGatekeeperApproval
} from '../src/approval/gatekeeper-signatures.mjs';
import {
  TEST_GATEKEEPER,
  createTestTrustStore,
  signTestApproval
} from './helpers/gatekeeper-fixture.mjs';

const NOW = new Date('2026-08-01T22:00:00.000Z');

function approval(overrides = {}) {
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

test('verifies an exact Ed25519 Gatekeeper approval', () => {
  const signed = signTestApproval(approval());
  const result = createTestTrustStore().verify(signed, { now: NOW });

  assert.equal(result.issuer, TEST_GATEKEEPER.issuer);
  assert.equal(result.keyId, TEST_GATEKEEPER.keyId);
  assert.equal(result.keyStatus, 'active');
  assert.equal(result.verified, true);
  assert.match(result.keyFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.signatureFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(gatekeeperApprovalFingerprint(signed), /^sha256:[0-9a-f]{64}$/);
});

test('rejects signed-field substitution', () => {
  const signed = signTestApproval(approval());
  assert.throws(
    () => createTestTrustStore().verify({ ...signed, planFingerprint: 'sha256:substituted' }, { now: NOW }),
    (error) => error instanceof GatekeeperSignatureError && error.code === 'GATEKEEPER_SIGNATURE_MISMATCH'
  );
});

test('rejects unknown and revoked signing keys', () => {
  const signed = signTestApproval(approval());
  const other = generateKeyPairSync('ed25519');
  const unknownStore = new GatekeeperTrustStore({
    keys: [{
      issuer: 'gatekeeper.test',
      keyId: 'other-key',
      publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }),
      status: 'active',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2027-01-01T00:00:00.000Z'
    }]
  });

  assert.throws(
    () => unknownStore.verify(signed, { now: NOW }),
    (error) => error instanceof GatekeeperSignatureError && error.code === 'GATEKEEPER_KEY_UNKNOWN'
  );
  assert.throws(
    () => createTestTrustStore({ status: 'revoked' }).verify(signed, { now: NOW }),
    (error) => error instanceof GatekeeperSignatureError && error.code === 'GATEKEEPER_KEY_REVOKED'
  );
});

test('retired keys verify historical approvals but cannot sign after retirement', () => {
  const historical = signTestApproval(approval({ issuedAt: '2026-07-31T23:00:00.000Z' }));
  const afterRetirement = signTestApproval(approval({
    approvalId: 'approval-2',
    issuedAt: '2026-08-01T12:00:00.000Z'
  }));
  const store = createTestTrustStore({
    status: 'retired',
    retiredAt: '2026-08-01T00:00:00.000Z'
  });

  assert.equal(store.verify(historical, { now: NOW }).keyStatus, 'retired');
  assert.throws(
    () => store.verify(afterRetirement, { now: NOW }),
    (error) => error instanceof GatekeeperSignatureError && error.code === 'GATEKEEPER_KEY_RETIRED'
  );
});

test('rotation accepts historical old-key approvals and current new-key approvals', () => {
  const next = generateKeyPairSync('ed25519');
  const nextPrivateKey = next.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const nextPublicKey = next.publicKey.export({ type: 'spki', format: 'pem' });
  const oldApproval = signTestApproval(approval({ issuedAt: '2026-07-31T23:00:00.000Z' }));
  const newApproval = signGatekeeperApproval({
    approval: approval({ approvalId: 'approval-next', idempotencyKey: 'idem-next' }),
    issuer: TEST_GATEKEEPER.issuer,
    keyId: 'key-next',
    privateKey: nextPrivateKey
  });
  const store = new GatekeeperTrustStore({
    keys: [
      {
        issuer: TEST_GATEKEEPER.issuer,
        keyId: TEST_GATEKEEPER.keyId,
        publicKey: TEST_GATEKEEPER.publicKey,
        status: 'retired',
        notBefore: TEST_GATEKEEPER.notBefore,
        notAfter: TEST_GATEKEEPER.notAfter,
        retiredAt: '2026-08-01T00:00:00.000Z'
      },
      {
        issuer: TEST_GATEKEEPER.issuer,
        keyId: 'key-next',
        publicKey: nextPublicKey,
        status: 'active',
        notBefore: '2026-08-01T00:00:00.000Z',
        notAfter: '2027-08-01T00:00:00.000Z'
      }
    ]
  });

  assert.equal(store.verify(oldApproval, { now: NOW }).keyId, TEST_GATEKEEPER.keyId);
  assert.equal(store.verify(newApproval, { now: NOW }).keyId, 'key-next');
});

test('rejects duplicate key identities and invalid key windows', () => {
  const record = {
    issuer: TEST_GATEKEEPER.issuer,
    keyId: TEST_GATEKEEPER.keyId,
    publicKey: TEST_GATEKEEPER.publicKey,
    status: 'active',
    notBefore: TEST_GATEKEEPER.notBefore,
    notAfter: TEST_GATEKEEPER.notAfter
  };
  assert.throws(
    () => new GatekeeperTrustStore({ keys: [record, record] }),
    (error) => error instanceof GatekeeperSignatureError && error.code === 'GATEKEEPER_KEY_DUPLICATE'
  );
  assert.throws(
    () => new GatekeeperTrustStore({
      keys: [{ ...record, notBefore: record.notAfter, notAfter: record.notBefore }]
    }),
    (error) => error instanceof GatekeeperSignatureError && error.code === 'GATEKEEPER_KEY_WINDOW_INVALID'
  );
});

test('signing output excludes unsigned extension fields', () => {
  const signed = signTestApproval({ ...approval(), rawCredential: 'must-not-survive' });
  assert.equal(Object.hasOwn(signed, 'rawCredential'), false);
  assert.equal(createTestTrustStore().verify(signed, { now: NOW }).verified, true);
});
