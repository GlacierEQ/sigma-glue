import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 'sigma-glue/persistence/v1';

function assertSafeJobId(jobId) {
  if (typeof jobId !== 'string' || jobId.length === 0 || /[\u0000-\u001F\u007F]/.test(jobId)) {
    throw new TypeError('jobId must be a non-empty safe string');
  }
}

function fileKey(jobId) {
  assertSafeJobId(jobId);
  return encodeURIComponent(jobId);
}

function providerId(provider) {
  return provider && typeof provider.stableId === 'string' ? provider.stableId : undefined;
}

function evidenceSummary(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    status: typeof evidence.status === 'string' ? evidence.status : undefined,
    provider: providerId(evidence.provider ? { stableId: evidence.provider } : evidence),
    operation: typeof evidence.operation === 'string' ? evidence.operation : undefined,
    planFingerprint: typeof evidence.planFingerprint === 'string' ? evidence.planFingerprint : undefined,
    idempotencyKey: typeof evidence.idempotencyKey === 'string' ? evidence.idempotencyKey : undefined
  };
}

/**
 * Keep only lifecycle metadata. Plans, paths, credentials, tokens, and provider
 * payloads are intentionally excluded from durable records.
 */
export function redactJob(job) {
  if (!job || typeof job !== 'object') throw new TypeError('job is required');
  assertSafeJobId(job.jobId);
  return {
    schemaVersion: SCHEMA_VERSION,
    recordType: 'job',
    jobId: job.jobId,
    state: job.state,
    operation: job.operation,
    componentRef: job.componentRef,
    planFingerprint: job.planFingerprint,
    updatedAt: job.updatedAt,
    history: Array.isArray(job.history) ? job.history.map((entry) => ({
      fromState: entry.fromState,
      toState: entry.toState,
      actor: entry.actor,
      reasonCode: entry.reasonCode,
      inputFingerprint: entry.inputFingerprint,
      policyVersion: entry.policyVersion,
      at: entry.at
    })) : []
  };
}

export class DurableJobStore {
  constructor(root) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('storage root is required');
    this.root = root;
    this.jobsDir = join(root, 'jobs');
    this.auditFile = join(root, 'audit.ndjson');
  }

  async initialize() {
    await mkdir(this.jobsDir, { recursive: true });
    return this;
  }

  async saveJob(job) {
    await this.initialize();
    const record = redactJob(job);
    const target = join(this.jobsDir, `${fileKey(job.jobId)}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    return record;
  }

  async getJob(jobId) {
    await this.initialize();
    try {
      return JSON.parse(await readFile(join(this.jobsDir, `${fileKey(jobId)}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async appendAudit(event) {
    await this.initialize();
    const record = { schemaVersion: SCHEMA_VERSION, recordType: 'audit', ...event };
    await appendFile(this.auditFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return record;
  }

  async recordTransition(job) {
    const record = await this.saveJob(job);
    const latest = job.history?.at(-1);
    await this.appendAudit({
      event: 'state_transition',
      jobId: job.jobId,
      state: job.state,
      fromState: latest?.fromState,
      toState: latest?.toState,
      actor: latest?.actor,
      reasonCode: latest?.reasonCode,
      inputFingerprint: latest?.inputFingerprint,
      policyVersion: latest?.policyVersion,
      at: latest?.at,
      planFingerprint: job.planFingerprint
    });
    return record;
  }

  async recordOutcome({ job, receipt, reconciliation }) {
    const record = await this.saveJob(job);
    await this.appendAudit({
      event: 'execution_outcome',
      jobId: job.jobId,
      state: job.state,
      planFingerprint: job.planFingerprint,
      receipt: evidenceSummary(receipt),
      reconciliation: evidenceSummary(reconciliation),
      at: job.updatedAt
    });
    return record;
  }

  async recordFailure(job, error) {
    if (!job) return null;
    const record = await this.saveJob(job);
    await this.appendAudit({
      event: 'execution_failure',
      jobId: job.jobId,
      state: job.state,
      planFingerprint: job.planFingerprint,
      reasonCode: typeof error?.code === 'string' ? error.code : 'ORCHESTRATOR_FAILED',
      at: job.updatedAt
    });
    return record;
  }
}
