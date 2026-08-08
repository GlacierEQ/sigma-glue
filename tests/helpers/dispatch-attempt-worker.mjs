import { FencedSqliteClaimLedger } from '../../src/ledger/fenced-sqlite-claim-ledger.mjs';
import { createTestTrustStore } from './gatekeeper-fixture.mjs';

const [dbPath, permitJson, requestId, envelopeFingerprint, nowIso] = process.argv.slice(2);
const ledger = new FencedSqliteClaimLedger(dbPath, {
  timeoutMs: 10_000,
  approvalVerifier: createTestTrustStore()
});
try {
  const attempt = ledger.beginDispatchAttempt({
    permit: JSON.parse(permitJson),
    requestId,
    envelopeFingerprint,
    now: new Date(nowIso)
  });
  process.stdout.write(`${JSON.stringify({ ok: true, attempt })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`);
} finally {
  ledger.close();
}
