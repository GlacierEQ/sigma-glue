import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto';
import { canonicalize } from '../plan/fingerprint.mjs';

const SIGNATURE_ALGORITHM = 'Ed25519';
const SIGNATURE_VERSION = 'gatekeeper-approval/v1';
const KEY_STATUSES = Object.freeze(['active', 'retired', 'revoked']);
const APPROVAL_FIELDS = Object.freeze([
  'approvalId',
  'jobId',
  'planFingerprint',
  'componentRef',
  'method',
  'idempotencyKey',
  'policyVersion',
  'issuedAt',
  'expiresAt',
  'status',
  'issuer',
  'keyId',
  'signatureAlgorithm',
  'signatureVersion'
]);

export class GatekeeperSignatureError extends Error {
  constructor(message, code = 'GATEKEEPER_SIGNATURE_INVALID', options = undefined) {
    super(message, options);
    this.name = 'GatekeeperSignatureError';
    this.code = code;
  }
}

export class GatekeeperTrustStore {
  #keys = new Map();

  constructor({ keys } = {}) {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new GatekeeperSignatureError('at least one Gatekeeper verification key is required', 'GATEKEEPER_TRUST_STORE_EMPTY');
    }

    for (const source of keys) {
      const record = normalizeKeyRecord(source);
      const identity = keyIdentity(record.issuer, record.keyId);
      if (this.#keys.has(identity)) {
        throw new GatekeeperSignatureError(`duplicate Gatekeeper key ${identity}`, 'GATEKEEPER_KEY_DUPLICATE');
      }
      this.#keys.set(identity, record);
    }
  }

  verify(approval, { now = new Date() } = {}) {
    validDate(now, 'GATEKEEPER_VERIFICATION_TIME_INVALID');
    const envelope = normalizeSignedApproval(approval);
    const record = this.#keys.get(keyIdentity(envelope.issuer, envelope.keyId));
    if (!record) {
      throw new GatekeeperSignatureError('Gatekeeper signing key is unknown', 'GATEKEEPER_KEY_UNKNOWN');
    }
    if (record.status === 'revoked') {
      throw new GatekeeperSignatureError('Gatekeeper signing key is revoked', 'GATEKEEPER_KEY_REVOKED');
    }

    const issuedMs = Date.parse(envelope.issuedAt);
    if (issuedMs < record.notBeforeMs || issuedMs >= record.notAfterMs) {
      throw new GatekeeperSignatureError('approval was signed outside the key validity window', 'GATEKEEPER_KEY_WINDOW_INVALID');
    }
    if (record.status === 'retired' && record.retiredAtMs !== null && issuedMs >= record.retiredAtMs) {
      throw new GatekeeperSignatureError('approval was issued after the key retired', 'GATEKEEPER_KEY_RETIRED');
    }

    const signature = decodeSignature(envelope.signature);
    const payload = Buffer.from(canonicalize(signingPayload(envelope)), 'utf8');
    if (!cryptoVerify(null, payload, record.publicKey, signature)) {
      throw new GatekeeperSignatureError('Gatekeeper approval signature does not verify', 'GATEKEEPER_SIGNATURE_MISMATCH');
    }

    return Object.freeze({
      issuer: envelope.issuer,
      keyId: envelope.keyId,
      keyStatus: record.status,
      keyFingerprint: record.keyFingerprint,
      signatureFingerprint: hashBytes(signature),
      signatureVersion: SIGNATURE_VERSION,
      verified: true
    });
  }
}

export function signGatekeeperApproval({ approval, issuer, keyId, privateKey }) {
  const unsigned = normalizeUnsignedApproval({
    ...approval,
    issuer,
    keyId,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signatureVersion: SIGNATURE_VERSION
  });

  let signingKey;
  try {
    signingKey = createPrivateKey(privateKey);
  } catch (error) {
    throw new GatekeeperSignatureError('Gatekeeper private key is invalid', 'GATEKEEPER_PRIVATE_KEY_INVALID', { cause: error });
  }
  if (signingKey.asymmetricKeyType !== 'ed25519') {
    throw new GatekeeperSignatureError('Gatekeeper private key must be Ed25519', 'GATEKEEPER_KEY_ALGORITHM_INVALID');
  }

  const payload = Buffer.from(canonicalize(signingPayload(unsigned)), 'utf8');
  const signature = cryptoSign(null, payload, signingKey).toString('base64url');
  return Object.freeze({ ...unsigned, signature });
}

export function gatekeeperApprovalFingerprint(approval) {
  const envelope = normalizeSignedApproval(approval);
  return `sha256:${createHash('sha256').update(canonicalize(envelope), 'utf8').digest('hex')}`;
}

