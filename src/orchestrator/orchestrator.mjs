import { assertApprovalBinding } from '../approval/approval-binding.mjs';
import { planFingerprint } from '../plan/fingerprint.mjs';
import { makeCompensationPlan, makeMovePlan, normalizeMoveRequest } from '../protocol/request.mjs';
import { transition } from '../state/state-machine.mjs';

const ACTOR = 'sigma-orchestrator';
const RECOVERY_STATES = new Set(['dispatched', 'attempted', 'provider_confirmed', 'reconciling', 'reconciled']);

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

function dispatchClaimDisposition(claim) {
  if (!claim || typeof claim !== 'object' || typeof claim.reused !== 'boolean' || !claim.record || typeof claim.record !== 'object') {
    throw new OrchestratorError('idempotency ledger returned a malformed claim', 'IDEMPOTENCY_LEDGER_STATE_INVALID');
  }
  const state = claim.record.state;
  if (claim.reused === false) {
    if (state !== 'claimed') {
      throw new OrchestratorError('fresh idempotency claim is not active', 'IDEMPOTENCY_LEDGER_STATE_INVALID');
    }
    return 'fresh';
  }
  if (state === 'completed') return 'completed';
  if (state === 'claimed') return 'claimed';
  throw new OrchestratorError(
    `idempotency ledger returned unsupported state: ${String(state)}`,
    'IDEMPOTENCY_LEDGER_STATE_INVALID'
  );
}

function assertLedgerContract(ledger) {
  if (!ledger || typeof ledger.claim !== 'function' || typeof ledger.complete !== 'function' || typeof ledger.release !== 'function') {
    throw new TypeError('durable idempotency ledger with claim, complete, and release is required');
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
  constructor({ registry, gatekeeper, colossus, store = null, ledger, policyVersion = 'policy-v1', now = () => new Date() }) {
    if (!colossus || typeof colossus.dispatch !== 'function' || typeof colossus.reconcile !== 'function') {
      throw new TypeError('Colossus gateway with dispatch and reconcile is required');
    }
    assertLedgerContract(ledger);
    this.registry = registry;
    this.gatekeeper = gatekeeper;
    this.colossus = colossus;
    this.store = store;
    this.ledger = ledger;
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
    let freshClaimPlan = null;
    let providerBoundaryEntered = false;
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
      const approval = await this.gatekeeper.requestApproval({
        jobId: request.jobId,
        componentRef: request.componentRef,
        method,
        operation,
        policyVersion: this.policyVersion,
        plan
      });
      assertApprovalBinding({
        approval,
        expected: {
          approvalId: approval?.approvalId,
          jobId: request.jobId,
          planFingerprint: plan.planFingerprint,
          componentRef: request.componentRef,
          method,
          idempotencyKey: plan.idempotencyKey,
          policyVersion: this.policyVersion
        },
        now: this.now()
      });
      assertPlanIntegrity(plan);
      const claim = await this.ledger.claim(plan, this.now().toISOString());
      const disposition = dispatchClaimDisposition(claim);
      if (disposition === 'claimed') {
        job = await this.advance(job, 'recovery_required', this.metadata(plan.planFingerprint, 'IDEMPOTENCY_CLAIM_ALREADY_ACTIVE'));
        throw new OrchestratorError(
          'idempotent operation is already claimed; reconcile the prior attempt before retrying',
          'IDEMPOTENCY_RECOVERY_REQUIRED',
          job
        );
      }
      if (disposition === 'completed') {
        throw new OrchestratorError(
          'idempotent operation already completed; mutation replay is blocked',
          'IDEMPOTENCY_ALREADY_COMPLETED',
          job
        );
      }
      freshClaimPlan = plan;
      job = await this.advance(job, 'approved', this.metadata(plan.planFingerprint, 'APPROVAL_BOUND'));
      job = await this.advance(job, 'dispatched', this.metadata(plan.planFingerprint, 'DISPATCHED_THROUGH_COLOSSUS'));
      providerBoundaryEntered = true;
      const receipt = await this.colossus.dispatch({
        jobId: request.jobId,
        componentRef: request.componentRef,
        operation,
        method,
        plan,
        approval
      });
      job = await this.advance(job, 'attempted', this.metadata(plan.planFingerprint, 'EXECUTION_ATTEMPTED'));
      assertEvidenceBinding(receipt, 'provider_confirmed', plan, 'PROVIDER_RESULT_UNCONFIRMED');
      job = await this.advance(job, 'provider_confirmed', this.metadata(plan.planFingerprint, 'PROVIDER_CONFIRMED'));
      job = await this.advance(job, 'reconciling', this.metadata(plan.planFingerprint, 'RECONCILIATION_STARTED'));
      const reconciliation = await this.colossus.reconcile({
        jobId: request.jobId,
        componentRef: request.componentRef,
        operation,
        method,
        plan,
        approval
      });
      assertEvidenceBinding(reconciliation, 'reconciled', plan, 'RECONCILIATION_FAILED');
      job = await this.advance(job, 'reconciled', this.metadata(plan.planFingerprint, 'RECONCILED'));
      if (this.store?.recordOutcome) await this.store.recordOutcome({ job, receipt, reconciliation });
      await this.ledger.complete(plan, { receipt, reconciliation, now: job.updatedAt });
      freshClaimPlan = null;
      return Object.freeze({ job, plan, approval: { approvalId: approval.approvalId }, receipt, reconciliation });
    } catch (error) {
      if (error?.providerBoundaryEntered === false) {
        providerBoundaryEntered = false;
      }

      let failure = error instanceof OrchestratorError
        ? error
        : new OrchestratorError(error.message, error.code || 'ORCHESTRATOR_FAILED', job);

      if (freshClaimPlan && !providerBoundaryEntered) {
        try {
          await this.ledger.release(freshClaimPlan);
          freshClaimPlan = null;
        } catch (releaseError) {
          failure = new OrchestratorError(
            `pre-dispatch failure could not release idempotency claim: ${releaseError.message}`,
            'IDEMPOTENCY_RELEASE_FAILED',
            job
          );
        }
      }

      if (!providerBoundaryEntered && job?.state === 'dispatched') {
        try {
          if (freshClaimPlan) {
            job = await this.advance(job, 'recovery_required', this.metadata(job.planFingerprint || requestFingerprint, 'IDEMPOTENCY_RELEASE_UNCERTAIN'));
          } else {
            job = await this.advance(job, 'failed', this.metadata(job.planFingerprint || requestFingerprint, 'DISPATCH_REJECTED_BEFORE_PROVIDER_BOUNDARY'));
          }
          failure.job = job;
        } catch {
          // Preserve the original failure if failure-state persistence also fails.
        }
      }

      if (providerBoundaryEntered && job && RECOVERY_STATES.has(job.state)) {
        try {
          job = await this.advance(job, 'recovery_required', this.metadata(job.planFingerprint || requestFingerprint, 'PROVIDER_OUTCOME_UNCERTAIN'));
          failure.job = job;
        } catch {
          // Preserve the original provider-boundary failure if durable recovery-state persistence also fails.
        }
      }

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
