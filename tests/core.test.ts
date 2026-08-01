import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalizationError,
  IllegalTransitionError,
  PolicyVersionMismatchError,
  applyGatekeeperApproval,
  canonicalize,
  fingerprintPlan,
  transitionJob,
  type GatekeeperApproval,
  type JobSnapshot,
  type JobState,
  type PlanFingerprint,
} from "../src/index.ts";

test("canonical plan fingerprint ignores object insertion order", () => {
  const first = {
    operation: "move",
    resource: { remoteId: "file-1", provider: "local" },
    destination: { path: "/approved/example.txt" },
  };
  const second = {
    destination: { path: "/approved/example.txt" },
    resource: { provider: "local", remoteId: "file-1" },
    operation: "move",
  };

  assert.equal(canonicalize(first), canonicalize(second));
  assert.equal(fingerprintPlan(first), fingerprintPlan(second));
});

test("array order remains significant", () => {
  assert.notEqual(fingerprintPlan({ items: ["a", "b"] }), fingerprintPlan({ items: ["b", "a"] }));
});

test("ambiguous or unsafe JavaScript values are rejected", () => {
  assert.throws(() => canonicalize({ value: undefined }), CanonicalizationError);
  assert.throws(() => canonicalize({ value: Number.NaN }), CanonicalizationError);
  assert.throws(() => canonicalize(new Date()), CanonicalizationError);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalize(cyclic), CanonicalizationError);

  const sparse = new Array(2);
  sparse[1] = "present";
  assert.throws(() => canonicalize(sparse), CanonicalizationError);

  const symbolKeyed = { visible: true, [Symbol("hidden")]: "not-fingerprinted" };
  assert.throws(() => canonicalize(symbolKeyed), CanonicalizationError);

  const accessor = Object.defineProperty({}, "dynamic", { enumerable: true, get: () => 1 });
  assert.throws(() => canonicalize(accessor), CanonicalizationError);
});

const initialJob: JobSnapshot = {
  jobId: "job-001",
  state: "received",
  policyVersion: "policy/v1",
  history: [],
};

const context = {
  actor: "sigma-ui/session-1",
  timestamp: "2026-08-01T22:00:00.000Z",
  inputFingerprint: "sha256:input",
  policyVersion: "policy/v1",
  reasonCode: "REQUEST_NORMALIZED",
};

test("legal transitions append immutable evidence", () => {
  const normalized = transitionJob(initialJob, "normalized", context);

  assert.equal(normalized.state, "normalized");
  assert.equal(normalized.history.length, 1);
  assert.deepEqual(normalized.history[0], {
    fromState: "received",
    toState: "normalized",
    actor: context.actor,
    timestamp: context.timestamp,
    inputFingerprint: context.inputFingerprint,
    policyVersion: context.policyVersion,
    reasonCode: context.reasonCode,
  });
  assert.equal(initialJob.state, "received");
  assert.equal(initialJob.history.length, 0);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.history));
});

test("illegal transitions fail closed", () => {
  assert.throws(() => transitionJob(initialJob, "approved", context), IllegalTransitionError);
});

test("policy version cannot silently change during transition", () => {
  assert.throws(
    () => transitionJob(initialJob, "normalized", { ...context, policyVersion: "policy/v2" }),
    PolicyVersionMismatchError,
  );
});

test("pre-dispatch policy exclusions are skipped, not failed", () => {
  const normalized = transitionJob(initialJob, "normalized", context);
  const skipped = transitionJob(normalized, "skipped", {
    ...context,
    timestamp: "2026-08-01T22:00:00.001Z",
    reasonCode: "POLICY_EXCLUDED",
  });

  assert.equal(skipped.state, "skipped");
  assert.equal(skipped.history.at(-1)?.reasonCode, "POLICY_EXCLUDED");
});

const policyVersion = "policy/v1";
const now = "2026-08-01T22:00:00.000Z";

