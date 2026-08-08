import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ScopedHandleSignatureError,
  ScopedHandleTrustStore,
  signScopedHandle
} from '../src/dispatch/scoped-handle-signatures.mjs';
import {
  createScopedHandleTrustStore,
  signTestScopedHandle,
  TEST_SCOPED_HANDLE_AUTHORITY
} from './helpers/scoped-handle-fixture.mjs';

const NOW = new Date('2026-08-01T22:00:00.000Z');

function unsigned(overrides = {}) {
  return {
    type: 'filesystem-root',
    id: 'root-signature-1',
    scope: 'move-within-root',
    issuedAt: '2026-08-01T21:59:00.000Z',
    expiresAt: '2026-08-01T22:05:00.000Z',
    bindingFingerprint: 'sha256:binding-1',
    ...overrides
  };
}

test('valid Ed25519 scoped handle verifies with trusted issuer identity', () => {
  const handle = signTestScopedHandle(unsigned());
  const verified = createScopedHandleTrustStore().verify(handle, { now: NOW });
  assert.equal(verified.verified, true);
  assert.equal(verified.issuer, TEST_SCOPED_HANDLE_AUTHORITY.issuer);
  assert.equal(verified.keyId, TEST_SCOPED_HANDLE_AUTHORITY.keyId);
  assert.match(verified.signatureFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('tampering any signed authority field invalidates the signature', () => {
  const handle = signTestScopedHandle(unsigned());
  const trust = createScopedHandleTrustStore();
  for (const mutation of [
    { id: 'root-other' },
    { scope: 'root-admin' },
    { bindingFingerprint: 'sha256:other-binding' },
    { expiresAt: '2026-08-01T22:06:00.000Z' }
  ]) {
    assert.throws(
      () => trust.verify({ ...handle, ...mutation }, { now: NOW }),
      (error) => error instanceof ScopedHandleSignatureError &&
        error.code === 'SCOPED_HANDLE_SIGNATURE_MISMATCH'
    );
  }
});

test('revoked scoped-handle keys fail closed', () => {
  const handle = signTestScopedHandle(unsigned());
  const trust = createScopedHandleTrustStore({ status: 'revoked' });
  assert.throws(
    () => trust.verify(handle, { now: NOW }),
    (error) => error instanceof ScopedHandleSignatureError &&
      error.code === 'SCOPED_HANDLE_KEY_REVOKED'
  );
});

test('retired key verifies only handles issued before retirement', () => {
  const trust = createScopedHandleTrustStore({
    status: 'retired',
    retiredAt: '2026-08-01T22:00:00.000Z'
  });
  const before = signTestScopedHandle(unsigned({ issuedAt: '2026-08-01T21:59:00.000Z' }));
  assert.equal(trust.verify(before, { now: new Date('2026-08-01T22:01:00.000Z') }).verified, true);

  const after = signTestScopedHandle(unsigned({
    issuedAt: '2026-08-01T22:00:00.000Z',
    expiresAt: '2026-08-01T22:05:00.000Z'
  }));
  assert.throws(
    () => trust.verify(after, { now: new Date('2026-08-01T22:01:00.000Z') }),
    (error) => error instanceof ScopedHandleSignatureError &&
      error.code === 'SCOPED_HANDLE_KEY_RETIRED'
  );
});

test('unknown issuer/key identity is rejected even when signature is cryptographically valid', () => {
  const handle = signScopedHandle({
    handle: unsigned(),
    issuer: 'other-authority.test',
    keyId: 'other-key',
    privateKey: TEST_SCOPED_HANDLE_AUTHORITY.privateKey
  });
  assert.throws(
    () => createScopedHandleTrustStore().verify(handle, { now: NOW }),
    (error) => error instanceof ScopedHandleSignatureError &&
      error.code === 'SCOPED_HANDLE_KEY_UNKNOWN'
  );
});

test('trust store rejects non-Ed25519 or empty key sets', () => {
  assert.throws(
    () => new ScopedHandleTrustStore({ keys: [] }),
    (error) => error instanceof ScopedHandleSignatureError &&
      error.code === 'SCOPED_HANDLE_TRUST_STORE_EMPTY'
  );
});
