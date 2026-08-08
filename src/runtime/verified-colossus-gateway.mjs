import { markProvablyPreProviderBoundary } from '../orchestrator/provider-boundary-proof.mjs';
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
 * The gateway owns the dispatch projection and durable phase boundaries. The
 * deployment-supplied authority may provide only capability/scoped handles;
 * the evidence bridge may provide only provider confirmation and reconciliation
 * observations. Attempt/reconciliation start records are created here before
 * awaiting external work so crashes remain restart-readable.
 */
export class VerifiedColossusGateway {
  #permitLedger;
  #dispatchCoordinator;
  #executionLedger;
  #dispatchAuthority;
  #evidenceBridge;
  #observationMethod;
  #now;

  constructor({
    permitLedger,
    dispatchCoordinator,
    executionLedger,
    dispatchAuthority,
    evidenceBridge,
    now = () => new Date()
  } = {}) {
    if (!permitLedger ||
        typeof permitLedger.registerApproval !== 'function' ||
        typeof permitLedger.claimDispatchPermit !== 'function' ||
        typeof permitLedger.getDispatchAttemptByPermitId !== 'function') {
      throw new VerifiedColossusGatewayError(
        'signed one-shot permit ledger is required',
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
    if (typeof dispatchAuthority !== 'function') {
      throw new VerifiedColossusGatewayError(
        'dispatch authority provider is required',
        'DISPATCH_AUTHORITY_INVALID'
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
    if (typeof evidenceBridge.observationMethod !== 'string' ||
        evidenceBridge.observationMethod.trim() === '') {
      throw new VerifiedColossusGatewayError(
        'provider evidence bridge observationMethod is required',
        'RECONCILIATION_METHOD_INVALID'
      );
    }
    if (typeof now !== 'function') {
      throw new VerifiedColossusGatewayError('clock must be a function', 'CLOCK_INVALID');
    }

    this.#permitLedger = permitLedger;
    this.#dispatchCoordinator = dispatchCoordinator;
    this.#executionLedger = executionLedger;
    this.#dispatchAuthority = dispatchAuthority;
    this.#evidenceBridge = evidenceBridge;
    this.#observationMethod = evidenceBridge.observationMethod;
    this.#now = now;
  }

  async dispatch(input) {
    const subject = orchestrationSubject(input);
    let permit = null;

    try {
      const approvalNow = this.#date();
      this.#permitLedger.registerApproval({ approval: input.approval, now: approvalNow });
      permit = this.#permitLedger.claimDispatchPermit({
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
      const authority = normalizeDispatchAuthority(await this.#dispatchAuthority({
        ...input,
        permit,
        requestId,
        now: this.#date()
      }));
      const request = buildPlanBoundDispatchRequest({
        input,
        subject,
        requestId,
        authority
      });

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

      const attemptAt = this.#date();
      const attempt = Object.freeze({
        attemptId: executionAttemptIdentity(dispatched.operation),
        adapterId: dispatched.operation.resolvedAdapterId,
        envelopeFingerprint: dispatched.operation.envelopeFingerprint,
        startedAt: attemptAt.toISOString()
      });
      let operation = this.#executionLedger.recordAttempt({
        operationId: dispatched.operation.operationId,
        attempt,
        transitionKey: `attempt:${requestId}`,
        now: attemptAt
      });

      const confirmation = await this.#evidenceBridge.awaitProviderConfirmation({
        ...input,
        permit,
        request,
        attempt,
        dispatchReceipt: dispatched.receipt,
        operation,
        now: this.#date()
      });
      if (!confirmation || typeof confirmation !== 'object') {
        throw new VerifiedColossusGatewayError(
          'provider evidence bridge returned incomplete confirmation evidence',
          'PROVIDER_EVIDENCE_INCOMPLETE'
        );
      }
      operation = this.#executionLedger.recordProviderConfirmation({
        operationId: operation.operationId,
        confirmation,
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
        providerRequestId: confirmation.providerRequestId,
        beforeFingerprint: confirmation.beforeFingerprint,
        afterFingerprint: confirmation.afterFingerprint,
        dispatchReceiptId: dispatched.receipt.receiptId,
        executionOperationId: operation.operationId,
        requestId
      });
    } catch (error) {
      throw this.#classifyDispatchFailure(error, permit);
    }
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

    const reconciliationAt = this.#date();
    const reconciliationStart = Object.freeze({
      observationMethod: this.#observationMethod,
      startedAt: reconciliationAt.toISOString()
    });
    operation = this.#executionLedger.startReconciliation({
      operationId: operation.operationId,
      reconciliation: reconciliationStart,
      transitionKey: `reconciliation-start:${requestId}`,
      now: reconciliationAt
    });

    const result = await this.#evidenceBridge.reconcile({
      ...input,
      requestId,
      operation,
      confirmation: confirmationEvent.evidence,
      reconciliationStart,
      now: this.#date()
    });
    if (!result || typeof result !== 'object') {
      throw new VerifiedColossusGatewayError(
        'provider evidence bridge returned incomplete reconciliation evidence',
        'RECONCILIATION_EVIDENCE_INCOMPLETE'
      );
    }

    operation = this.#executionLedger.completeReconciliation({
      operationId: operation.operationId,
      result,
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
      observationMethod: result.observationMethod,
      expectedFingerprint: result.expectedFingerprint,
      observedFingerprint: result.observedFingerprint,
      executionOperationId: operation.operationId,
      requestId
    });
  }

  #classifyDispatchFailure(error, permit) {
    let providerBoundaryEntered = false;
    if (permit) {
      try {
        providerBoundaryEntered = Boolean(
          this.#permitLedger.getDispatchAttemptByPermitId(permit.permitId)
        );
      } catch {
        // Failure to prove absence is treated as provider-boundary uncertainty.
        providerBoundaryEntered = true;
      }
    }
    const classified = new VerifiedColossusGatewayError(
      error?.message || 'verified Colossus dispatch failed',
      error?.code || 'VERIFIED_COLOSSUS_DISPATCH_FAILED',
      { cause: error }
    );
    return providerBoundaryEntered
      ? classified
      : markProvablyPreProviderBoundary(classified);
  }

  #date() {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new VerifiedColossusGatewayError('clock returned an invalid date', 'CLOCK_INVALID');
    }
    return value;
  }
}

