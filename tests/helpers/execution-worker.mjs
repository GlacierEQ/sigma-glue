import { SqliteExecutionLedger } from '../../src/ledger/sqlite-execution-ledger.mjs';

const [dbPath, operationId, transitionKey, envelopeFingerprint, nowIso] = process.argv.slice(2);
const ledger = new SqliteExecutionLedger(dbPath, { timeoutMs: 10_000 });
try {
  const operation = ledger.recordAttempt({
    operationId,
    transitionKey,
    attempt: {
      attemptId: 'attempt-concurrent',
      adapterId: 'commander',
      envelopeFingerprint,
      startedAt: nowIso
    },
    now: new Date(nowIso)
  });
  process.stdout.write(`${JSON.stringify({ ok: true, operation })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`);
  process.exitCode = 1;
} finally {
  ledger.close();
}
