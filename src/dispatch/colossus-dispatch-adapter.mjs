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

export { ColossusDispatchError } from './common.mjs';

export class ColossusDispatchAdapter {
  #registry;
  #transport;
  #permitStore;
  #timeoutMs;
  #protocolVersion;
  #schemaVersion;

  constructor({
    registry,
    transport,
    permitStore,
    timeoutMs = 10_000,
    protocolVersion = 'sigma-federation/v1',
    schemaVersion = 'colossus-dispatch/v1'
  } = {}) {
    if (!transport || typeof transport.dispatch !== 'function' || transport.supportsAbort !== true) {
      throw new ColossusDispatchError(
        'an abort-aware transport.dispatch is required',
        'COLOSSUS_TRANSPORT_INVALID'
      );
    }
    if (!permitStore || typeof permitStore.getPermitByIdempotencyKey !== 'function') {
      throw new ColossusDispatchError('permit store is required', 'DISPATCH_PERMIT_STORE_INVALID');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new ColossusDispatchError('timeoutMs must be a positive safe integer', 'COLOSSUS_TIMEOUT_INVALID');
    }

    this.#registry = normalizeRegistry(registry);
    this.#transport = transport;
    this.#permitStore = permitStore;
    this.#timeoutMs = timeoutMs;
    this.#protocolVersion = requireString(protocolVersion, 'protocolVersion', 'PROTOCOL_VERSION_INVALID');
    this.#schemaVersion = requireString(schemaVersion, 'schemaVersion', 'SCHEMA_VERSION_INVALID');
  }

  async dispatch({ permit, request, now = new Date() }) {
    const nowIso = canonicalDate(now, 'DISPATCH_TIME_INVALID');
    const normalizedPermit = validatePermit(permit, now);
    assertPersistedPermit(this.#permitStore, normalizedPermit);
    const normalizedRequest = normalizeRequest(request);
    if (normalizedRequest.protocolVersion !== this.#protocolVersion) {
      throw new ColossusDispatchError('protocol version is incompatible', 'PROTOCOL_VERSION_INCOMPATIBLE');
    }
    if (normalizedRequest.schemaVersion !== this.#schemaVersion) {
      throw new ColossusDispatchError('schema version is incompatible', 'SCHEMA_VERSION_INCOMPATIBLE');
    }
    assertExactBinding(normalizedPermit, normalizedRequest);
    validateScopedHandles(normalizedRequest.scopedHandles, now, normalizedPermit.expiresAt);

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
    const receipt = await dispatchOnce(this.#transport, envelope, this.#timeoutMs);

    return validateReceipt(receipt, {
      request: normalizedRequest,
      permit: normalizedPermit,
      route,
      envelopeFingerprint
    });
  }
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
