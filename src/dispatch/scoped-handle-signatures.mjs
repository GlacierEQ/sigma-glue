import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto';

import { canonicalize } from '../plan/fingerprint.mjs';

const SIGNATURE_ALGORITHM = 'Ed25519';
const SIGNATURE_VERSION = 'sigma-scoped-handle/v1';
const KEY_STATUSES = Object.freeze(['active', 'retired', 'revoked']);
const SIGNED_FIELDS = Object.freeze([
  'type',
  'id',
  'scope',
  'issuedAt',
  'expiresAt',
  'bindingFingerprint',
  'issuer',
  'keyId',
  'signatureAlgorithm',
  'signatureVersion'
]);

export class ScopedHandleSignatureError extends Error {
  constructor(message, code = 'SCOPED_HANDLE_SIGNATURE_INVALID', options = undefined) {
    super(message, options);
    this.name = 'ScopedHandleSignatureError';
    this.code = code;
  }
}

export class ScopedHandleTrustStore {
  #keys = new Map();

  constructor({ keys } = {}) {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new ScopedHandleSignatureError(
        'at least one scoped-handle verification key is required',
        'SCOPED_HANDLE_TRUST_STORE_EMPTY'
      );
    }
    for (const source of keys) {
      const record = normalizeKeyRecord(source);
      const identity = keyIdentity(record.issuer, record.keyId);
      if (this.#keys.has(identity)) {
        throw new ScopedHandleSignatureError(
          `duplicate scoped-handle key ${identity}`,
          'SCOPED_HANDLE_KEY_DUPLICATE'
        );
      }
      this.#keys.set(identity, record);
    }
  }

  verify(handle, { now = new Date() } = {}) {
    const nowMs = validDate(now, 'SCOPED_HANDLE_VERIFICATION_TIME_INVALID');
    const envelope = normalizeSignedHandle(handle);
    const record = this.#keys.get(keyIdentity(envelope.issuer, envelope.keyId));
    if (!record) {
      throw new ScopedHandleSignatureError(
        'scoped-handle signing key is unknown',
        'SCOPED_HANDLE_KEY_UNKNOWN'
      );
    }
    if (record.status === 'revoked') {
      throw new ScopedHandleSignatureError(
        'scoped-handle signing key is revoked',
        'SCOPED_HANDLE_KEY_REVOKED'
      );
    }

    const issuedMs = Date.parse(envelope.issuedAt);
    const expiresMs = Date.parse(envelope.expiresAt);
    if (issuedMs > nowMs || expiresMs <= nowMs) {
      throw new ScopedHandleSignatureError(
        'scoped handle is outside its validity window',
        'SCOPED_HANDLE_TIME_INVALID'
      );
    }
    if (issuedMs < record.notBeforeMs || issuedMs >= record.notAfterMs) {
      throw new ScopedHandleSignatureError(
        'scoped handle was signed outside the key validity window',
        'SCOPED_HANDLE_KEY_WINDOW_INVALID'
      );
    }
    if (record.status === 'retired' &&
        record.retiredAtMs !== null &&
        issuedMs >= record.retiredAtMs) {
      throw new ScopedHandleSignatureError(
        'scoped handle was issued after the key retired',
        'SCOPED_HANDLE_KEY_RETIRED'
      );
    }

    const signature = decodeSignature(envelope.signature);
    const payload = Buffer.from(canonicalize(signingPayload(envelope)), 'utf8');
    if (!cryptoVerify(null, payload, record.publicKey, signature)) {
      throw new ScopedHandleSignatureError(
        'scoped-handle signature does not verify',
        'SCOPED_HANDLE_SIGNATURE_MISMATCH'
      );
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

export function signScopedHandle({ handle, issuer, keyId, privateKey }) {
  const unsigned = normalizeUnsignedHandle({
    ...handle,
    issuer,
    keyId,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signatureVersion: SIGNATURE_VERSION
  });

  let signingKey;
  try {
    signingKey = createPrivateKey(privateKey);
  } catch (error) {
    throw new ScopedHandleSignatureError(
      'scoped-handle private key is invalid',
      'SCOPED_HANDLE_PRIVATE_KEY_INVALID',
      { cause: error }
    );
  }
  if (signingKey.asymmetricKeyType !== 'ed25519') {
    throw new ScopedHandleSignatureError(
      'scoped-handle private key must be Ed25519',
      'SCOPED_HANDLE_KEY_ALGORITHM_INVALID'
    );
  }

  const payload = Buffer.from(canonicalize(signingPayload(unsigned)), 'utf8');
  const signature = cryptoSign(null, payload, signingKey).toString('base64url');
  return Object.freeze({ ...unsigned, signature });
}

export function scopedHandleFingerprint(handle) {
  const envelope = normalizeSignedHandle(handle);
  return `sha256:${createHash('sha256').update(canonicalize(envelope), 'utf8').digest('hex')}`;
}

function normalizeKeyRecord(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ScopedHandleSignatureError(
      'scoped-handle key record is invalid',
      'SCOPED_HANDLE_KEY_RECORD_INVALID'
    );
  }
  const issuer = nonEmpty(source.issuer, 'issuer', 'SCOPED_HANDLE_KEY_RECORD_INVALID');
  const keyId = nonEmpty(source.keyId, 'keyId', 'SCOPED_HANDLE_KEY_RECORD_INVALID');
  const status = nonEmpty(source.status, 'status', 'SCOPED_HANDLE_KEY_RECORD_INVALID');
  if (!KEY_STATUSES.includes(status)) {
    throw new ScopedHandleSignatureError(
      'scoped-handle key status is invalid',
      'SCOPED_HANDLE_KEY_STATUS_INVALID'
    );
  }

  let publicKey;
  try {
    publicKey = createPublicKey(source.publicKey);
  } catch (error) {
    throw new ScopedHandleSignatureError(
      'scoped-handle public key is invalid',
      'SCOPED_HANDLE_PUBLIC_KEY_INVALID',
      { cause: error }
    );
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new ScopedHandleSignatureError(
      'scoped-handle public key must be Ed25519',
      'SCOPED_HANDLE_KEY_ALGORITHM_INVALID'
    );
  }

  const notBeforeMs = timestamp(source.notBefore, 'SCOPED_HANDLE_KEY_WINDOW_INVALID');
  const notAfterMs = timestamp(source.notAfter, 'SCOPED_HANDLE_KEY_WINDOW_INVALID');
  if (notBeforeMs >= notAfterMs) {
    throw new ScopedHandleSignatureError(
      'scoped-handle key validity window is inverted',
      'SCOPED_HANDLE_KEY_WINDOW_INVALID'
    );
  }
  const retiredAtMs = source.retiredAt === undefined || source.retiredAt === null
    ? null
    : timestamp(source.retiredAt, 'SCOPED_HANDLE_KEY_RETIREMENT_INVALID');
  if (status === 'retired' && retiredAtMs === null) {
    throw new ScopedHandleSignatureError(
      'retired scoped-handle key requires retiredAt',
      'SCOPED_HANDLE_KEY_RETIREMENT_INVALID'
    );
  }
  if (retiredAtMs !== null &&
      (retiredAtMs <= notBeforeMs || retiredAtMs > notAfterMs)) {
    throw new ScopedHandleSignatureError(
      'scoped-handle key retirement is outside its validity window',
      'SCOPED_HANDLE_KEY_RETIREMENT_INVALID'
    );
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

function normalizeUnsignedHandle(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ScopedHandleSignatureError(
      'scoped handle is invalid',
      'SCOPED_HANDLE_INVALID'
    );
  }
  const normalized = {};
  for (const field of SIGNED_FIELDS) {
    normalized[field] = nonEmpty(source[field], field, 'SCOPED_HANDLE_INVALID');
  }
  if (normalized.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
      normalized.signatureVersion !== SIGNATURE_VERSION) {
    throw new ScopedHandleSignatureError(
      'scoped-handle signature metadata is incompatible',
      'SCOPED_HANDLE_SIGNATURE_VERSION_INVALID'
    );
  }
  const issuedMs = timestamp(normalized.issuedAt, 'SCOPED_HANDLE_TIME_INVALID');
  const expiresMs = timestamp(normalized.expiresAt, 'SCOPED_HANDLE_TIME_INVALID');
  if (issuedMs >= expiresMs) {
    throw new ScopedHandleSignatureError(
      'scoped-handle validity window is inverted',
      'SCOPED_HANDLE_TIME_INVALID'
    );
  }
  normalized.issuedAt = new Date(issuedMs).toISOString();
  normalized.expiresAt = new Date(expiresMs).toISOString();
  return Object.freeze(normalized);
}

function normalizeSignedHandle(source) {
  const unsigned = normalizeUnsignedHandle(source);
  const signature = nonEmpty(source.signature, 'signature', 'SCOPED_HANDLE_SIGNATURE_MISSING');
  decodeSignature(signature);
  return Object.freeze({ ...unsigned, signature });
}

function signingPayload(handle) {
  const payload = {};
  for (const field of SIGNED_FIELDS) payload[field] = handle[field];
  return Object.freeze(payload);
}

function decodeSignature(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ScopedHandleSignatureError(
      'scoped-handle signature encoding is invalid',
      'SCOPED_HANDLE_SIGNATURE_ENCODING_INVALID'
    );
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) {
    throw new ScopedHandleSignatureError(
      'scoped-handle signature encoding is invalid',
      'SCOPED_HANDLE_SIGNATURE_ENCODING_INVALID'
    );
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
    throw new ScopedHandleSignatureError(`${field} must be a non-empty string`, code);
  }
  return value;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScopedHandleSignatureError('timestamp is missing', code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ScopedHandleSignatureError('timestamp is invalid', code);
  }
  return parsed;
}

function validDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ScopedHandleSignatureError('verification time is invalid', code);
  }
  return value.getTime();
}
