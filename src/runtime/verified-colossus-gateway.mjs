import { planFingerprint } from '../plan/fingerprint.mjs';

export class VerifiedColossusGatewayError extends Error {
  constructor(message, code = 'VERIFIED_COLOSSUS_GATEWAY_FAILED', options = undefined) {
    super(message, options);
    this.name = 'VerifiedColossusGatewayError';
    this.code = code;
  }
}

/**
 * Composes the signed approval/permit path, one-shot Colossus dispatch,
 * append-only execution evidence, provider confirmation, and reconciliation
 * behind the existing SigmaOrchestrator { dispatch, reconcile } gateway shape.
 *
 * This class does not own provider credentials or provider APIs. The injected
 * evidenceBridge supplies bounded component/provider evidence. The gateway
 * verifies and persists that evidence before projecting the legacy
 * provider_confirmed/reconciled receipts expected by SigmaOrchestrator.
 */
export class VerifiedColossusGateway {
  #permitLedger;
  #dispatchCoordinator;
  #executionLedger;
  #requestBuilder;
  #evidenceBridge;
  #now;

  constructor({
    permitLedger,
    dispatchCoordinator,
    executionLedger,
    requestBuilder,
    evidenceBridge,
    now = () => new Date()
  } = {}) {
    if (!permitLedger ||
        typeof permitLedger.registerApproval !== 'function' ||
        typeof permitLedger.claimDispatchPermit !== 'function') {
      throw new VerifiedColossusGatewayError(
        'signed permit ledger is required',
        'SIGNED_PERMIT_LEDGER_INVALID'
      );
    }
    if (!dispatchCoordinator || typeof dispatchCoordinator.dispatchAndRecord !== 'function') {
      throw new VerifiedColossusGatewayError(
        'durable dispatch coordinator is required',
        'DURABLE_DISPATCH_COORDINATOR_INVALID'
      );
    }
    if (!executionLedger ||
        typeof executionLedger.recordAttempt !== 'function' ||
        typeof executionLedger.recordProviderConfirmation !== 'function' ||
        typeof executionLedger.startReconciliation !== 'function' ||
        typeof executionLedger.completeReconciliation !== 'function' ||
        typeof executionLedger.getOperationByRequestId !== 'function' ||
        typeof executionLedger.getEvents !== 'function' ||
        typeof executionLedger.verifyEventChain !== 'function') {
      throw new VerifiedColossusGatewayError(
        'verified execution ledger is required',
        'VERIFIED_EXECUTION_LEDGER_INVALID'
      );
    }
    if (typeof requestBuilder !== 'function') {
      throw new VerifiedColossusGatewayError(
        'dispatch request builder is required',
        'DISPATCH_REQUEST_BUILDER_INVALID'
      );
    }
    if (!evidenceBridge ||
        typeof evidenceBridge.awaitProviderConfirmation !== 'function' ||
        typeof evidenceBridge.reconcile !== 'function') {
      throw new VerifiedColossusGatewayError(
        'provider evidence bridge is required',
        'PROVIDER_EVIDENCE_BRIDGE_INVALID'
      );
    }
    if (typeof now !== 'function') {
      throw new VerifiedColossusGatewayError('clock must be a function', 'CLOCK_INVALID');
    }

    this.#permitLedger = permitLedger;
    this.#dispatchCoordinator = dispatchCoordinator;
    this.#executionLedger = executionLedger;
    this.#requestBuilder = requestBuilder;
    this.#evidenceBridge = evidenceBridge;
    this.#now = now;
  }

