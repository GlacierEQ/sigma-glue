import { cloneCanonical, ColossusDispatchError, requireString } from './common.mjs';

export function normalizeRegistry(registry) {
  registry = cloneCanonical(registry);
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new ColossusDispatchError('component registry is required', 'COMPONENT_REGISTRY_INVALID');
  }

  const normalized = {};
  for (const [componentRef, entry] of Object.entries(registry)) {
    requireString(componentRef, 'componentRef', 'COMPONENT_REGISTRY_INVALID');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ColossusDispatchError(`registry entry is invalid for ${componentRef}`, 'COMPONENT_REGISTRY_INVALID');
    }
    requireString(entry.adapterId, 'adapterId', 'COMPONENT_REGISTRY_INVALID');
    if (!entry.methods || typeof entry.methods !== 'object' || Array.isArray(entry.methods)) {
      throw new ColossusDispatchError(`methods are missing for ${componentRef}`, 'COMPONENT_REGISTRY_INVALID');
    }
    if (!entry.authority || typeof entry.authority !== 'object' || Array.isArray(entry.authority)) {
      throw new ColossusDispatchError(`authority policy is missing for ${componentRef}`, 'COMPONENT_REGISTRY_INVALID');
    }

    const methods = {};
    const declaredCapabilities = new Set();
    for (const [method, capabilities] of Object.entries(entry.methods)) {
      requireString(method, 'method', 'COMPONENT_REGISTRY_INVALID');
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        throw new ColossusDispatchError(
          `capabilities are missing for ${componentRef}.${method}`,
          'COMPONENT_REGISTRY_INVALID'
        );
      }
      methods[method] = Object.freeze(capabilities.map((capability) => {
        requireString(capability, 'capability', 'COMPONENT_REGISTRY_INVALID');
        declaredCapabilities.add(capability);
        return capability;
      }));
    }

    const authority = {};
    for (const capability of declaredCapabilities) {
      authority[capability] = normalizeAuthorityPolicy(
        entry.authority[capability],
        `${componentRef}.${capability}`
      );
    }
    const undeclared = Object.keys(entry.authority).find((capability) => !declaredCapabilities.has(capability));
    if (undeclared) {
      throw new ColossusDispatchError(
        `authority policy references undeclared capability ${undeclared}`,
        'COMPONENT_REGISTRY_INVALID'
      );
    }

    normalized[componentRef] = Object.freeze({
      adapterId: entry.adapterId,
      methods: Object.freeze(methods),
      authority: Object.freeze(authority)
    });
  }
  return Object.freeze(normalized);
}

export function resolveRoute(registry, request) {
  const component = registry[request.componentRef];
  if (!component) {
    throw new ColossusDispatchError('component is not registered', 'COMPONENT_NOT_REGISTERED');
  }
  const capabilities = component.methods[request.method];
  if (!capabilities) {
    throw new ColossusDispatchError('method is not supported', 'CAPABILITY_NOT_SUPPORTED');
  }
  if (!capabilities.includes(request.capability)) {
    throw new ColossusDispatchError('capability is not allowed for method', 'CAPABILITY_SCOPE_MISMATCH');
  }
  const authorityPolicy = component.authority[request.capability];
  if (!authorityPolicy) {
    throw new ColossusDispatchError(
      'capability has no scoped-handle authority policy',
      'SCOPED_HANDLE_POLICY_MISSING'
    );
  }
  return Object.freeze({
    adapterId: component.adapterId,
    authorityPolicy
  });
}

function normalizeAuthorityPolicy(policy, label) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ColossusDispatchError(
      `authority policy is invalid for ${label}`,
      'COMPONENT_REGISTRY_INVALID'
    );
  }
  const minHandles = boundedInteger(policy.minHandles, 'minHandles', 0);
  const maxHandles = boundedInteger(policy.maxHandles, 'maxHandles', minHandles);
  if (!Array.isArray(policy.handles) || policy.handles.length === 0) {
    throw new ColossusDispatchError(
      `authority handle patterns are missing for ${label}`,
      'COMPONENT_REGISTRY_INVALID'
    );
  }
  if (!Array.isArray(policy.issuers) || policy.issuers.length === 0) {
    throw new ColossusDispatchError(
      `trusted scoped-handle issuers are missing for ${label}`,
      'COMPONENT_REGISTRY_INVALID'
    );
  }

  const handles = policy.handles.map((handle, index) => {
    if (!handle || typeof handle !== 'object' || Array.isArray(handle)) {
      throw new ColossusDispatchError(
        `authority handle pattern ${index} is invalid for ${label}`,
        'COMPONENT_REGISTRY_INVALID'
      );
    }
    const type = requireString(handle.type, 'type', 'COMPONENT_REGISTRY_INVALID');
    const scope = requireString(handle.scope, 'scope', 'COMPONENT_REGISTRY_INVALID');
    return Object.freeze({ type, scope });
  });

  const issuerIdentities = new Set();
  const issuers = policy.issuers.map((issuer, index) => {
    if (!issuer || typeof issuer !== 'object' || Array.isArray(issuer)) {
      throw new ColossusDispatchError(
        `authority issuer ${index} is invalid for ${label}`,
        'COMPONENT_REGISTRY_INVALID'
      );
    }
    const normalized = Object.freeze({
      issuer: requireString(issuer.issuer, 'issuer', 'COMPONENT_REGISTRY_INVALID'),
      keyId: requireString(issuer.keyId, 'keyId', 'COMPONENT_REGISTRY_INVALID')
    });
    const identity = `${normalized.issuer}\u0000${normalized.keyId}`;
    if (issuerIdentities.has(identity)) {
      throw new ColossusDispatchError(
        `duplicate authority issuer ${identity} for ${label}`,
        'COMPONENT_REGISTRY_INVALID'
      );
    }
    issuerIdentities.add(identity);
    return normalized;
  });

  return Object.freeze({
    minHandles,
    maxHandles,
    handles: Object.freeze(handles),
    issuers: Object.freeze(issuers)
  });
}

function boundedInteger(value, field, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ColossusDispatchError(
      `${field} must be a safe integer >= ${minimum}`,
      'COMPONENT_REGISTRY_INVALID'
    );
  }
  return value;
}
