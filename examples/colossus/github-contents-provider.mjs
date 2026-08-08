import { createHash } from 'node:crypto';

import { ColossusDispatchError, deepFreeze } from '../../src/dispatch/common.mjs';

const HANDLE_PATTERN = /^credh_[A-Za-z0-9._~-]{8,256}$/;
const MAX_CONTENT_BYTES = 65_536;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i;

export class GitHubContentsProviderError extends Error {
  constructor(message, code = 'GITHUB_CONTENTS_PROVIDER_FAILED', options = undefined) {
    super(message, options);
    this.name = 'GitHubContentsProviderError';
    this.code = code;
  }
}

export class GitHubContentsProviderUncertainError extends GitHubContentsProviderError {
  constructor(message, uncertainty, options = undefined) {
    super(message, 'GITHUB_CONTENTS_PROVIDER_UNCERTAIN', options);
    this.name = 'GitHubContentsProviderUncertainError';
    this.uncertainty = deepFreeze(structuredClone(uncertainty));
  }
}

/**
 * Downstream Colossus reference for GitHub Contents conditional writes.
 * Provider credentials remain inside the opaque broker; Sigma never receives
 * or persists them.
 */
export class GitHubContentsColossusTransport {
  supportsAbort = true;

  #broker;
  #credentialHandle;
  #apiBase;
  #clock;

  constructor({
    credentialBroker,
    credentialHandle,
    apiBase = 'https://api.github.com',
    clock = () => new Date()
  } = {}) {
    assertBroker(credentialBroker, credentialHandle);
    if (typeof clock !== 'function') {
      throw new GitHubContentsProviderError('clock must be a function', 'GITHUB_CONTENTS_CLOCK_INVALID');
    }
    this.#broker = credentialBroker;
    this.#credentialHandle = credentialHandle;
    this.#apiBase = normalizeApiBase(apiBase);
    this.#clock = clock;
  }

