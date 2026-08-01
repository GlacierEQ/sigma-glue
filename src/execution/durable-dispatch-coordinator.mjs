import { planFingerprint } from '../plan/fingerprint.mjs';
import { ExecutionLedgerError } from '../ledger/sqlite-execution-ledger.mjs';

export class DurableDispatchCoordinatorError extends Error {
  constructor(message, code = 'DURABLE_DISPATCH_FAILED', options = undefined) {
    super(message, options);
    this.name = 'DurableDispatchCoordinatorError';
    this.code = code;
    this.receiptFingerprint = options?.receiptFingerprint ?? null;
  }
}

/**
 * Connects a validated Colossus dispatch receipt to durable execution state.
 * Provider execution remains downstream and separate.
 */
export class DurableDispatchCoordinator {
  #dispatchAdapter;
  #executionLedger;

  constructor({ dispatchAdapter, executionLedger } = {}) {
    if (!dispatchAdapter || typeof dispatchAdapter.dispatch !== 'function') {
      throw new DurableDispatchCoordinatorError('dispatch adapter is required', 'DISPATCH_ADAPTER_INVALID');
    }
    if (!executionLedger || typeof executionLedger.recordDispatched !== 'function') {
      throw new DurableDispatchCoordinatorError('execution ledger is required', 'EXECUTION_LEDGER_INVALID');
    }
    this.#dispatchAdapter = dispatchAdapter;
    this.#executionLedger = executionLedger;
  }

  async dispatchAndRecord({ permit, request, now = new Date() }) {
    const receipt = await this.#dispatchAdapter.dispatch({ permit, request, now });
    if (!receipt || receipt.status !== 'dispatched') {
      throw new DurableDispatchCoordinatorError(
        'Colossus did not accept the dispatch',
        'DISPATCH_NOT_ACCEPTED',
        { receiptFingerprint: receipt ? planFingerprint(receipt) : null }
      );
    }

    try {
      const operation = this.#executionLedger.recordDispatched({
        receipt,
        transitionKey: `dispatch:${receipt.receiptId}`,
        now: new Date(receipt.receivedAt)
      });
      return Object.freeze({ receipt, operation });
    } catch (error) {
      if (error instanceof ExecutionLedgerError) {
        throw new DurableDispatchCoordinatorError(
          'Colossus accepted the dispatch but durable receipt persistence failed',
          'DISPATCH_RECEIPT_PERSISTENCE_FAILED',
          { cause: error, receiptFingerprint: planFingerprint(receipt) }
        );
      }
      throw error;
    }
  }
}
