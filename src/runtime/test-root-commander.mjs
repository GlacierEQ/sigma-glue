import { mkdir, rename, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export class TestRootCommanderError extends Error {
  constructor(message, code = 'COMMANDER_ERROR') {
    super(message);
    this.name = 'TestRootCommanderError';
    this.code = code;
  }
}

export class TestRootCommander {
  constructor(root) {
    this.root = resolve(root);
    this.receipts = new Map();
  }

  pathFor(relativePath) {
    const path = resolve(this.root, relativePath);
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(path) !== path) {
      throw new TestRootCommanderError('path is outside the test root', 'PATH_OUTSIDE_SCOPE');
    }
    return path;
  }

  async inspect(plan) {
    for (const item of plan.items) {
      const source = this.pathFor(item.source);
      try { await stat(source); } catch { throw new TestRootCommanderError(`source is missing: ${item.source}`, 'SOURCE_NOT_FOUND'); }
    }
    return { status: 'inspected', itemCount: plan.items.length, provider: plan.provider.stableId };
  }

  async execute(plan, { idempotencyKey } = {}) {
    if (!idempotencyKey) throw new TestRootCommanderError('idempotency key is required', 'IDEMPOTENCY_KEY_REQUIRED');
    if (this.receipts.has(idempotencyKey)) return this.receipts.get(idempotencyKey);
    await this.inspect(plan);
    const moved = [];
    try {
      for (const item of plan.items) {
        const source = this.pathFor(item.source);
        const destination = this.pathFor(item.destination);
        await mkdir(resolve(destination, '..'), { recursive: true });
        try { await stat(destination); throw new TestRootCommanderError(`destination exists: ${item.destination}`, 'DESTINATION_EXISTS'); } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'DESTINATION_EXISTS') throw error;
          if (error.code === 'DESTINATION_EXISTS') throw error;
        }
        await rename(source, destination);
        moved.push(item);
      }
    } catch (error) {
      for (const item of moved.reverse()) {
        await rename(this.pathFor(item.destination), this.pathFor(item.source)).catch(() => {});
      }
      throw error;
    }
    const receipt = Object.freeze({
      status: 'provider_confirmed',
      provider: plan.provider.stableId,
      idempotencyKey,
      planFingerprint: plan.planFingerprint,
      movedItems: moved.map((item) => item.stableId)
    });
    this.receipts.set(idempotencyKey, receipt);
    return receipt;
  }

  async reconcile(plan) {
    for (const item of plan.items) {
      try { await stat(this.pathFor(item.source)); throw new TestRootCommanderError(`source still exists: ${item.source}`, 'RECONCILIATION_FAILED'); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try { await stat(this.pathFor(item.destination)); } catch { throw new TestRootCommanderError(`destination is missing: ${item.destination}`, 'RECONCILIATION_FAILED'); }
    }
    return Object.freeze({ status: 'reconciled', planFingerprint: plan.planFingerprint, itemCount: plan.items.length });
  }

  async compensate(plan, { idempotencyKey } = {}) {
    return this.execute(plan, { idempotencyKey });
  }
}
