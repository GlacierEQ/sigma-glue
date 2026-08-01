export const STATES = Object.freeze([
  'received', 'normalized', 'capability_checked', 'planned',
  'awaiting_approval', 'approved', 'dispatched', 'attempted',
  'provider_confirmed', 'reconciling', 'reconciled', 'blocked',
  'failed', 'skipped', 'expired', 'recovery_required', 'cancelled'
]);

const transitions = Object.freeze({
  received: ['normalized', 'blocked', 'cancelled'],
  normalized: ['capability_checked', 'blocked', 'skipped', 'cancelled'],
  capability_checked: ['planned', 'blocked', 'skipped', 'cancelled'],
  planned: ['awaiting_approval', 'blocked', 'skipped', 'expired', 'cancelled'],
  awaiting_approval: ['approved', 'expired', 'blocked', 'skipped', 'cancelled'],
  approved: ['dispatched', 'expired', 'blocked', 'skipped', 'cancelled'],
  dispatched: ['attempted', 'failed', 'blocked', 'cancelled', 'recovery_required'],
  attempted: ['provider_confirmed', 'failed', 'recovery_required'],
  provider_confirmed: ['reconciling', 'failed', 'recovery_required'],
  reconciling: ['reconciled', 'failed', 'recovery_required'],
  reconciled: [], blocked: [], failed: [], skipped: [], expired: [],
  recovery_required: ['planned', 'cancelled', 'failed'], cancelled: []
});

export class StateTransitionError extends Error {
  constructor(message, code = 'ILLEGAL_STATE_TRANSITION') {
    super(message);
    this.name = 'StateTransitionError';
    this.code = code;
  }
}

export function transition(job, toState, metadata = {}) {
  const { actor, reasonCode, inputFingerprint, policyVersion, at = new Date().toISOString() } = metadata;

  if (!job || typeof job !== 'object') {
    throw new StateTransitionError('job is required', 'INVALID_JOB');
  }
  if (!STATES.includes(job.state)) {
    throw new StateTransitionError(`unknown source state: ${job.state}`, 'UNKNOWN_STATE');
  }
  if (!STATES.includes(toState)) {
    throw new StateTransitionError(`unknown target state: ${toState}`, 'UNKNOWN_STATE');
  }
  for (const [field, value] of Object.entries({ actor, reasonCode, inputFingerprint, policyVersion })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new StateTransitionError(`transition metadata is missing ${field}`, 'INCOMPLETE_TRANSITION_METADATA');
    }
  }
  if (typeof job.policyVersion !== 'string' || job.policyVersion !== policyVersion) {
    throw new StateTransitionError('transition policy version does not match job', 'POLICY_VERSION_MISMATCH');
  }

  const parsedAt = Date.parse(at);
  if (!Number.isFinite(parsedAt)) {
    throw new StateTransitionError('transition timestamp is invalid', 'INVALID_TRANSITION_TIMESTAMP');
  }
  const canonicalAt = new Date(parsedAt).toISOString();

  const allowed = transitions[job.state] ?? [];
  if (!allowed.includes(toState)) {
    throw new StateTransitionError(`${job.state} -> ${toState} is not allowed`);
  }

  const record = Object.freeze({
    fromState: job.state,
    toState,
    actor,
    reasonCode,
    inputFingerprint,
    policyVersion,
    at: canonicalAt
  });
  const history = Object.freeze([...(job.history ?? []), record]);

  return Object.freeze({
    ...job,
    state: toState,
    updatedAt: canonicalAt,
    history
  });
}
