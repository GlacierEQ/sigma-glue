import { planFingerprint } from '../plan/fingerprint.mjs';
import {
  canonicalDate,
  ColossusDispatchError,
  deepFreeze,
  rejectSecretShapedContent,
  requireString
} from './common.mjs';
import { assertExactBinding, assertPersistedPermit, validatePermit } from './permit.mjs';
import { normalizeRegistry, resolveRoute } from './registry.mjs';
import { normalizeRequest, validateScopedHandles } from './request.mjs';
import { validateReceipt } from './receipt.mjs';

const PUBLIC_FENCE_CODES = new Set([
  'DISPATCH_PERMIT_ALREADY_ATTEMPTED',
  'DISPATCH_ATTEMPT_LOCK_UNAVAILABLE',
  'DISPATCH_PERMIT_NOT_ACTIVE',
  'DISPATCH_PERMIT_EXPIRED',
  'DISPATCH_PERMIT_NOT_PERSISTED',
  'DISPATCH_PERMIT_STORE_MISMATCH'
]);

export { ColossusDispatchError } from './common.mjs';

export class ColossusDispatchAdapter {
  #registry;
  #transport;
  #permitStore;
  #timeoutMs;
  #protocolVersion;
  #schemaVersion;
  #clock;

  constructor({
    registry,
    transport,
    permitStore,
    timeoutMs = 10_000,
    protocolVersion = 'sigma-federation/v1',
    schemaVersion = 'colossus-dispatch/v1',
    clock = () => new Date()
  } = {}) {
    if (!transport || typeof transport.dispatch !== 'function' || transport.supportsAbort !== true) {
      throw new ColossusDispatchError(
        'an abort-aware transport.dispatch is required',
        'COLOSSUS_TRANSPORT_INVALID'
      );
    }
    if (!permitStore ||
        typeof permitStore.getPermitByIdempotencyKey !== 'function' ||
        typeof permitStore.beginDispatchAttempt !== 'function' ||
        typeof permitStore.completeDispatchAttempt !== 'function') {
      throw new ColossusDispatchError(
        'one-shot dispatch permit store is required',
        'DISPATCH_PERMIT_STORE_INVALID'
      );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ColossusDispatchError('timeoutMs must be a positive safe integer', 'COLOSSUS_TIMEOUT_INVALID');
    }
    if (typeof clock !== 'function') {
      throw new ColossusDispatchError('clock must be a function', 'DISPATCH_CLOCK_INVALID');
    }

    this.#registry = normalizeRegistry(registry);
    this.#transport = transport;
    this.#permitStore = permitStore;
    this.#timeoutMs = timeoutMs;
    this.#protocolVersion = requireString(protocolVersion, 'protocolVersion', 'PROTOCOL_VERSION_INVALID');
    this.#schemaVersion = requireString(schemaVersion, 'schemaVersion', 'SCHEMA_VERSION_INVALID');
    this.#clock = clock;
  }

