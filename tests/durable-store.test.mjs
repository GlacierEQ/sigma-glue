import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComponentRegistry } from '../src/registry/component-registry.mjs';
import { SigmaOrchestrator } from '../src/orchestrator/orchestrator.mjs';
import { TestRootCommander } from '../src/runtime/test-root-commander.mjs';
import { DurableJobStore } from '../src/persistence/durable-store.mjs';

const component = {
  name: 'commander-test-root', ref: 'commander-test-root@v1', protocolVersion: 'sigma-federation/v1',
  allowedOperations: ['execute', 'reconcile'],
  supportedMethods: { execute: true, reconcile: true }
};

test('persists restart-readable lifecycle records without raw plan data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sigma-store-root-'));
  const storage = await mkdtemp(join(tmpdir(), 'sigma-store-data-'));
  try {
    await mkdir(join(root, 'inbox'), { recursive: true });
    await (await import('node:fs/promises')).writeFile(join(root, 'inbox', 'private-note.txt'), 'private');
    const registry = new ComponentRegistry();
    registry.register(component);
    const store = new DurableJobStore(storage);
    const commander = new TestRootCommander(root);
    const orchestrator = new SigmaOrchestrator({
      registry,
      store,
      commander,
      gatekeeper: { requestApproval: async ({ jobId, componentRef, method, plan }) => ({
        approvalId: 'approval-durable-1', status: 'approved', jobId, componentRef, method,
        idempotencyKey: plan.idempotencyKey, planFingerprint: plan.planFingerprint,
        expiresAt: '2099-01-01T00:00:00Z'
      }) }
    });

    const result = await orchestrator.move({
      jobId: 'job-durable-1', componentRef: component.ref,
      provider: { stableId: 'local-test-root', accessToken: 'must-never-persist' },
      items: [{ stableId: 'file:private-note', source: 'inbox/private-note.txt', destination: 'archive/private-note.txt' }],
      idempotencyKey: 'idem-durable-1'
    });

    const restartedStore = new DurableJobStore(storage);
    const saved = await restartedStore.getJob('job-durable-1');
    assert.equal(saved.state, 'reconciled');
    assert.equal(saved.planFingerprint, result.plan.planFingerprint);
    assert.match(saved.schemaVersion, /persistence\/v1$/);
    assert.equal(Object.hasOwn(saved, 'items'), false);
    const audit = await readFile(join(storage, 'audit.ndjson'), 'utf8');
    assert.equal(audit.split('\n').filter(Boolean).length, 11);
    assert.ok(audit.includes('execution_outcome'));
    assert.ok(!audit.includes('private-note.txt'));
    assert.ok(!audit.includes('must-never-persist'));
    assert.ok(!audit.includes('accessToken'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});
