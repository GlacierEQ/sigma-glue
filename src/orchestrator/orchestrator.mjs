import { assertApprovalBinding } from '../approval/approval-binding.mjs';
import { planFingerprint } from '../plan/fingerprint.mjs';
import { makeCompensationPlan, makeMovePlan, normalizeMoveRequest } from '../protocol/request.mjs';
import { transition } from '../state/state-machine.mjs';

const ACTOR = 'sigma-orchestrator';

export class OrchestratorError extends Error {
  constructor(message, code = 'ORCHESTRATOR_FAILED', job = null) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.job = job;
  }
}

export class SigmaOrchestrator {
  constructor({ registry, gatekeeper, commander, policyVersion = 'policy-v1', now = () => new Date() }) {
    this.registry = registry;
    this.gatekeeper = gatekeeper;
    this.commander = commander;
    this.policyVersion = policyVersion;
    this.now = now;
  }

  metadata(fingerprint, reasonCode) {
    return { actor: ACTOR, reasonCode, inputFingerprint: fingerprint, policyVersion: this.policyVersion, at: this.now().toISOString() };
  }

  async move(input) {
    return this.dispatch(normalizeMoveRequest(input), { planFactory: makeMovePlan, operation: 'move', method: 'execute' });
  }

  async dispatch(request, { planFactory, operation, method }) {
    let job = { jobId: request.jobId, state: 'received', history: [], componentRef: request.componentRef, operation };
    const requestFingerprint = request.requestFingerprint || planFingerprint(request);
    try {
      job = transition(job, 'normalized', this.metadata(requestFingerprint, 'REQUEST_NORMALIZED'));
      // Registry operations are the federation method surface; the request's
      // business operation (for example, move) remains in the plan subject.
      const component = this.registry.assertSupports(request.componentRef, { operation: method, method });
      if (component.protocolVersion !== request.protocolVersion) throw new OrchestratorError('request protocol version is incompatible', 'PROTOCOL_VERSION_UNSUPPORTED', job);
      job = transition(job, 'capability_checked', this.metadata(requestFingerprint, 'CAPABILITY_CHECKED'));
      const plan = planFactory(request);
      job = { ...job, planFingerprint: plan.planFingerprint };
      job = transition(job, 'planned', this.metadata(plan.planFingerprint, 'PLAN_CREATED'));
      job = transition(job, 'awaiting_approval', this.metadata(plan.planFingerprint, 'APPROVAL_REQUESTED'));
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
      job = transition(job, 'approved', this.metadata(plan.planFingerprint, 'APPROVAL_BOUND'));
      job = transition(job, 'dispatched', this.metadata(plan.planFingerprint, 'DISPATCHED_THROUGH_COMMANDER'));
      const receipt = method === 'compensate'
        ? await this.commander.compensate(plan, { idempotencyKey: plan.idempotencyKey })
        : await this.commander.execute(plan, { idempotencyKey: plan.idempotencyKey });
      job = transition(job, 'attempted', this.metadata(plan.planFingerprint, 'EXECUTION_ATTEMPTED'));
      if (receipt?.status !== 'provider_confirmed') throw new OrchestratorError('provider confirmation was not returned', 'PROVIDER_CONFIRMATION_MISSING', job);
      job = transition(job, 'provider_confirmed', this.metadata(plan.planFingerprint, 'PROVIDER_CONFIRMED'));
      job = transition(job, 'reconciling', this.metadata(plan.planFingerprint, 'RECONCILIATION_STARTED'));
      const reconciliation = await this.commander.reconcile(plan);
      if (reconciliation?.status !== 'reconciled') throw new OrchestratorError('reconciliation did not confirm the plan', 'RECONCILIATION_FAILED', job);
      job = transition(job, 'reconciled', this.metadata(plan.planFingerprint, 'RECONCILED'));
      return Object.freeze({ job, plan, approval: { approvalId: approval.approvalId }, receipt, reconciliation });
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      throw new OrchestratorError(error.message, error.code || 'ORCHESTRATOR_FAILED', job);
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
