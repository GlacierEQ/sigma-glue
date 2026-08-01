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

    const methods = {};
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
        return capability;
      }));
    }
    normalized[componentRef] = Object.freeze({ adapterId: entry.adapterId, methods: Object.freeze(methods) });
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
  return component;
}