  async dispatch(input) {
    const subject = orchestrationSubject(input);
    const approvalNow = this.#date();

    this.#permitLedger.registerApproval({ approval: input.approval, now: approvalNow });
    const permit = this.#permitLedger.claimDispatchPermit({
      expected: {
        approvalId: input.approval.approvalId,
        jobId: subject.jobId,
        planFingerprint: subject.planFingerprint,
        componentRef: subject.componentRef,
        method: subject.method,
        idempotencyKey: subject.idempotencyKey,
        policyVersion: subject.policyVersion
      },
      now: approvalNow
    });

    const requestId = requestIdentity(subject);
    const request = await this.#requestBuilder({
      ...input,
      permit,
      requestId,
      now: this.#date()
    });
    if (!request || request.requestId !== requestId) {
      throw new VerifiedColossusGatewayError(
        'dispatch request builder changed the deterministic request identity',
        'DISPATCH_REQUEST_IDENTITY_MISMATCH'
      );
    }

    const dispatched = await this.#dispatchCoordinator.dispatchAndRecord({
      permit,
      request,
      now: this.#date()
    });
    if (!dispatched?.operation || dispatched.operation.requestId !== requestId ||
        dispatched.operation.idempotencyKey !== subject.idempotencyKey) {
      throw new VerifiedColossusGatewayError(
        'durable dispatch operation does not match the orchestration subject',
        'DISPATCH_OPERATION_SUBJECT_MISMATCH'
      );
    }

    const evidence = await this.#evidenceBridge.awaitProviderConfirmation({
      ...input,
      permit,
      request,
      dispatchReceipt: dispatched.receipt,
      operation: dispatched.operation,
      now: this.#date()
    });
    if (!evidence || typeof evidence !== 'object' || !evidence.attempt || !evidence.confirmation) {
      throw new VerifiedColossusGatewayError(
        'provider evidence bridge returned incomplete execution evidence',
        'PROVIDER_EVIDENCE_INCOMPLETE'
      );
    }

    let operation = this.#executionLedger.recordAttempt({
      operationId: dispatched.operation.operationId,
      attempt: evidence.attempt,
      transitionKey: `attempt:${requestId}`,
      now: this.#date()
    });
    operation = this.#executionLedger.recordProviderConfirmation({
      operationId: operation.operationId,
      confirmation: evidence.confirmation,
      transitionKey: `provider-confirmation:${requestId}`,
      now: this.#date()
    });
    const chain = this.#executionLedger.verifyEventChain(operation.operationId);
    if (!chain?.valid || operation.state !== 'provider_confirmed') {
      throw new VerifiedColossusGatewayError(
        'provider confirmation did not produce a verified execution head',
        'PROVIDER_CONFIRMATION_NOT_VERIFIED'
      );
    }

    return Object.freeze({
      status: 'provider_confirmed',
      provider: subject.provider,
      operation: subject.operation,
      idempotencyKey: subject.idempotencyKey,
      planFingerprint: subject.planFingerprint,
      providerRequestId: evidence.confirmation.providerRequestId,
      beforeFingerprint: evidence.confirmation.beforeFingerprint,
      afterFingerprint: evidence.confirmation.afterFingerprint,
      dispatchReceiptId: dispatched.receipt.receiptId,
      executionOperationId: operation.operationId,
      requestId
    });
  }

  async reconcile(input) {
    const subject = orchestrationSubject(input);
    const requestId = requestIdentity(subject);
    let operation = this.#executionLedger.getOperationByRequestId(requestId);
    if (!operation) {
      throw new VerifiedColossusGatewayError(
        'durable execution operation was not found for reconciliation',
        'EXECUTION_OPERATION_NOT_FOUND'
      );
    }
    if (operation.idempotencyKey !== subject.idempotencyKey ||
        operation.componentRef !== subject.componentRef ||
        operation.method !== subject.method ||
        operation.state !== 'provider_confirmed') {
      throw new VerifiedColossusGatewayError(
        'reconciliation operation does not match the provider-confirmed orchestration subject',
        'RECONCILIATION_SUBJECT_MISMATCH'
      );
    }

    const events = this.#executionLedger.getEvents(operation.operationId);
    const confirmationEvent = [...events].reverse().find(
      (event) => event.eventType === 'provider.confirmed'
    );
    if (!confirmationEvent) {
      throw new VerifiedColossusGatewayError(
        'provider confirmation evidence is missing',
        'PROVIDER_CONFIRMATION_EVIDENCE_MISSING'
      );
    }

    const evidence = await this.#evidenceBridge.reconcile({
      ...input,
      requestId,
      operation,
      confirmation: confirmationEvent.evidence,
      now: this.#date()
    });
    if (!evidence || typeof evidence !== 'object' || !evidence.start || !evidence.result) {
      throw new VerifiedColossusGatewayError(
        'provider evidence bridge returned incomplete reconciliation evidence',
        'RECONCILIATION_EVIDENCE_INCOMPLETE'
      );
    }

    operation = this.#executionLedger.startReconciliation({
      operationId: operation.operationId,
      reconciliation: evidence.start,
      transitionKey: `reconciliation-start:${requestId}`,
      now: this.#date()
    });
    operation = this.#executionLedger.completeReconciliation({
      operationId: operation.operationId,
      result: evidence.result,
      transitionKey: `reconciliation-result:${requestId}`,
      now: this.#date()
    });
    const chain = this.#executionLedger.verifyEventChain(operation.operationId);
    if (!chain?.valid) {
      throw new VerifiedColossusGatewayError(
        'reconciliation did not preserve the verified execution chain',
        'RECONCILIATION_CHAIN_INVALID'
      );
    }
    if (operation.state !== 'reconciled') {
      throw new VerifiedColossusGatewayError(
        'provider state did not reconcile to the confirmed expectation',
        'RECONCILIATION_FAILED'
      );
    }

    return Object.freeze({
      status: 'reconciled',
      provider: subject.provider,
      operation: subject.operation,
      idempotencyKey: subject.idempotencyKey,
      planFingerprint: subject.planFingerprint,
      observationMethod: evidence.result.observationMethod,
      expectedFingerprint: evidence.result.expectedFingerprint,
      observedFingerprint: evidence.result.observedFingerprint,
      executionOperationId: operation.operationId,
      requestId
    });
  }

  #date() {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new VerifiedColossusGatewayError('clock returned an invalid date', 'CLOCK_INVALID');
    }
    return value;
  }
}

