import { canonicalize } from '../plan/fingerprint.mjs';
import { ColossusDispatchError, deepFreeze } from '../dispatch/common.mjs';

const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i;
const HANDLE_PATTERN = /^credh_[A-Za-z0-9._~-]{8,256}$/;

/**
 * Concrete Colossus HTTPS transport whose credential broker owns authenticated
 * I/O. Sigma Glue passes only an opaque handle and never receives raw secrets.
 */
export class OpaqueBrokerColossusHttpTransport {
  supportsAbort = true;

  #endpoint;
  #credentialBroker;
  #credentialHandle;
  #maxResponseBytes;
  #allowedOrigins;

  constructor({
    endpoint,
    credentialBroker,
    credentialHandle,
    maxResponseBytes = 1_048_576,
    allowedOrigins
  } = {}) {
    this.#endpoint = normalizeEndpoint(endpoint);
    if (!credentialBroker || credentialBroker.supportsOpaqueHandles !== true ||
        typeof credentialBroker.authorizedFetch !== 'function') {
      throw new ColossusDispatchError(
        'an opaque-handle credential broker is required',
        'CREDENTIAL_BROKER_INVALID'
      );
    }
    if (typeof credentialHandle !== 'string' || !HANDLE_PATTERN.test(credentialHandle)) {
      throw new ColossusDispatchError('credential handle is invalid', 'CREDENTIAL_HANDLE_INVALID');
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
      throw new ColossusDispatchError('maxResponseBytes must be a positive safe integer', 'COLOSSUS_RESPONSE_LIMIT_INVALID');
    }

    const origins = allowedOrigins ?? [this.#endpoint.origin];
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new ColossusDispatchError('at least one allowed Colossus origin is required', 'COLOSSUS_ORIGIN_POLICY_INVALID');
    }
    this.#allowedOrigins = new Set(origins.map(normalizeOrigin));
    if (!this.#allowedOrigins.has(this.#endpoint.origin)) {
      throw new ColossusDispatchError('configured endpoint is outside the allowed origins', 'COLOSSUS_ORIGIN_NOT_ALLOWED');
    }

    this.#credentialBroker = credentialBroker;
    this.#credentialHandle = credentialHandle;
    this.#maxResponseBytes = maxResponseBytes;
  }

  async dispatch(envelope, { signal } = {}) {
    if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
      throw new ColossusDispatchError('an AbortSignal is required', 'COLOSSUS_ABORT_SIGNAL_REQUIRED');
    }
    if (signal.aborted) {
      throw new ColossusDispatchError('Colossus request was aborted before dispatch', 'COLOSSUS_REQUEST_ABORTED');
    }

    const body = canonicalize(envelope);
    const request = deepFreeze({
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-sigma-envelope-fingerprint': envelope.envelopeFingerprint,
        'x-sigma-request-id': envelope.requestId,
        'x-sigma-trace-id': envelope.traceId
      },
      body,
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit'
    });

    let response;
    try {
      response = await this.#credentialBroker.authorizedFetch({
        credentialHandle: this.#credentialHandle,
        url: this.#endpoint.href,
        request,
        signal
      });
    } catch (error) {
      if (signal.aborted) {
        throw new ColossusDispatchError('Colossus request was aborted', 'COLOSSUS_REQUEST_ABORTED', { cause: error });
      }
      throw new ColossusDispatchError('credential broker request failed', 'CREDENTIAL_BROKER_REQUEST_FAILED', { cause: error });
    }

    validateResponseShape(response);
    if (typeof response.url === 'string' && response.url !== '') {
      const responseUrl = normalizeEndpoint(response.url);
      if (!this.#allowedOrigins.has(responseUrl.origin) || responseUrl.href !== this.#endpoint.href) {
        throw new ColossusDispatchError('Colossus response origin or URL changed', 'COLOSSUS_REDIRECT_REJECTED');
      }
    }

    if (response.status < 200 || response.status > 299) {
      throw new ColossusDispatchError(
        `Colossus rejected the request with HTTP ${response.status}`,
        'COLOSSUS_HTTP_REJECTED'
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      throw new ColossusDispatchError('Colossus response is not JSON', 'COLOSSUS_CONTENT_TYPE_INVALID');
    }

    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      const parsed = Number(declaredLength);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new ColossusDispatchError('Colossus content length is invalid', 'COLOSSUS_CONTENT_LENGTH_INVALID');
      }
      if (parsed > this.#maxResponseBytes) {
        throw new ColossusDispatchError('Colossus response exceeds the configured limit', 'COLOSSUS_RESPONSE_TOO_LARGE');
      }
    }

    const bytes = await readResponseBytes(response);
    if (bytes.length > this.#maxResponseBytes) {
      throw new ColossusDispatchError('Colossus response exceeds the configured limit', 'COLOSSUS_RESPONSE_TOO_LARGE');
    }

    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new ColossusDispatchError('Colossus returned malformed JSON', 'COLOSSUS_RESPONSE_JSON_INVALID', { cause: error });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ColossusDispatchError('Colossus response must be an object', 'COLOSSUS_RESPONSE_SHAPE_INVALID');
    }
    return parsed;
  }
}

function normalizeEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ColossusDispatchError('Colossus endpoint is invalid', 'COLOSSUS_ENDPOINT_INVALID', { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw new ColossusDispatchError('Colossus endpoint must use HTTPS', 'COLOSSUS_ENDPOINT_INSECURE');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ColossusDispatchError('Colossus endpoint cannot contain credentials, query, or fragment', 'COLOSSUS_ENDPOINT_UNSAFE');
  }
  return url;
}

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ColossusDispatchError('allowed Colossus origin is invalid', 'COLOSSUS_ORIGIN_POLICY_INVALID', { cause: error });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ColossusDispatchError('allowed origin must be an HTTPS origin only', 'COLOSSUS_ORIGIN_POLICY_INVALID');
  }
  return url.origin;
}

function validateResponseShape(response) {
  if (!response || typeof response !== 'object' || !Number.isInteger(response.status) ||
      response.status < 100 || response.status > 599 ||
      !response.headers || typeof response.headers.get !== 'function') {
    throw new ColossusDispatchError('credential broker returned an invalid response', 'COLOSSUS_RESPONSE_INVALID');
  }
  if (typeof response.arrayBuffer !== 'function' && typeof response.text !== 'function') {
    throw new ColossusDispatchError('Colossus response body reader is missing', 'COLOSSUS_RESPONSE_INVALID');
  }
}

async function readResponseBytes(response) {
  try {
    if (typeof response.arrayBuffer === 'function') {
      return Buffer.from(await response.arrayBuffer());
    }
    return Buffer.from(await response.text(), 'utf8');
  } catch (error) {
    throw new ColossusDispatchError('failed to read Colossus response', 'COLOSSUS_RESPONSE_READ_FAILED', { cause: error });
  }
}
