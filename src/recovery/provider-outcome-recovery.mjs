import { planFingerprint } from '../plan/fingerprint.mjs';

const RECOVERY_STATES = new Set([
  'confirmed_applied',
  'confirmed_not_applied',
  'still_unknown'
]);

export class ProviderOutcomeRecoveryError extends Error {
  constructor(message, code = 'PROVIDER_RECOVERY_FAILED', options = undefined) {
    super(message, options);
    this.name = 'ProviderOutcomeRecoveryError';
    this.code = code;
  }
}

/**
 * Coordinates recovery after a provider-boundary outcome becomes ambiguous.
 *
 * This class never performs a mutation. It asks a provider observer to inspect
 * current state and classifies that observation against the exact desired and
 * baseline fingerprints captured by the approved mutation intent.
 *
 * Safe retry rule:
 * - confirmed_applied     -> reconcile; never replay
 * - confirmed_not_applied -> a new authorization is required before retry
 * - still_unknown         -> freeze; never replay automatically
 */
export class ProviderOutcomeRecoveryCoordinator {
  #observer;
  #clock;

  constructor({ observer, clock = () => new Date() } = {}) {
    if (!observer || typeof observer.inspectOutcome !== 'function') {
      throw new ProviderOutcomeRecoveryError(
        'provider outcome observer is required',
        'PROVIDER_OBSERVER_INVALID'
      );
    }
    if (typeof clock !== 'function') {
      throw new ProviderOutcomeRecoveryError('clock must be a function', 'PROVIDER_RECOVERY_CLOCK_INVALID');
    }
    this.#observer = observer;
    this.#clock = clock;
  }

  async recover({ uncertainty } = {}) {
    const normalized = normalizeUncertainty(uncertainty);
    const observedAt = observedDate(this.#clock());

    let observation;
    try {
      observation = await this.#observer.inspectOutcome({
        uncertainty: normalized,
        now: observedAt
      });
    } catch (error) {
      return freezeResult({
        uncertainty: normalized,
        state: 'still_unknown',
        observation: null,
        observedAt,
        reasonCode: 'PROVIDER_OBSERVATION_FAILED',
        retryDisposition: 'forbidden_until_resolved',
        cause: error
      });
    }

    const exactObservation = normalizeObservation(observation, normalized, observedAt);
    const state = classifyOutcome(normalized, exactObservation);
    const reasonCode = state === 'confirmed_applied'
      ? 'DESIRED_FINGERPRINT_OBSERVED'
      : state === 'confirmed_not_applied'
        ? 'BASELINE_FINGERPRINT_OBSERVED'
        : 'PROVIDER_STATE_DIVERGED';
    const retryDisposition = state === 'confirmed_applied'
      ? 'do_not_retry_reconcile'
      : state === 'confirmed_not_applied'
        ? 'requires_new_authorization'
        : 'forbidden_until_resolved';

    return freezeResult({
      uncertainty: normalized,
      state,
      observation: exactObservation,
      observedAt,
      reasonCode,
      retryDisposition
    });
  }
}

export function providerRecoveryFingerprint(value) {
  const normalized = normalizeRecoveryRecord(value);
  return planFingerprint(normalized);
}

function classifyOutcome(uncertainty, observation) {
  if (observation.exists && observation.contentFingerprint === uncertainty.desiredFingerprint) {
    return 'confirmed_applied';
  }
  if (!uncertainty.baseline.exists && !observation.exists) {
    return 'confirmed_not_applied';
  }
  if (uncertainty.baseline.exists && observation.exists &&
      observation.contentFingerprint === uncertainty.baseline.contentFingerprint &&
      observation.version === uncertainty.baseline.version) {
    return 'confirmed_not_applied';
  }
  return 'still_unknown';
}

function normalizeUncertainty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderOutcomeRecoveryError(
      'provider uncertainty record is required',
      'PROVIDER_UNCERTAINTY_INVALID'
    );
  }
  const target = exactTarget(value.target);
  const baseline = normalizeBaseline(value.baseline);
  return Object.freeze({
    provider: requiredString(value.provider, 'provider'),
    operation: requiredString(value.operation, 'operation'),
    idempotencyKey: requiredString(value.idempotencyKey, 'idempotencyKey'),
    requestId: requiredString(value.requestId, 'requestId'),
    envelopeFingerprint: requiredFingerprint(value.envelopeFingerprint, 'envelopeFingerprint'),
    desiredFingerprint: requiredFingerprint(value.desiredFingerprint, 'desiredFingerprint'),
    target,
    baseline
  });
}

function normalizeBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.exists !== 'boolean') {
    throw new ProviderOutcomeRecoveryError('baseline is invalid', 'PROVIDER_BASELINE_INVALID');
  }
  if (!value.exists) {
    if (value.contentFingerprint != null || value.version != null) {
      throw new ProviderOutcomeRecoveryError(
        'missing baseline cannot claim content or version evidence',
        'PROVIDER_BASELINE_INVALID'
      );
    }
    return Object.freeze({ exists: false, contentFingerprint: null, version: null });
  }
  return Object.freeze({
    exists: true,
    contentFingerprint: requiredFingerprint(value.contentFingerprint, 'baseline.contentFingerprint'),
    version: requiredString(value.version, 'baseline.version')
  });
}