function orchestrationSubject(input) {
  if (!input || typeof input !== 'object' || !input.plan || !input.approval) {
    throw new VerifiedColossusGatewayError(
      'orchestration plan and approval are required',
      'ORCHESTRATION_SUBJECT_INVALID'
    );
  }
  const plan = input.plan;
  const approval = input.approval;
  const subject = {
    jobId: requiredString(input.jobId, 'jobId'),
    componentRef: requiredString(input.componentRef, 'componentRef'),
    method: requiredString(input.method, 'method'),
    operation: requiredString(input.operation, 'operation'),
    idempotencyKey: requiredString(plan.idempotencyKey, 'idempotencyKey'),
    planFingerprint: requiredString(plan.planFingerprint, 'planFingerprint'),
    provider: requiredString(plan.provider?.stableId, 'provider.stableId'),
    policyVersion: requiredString(approval.policyVersion, 'approval.policyVersion')
  };
  if (plan.componentRef !== subject.componentRef || plan.method !== subject.method ||
      plan.operation !== subject.operation || approval.jobId !== subject.jobId ||
      approval.componentRef !== subject.componentRef || approval.method !== subject.method ||
      approval.idempotencyKey !== subject.idempotencyKey ||
      approval.planFingerprint !== subject.planFingerprint) {
    throw new VerifiedColossusGatewayError(
      'orchestration input is not exactly bound to the plan and approval',
      'ORCHESTRATION_SUBJECT_MISMATCH'
    );
  }
  return Object.freeze(subject);
}

function requestIdentity(subject) {
  return `request_${planFingerprint({
    jobId: subject.jobId,
    componentRef: subject.componentRef,
    method: subject.method,
    operation: subject.operation,
    idempotencyKey: subject.idempotencyKey,
    planFingerprint: subject.planFingerprint,
    policyVersion: subject.policyVersion
  }).slice('sha256:'.length)}`;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VerifiedColossusGatewayError(
      `${field} must be a non-empty string`,
      'ORCHESTRATION_SUBJECT_INVALID'
    );
  }
  return value;
}