function jobAwaitingApproval(planFingerprint: PlanFingerprint): JobSnapshot {
  let job: JobSnapshot = {
    jobId: "job-approval-001",
    state: "received",
    policyVersion,
    planFingerprint,
    history: [],
  };

  const path: readonly JobState[] = [
    "normalized",
    "capability_checked",
    "planned",
    "awaiting_approval",
  ];

  for (const [index, state] of path.entries()) {
    job = transitionJob(job, state, {
      actor: "sigma-glue",
      timestamp: new Date(Date.parse(now) + index).toISOString(),
      inputFingerprint: `sha256:transition-${index}`,
      policyVersion,
      reasonCode: `TEST_${state.toUpperCase()}`,
    });
  }

  return job;
}

function approval(
  manifestFingerprint: PlanFingerprint,
  overrides: Partial<GatekeeperApproval> = {},
): GatekeeperApproval {
  return {
    approvalId: "approval-001",
    subjectId: "user-001",
    manifestFingerprint,
    policyVersion,
    issuedAt: "2026-08-01T21:59:00.000Z",
    expiresAt: "2026-08-01T22:05:00.000Z",
    singleUse: true,
    status: "active",
    ...overrides,
  };
}

test("exact active approval advances awaiting_approval to approved and is consumed", () => {
  const fingerprint = fingerprintPlan({ operation: "move", itemId: "file-1" });
  const result = applyGatekeeperApproval(jobAwaitingApproval(fingerprint), approval(fingerprint), {
    actor: "gatekeeper",
    timestamp: now,
  });

  assert.equal(result.decision, "approved");
  assert.equal(result.job.state, "approved");
  assert.equal(result.approval.status, "consumed");
  assert.equal(result.job.history.at(-1)?.reasonCode, "APPROVAL_BOUND");
});

test("destination or plan substitution is blocked", () => {
  const approvedPlan = fingerprintPlan({ operation: "move", destination: "/allowed" });
  const substitutedPlan = fingerprintPlan({ operation: "move", destination: "/substituted" });

  const result = applyGatekeeperApproval(
    jobAwaitingApproval(substitutedPlan),
    approval(approvedPlan),
    { actor: "gatekeeper", timestamp: now },
  );

  assert.equal(result.decision, "blocked");
  assert.equal(result.job.state, "blocked");
  assert.equal(result.reasonCode, "PLAN_FINGERPRINT_MISMATCH");
});

test("expired approval cannot advance the job", () => {
  const fingerprint = fingerprintPlan({ operation: "move", itemId: "file-1" });
  const result = applyGatekeeperApproval(
    jobAwaitingApproval(fingerprint),
    approval(fingerprint, { expiresAt: now }),
    { actor: "gatekeeper", timestamp: now },
  );

  assert.equal(result.decision, "expired");
  assert.equal(result.job.state, "expired");
  assert.equal(result.reasonCode, "AUTHORIZATION_EXPIRED");
});

test("consumed approval reuse is blocked", () => {
  const fingerprint = fingerprintPlan({ operation: "move", itemId: "file-1" });
  const result = applyGatekeeperApproval(
    jobAwaitingApproval(fingerprint),
    approval(fingerprint, { status: "consumed" }),
    { actor: "gatekeeper", timestamp: now },
  );

  assert.equal(result.decision, "blocked");
  assert.equal(result.job.state, "blocked");
  assert.equal(result.reasonCode, "AUTHORIZATION_CONSUMED");
});

test("policy substitution is blocked", () => {
  const fingerprint = fingerprintPlan({ operation: "move", itemId: "file-1" });
  const result = applyGatekeeperApproval(
    jobAwaitingApproval(fingerprint),
    approval(fingerprint, { policyVersion: "policy/v2" }),
    { actor: "gatekeeper", timestamp: now },
  );

  assert.equal(result.decision, "blocked");
  assert.equal(result.job.state, "blocked");
  assert.equal(result.reasonCode, "POLICY_VERSION_MISMATCH");
});

test("future-issued or inverted approval window is blocked", () => {
  const fingerprint = fingerprintPlan({ operation: "move", itemId: "file-1" });
  const result = applyGatekeeperApproval(
    jobAwaitingApproval(fingerprint),
    approval(fingerprint, {
      issuedAt: "2026-08-01T22:01:00.000Z",
      expiresAt: "2026-08-01T22:00:30.000Z",
    }),
    { actor: "gatekeeper", timestamp: now },
  );

  assert.equal(result.decision, "blocked");
  assert.equal(result.job.state, "blocked");
  assert.equal(result.reasonCode, "AUTHORIZATION_INVALID");
});
