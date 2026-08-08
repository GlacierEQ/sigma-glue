# Implementation status

## Verified in the current runnable control-plane slice

### Integrity and authorization

- Deterministic JSON-compatible plan fingerprinting with rejection of ambiguous unsupported values.
- Exact approval binding across approval ID, job ID, plan fingerprint, component ref, method, idempotency key, and policy version.
- Ed25519 Gatekeeper approval verification with signed-field substitution rejection, key rotation support, retirement handling, and revocation checks.
- Signed approval authenticity persisted separately from mutable execution state.

### Durable claim and transport control

- File-backed SQLite approval, idempotency-claim, and dispatch-permit ledger.
- `BEGIN IMMEDIATE`, WAL mode, `synchronous = FULL`, strict tables, foreign keys, and rollback-on-failure behavior.
- Concurrent duplicate processes converge on one exact dispatch permit.
- One-shot permit transport fence binds permit + request ID + immutable envelope fingerprint before external transport entry.
- Sequential, cross-connection, and independent-process permit replay attacks fail closed before a second transport entry.
- Timeout/invalid-receipt uncertainty remains durably `started` and is not automatically replayed.
- Valid `dispatched` outcomes become `accepted`; explicit `blocked`/`failed` outcomes become `rejected`.
- Local completion observation time is stored separately from provider-reported receipt time.
- The known PR #10 attempt-table schema migrates transactionally; legacy rows become non-replayable `legacy_uncertain` evidence rather than being overclaimed as exact modern evidence.
- Unknown attempt-table layouts fail closed instead of receiving a guessed migration.

### Colossus composition and execution evidence

- Colossus is a required mutation boundary for `SigmaOrchestrator`; direct Commander mutation dispatch is rejected.
- `VerifiedColossusGateway` composes signed approval registration, permit issuance, one-shot transport, durable dispatch recording, execution-attempt ordering, provider confirmation, and reconciliation behind the orchestrator gateway contract.
- Dispatch authority may supply scoped capability/handle data but cannot substitute plan-owned mutation payload or execution subject fields.
- Provider confirmation is bound to durable request, operation, attempt, and envelope identities before it can advance execution state.
- Reconciliation truth is bound to provider-confirmed after-state and the selected observation method; a claimed match must equal the actual fingerprint comparison.
- Proof-gated pre-provider failures may release retry authority only when the repository-internal boundary proof establishes that no provider transport attempt was durably observed.
- Provider-boundary uncertainty and post-reconciliation ledger-completion failure route to recovery-required state instead of unsafe replay.
- Durable execution/reconciliation evidence is append-only, transition-key protected, and hash-chain verifiable across restart.

### Colossus adapter and broker boundary

- Adapter routing is registry-only; callers cannot inject an adapter choice.
- Protocol/schema versions, scoped handles, capability/method scope, raw credential-shaped fields, permit persistence, expiry, and exact binding are validated before transport.
- Transport is abort-aware and makes no hidden retry.
- Validated receipts are bound to request, envelope, permit, component, resolved adapter, capability, method, and idempotency key.
- Dispatch receipts cannot overclaim provider confirmation.
- Opaque credential-broker HTTP transport rejects insecure endpoints, redirects, oversized responses, malformed JSON, and broker-detail leakage.

### Local runnable proof

- Test-root Commander execution with path containment, symlink escape rejection, idempotency, and compensating recovery coverage.
- Local durable job snapshots and redacted lifecycle receipts avoid persisting raw plan paths or credential-like fields in the tested persistence surfaces.
- Native GitHub Actions runs the full `npm test` suite on Node 22 for pull-request candidates.

## Explicit boundaries and unresolved production work

- The SQLite ledgers are **single-host durability mechanisms**, not distributed consensus or multi-host exactly-once services.
- The permit fence proves **at-most-once transport entry for one persisted permit**; it does not prove provider-transactional exactly-once execution.
- A durable `started` or migrated `legacy_uncertain` transport attempt is an uncertainty state requiring reconciliation because the provider may already have acted.
- Provider-side duplicate suppression is not assumed unless a provider adapter proves it.
- The repository verifies injected/fixture boundaries; it does not by itself prove live production Gatekeeper, Colossus, Commander, or provider deployments.
- Encryption-at-rest, operational key management, backup/restore procedures, a general future schema-versioning policy, multi-host coordination, and production deployment hardening remain separate gates.
- `node:sqlite` is an evolving runtime surface; the repository declares the minimum Node runtime required by the transaction-state API it uses.
