import { assertAdapterMethod, assertDispatchEnvelope, AdapterContractError, FEDERATION_PROTOCOL_VERSION } from '../adapters/adapter-contract.mjs';

/**
 * Fixture-only Colossus boundary. It proves Sigma Glue routes through a
 * gateway-shaped adapter without claiming a live Colossus deployment.
 */
export class TestRootColossusGateway {
  constructor({ commander, componentRef, protocolVersion = FEDERATION_PROTOCOL_VERSION, adapterVersion = '0.1.0-test' }) {
    this.commander = commander;
    this.componentRef = componentRef;
    this.protocolVersion = protocolVersion;
    this.adapterVersion = adapterVersion;
  }

  assertEnvelope({ plan, approval, method, jobId }) {
    if (plan.componentRef !== this.componentRef) {
      throw new AdapterContractError('component identity does not match gateway binding', 'COMPONENT_IDENTITY_MISMATCH');
    }
    if (plan.protocolVersion !== this.protocolVersion) {
      throw new AdapterContractError('gateway protocol version is incompatible', 'PROTOCOL_VERSION_UNSUPPORTED');
    }
    assertDispatchEnvelope({ plan, approval, method, jobId });
  }

  async dispatch({ plan, approval, method, jobId }) {
    this.assertEnvelope({ plan, approval, method, jobId });
    const command = method === 'compensate' ? 'compensate' : 'execute';
    assertAdapterMethod(this.commander, command);
    return this.commander[command](plan, { idempotencyKey: plan.idempotencyKey });
  }

  async reconcile({ plan, approval, method, jobId }) {
    this.assertEnvelope({ plan, approval, method, jobId });
    assertAdapterMethod(this.commander, 'reconcile');
    return this.commander.reconcile(plan);
  }
}