  async dispatch(envelope, { signal } = {}) {
    assertSignal(signal);
    const intent = normalizeIntent(envelope?.payload);
    const baseline = await readTarget({
      broker: this.#broker,
      credentialHandle: this.#credentialHandle,
      apiBase: this.#apiBase,
      target: intent.target,
      signal
    });

    if (baseline.exists && baseline.contentFingerprint === intent.desiredFingerprint) {
      return receipt(envelope, {
        status: 'dispatched',
        receivedAt: observedDate(this.#clock()).toISOString(),
        diagnostics: ['github-contents-idempotent-replay']
      });
    }

    if (!sameBaseline(baseline, intent.baseline)) {
      return receipt(envelope, {
        status: 'blocked',
        reasonCode: 'PROVIDER_CONDITIONAL_WRITE_CONFLICT',
        receivedAt: observedDate(this.#clock()).toISOString(),
        diagnostics: ['github-contents-baseline-mismatch']
      });
    }

    const uncertainty = deepFreeze({
      provider: 'github-contents/v1',
      operation: 'put',
      idempotencyKey: envelope.idempotencyKey,
      requestId: envelope.requestId,
      envelopeFingerprint: envelope.envelopeFingerprint,
      desiredFingerprint: intent.desiredFingerprint,
      target: intent.target,
      baseline: intent.baseline
    });

    let response;
    try {
      response = await this.#broker.authorizedFetch({
        credentialHandle: this.#credentialHandle,
        url: contentsUrl(this.#apiBase, intent.target),
        request: deepFreeze({
          method: 'PUT',
          headers: {
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28'
          },
          body: JSON.stringify({
            message: intent.commitMessage,
            content: Buffer.from(intent.desiredContent, 'utf8').toString('base64'),
            branch: intent.target.branch,
            ...(baseline.exists ? { sha: baseline.version } : {})
          }),
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit'
        }),
        signal
      });
      validateResponse(response);
    } catch (error) {
      throw uncertain('GitHub Contents mutation outcome is uncertain', uncertainty, error);
    }

    if (response.status === 409 || response.status === 422) {
      const converged = await readTarget({
        broker: this.#broker,
        credentialHandle: this.#credentialHandle,
        apiBase: this.#apiBase,
        target: intent.target,
        signal
      });
      if (converged.exists && converged.contentFingerprint === intent.desiredFingerprint) {
        return receipt(envelope, {
          status: 'dispatched',
          receivedAt: observedDate(this.#clock()).toISOString(),
          diagnostics: ['github-contents-concurrent-idempotent-convergence']
        });
      }
      return receipt(envelope, {
        status: 'blocked',
        reasonCode: 'PROVIDER_CONDITIONAL_WRITE_CONFLICT',
        receivedAt: observedDate(this.#clock()).toISOString(),
        diagnostics: ['github-contents-conditional-write-rejected']
      });
    }

    if (response.status >= 500) {
      throw uncertain(
        `GitHub Contents returned HTTP ${response.status} after mutation submission`,
        uncertainty
      );
    }
    if (response.status < 200 || response.status > 299) {
      return receipt(envelope, {
        status: 'failed',
        reasonCode: 'PROVIDER_HTTP_REJECTED',
        receivedAt: observedDate(this.#clock()).toISOString(),
        diagnostics: [`github-contents-http-${response.status}`]
      });
    }

    let body;
    try {
      body = await readJson(response, 'GITHUB_CONTENTS_WRITE_RESPONSE_INVALID');
      if (!body?.commit?.sha || !body?.content?.sha) {
        throw new GitHubContentsProviderError(
          'GitHub accepted a mutation but returned incomplete commit evidence',
          'GITHUB_CONTENTS_WRITE_RESPONSE_INVALID'
        );
      }
    } catch (error) {
      throw uncertain(
        'GitHub accepted a mutation but its success response could not prove the outcome',
        uncertainty,
        error
      );
    }

    return receipt(envelope, {
      status: 'dispatched',
      receivedAt: observedDate(this.#clock()).toISOString(),
      diagnostics: ['github-contents-write-accepted']
    });
  }
}

/** Read-only provider observer consumed by the generic recovery coordinator. */
export class GitHubContentsProviderObserver {
  #broker;
  #credentialHandle;
  #apiBase;

  constructor({ credentialBroker, credentialHandle, apiBase = 'https://api.github.com' } = {}) {
    assertBroker(credentialBroker, credentialHandle);
    this.#broker = credentialBroker;
    this.#credentialHandle = credentialHandle;
    this.#apiBase = normalizeApiBase(apiBase);
  }

  async inspectOutcome({ uncertainty, signal } = {}) {
    const target = normalizeTarget(uncertainty?.target);
    const result = await readTarget({
      broker: this.#broker,
      credentialHandle: this.#credentialHandle,
      apiBase: this.#apiBase,
      target,
      signal
    });
    return deepFreeze({
      target,
      exists: result.exists,
      contentFingerprint: result.contentFingerprint,
      version: result.version,
      providerRequestId: result.providerRequestId
    });
  }
}

export function githubContentFingerprint(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function readTarget({ broker, credentialHandle, apiBase, target, signal }) {
  let response;
  try {
    response = await broker.authorizedFetch({
      credentialHandle,
      url: contentsUrl(apiBase, target, true),
      request: readRequest(),
      signal
    });
    validateResponse(response);
  } catch (error) {
    throw new GitHubContentsProviderError(
      'GitHub Contents observation failed',
      'GITHUB_CONTENTS_OBSERVATION_FAILED',
      { cause: error }
    );
  }

  const providerRequestId = safeRequestId(response.headers.get('x-github-request-id'));
  if (response.status === 404) {
    await assertTargetScopeExists({ broker, credentialHandle, apiBase, target, signal });
    return Object.freeze({
      exists: false,
      contentFingerprint: null,
      version: null,
      providerRequestId
    });
  }
  if (response.status < 200 || response.status > 299) {
    throw new GitHubContentsProviderError(
      `GitHub Contents observation returned HTTP ${response.status}`,
      'GITHUB_CONTENTS_OBSERVATION_REJECTED'
    );
  }

  const body = await readJson(response, 'GITHUB_CONTENTS_OBSERVATION_INVALID');
  if (body?.type !== 'file' || typeof body.sha !== 'string' || body.sha.trim() === '' ||
      body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new GitHubContentsProviderError(
      'GitHub Contents observation is not an exact file record',
      'GITHUB_CONTENTS_OBSERVATION_INVALID'
    );
  }
  const bytes = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
  if (bytes.length > MAX_CONTENT_BYTES) {
    throw new GitHubContentsProviderError(
      'GitHub Contents observation exceeds proof size limit',
      'GITHUB_CONTENTS_CONTENT_TOO_LARGE'
    );
  }
  return Object.freeze({
    exists: true,
    contentFingerprint: githubContentFingerprint(bytes),
    version: body.sha,
    providerRequestId
  });
}

async function assertTargetScopeExists({ broker, credentialHandle, apiBase, target, signal }) {
  const repositoryResponse = await scopeFetch({
    broker,
    credentialHandle,
    url: repositoryUrl(apiBase, target),
    signal
  });
  if (repositoryResponse.status < 200 || repositoryResponse.status > 299) {
    throw new GitHubContentsProviderError(
      'GitHub repository scope could not be verified',
      'GITHUB_CONTENTS_TARGET_UNRESOLVED'
    );
  }

  const refResponse = await scopeFetch({
    broker,
    credentialHandle,
    url: branchRefUrl(apiBase, target),
    signal
  });
  if (refResponse.status < 200 || refResponse.status > 299) {
    throw new GitHubContentsProviderError(
      'GitHub branch scope could not be verified',
      'GITHUB_CONTENTS_TARGET_UNRESOLVED'
    );
  }
  const refBody = await readJson(refResponse, 'GITHUB_CONTENTS_TARGET_UNRESOLVED');
  if (typeof refBody.ref !== 'string' || !refBody.ref.startsWith('refs/heads/')) {
    throw new GitHubContentsProviderError(
      'GitHub branch scope returned invalid ref evidence',
      'GITHUB_CONTENTS_TARGET_UNRESOLVED'
    );
  }
}

async function scopeFetch({ broker, credentialHandle, url, signal }) {
  try {
    const response = await broker.authorizedFetch({
      credentialHandle,
      url,
      request: readRequest(),
      signal
    });
    validateResponse(response);
    return response;
  } catch (error) {
    if (error instanceof GitHubContentsProviderError) throw error;
    throw new GitHubContentsProviderError(
      'GitHub target scope verification failed',
      'GITHUB_CONTENTS_TARGET_UNRESOLVED',
      { cause: error }
    );
  }
}

function readRequest() {
  return deepFreeze({
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    },
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit'
  });
}

function normalizeIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.provider?.stableId !== 'github-contents/v1' || value.operation !== 'put') {
    throw new GitHubContentsProviderError('GitHub Contents intent is invalid', 'GITHUB_CONTENTS_INTENT_INVALID');
  }
  const target = normalizeTarget(value.target);
  const desired = value.desired;
  if (!desired || desired.encoding !== 'utf-8' || typeof desired.content !== 'string') {
    throw new GitHubContentsProviderError('desired UTF-8 content is required', 'GITHUB_CONTENTS_INTENT_INVALID');
  }
  const bytes = Buffer.from(desired.content, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_CONTENT_BYTES) {
    throw new GitHubContentsProviderError('desired content size is invalid', 'GITHUB_CONTENTS_CONTENT_TOO_LARGE');
  }
  const desiredFingerprint = githubContentFingerprint(bytes);
  if (desired.fingerprint !== desiredFingerprint) {
    throw new GitHubContentsProviderError(
      'desired content fingerprint does not match bytes',
      'GITHUB_CONTENTS_DESIRED_FINGERPRINT_MISMATCH'
    );
  }
  return Object.freeze({
    target,
    desiredContent: desired.content,
    desiredFingerprint,
    baseline: normalizeBaseline(value.baseline),
    commitMessage: safeString(value.commitMessage, 'commitMessage')
  });
}

function normalizeBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.exists !== 'boolean') {
    throw new GitHubContentsProviderError('baseline is invalid', 'GITHUB_CONTENTS_BASELINE_INVALID');
  }
  if (!value.exists) {
    if (value.contentFingerprint != null || value.version != null) {
      throw new GitHubContentsProviderError('missing baseline overclaims evidence', 'GITHUB_CONTENTS_BASELINE_INVALID');
    }
    return Object.freeze({ exists: false, contentFingerprint: null, version: null });
  }
  const contentFingerprint = safeString(value.contentFingerprint, 'baseline.contentFingerprint');
  if (!/^sha256:[0-9a-f]{64}$/.test(contentFingerprint)) {
    throw new GitHubContentsProviderError('baseline fingerprint is invalid', 'GITHUB_CONTENTS_BASELINE_INVALID');
  }
  return Object.freeze({
    exists: true,
    contentFingerprint,
    version: safeString(value.version, 'baseline.version')
  });
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubContentsProviderError('target is invalid', 'GITHUB_CONTENTS_TARGET_INVALID');
  }
  const unknown = Object.keys(value).filter((field) => !['owner', 'repo', 'branch', 'path'].includes(field));
  if (unknown.length > 0) {
    throw new GitHubContentsProviderError(`target contains unsupported field ${unknown[0]}`, 'GITHUB_CONTENTS_TARGET_INVALID');
  }
  const path = safeString(value.path, 'target.path');
  if (path.startsWith('/') || path.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new GitHubContentsProviderError('target path is unsafe', 'GITHUB_CONTENTS_TARGET_INVALID');
  }
  return Object.freeze({
    owner: safeSlug(value.owner, 'target.owner'),
    repo: safeSlug(value.repo, 'target.repo'),
    branch: safeString(value.branch, 'target.branch'),
    path
  });
}

