import { deepFreeze } from '../plan/fingerprint.mjs';

export class ComponentRegistryError extends Error {
  constructor(message, code = 'COMPONENT_REGISTRY_ERROR') {
    super(message);
    this.name = 'ComponentRegistryError';
    this.code = code;
  }
}

export class ComponentRegistry {
  constructor({ protocolVersion = 'sigma-federation/v1' } = {}) {
    this.protocolVersion = protocolVersion;
    this.components = new Map();
  }

  register(component) {
    if (!component?.ref || !component?.name) {
      throw new ComponentRegistryError('component ref and name are required', 'COMPONENT_INVALID');
    }
    if (component.protocolVersion !== this.protocolVersion) {
      throw new ComponentRegistryError('component protocol version is incompatible', 'PROTOCOL_VERSION_UNSUPPORTED');
    }
    if (this.components.has(component.ref)) {
      throw new ComponentRegistryError(`component is already registered: ${component.ref}`, 'COMPONENT_DUPLICATE');
    }
    this.components.set(component.ref, deepFreeze(structuredClone(component)));
    return this.components.get(component.ref);
  }

  resolve(ref) {
    const component = this.components.get(ref);
    if (!component) throw new ComponentRegistryError(`component is not registered: ${ref}`, 'COMPONENT_NOT_FOUND');
    return component;
  }

  assertSupports(ref, { operation, method }) {
    const component = this.resolve(ref);
    if (typeof operation !== 'string' || !component.allowedOperations?.includes(operation)) {
      throw new ComponentRegistryError(`${ref} does not allow operation ${operation}`, 'OPERATION_UNSUPPORTED');
    }
    if (typeof method !== 'string' || component.supportedMethods?.[method] !== true) {
      throw new ComponentRegistryError(`${ref} does not support method ${method}`, 'METHOD_UNSUPPORTED');
    }
    return component;
  }
}