function normalizeKeyRecord(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new GatekeeperSignatureError('Gatekeeper key record is invalid', 'GATEKEEPER_KEY_RECORD_INVALID');
  }
  const issuer = nonEmpty(source.issuer, 'issuer', 'GATEKEEPER_KEY_RECORD_INVALID');
  const keyId = nonEmpty(source.keyId, 'keyId', 'GATEKEEPER_KEY_RECORD_INVALID');
  const status = nonEmpty(source.status, 'status', 'GATEKEEPER_KEY_RECORD_INVALID');
  if (!KEY_STATUSES.includes(status)) {
    throw new GatekeeperSignatureError('Gatekeeper key status is invalid', 'GATEKEEPER_KEY_STATUS_INVALID');
  }

  let publicKey;
  try {
    publicKey = createPublicKey(source.publicKey);
  } catch (error) {
    throw new GatekeeperSignatureError('Gatekeeper public key is invalid', 'GATEKEEPER_PUBLIC_KEY_INVALID', { cause: error });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new GatekeeperSignatureError('Gatekeeper public key must be Ed25519', 'GATEKEEPER_KEY_ALGORITHM_INVALID');
  }

  const notBeforeMs = timestamp(source.notBefore, 'GATEKEEPER_KEY_WINDOW_INVALID');
  const notAfterMs = timestamp(source.notAfter, 'GATEKEEPER_KEY_WINDOW_INVALID');
  if (notBeforeMs >= notAfterMs) {
    throw new GatekeeperSignatureError('Gatekeeper key validity window is inverted', 'GATEKEEPER_KEY_WINDOW_INVALID');
  }
  const retiredAtMs = source.retiredAt === undefined || source.retiredAt === null
    ? null
    : timestamp(source.retiredAt, 'GATEKEEPER_KEY_RETIREMENT_INVALID');
  if (status === 'retired' && retiredAtMs === null) {
    throw new GatekeeperSignatureError('retired Gatekeeper key requires retiredAt', 'GATEKEEPER_KEY_RETIREMENT_INVALID');
  }
  if (retiredAtMs !== null && (retiredAtMs <= notBeforeMs || retiredAtMs > notAfterMs)) {
    throw new GatekeeperSignatureError('Gatekeeper key retirement is outside its validity window', 'GATEKEEPER_KEY_RETIREMENT_INVALID');
  }

  const der = publicKey.export({ type: 'spki', format: 'der' });
  return Object.freeze({
    issuer,
    keyId,
    status,
    publicKey,
    keyFingerprint: hashBytes(der),
    notBeforeMs,
    notAfterMs,
    retiredAtMs
  });
}

function normalizeUnsignedApproval(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new GatekeeperSignatureError('Gatekeeper approval is invalid', 'GATEKEEPER_APPROVAL_INVALID');
  }
  const normalized = {};
  for (const field of APPROVAL_FIELDS) {
    normalized[field] = nonEmpty(source[field], field, 'GATEKEEPER_APPROVAL_INVALID');
  }
  if (normalized.status !== 'approved') {
    throw new GatekeeperSignatureError('only approved Gatekeeper envelopes can be signed', 'GATEKEEPER_APPROVAL_STATUS_INVALID');
  }
  if (normalized.signatureAlgorithm !== SIGNATURE_ALGORITHM || normalized.signatureVersion !== SIGNATURE_VERSION) {
    throw new GatekeeperSignatureError('Gatekeeper signature metadata is incompatible', 'GATEKEEPER_SIGNATURE_VERSION_INVALID');
  }

  const issuedMs = timestamp(normalized.issuedAt, 'GATEKEEPER_APPROVAL_TIME_INVALID');
  const expiresMs = timestamp(normalized.expiresAt, 'GATEKEEPER_APPROVAL_TIME_INVALID');
  if (issuedMs >= expiresMs) {
    throw new GatekeeperSignatureError('Gatekeeper approval validity window is inverted', 'GATEKEEPER_APPROVAL_TIME_INVALID');
  }
  normalized.issuedAt = new Date(issuedMs).toISOString();
  normalized.expiresAt = new Date(expiresMs).toISOString();
  return Object.freeze(normalized);
}

function normalizeSignedApproval(source) {
  const unsigned = normalizeUnsignedApproval(source);
  const signature = nonEmpty(source.signature, 'signature', 'GATEKEEPER_SIGNATURE_MISSING');
  decodeSignature(signature);
  return Object.freeze({ ...unsigned, signature });
}

function signingPayload(approval) {
  const payload = {};
  for (const field of APPROVAL_FIELDS) payload[field] = approval[field];
  return Object.freeze(payload);
}

function decodeSignature(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GatekeeperSignatureError('Gatekeeper signature encoding is invalid', 'GATEKEEPER_SIGNATURE_ENCODING_INVALID');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) {
    throw new GatekeeperSignatureError('Gatekeeper signature encoding is invalid', 'GATEKEEPER_SIGNATURE_ENCODING_INVALID');
  }
  return bytes;
}

function keyIdentity(issuer, keyId) {
  return `${issuer}\u0000${keyId}`;
}

function hashBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function nonEmpty(value, field, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatekeeperSignatureError(`${field} must be a non-empty string`, code);
  }
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatekeeperSignatureError('timestamp is missing', code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new GatekeeperSignatureError('timestamp is invalid', code);
  }
  return parsed;
}

function validDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new GatekeeperSignatureError('verification time is invalid', code);
  }
  return value.getTime();
}