  async dispatch({ permit, request, now = undefined } = {}) {
    const dispatchNow = now ?? this.#clock();
    const nowIso = canonicalDate(dispatchNow, 'DISPATCH_TIME_INVALID');
    const normalizedPermit = validatePermit(permit, dispatchNow);
    assertPersistedPermit(this.#permitStore, normalizedPermit);
    const normalizedRequest = normalizeRequest(request);
    if (normalizedRequest.protocolVersion !== this.#protocolVersion) {
      throw new ColossusDispatchError('protocol version is incompatible', 'PROTOCOL_VERSION_INCOMPATIBLE');
    }
    if (normalizedRequest.schemaVersion !== this.#schemaVersion) {
      throw new ColossusDispatchError('schema version is incompatible', 'SCHEMA_VERSION_INCOMPATIBLE');
    }
    assertExactBinding(normalizedPermit, normalizedRequest);
    validateScopedHandles(normalizedRequest.scopedHandles, dispatchNow, normalizedPermit.expiresAt);

    const route = resolveRoute(this.#registry, normalizedRequest);
    rejectSecretShapedContent(normalizedRequest.payload, '$.payload');
    rejectSecretShapedContent(normalizedRequest.scopedHandles, '$.scopedHandles');

    const envelopeCore = {
      protocolVersion: normalizedRequest.protocolVersion,
      schemaVersion: normalizedRequest.schemaVersion,
      requestId: normalizedRequest.requestId,
      traceId: normalizedRequest.traceId,
      jobId: normalizedRequest.jobId,
      componentRef: normalizedRequest.componentRef,
      resolvedAdapterId: route.adapterId,
      method: normalizedRequest.method,
      capability: normalizedRequest.capability,
      idempotencyKey: normalizedRequest.idempotencyKey,
      planFingerprint: normalizedRequest.planFingerprint,
      policyVersion: normalizedRequest.policyVersion,
      scopedHandles: normalizedRequest.scopedHandles,
      payload: normalizedRequest.payload,
      authorization: Object.freeze({
        permitId: normalizedPermit.permitId,
        permitFingerprint: normalizedPermit.permitFingerprint,
        expiresAt: normalizedPermit.expiresAt
      }),
      createdAt: nowIso
    };
    const envelopeFingerprint = planFingerprint(envelopeCore);
    const envelope = deepFreeze({ ...envelopeCore, envelopeFingerprint });

    let attempt;
    try {
      attempt = this.#permitStore.beginDispatchAttempt({
        permit: normalizedPermit,
        requestId: normalizedRequest.requestId,
        envelopeFingerprint,
        now: dispatchNow
      });
    } catch (error) {
      throw dispatchFenceError(error, 'DISPATCH_ATTEMPT_FENCE_FAILED');
    }

    const receipt = await dispatchOnce(this.#transport, envelope, this.#timeoutMs);
    const validatedReceipt = validateReceipt(receipt, {
      request: normalizedRequest,
      permit: normalizedPermit,
      route,
      envelopeFingerprint
    });

    try {
      this.#permitStore.completeDispatchAttempt({
        attemptId: attempt.attemptId,
        permit: normalizedPermit,
        requestId: normalizedRequest.requestId,
        envelopeFingerprint,
        receiptStatus: validatedReceipt.status,
        receiptFingerprint: planFingerprint(validatedReceipt),
        providerReceivedAt: validatedReceipt.receivedAt,
        reasonCode: validatedReceipt.reasonCode,
        now: observedDate(this.#clock(), 'DISPATCH_COMPLETION_TIME_INVALID')
      });
    } catch (error) {
      const failure = new ColossusDispatchError(
        'Colossus returned a validated dispatch outcome but durable one-shot attempt persistence failed',
        'DISPATCH_ATTEMPT_COMPLETION_FAILED',
        { cause: error }
      );
      failure.receipt = validatedReceipt;
      failure.attemptId = attempt.attemptId;
      failure.envelopeFingerprint = envelopeFingerprint;
      throw failure;
    }

    return validatedReceipt;
  }
}

function dispatchFenceError(error, fallbackCode) {
  const code = PUBLIC_FENCE_CODES.has(error?.code) ? error.code : fallbackCode;
  return new ColossusDispatchError(
    'dispatch-attempt fence rejected the request',
    code,
    { cause: error }
  );
}

function observedDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ColossusDispatchError('local observation clock returned an invalid date', code);
  }
  return value;
}

async function dispatchOnce(transport, envelope, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ColossusDispatchError('Colossus dispatch timed out', 'COLOSSUS_TIMEOUT'));
      }, timeoutMs);
      timeout.unref?.();
    });
    return await Promise.race([
      Promise.resolve().then(() => transport.dispatch(envelope, { signal: controller.signal })),
      timeoutPromise
    ]);
  } catch (error) {
    if (error instanceof ColossusDispatchError) throw error;
    throw new ColossusDispatchError('Colossus transport failed', 'COLOSSUS_TRANSPORT_FAILED', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}