function normalizeObservation(value, uncertainty, observedAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.exists !== 'boolean') {
    throw new ProviderOutcomeRecoveryError(
      'provider observation is invalid',
      'PROVIDER_OBSERVATION_INVALID'
    );
  }
  const target = exactTarget(value.target);
  if (planFingerprint(target) !== planFingerprint(uncertainty.target)) {
    throw new ProviderOutcomeRecoveryError(
      'provider observation target does not match uncertainty target',
      'PROVIDER_OBSERVATION_TARGET_MISMATCH'
    );
  }
  if (!value.exists) {
    if (value.contentFingerprint != null || value.version != null) {
      throw new ProviderOutcomeRecoveryError(
        'missing provider observation cannot claim content or version evidence',
        'PROVIDER_OBSERVATION_INVALID'
      );
    }
    return Object.freeze({
      target,
      exists: false,
      contentFingerprint: null,
      version: null,
      providerRequestId: optionalString(value.providerRequestId),
      observedAt: observedAt.toISOString()
    });
  }
  return Object.freeze({
    target,
    exists: true,
    contentFingerprint: requiredFingerprint(value.contentFingerprint, 'observation.contentFingerprint'),
    version: requiredString(value.version, 'observation.version'),
    providerRequestId: optionalString(value.providerRequestId),
    observedAt: observedAt.toISOString()
  });
}

function normalizeRecoveryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !RECOVERY_STATES.has(value.state)) {
    throw new ProviderOutcomeRecoveryError('recovery record is invalid', 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  return Object.freeze({
    state: value.state,
    reasonCode: requiredString(value.reasonCode, 'reasonCode'),
    retryDisposition: requiredString(value.retryDisposition, 'retryDisposition'),
    uncertainty: normalizeUncertainty(value.uncertainty),
    observation: value.observation == null ? null : normalizeStoredObservation(value.observation)
  });
}

function normalizeStoredObservation(value) {
  const target = exactTarget(value.target);
  if (typeof value.exists !== 'boolean') {
    throw new ProviderOutcomeRecoveryError('stored observation is invalid', 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  if (!value.exists) {
    return Object.freeze({
      target,
      exists: false,
      contentFingerprint: null,
      version: null,
      providerRequestId: optionalString(value.providerRequestId),
      observedAt: canonicalTimestamp(value.observedAt)
    });
  }
  return Object.freeze({
    target,
    exists: true,
    contentFingerprint: requiredFingerprint(value.contentFingerprint, 'observation.contentFingerprint'),
    version: requiredString(value.version, 'observation.version'),
    providerRequestId: optionalString(value.providerRequestId),
    observedAt: canonicalTimestamp(value.observedAt)
  });
}

function freezeResult({ uncertainty, state, observation, observedAt, reasonCode, retryDisposition, cause }) {
  const result = {
    state,
    reasonCode,
    retryDisposition,
    uncertainty,
    observation,
    observedAt: observedAt.toISOString()
  };
  if (cause) {
    Object.defineProperty(result, 'cause', {
      value: cause,
      enumerable: false,
      writable: false,
      configurable: false
    });
  }
  return Object.freeze(result);
}

function exactTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderOutcomeRecoveryError('provider target is invalid', 'PROVIDER_TARGET_INVALID');
  }
  const unknown = Object.keys(value).filter(
    (field) => !['owner', 'repo', 'branch', 'path'].includes(field)
  );
  if (unknown.length > 0) {
    throw new ProviderOutcomeRecoveryError(
      `provider target contains unsupported field ${unknown[0]}`,
      'PROVIDER_TARGET_INVALID'
    );
  }
  const path = requiredString(value.path, 'target.path');
  if (path.startsWith('/') || path.includes('..') || /[\u0000-\u001F\u007F]/.test(path)) {
    throw new ProviderOutcomeRecoveryError('provider target path is unsafe', 'PROVIDER_TARGET_INVALID');
  }
  return Object.freeze({
    owner: requiredString(value.owner, 'target.owner'),
    repo: requiredString(value.repo, 'target.repo'),
    branch: requiredString(value.branch, 'target.branch'),
    path
  });
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new ProviderOutcomeRecoveryError(`${field} must be a non-empty safe string`, 'PROVIDER_RECOVERY_FIELD_INVALID');
  }
  return value;
}

function requiredFingerprint(value, field) {
  value = requiredString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ProviderOutcomeRecoveryError(`${field} must be a sha256 fingerprint`, 'PROVIDER_RECOVERY_FINGERPRINT_INVALID');
  }
  return value;
}

function optionalString(value) {
  if (value == null) return null;
  return requiredString(value, 'optional string');
}

function observedDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ProviderOutcomeRecoveryError('clock returned an invalid date', 'PROVIDER_RECOVERY_CLOCK_INVALID');
  }
  return value;
}

function canonicalTimestamp(value) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.getTime())) {
    throw new ProviderOutcomeRecoveryError('observation timestamp is invalid', 'PROVIDER_RECOVERY_RECORD_INVALID');
  }
  return parsed.toISOString();
}
