import { assertApprovalBinding } from '../approval/approval-binding.mjs';
import { planFingerprint } from '../plan/fingerprint.mjs';
import { makeCompensationPlan, makeMovePlan, normalizeMoveRequest } from '../protocol/request.mjs';
import { transition } from '../state/state-machine.mjs';

const ACTOR = 'sigma-orchestrator';

function subjectFingerprint(plan) {
  const { planFingerprint: _ignored, ...subject } = plan;
  return planFingerprint(subject);
}

function assertPlanIntegrity(plan) {
  if (!plan?.planFingerprint || subjectFingerprint(plan) !== plan.planFingerprint) {
    throw new OrchestratorError('plan changed after fingerprinting', 'PLAN_FINGERPRINT_MISMATCH');
  }
}

function assertEvidenceBinding(evidence, expectedStatus, plan, failureCode) {
  if (!evidence || evidence.status !== expectedStatus) {
    throw new OrchestratorError(`expected ${expectedStatus} evidence`, failureCode);
  }
  const fields = {
    planFingerprint: plan.planFingerprint,
    provider: plan.provider.stableId,
    idempotencyKey: plan.idempotencyKey
  };
  for (const [field, expected] of Object.entries(fields)) {
    if (evidence[field] !== expected) {
      throw new OrchestratorError(`${expectedStatus} evidence does not bind ${field}`, failureCode);
    }
  }
}

export class OrchestratorError extends Error {
  constructor(message, code = 'ORCHESTRATOR_FAILED', job = null) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.job = job;
  }
}

export class SigmaOrchestrator {
  constructor({ registry, gatekeeper, commander, store = null, policyVersion = 'policy-v1', now = () => new Date() }) {
    this.registry = registry;
    this.gatekeeper = gatekeeper;
    this.commander = commander;
    this.store = store;
    this.policyVersion = policyVersion;
    this.now = now;
  }

  metadata(fingerprint, reasonCode) {
    return { actor: ACTOR, reasonCode, inputFingerprint: fingerprint, policyVersion: this.policyVersion, at: this.now().toISOString() };
  }

  async advance(job, toState, metadata) {
    const next = transition(job, toState, metadata);
    if (this.store?.recordTransition) await this.store.recordTransition(next);
    return next;
  }

  async move(input) {
    return this.dispatch(normalizeMoveRequest(input), { planFactory: makeMovePlan, operation: 'move', method: 'execute' });
  }

  async dispatch(request, { planFactory, operation, method, initialJob = null }) {
    let job = initialJob || { jobId: request.jobId, state: 'received', history: [], componentRef: request.componentRef, operation };
    const isRecovery = Boolean(initialJob);
    const requestFingerprint = request.requestFingerprint || planFingerprint(request);
    try {
      job = await this.advance(job, isRecovery ? 'recovery_required' : 'normalized', this.metadata(requestFingerprint, isRecovery ? 'RECOVERY_REQUESTED' : 'REQUEST_NORMALIZED'));
      // Registry operations are the federation method surface; the request's
      // business operation (for example, move) remains in the plan subject.
      const component = this.registry.assertSupports(request.componentRef, { operation: method, method });
      if (component.protocolVersion !== request.protocolVersion) throw new OrchestratorError('request protocol version is incompatible', 'PROTOCOL_VERSION_UNSUPPORTED', job);
      job = await this.advance(job, 'capability_checked', this.metadata(requestFingerprint, 'CAPABILITY_CHECKED'));
      const plan = planFactory(request);
      assertPlanIntegrity(plan);
      job = { ...job, planFingerprint: plan.planFingerprint };
      job = await this.advance(job, 'planned', this.metadata(plan.planFingerprint, 'PLAN_CREATED'));
      job = await this.advance(job, 'awaiting_approval', this.metadata(plan.planFingerprint, 'APPROVAL_REQUESTED'));
      const approval = await this.gatekeeper.requestApproval({ jobId: request.jobId, componentRef: request.componentRef, method, operation, plan });
      assertApprovalBinding({
        approval,
        expected: {
          approvalId: approval?.approvalId,
          jobId: request.jobId,
          planFingerprint: plan.planFingerprint,
          componentRef: request.componentRef,
          method,
          idempotencyKey: plan.idempotencyKey
        },
        now: this.now()
      });
      assertPlanIntegrity(plan);
      job = await this.advance(job, 'approved', this.metadata(plan.planFingerprint, 'APPROVAL_BOUND'));
      job = await this.advance(job, 'dispatched', this.metadata(plan.planFingerprint, 'DISPATCHED_THROUGH_COMMANDER'));
      const receipt = method === 'compensate'
        ? await this.commander.compensate(plan, { idempotencyKey: plan.idempotencyKey })
        : await this.commander.execute(plan, { idempotencyKey: plan.idempotencyKey });
      job = await this.advance(job, 'attempted', this.metadata(plan.planFingerprint, 'EXECUTION_ATTEMPTED'));
      assertEvidenceBinding(receipt, 'provider_confirmed', plan, 'PROVIDER_RESULT_UNCONFIRMED');
      job = await this.advance(job, 'provider_confirmed', this.metadata(plan.planFingerprint, 'PROVIDER_CONFIRMED'));
      job = await this.advance(job, 'reconciling', this.metadata(plan.planFingerprint, 'RECONCILIATION_STARTED'));
      const reconciliation = await this.commander.reconcile(plan);
      assertEvidenceBinding(reconciliation, 'reconciled', plan, 'RECONCILIATION_FAILED');
      job = await this.advance(job, 'reconciled', this.metadata(plan.planFingerprint, 'RECONCILED'));
      if (this.store?.recordOutcome) await this.store.recordOutcome({ job, receipt, reconciliation });
      return Object.freeze({ job, plan, approval: { approvalId: approval.approvalId }, receipt, reconciliation });
    } catch (error) {
      const failure = error instanceof OrchestratorError
        ? error
        : new OrchestratorError(error.message, error.code || 'ORCHESTRATOR_FAILED', job);
      if (this.store?.recordFailure && job) {
        try { await this.store.recordFailure(job, failure); } catch { /* preserve the original failure */ }
      }
      throw failure;
    }
  }

  async compensate(result) {
    if (result?.job?.state !== 'reconciled') throw new OrchestratorError('only reconciled jobs may be compensated', 'RECOVERY_PRECONDITION_FAILED', result?.job || null);
    const recoveryPlan = makeCompensationPlan(result);
    const recoveryRequest = {
      protocolVersion: recoveryPlan.protocolVersion,
      jobId: `${result.job.jobId}:recovery`,
      componentRef: recoveryPlan.componentRef,
      provider: recoveryPlan.provider,
      items: recoveryPlan.items,
      idempotencyKey: recoveryPlan.idempotencyKey,
      requestFingerprint: planFingerprint(recoveryPlan)
    };
    return this.dispatch(recoveryRequest, {
      planFactory: () => recoveryPlan,
      operation: 'compensate',
      method: 'compensate',
      initialJob: { ...result.job, jobId: recoveryRequest.jobId, state: 'reconciled', operation: 'compensate' }
    });
  }
}
