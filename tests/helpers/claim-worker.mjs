import { SqliteClaimLedger } from '../../src/ledger/sqlite-claim-ledger.mjs';
import { createTestTrustStore } from './gatekeeper-fixture.mjs';

const [dbPath, expectedJson, nowIso] = process.argv.slice(2);
const ledger = new SqliteClaimLedger(dbPath, {
  timeoutMs: 10_000,
  approvalVerifier: createTestTrustStore()
});
try {
  const permit = ledger.claimDispatchPermit({
    expected: JSON.parse(expectedJson),
    now: new Date(nowIso)
  });
  process.stdout.write(`${JSON.stringify({ ok: true, permit })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`);
  process.exitCode = 1;
} finally {
  ledger.close();
}
