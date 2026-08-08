const PRE_PROVIDER_BOUNDARY = Symbol('sigma-glue/pre-provider-boundary');

/**
 * Marks an Error as carrying an explicit, repository-internal proof that no
 * provider transport attempt was durably observed for the failed dispatch.
 *
 * The Symbol is intentionally module-private so a plain object property such as
 * `providerBoundaryEntered = false` cannot accidentally trigger idempotency
 * release in SigmaOrchestrator.
 */
export function markProvablyPreProviderBoundary(error) {
  if (!(error instanceof Error)) {
    throw new TypeError('provider-boundary proof requires an Error instance');
  }
  Object.defineProperty(error, PRE_PROVIDER_BOUNDARY, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return error;
}

export function isProvablyPreProviderBoundary(error) {
  return error instanceof Error && error[PRE_PROVIDER_BOUNDARY] === true;
}