function sameBaseline(actual, expected) {
  if (actual.exists !== expected.exists) return false;
  if (!actual.exists) return true;
  return actual.contentFingerprint === expected.contentFingerprint && actual.version === expected.version;
}

function receipt(envelope, { status, reasonCode = null, receivedAt, diagnostics }) {
  if (!envelope?.authorization?.permitFingerprint) {
    throw new ColossusDispatchError('provider transport envelope is incomplete', 'COLOSSUS_ENVELOPE_INVALID');
  }
  const receiptId = `receipt_${createHash('sha256')
    .update(`${envelope.requestId}\0${envelope.envelopeFingerprint}\0${status}`, 'utf8')
    .digest('hex')}`;
  return deepFreeze({
    receiptId,
    requestId: envelope.requestId,
    envelopeFingerprint: envelope.envelopeFingerprint,
    permitFingerprint: envelope.authorization.permitFingerprint,
    componentRef: envelope.componentRef,
    method: envelope.method,
    idempotencyKey: envelope.idempotencyKey,
    resolvedAdapterId: envelope.resolvedAdapterId,
    capability: envelope.capability,
    status,
    ...(reasonCode ? { reasonCode } : {}),
    receivedAt,
    redactedDiagnostics: diagnostics
  });
}

function contentsUrl(apiBase, target, includeRef = false) {
  const path = target.path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${path}`, apiBase);
  if (includeRef) url.searchParams.set('ref', target.branch);
  return url.href;
}

function repositoryUrl(apiBase, target) {
  return new URL(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`, apiBase).href;
}

