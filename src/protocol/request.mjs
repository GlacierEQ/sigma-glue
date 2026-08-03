import { deepFreeze, planFingerprint } from '../plan/fingerprint.mjs';

export class RequestValidationError extends Error {
  constructor(message, code = 'REQUEST_INVALID') {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
  }
}

function assertIdentity(value, label, code = 'REQUEST_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new RequestValidationError(`${label} must be a non-empty safe string`, code);
  }
  return value;
}

function assertRelativePath(value, label) {
  assertIdentity(value, label, 'PATH_OUTSIDE_SCOPE');
  if (value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
    throw new RequestValidationError(`${label} must be a non-empty relative path`, 'PATH_OUTSIDE_SCOPE');
  }
  return value;
}

export function normalizeMoveRequest(input) {
  if (!input || typeof input !== 'object') throw new RequestValidationError('request must be an object');
  assertIdentity(input.jobId, 'jobId');
  assertIdentity(input.componentRef, 'componentRef');
  assertIdentity(input.idempotencyKey, 'idempotencyKey');
  assertIdentity(input.protocolVersion || 'sigma-federation/v1', 'protocolVersion');
  if (!input.provider || typeof input.provider !== 'object') throw new RequestValidationError('provider is required', 'PROVIDER_ID_REQUIRED');
  assertIdentity(input.provider.stableId, 'provider.stableId', 'PROVIDER_ID_REQUIRED');
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new RequestValidationError('at least one item is required', 'ITEMS_REQUIRED');
  }
  const stableIds = new Set();
  const sources = new Set();
  const destinations = new Set();
  const items = input.items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new RequestValidationError(`items[${index}] must be an object`);
    const stableId = assertIdentity(item.stableId, `items[${index}].stableId`);
    const source = assertRelativePath(item.source, `items[${index}].source`);
    const destination = assertRelativePath(item.destination, `items[${index}].destination`);
    if (source === destination) throw new RequestValidationError(`items[${index}] source and destination must differ`, 'ITEM_CONFLICT');
    if (stableIds.has(stableId) || sources.has(source) || destinations.has(destination)) {
      throw new RequestValidationError(`items[${index}] duplicates an item identity or path`, 'ITEM_CONFLICT');
    }
    if (sources.has(destination) || destinations.has(source)) {
      throw new RequestValidationError(`items[${index}] overlaps another item path`, 'ITEM_CONFLICT');
    }
    stableIds.add(stableId);
    sources.add(source);
    destinations.add(destination);
    return { stableId, source, destination };
  });
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
  return deepFreeze({ ...request, requestFingerprint: planFingerprint(request) });
}

export function makeMovePlan(request) {
  const plan = {
    protocolVersion: request.protocolVersion,
    operation: request.operation,
    provider: { ...request.provider },
    items: request.items.map((item) => ({ ...item })),
    componentRef: request.componentRef,
    method: request.method,
    idempotencyKey: request.idempotencyKey
  };
  return deepFreeze({ ...plan, planFingerprint: planFingerprint(plan) });
}

export function makeCompensationPlan(result) {
  const original = result.plan;
  const plan = {
    protocolVersion: original.protocolVersion,
    operation: 'compensate',
    provider: { ...original.provider },
    items: original.items.map((item) => ({
      stableId: item.stableId,
      source: item.destination,
      destination: item.source
    })),
    componentRef: original.componentRef,
    method: 'compensate',
    idempotencyKey: `${original.idempotencyKey}:compensate`
  };
  return deepFreeze({ ...plan, planFingerprint: planFingerprint(plan) });
}
