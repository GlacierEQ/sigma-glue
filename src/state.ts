import type { PlanFingerprint } from "./plan.ts";

export const JOB_STATES = [
  "received",
  "normalized",
  "capability_checked",
  "planned",
  "awaiting_approval",
  "approved",
  "dispatched",
  "attempted",
  "provider_confirmed",
  "reconciling",
  "reconciled",
  "blocked",
  "failed",
  "skipped",
  "expired",
  "recovery_required",
  "cancelled",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES = [
  "reconciled",
  "blocked",
  "failed",
  "skipped",
  "expired",
  "recovery_required",
  "cancelled",
] as const satisfies readonly JobState[];

export type TerminalState = (typeof TERMINAL_STATES)[number];

export interface TransitionRecord {
  readonly fromState: JobState;
  readonly toState: JobState;
  readonly actor: string;
  readonly timestamp: string;
  readonly inputFingerprint: string;
  readonly policyVersion: string;
  readonly reasonCode: string;
}

export interface JobSnapshot {
  readonly jobId: string;
  readonly state: JobState;
  readonly policyVersion: string;
  readonly planFingerprint?: PlanFingerprint;
  readonly history: readonly TransitionRecord[];
}

export interface TransitionContext {
  readonly actor: string;
  readonly timestamp: string;
  readonly inputFingerprint: string;
  readonly policyVersion: string;
  readonly reasonCode: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  received: ["normalized", "blocked", "cancelled"],
  normalized: ["capability_checked", "blocked", "skipped", "cancelled"],
  capability_checked: ["planned", "blocked", "skipped", "cancelled"],
  planned: ["awaiting_approval", "blocked", "skipped", "expired", "cancelled"],
  awaiting_approval: ["approved", "blocked", "skipped", "expired", "cancelled"],
  approved: ["dispatched", "blocked", "skipped", "expired", "cancelled"],
  dispatched: ["attempted", "failed", "recovery_required"],
  attempted: ["provider_confirmed", "failed", "recovery_required"],
  provider_confirmed: ["reconciling", "failed", "recovery_required"],
  reconciling: ["reconciled", "failed", "recovery_required"],
  reconciled: [],
  blocked: [],
  failed: [],
  skipped: [],
  expired: [],
  recovery_required: [],
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  readonly fromState: JobState;
  readonly toState: JobState;

  constructor(fromState: JobState, toState: JobState) {
    super(`Illegal Sigma Glue transition: ${fromState} -> ${toState}`);
    this.name = "IllegalTransitionError";
    this.fromState = fromState;
    this.toState = toState;
  }
}

export class PolicyVersionMismatchError extends Error {
  constructor(jobVersion: string, transitionVersion: string) {
    super(
      `Transition policy version ${transitionVersion} does not match job policy version ${jobVersion}`,
    );
    this.name = "PolicyVersionMismatchError";
  }
}

export function canTransition(fromState: JobState, toState: JobState): boolean {
  return ALLOWED_TRANSITIONS[fromState].includes(toState);
}

/** Apply one immutable, fail-closed state transition. */
export function transitionJob(
  job: JobSnapshot,
  toState: JobState,
  context: TransitionContext,
): JobSnapshot {
  if (!canTransition(job.state, toState)) {
    throw new IllegalTransitionError(job.state, toState);
  }

  if (job.policyVersion !== context.policyVersion) {
    throw new PolicyVersionMismatchError(job.policyVersion, context.policyVersion);
  }

  assertNonEmpty(context.actor, "actor");
  assertNonEmpty(context.inputFingerprint, "inputFingerprint");
  assertNonEmpty(context.reasonCode, "reasonCode");
  assertIsoTimestamp(context.timestamp);

  const record: TransitionRecord = Object.freeze({
    fromState: job.state,
    toState,
    actor: context.actor,
    timestamp: context.timestamp,
    inputFingerprint: context.inputFingerprint,
    policyVersion: context.policyVersion,
    reasonCode: context.reasonCode,
  });

  return Object.freeze({
    ...job,
    state: toState,
    history: Object.freeze([...job.history, record]),
  });
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

function assertIsoTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`timestamp must be canonical ISO-8601 UTC: ${value}`);
  }
}