function branchRefUrl(apiBase, target) {
  const branch = target.branch.split('/').map(encodeURIComponent).join('/');
  return new URL(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/ref/heads/${branch}`, apiBase).href;
}

async function readJson(response, code) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    throw new GitHubContentsProviderError('provider response is not JSON', code);
  }
  let value;
  try {
    value = await response.json();
  } catch (error) {
    throw new GitHubContentsProviderError('provider returned malformed JSON', code, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubContentsProviderError('provider JSON response shape is invalid', code);
  }
  return value;
}

function validateResponse(response) {
  if (!response || typeof response !== 'object' || !Number.isInteger(response.status) ||
      !response.headers || typeof response.headers.get !== 'function' || typeof response.json !== 'function') {
    throw new GitHubContentsProviderError('provider response is invalid', 'GITHUB_CONTENTS_RESPONSE_INVALID');
  }
}

function assertBroker(broker, credentialHandle) {
  if (!broker || broker.supportsOpaqueHandles !== true || typeof broker.authorizedFetch !== 'function') {
    throw new GitHubContentsProviderError('opaque credential broker is required', 'GITHUB_CONTENTS_BROKER_INVALID');
  }
  if (typeof credentialHandle !== 'string' || !HANDLE_PATTERN.test(credentialHandle)) {
    throw new GitHubContentsProviderError('credential handle is invalid', 'GITHUB_CONTENTS_HANDLE_INVALID');
  }
}

function assertSignal(signal) {
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
    throw new GitHubContentsProviderError('AbortSignal is required', 'GITHUB_CONTENTS_ABORT_SIGNAL_REQUIRED');
  }
  if (signal.aborted) {
    throw new GitHubContentsProviderError('request was aborted before provider dispatch', 'GITHUB_CONTENTS_REQUEST_ABORTED');
  }
}

function normalizeApiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new GitHubContentsProviderError('GitHub API base is invalid', 'GITHUB_CONTENTS_API_BASE_INVALID', { cause: error });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new GitHubContentsProviderError(
      'GitHub API base must be a clean HTTPS origin',
      'GITHUB_CONTENTS_API_BASE_INVALID'
    );
  }
  return url.origin;
}

function safeSlug(value, field) {
  value = safeString(value, field);
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new GitHubContentsProviderError(`${field} is invalid`, 'GITHUB_CONTENTS_TARGET_INVALID');
  }
  return value;
}

function safeString(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new GitHubContentsProviderError(`${field} must be a non-empty safe string`, 'GITHUB_CONTENTS_FIELD_INVALID');
  }
  return value;
}

function safeRequestId(value) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

function observedDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new GitHubContentsProviderError('clock returned an invalid date', 'GITHUB_CONTENTS_CLOCK_INVALID');
  }
  return value;
}

function uncertain(message, uncertainty, cause = undefined) {
  return new GitHubContentsProviderUncertainError(
    message,
    uncertainty,
    cause === undefined ? undefined : { cause }
  );
}
