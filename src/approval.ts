import { fingerprintPlan, type PlanFingerprint } from "./plan.ts";
import { IllegalTransitionError, transitionJob } from "./state.ts";
import type { JobSnapshot, TransitionContext } from "./state.ts";

export type ApprovalStatus = "active" | "consumed" | "expired" | "revoked";

export interface GatekeeperApproval {
  readonly approvalId: string;
  readonly subjectId: string;
  readonly manifestFingerprint: PlanFingerprint;
  readonly policyVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly singleUse: true;
  readonly status: ApprovalStatus;
}

export interface ApprovalApplicationContext {
  readonly actor: string;
  readonly timestamp: string;
}

export type ApprovalApplicationResult =
  | {
      readonly decision: "approved";
      readonly job: JobSnapshot;
      readonly approval: GatekeeperApproval & { readonly status: "consumed" };
    }
  | {
      readonly decision: "blocked" | "expired";
      readonly reasonCode: string;
      readonly job: JobSnapshot;
      readonly approval: GatekeeperApproval;
    };

/** Bind Gatekeeper approval to the exact current plan and policy. */
export function applyGatekeeperApproval(
  job: JobSnapshot,
  approval: GatekeeperApproval,
  context: ApprovalApplicationContext,
): ApprovalApplicationResult {
  if (job.state !== "awaiting_approval") {
    throw new IllegalTransitionError(job.state, "approved");
  }

  const now = parseCanonicalTimestamp(context.timestamp, "context.timestamp");
  const issuedAt = parseCanonicalTimestamp(approval.issuedAt, "approval.issuedAt");
  const expiresAt = parseCanonicalTimestamp(approval.expiresAt, "approval.expiresAt");
  const approvalInputFingerprint = fingerprintPlan(approval);

  if (issuedAt >= expiresAt || issuedAt > now) {
    const blockedJob = transitionJob(
      job,
      "blocked",
      transitionContext(job, approval, context, "AUTHORIZATION_INVALID", approvalInputFingerprint),
    );
    return {
      decision: "blocked",
      reasonCode: "AUTHORIZATION_INVALID",
      job: blockedJob,
      approval,
    };
  }

  if (now >= expiresAt || approval.status === "expired") {
    const expiredJob = transitionJob(
      job,
      "expired",
      transitionContext(job, approval, context, "AUTHORIZATION_EXPIRED", approvalInputFingerprint),
    );
    return {
      decision: "expired",
      reasonCode: "AUTHORIZATION_EXPIRED",
      job: expiredJob,
      approval,
    };
  }

  if (approval.status !== "active") {
    const reasonCode =
      approval.status === "consumed" ? "AUTHORIZATION_CONSUMED" : "AUTHORIZATION_REVOKED";
    const blockedJob = transitionJob(
      job,
      "blocked",
      transitionContext(job, approval, context, reasonCode, approvalInputFingerprint),
    );
    return { decision: "blocked", reasonCode, job: blockedJob, approval };
  }

  if (job.policyVersion !== approval.policyVersion) {
    const blockedJob = transitionJob(
      job,
      "blocked",
      transitionContext(job, approval, context, "POLICY_VERSION_MISMATCH", approvalInputFingerprint),
    );
    return {
      decision: "blocked",
      reasonCode: "POLICY_VERSION_MISMATCH",
      job: blockedJob,
      approval,
    };
  }

  if (job.planFingerprint === undefined || job.planFingerprint !== approval.manifestFingerprint) {
    const blockedJob = transitionJob(
      job,
      "blocked",
      transitionContext(job, approval, context, "PLAN_FINGERPRINT_MISMATCH", approvalInputFingerprint),
    );
    return {
      decision: "blocked",
      reasonCode: "PLAN_FINGERPRINT_MISMATCH",
      job: blockedJob,
      approval,
    };
  }

  const approvedJob = transitionJob(
    job,
    "approved",
    transitionContext(job, approval, context, "APPROVAL_BOUND", approvalInputFingerprint),
  );
  const consumedApproval = Object.freeze({ ...approval, status: "consumed" as const });

  return {
    decision: "approved",
    job: approvedJob,
    approval: consumedApproval,
  };
}

function transitionContext(
  job: JobSnapshot,
  approval: GatekeeperApproval,
  context: ApprovalApplicationContext,
  reasonCode: string,
  inputFingerprint = fingerprintPlan(approval),
): TransitionContext {
  return {
    actor: context.actor,
    timestamp: context.timestamp,
    inputFingerprint,
    policyVersion: job.policyVersion,
    reasonCode,
  };
}

function parseCanonicalTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${field} must be canonical ISO-8601 UTC: ${value}`);
  }
  return parsed;
}
