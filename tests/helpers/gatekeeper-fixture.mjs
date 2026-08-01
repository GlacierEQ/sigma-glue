import { generateKeyPairSync } from 'node:crypto';
import {
  GatekeeperTrustStore,
  signGatekeeperApproval
} from '../../src/approval/gatekeeper-signatures.mjs';

const primary = generateKeyPairSync('ed25519');

export const TEST_GATEKEEPER = Object.freeze({
  issuer: 'gatekeeper.test',
  keyId: 'key-primary',
  privateKey: primary.privateKey,
  publicKey: primary.publicKey,
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2027-01-01T00:00:00.000Z'
});

export function createTestTrustStore({
  status = 'active',
  retiredAt = undefined,
  issuer = TEST_GATEKEEPER.issuer,
  keyId = TEST_GATEKEEPER.keyId,
  publicKey = TEST_GATEKEEPER.publicKey,
  notBefore = TEST_GATEKEEPER.notBefore,
  notAfter = TEST_GATEKEEPER.notAfter
} = {}) {
  return new GatekeeperTrustStore({
    keys: [{ issuer, keyId, publicKey, status, notBefore, notAfter, retiredAt }]
  });
}

export function signTestApproval(approval, {
  issuer = TEST_GATEKEEPER.issuer,
  keyId = TEST_GATEKEEPER.keyId,
  privateKey = TEST_GATEKEEPER.privateKey
} = {}) {
  return signGatekeeperApproval({ approval, issuer, keyId, privateKey });
}