function buildPlanBoundDispatchRequest({ input, subject, requestId, authority }) {
  const plan = input.plan;
  return Object.freeze({
    protocolVersion: requiredString(plan.protocolVersion, 'plan.protocolVersion'),
    schemaVersion: 'colossus-dispatch/v1',
    requestId,
    traceId: `trace_${planFingerprint({ requestId, jobId: subject.jobId }).slice('sha256:'.length)}`,
    jobId: subject.jobId,
    componentRef: subject.componentRef,
    method: subject.method,
    capability: authority.capability,
    idempotencyKey: subject.idempotencyKey,
    planFingerprint: subject.planFingerprint,
    policyVersion: subject.policyVersion,
    scopedHandles: authority.scopedHandles,
    payload: canonicalPlanPayload(plan)
  });
}

function canonicalPlanPayload(plan) {
  if (!Array.isArray(plan.items) || plan.items.length === 0) {
    throw new VerifiedColossusGatewayError(
      'approved plan must contain mutation items',
      'PLAN_PAYLOAD_INVALID'
    );
  }
  return Object.freeze({
    operation: requiredString(plan.operation, 'plan.operation'),
    provider: Object.freeze({
      stableId: requiredString(plan.provider?.stableId, 'plan.provider.stableId')
    }),
    items: Object.freeze(plan.items.map((item, index) => Object.freeze({
      stableId: requiredString(item?.stableId, `plan.items[${index}].stableId`),
      source: requiredString(item?.source, `plan.items[${index}].source`),
      destination: requiredString(item?.destination, `plan.items[${index}].destination`)
    })))
  });
}

function normalizeDispatchAuthority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VerifiedColossusGatewayError(
      'dispatch authority must be an object',
      'DISPATCH_AUTHORITY_INVALID'
    );
  }
  const unknown = Object.keys(value).filter(
    (field) => !['capability', 'scopedHandles'].includes(field)
  );
  if (unknown.length > 0) {
    throw new VerifiedColossusGatewayError(
      `dispatch authority cannot supply ${unknown[0]}`,
      'DISPATCH_AUTHORITY_FIELD_FORBIDDEN'
    );
  }
  if (!Array.isArray(value.scopedHandles)) {
    throw new VerifiedColossusGatewayError(
      'dispatch authority scopedHandles must be an array',
      'DISPATCH_AUTHORITY_INVALID'
    );
  }
  return Object.freeze({
    capability: requiredString(value.capability, 'dispatchAuthority.capability'),
    scopedHandles: Object.freeze(value.scopedHandles.map((handle) => Object.freeze({ ...handle })))
  });
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
    policyVersion: requiredString(input.approval.policyVersion, 'approval.policyVersion')
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

function executionAttemptIdentity(operation) {
  return `attempt_${planFingerprint({
    operationId: operation.operationId,
    requestId: operation.requestId,
    envelopeFingerprint: operation.envelopeFingerprint,
    adapterId: operation.resolvedAdapterId
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
