export const STATES = Object.freeze([
  'received', 'normalized', 'capability_checked', 'planned',
  'awaiting_approval', 'approved', 'dispatched', 'attempted',
  'provider_confirmed', 'reconciling', 'reconciled', 'blocked',
  'failed', 'skipped', 'expired', 'recovery_required', 'cancelled'
]);

const transitions = Object.freeze({
  received: ['normalized', 'blocked', 'cancelled'],
  normalized: ['capability_checked', 'blocked', 'cancelled'],
  capability_checked: ['planned', 'blocked', 'cancelled'],
  planned: ['awaiting_approval', 'blocked', 'cancelled'],
  awaiting_approval: ['approved', 'expired', 'recovery_required', 'blocked', 'cancelled'],
  approved: ['dispatched', 'expired', 'blocked', 'cancelled'],
  dispatched: ['attempted', 'failed', 'recovery_required', 'blocked', 'cancelled'],
  attempted: ['provider_confirmed', 'failed', 'recovery_required', 'blocked'],
  provider_confirmed: ['reconciling', 'failed', 'recovery_required'],
  reconciling: ['reconciled', 'failed', 'recovery_required'],
  reconciled: ['recovery_required'], blocked: [], failed: [], skipped: [], expired: [],
  recovery_required: ['capability_checked', 'planned', 'cancelled', 'failed'], cancelled: []
});

export class StateTransitionError extends Error {
  constructor(message, code = 'ILLEGAL_STATE_TRANSITION') {
    super(message);
    this.name = 'StateTransitionError';
    this.code = code;
  }
}

export function transition(job, toState, { actor, reasonCode, inputFingerprint, policyVersion, at = new Date().toISOString() } = {}) {
  if (!STATES.includes(toState)) throw new StateTransitionError(`unknown target state: ${toState}`, 'UNKNOWN_STATE');
  if (!actor || !reasonCode || !inputFingerprint || !policyVersion) {
    throw new StateTransitionError('transition metadata is incomplete', 'INCOMPLETE_TRANSITION_METADATA');
  }
  const allowed = transitions[job.state] ?? [];
  if (!allowed.includes(toState)) {
    throw new StateTransitionError(`${job.state} -> ${toState} is not allowed`);
  }
  return {
    ...job,
    state: toState,
    updatedAt: at,
    history: [...(job.history ?? []), {
      fromState: job.state, toState, actor, reasonCode, inputFingerprint, policyVersion, at
    }]
  };
}
