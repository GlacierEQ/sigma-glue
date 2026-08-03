import { planFingerprint } from '../plan/fingerprint.mjs';

export class RequestValidationError extends Error {
  constructor(message, code = 'REQUEST_INVALID') {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
  }
}

function assertRelativePath(value, label) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
    throw new RequestValidationError(`${label} must be a non-empty relative path`, 'PATH_OUTSIDE_SCOPE');
  }
  return value;
}

export function normalizeMoveRequest(input) {
  if (!input?.jobId || !input?.componentRef || !input?.idempotencyKey) {
    throw new RequestValidationError('jobId, componentRef, and idempotencyKey are required');
  }
  if (!input.provider?.stableId) {
    throw new RequestValidationError('provider.stableId is required', 'PROVIDER_ID_REQUIRED');
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new RequestValidationError('at least one item is required', 'ITEMS_REQUIRED');
  }
  const items = input.items.map((item, index) => ({
    stableId: item?.stableId || (() => { throw new RequestValidationError(`items[${index}].stableId is required`); })(),
    source: assertRelativePath(item.source, `items[${index}].source`),
    destination: assertRelativePath(item.destination, `items[${index}].destination`)
  }));
  const request = {
    protocolVersion: input.protocolVersion || 'sigma-federation/v1',
    jobId: input.jobId,
    componentRef: input.componentRef,
    operation: 'move',
    method: 'execute',
    provider: { stableId: input.provider.stableId },
    items,
    idempotencyKey: input.idempotencyKey
  };
  return Object.freeze({ ...request, requestFingerprint: planFingerprint(request) });
}

export function makeMovePlan(request) {
  const plan = {
    protocolVersion: request.protocolVersion,
    operation: request.operation,
    provider: request.provider,
    items: request.items.map((item) => ({ ...item })),
    componentRef: request.componentRef,
    method: request.method,
    idempotencyKey: request.idempotencyKey
  };
  return Object.freeze({ ...plan, planFingerprint: planFingerprint(plan) });
}

export function makeCompensationPlan(result) {
  const original = result.plan;
  const plan = {
    protocolVersion: original.protocolVersion,
    operation: 'compensate',
    provider: original.provider,
    items: original.items.map((item) => ({
      stableId: item.stableId,
      source: item.destination,
      destination: item.source
    })),
    componentRef: original.componentRef,
    method: 'compensate',
    idempotencyKey: `${original.idempotencyKey}:compensate`
  };
  return Object.freeze({ ...plan, planFingerprint: planFingerprint(plan) });
}
