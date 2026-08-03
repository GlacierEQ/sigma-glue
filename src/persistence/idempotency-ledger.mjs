import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 'sigma-glue/idempotency/v1';

function safeKey(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new TypeError('idempotency key must be a non-empty safe string');
  }
  return encodeURIComponent(value);
}

function subject(plan) {
  if (!plan || typeof plan !== 'object') throw new TypeError('plan is required');
  if (typeof plan.planFingerprint !== 'string' || typeof plan.provider?.stableId !== 'string' || typeof plan.operation !== 'string') {
    throw new TypeError('plan fingerprint, provider identity, and operation are required');
  }
  return {
    idempotencyKey: plan.idempotencyKey,
    planFingerprint: plan.planFingerprint,
    provider: plan.provider.stableId,
    operation: plan.operation
  };
}

function evidenceSummary(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    status: typeof evidence.status === 'string' ? evidence.status : undefined,
    provider: typeof evidence.provider === 'string' ? evidence.provider : undefined,
    operation: typeof evidence.operation === 'string' ? evidence.operation : undefined,
    planFingerprint: typeof evidence.planFingerprint === 'string' ? evidence.planFingerprint : undefined,
    idempotencyKey: typeof evidence.idempotencyKey === 'string' ? evidence.idempotencyKey : undefined
  };
}

function sameSubject(record, expected) {
  return record.idempotencyKey === expected.idempotencyKey &&
    record.planFingerprint === expected.planFingerprint &&
    record.provider === expected.provider &&
    record.operation === expected.operation;
}

export class IdempotencyLedgerError extends Error {
  constructor(message, code = 'IDEMPOTENCY_LEDGER_ERROR') {
    super(message);
    this.name = 'IdempotencyLedgerError';
    this.code = code;
  }
}

export class DurableIdempotencyLedger {
  constructor(root) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('ledger root is required');
    this.root = root;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    return this;
  }

  fileFor(key) {
    return join(this.root, `${safeKey(key)}.json`);
  }

  async read(key) {
    await this.initialize();
    try { return JSON.parse(await readFile(this.fileFor(key), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async claim(plan, now = new Date().toISOString()) {
    const expected = subject(plan);
    await this.initialize();
    const record = {
      schemaVersion: SCHEMA_VERSION,
      recordType: 'idempotency_claim',
      ...expected,
      state: 'claimed',
      claimedAt: now,
      updatedAt: now
    };
    try {
      await writeFile(this.fileFor(expected.idempotencyKey), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { reused: false, record };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await this.read(expected.idempotencyKey);
      if (!existing || !sameSubject(existing, expected)) {
        throw new IdempotencyLedgerError('idempotency key was reused with a different payload', 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');
      }
      return { reused: true, record: existing };
    }
  }

  async complete(plan, { receipt, reconciliation, now = new Date().toISOString() } = {}) {
    const expected = subject(plan);
    const existing = await this.read(expected.idempotencyKey);
    if (!existing || !sameSubject(existing, expected)) {
      throw new IdempotencyLedgerError('idempotency claim is missing or mismatched', 'IDEMPOTENCY_SUBJECT_MISMATCH');
    }
    const completed = {
      ...existing,
      state: 'completed',
      receipt: evidenceSummary(receipt),
      reconciliation: evidenceSummary(reconciliation),
      updatedAt: now
    };
    const target = this.fileFor(expected.idempotencyKey);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(completed, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    return completed;
  }
}
