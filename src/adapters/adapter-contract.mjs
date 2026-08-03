export const FEDERATION_PROTOCOL_VERSION = 'sigma-federation/v1';

const SECRET_FIELDS = new Set([
  'accessToken', 'authorization', 'clientSecret', 'password', 'privateKey',
  'refreshToken', 'secret', 'token'
]);

export class AdapterContractError extends Error {
  constructor(message, code = 'ADAPTER_CONTRACT_INVALID') {
    super(message);
    this.name = 'AdapterContractError';
    this.code = code;
  }
}

function assertString(value, label, code = 'ADAPTER_CONTRACT_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new AdapterContractError(`${label} must be a non-empty safe string`, code);
  }
}

function assertNoSecrets(value, path = 'envelope', seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new AdapterContractError(`${path} contains a cycle`, 'ADAPTER_ENVELOPE_INVALID');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key)) throw new AdapterContractError(`${path}.${key} is not permitted`, 'RAW_CREDENTIALS_FORBIDDEN');
    assertNoSecrets(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

/**
 * Validates the narrow envelope that Colossus receives after Gatekeeper
 * approval. The adapter sees scoped plan data only; credential resolution is
 * deliberately outside Sigma Glue.
 */
export function assertDispatchEnvelope({ plan, approval, method, jobId = approval?.jobId }) {
  if (!plan || typeof plan !== 'object') throw new AdapterContractError('plan is required');
  assertString(plan.protocolVersion, 'plan.protocolVersion', 'PROTOCOL_VERSION_UNSUPPORTED');
  if (plan.protocolVersion !== FEDERATION_PROTOCOL_VERSION) {
    throw new AdapterContractError('unsupported federation protocol', 'PROTOCOL_VERSION_UNSUPPORTED');
  }
  assertString(plan.planFingerprint, 'plan.planFingerprint');
  assertString(plan.idempotencyKey, 'plan.idempotencyKey');
  assertString(plan.provider?.stableId, 'plan.provider.stableId', 'PROVIDER_ID_REQUIRED');
  assertString(method, 'method', 'METHOD_UNSUPPORTED');
  if (!approval || approval.status !== 'approved') {
    throw new AdapterContractError('approved envelope is required', 'APPROVAL_REQUIRED');
  }
  assertString(jobId, 'jobId', 'APPROVAL_BINDING_INVALID');
  if (approval.jobId !== jobId) throw new AdapterContractError('approval does not bind jobId', 'APPROVAL_BINDING_INVALID');
  for (const [field, expected] of Object.entries({
    planFingerprint: plan.planFingerprint,
    idempotencyKey: plan.idempotencyKey
  })) {
    if (approval[field] !== expected) throw new AdapterContractError(`approval does not bind ${field}`, 'APPROVAL_BINDING_INVALID');
  }
  assertNoSecrets(plan);
  assertNoSecrets(approval);
  return true;
}

export function assertAdapterMethod(adapter, method) {
  if (!adapter || typeof adapter[method] !== 'function') {
    throw new AdapterContractError(`adapter does not implement ${method}`, 'METHOD_UNSUPPORTED');
  }
}
