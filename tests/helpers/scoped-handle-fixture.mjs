import {
  ScopedHandleTrustStore,
  signScopedHandle
} from '../../src/dispatch/scoped-handle-signatures.mjs';
import { TEST_GATEKEEPER } from './gatekeeper-fixture.mjs';

export const TEST_SCOPED_HANDLE_AUTHORITY = Object.freeze({
  issuer: 'scoped-authority.test',
  keyId: 'handle-primary',
  privateKey: TEST_GATEKEEPER.privateKey,
  publicKey: TEST_GATEKEEPER.publicKey,
  notBefore: TEST_GATEKEEPER.notBefore,
  notAfter: TEST_GATEKEEPER.notAfter
});

export function createScopedHandleTrustStore({
  status = 'active',
  retiredAt = undefined,
  issuer = TEST_SCOPED_HANDLE_AUTHORITY.issuer,
  keyId = TEST_SCOPED_HANDLE_AUTHORITY.keyId,
  publicKey = TEST_SCOPED_HANDLE_AUTHORITY.publicKey,
  notBefore = TEST_SCOPED_HANDLE_AUTHORITY.notBefore,
  notAfter = TEST_SCOPED_HANDLE_AUTHORITY.notAfter
} = {}) {
  return new ScopedHandleTrustStore({
    keys: [{ issuer, keyId, publicKey, status, notBefore, notAfter, retiredAt }]
  });
}

export function signTestScopedHandle(handle, {
  issuer = TEST_SCOPED_HANDLE_AUTHORITY.issuer,
  keyId = TEST_SCOPED_HANDLE_AUTHORITY.keyId,
  privateKey = TEST_SCOPED_HANDLE_AUTHORITY.privateKey
} = {}) {
  return signScopedHandle({ handle, issuer, keyId, privateKey });
}
