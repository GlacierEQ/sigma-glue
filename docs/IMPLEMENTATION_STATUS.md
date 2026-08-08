# Implementation status

## Verified in the current runnable slice

### Integrity and authorization

- Deterministic JSON-compatible plan fingerprinting with rejection of ambiguous unsupported values.
- Exact approval binding across approval ID, job ID, plan fingerprint, component ref, method, idempotency key, and policy version.
- Ed25519 Gatekeeper approval verification with signed-field substitution rejection, key rotation support, retirement handling, and revocation checks.
- Signed approval authenticity persisted separately from claim state.

### Durable claim and dispatch control

- File-backed SQLite approval, idempotency-claim, and dispatch-permit ledger.
- `BEGIN IMMEDIATE`, WAL mode, `synchronous = FULL`, strict tables, foreign keys, and rollback-on-failure behavior.
- Concurrent duplicate processes converge on one exact dispatch permit.
- One-shot permit transport fence binds permit + request ID + immutable envelope fingerprint before external transport entry.
- Sequential, cross-connection, and independent-process permit replay attacks fail closed before a second transport entry.
- Timeout/invalid-receipt uncertainty remains durably `started` and is not automatically replayed.
- Valid `dispatched` outcomes become `accepted`; explicit `blocked`/`failed` outcomes become `rejected`.
- Local completion observation time is stored separately from provider-reported receipt time.

### Colossus and provider boundary

- Colossus is a required mutation boundary for the orchestrator.
- Adapter routing is registry-only; callers cannot inject an adapter choice.
- Protocol/schema versions, scoped handles, capability/method scope, raw credential-shaped fields, permit persistence, expiry, and exact binding are validated before transport.
- Transport is abort-aware and makes no hidden retry.
- Validated receipts are bound to request, envelope, permit, component, resolved adapter, capability, method, and idempotency key.
- Dispatch receipts cannot overclaim provider confirmation.
- Opaque credential-broker HTTP transport rejects insecure endpoints, redirects, oversized responses, malformed JSON, and broker-detail leakage.

### Execution evidence and recovery

- Durable execution/reconciliation ledger records dispatch, attempt, provider confirmation, reconciliation start, and reconciliation result evidence.
- Transition evidence is subject-bound and time-bounded; replay with changed evidence fails closed.
- Hash-chain verification survives close/reopen.
- Reconciliation expectation is bound to provider-confirmed after-state and selected observation method.
- Orchestrator mutation paths require a durable claim/complete/release idempotency contract.
- Provider-boundary uncertainty and post-reconciliation ledger-completion failure route to recovery-required state instead of unsafe replay.

### Local runnable proof

- Test-root Commander execution with path containment, symlink escape rejection, idempotency, and compensating recovery coverage.
- Local durable job snapshots and redacted lifecycle receipts avoid persisting raw plan paths or credential-like fields in the tested persistence surfaces.
- Native GitHub Actions runs `npm test` on Node 22 for pull-request candidates.

## Explicit boundaries and unresolved production work

- The SQLite ledgers are **single-host durability mechanisms**, not distributed consensus or multi-host exactly-once services.
- The permit fence proves **at-most-once transport entry for one persisted permit**; it does not prove provider-transactional exactly-once execution.
- A durable `started` transport attempt is an uncertainty state requiring reconciliation because the provider may already have acted.
- Provider-side duplicate suppression is not assumed unless a provider adapter proves it.
- Live production Gatekeeper/Colossus/provider integrations are not claimed by the injected/fixture transport tests.
- Encryption-at-rest, operational key management, backup/restore procedures, schema migration policy, and production deployment hardening remain separate gates.
- `node:sqlite` is an evolving runtime surface; the repository declares the minimum Node runtime required by the transaction-state API it uses.
