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

### Provider ambiguity recovery

- Provider uncertainty records bind provider, operation, idempotency key, request ID, exact dispatch-envelope fingerprint, desired-state fingerprint, exact target, original provider baseline, and provider version semantics.
- Exact recovery targets are preserved as bounded, canonical provider-neutral JSON identities; credential-shaped target fields fail closed, while the legacy GitHub target retains path-safety validation.
- Supported version-semantics classes are `monotonic_revision`, `content_addressed`, and `unknown`.
- Recovery observation is bounded by a fail-closed timeout and receives an AbortSignal.
- Desired state observed -> `confirmed_applied` -> desired provider state is currently present; no replay; proceed to reconciliation.
- `confirmed_not_applied` is allowed only when the exact original baseline and observation both carry the same `monotonic_revision` identity.
- Restored content-addressed baselines, current absence after an absent baseline, divergent state, inaccessible state, failed reads, and timed-out reads remain `still_unknown`; automatic replay is forbidden.
- Provider recovery classifications are persisted to a separate SQLite evidence ledger as stable identities/fingerprints plus version semantics, not raw mutation payloads or credentials.
- Exact duplicate recovery records are idempotent; conflicting evidence for one request fails closed; recovery records and proof-strength metadata survive close/reopen.
- The original ambiguous one-shot dispatch remains `started`; recovery does not synthesize a dispatch receipt that was never observed.

### Real GitHub Contents provider proof

- A downstream GitHub Contents reference provider lives under `examples/colossus/`; Sigma remains the recovery coordinator and does not become a competing provider gateway.
- GitHub credentials remain inside an opaque broker and are never included in Sigma plans or durable recovery evidence.
- Recovery observation is bound to exactly `github-contents/v1` + `put`; cross-wired providers or operations fail before I/O.
- GitHub file `sha` is used as the exact conditional-write version for updates and is explicitly classified as `content_addressed`, not monotonic.
- Current provider state is read before mutation and compared with the exact approved baseline.
- An already-converged desired fingerprint performs no second PUT.
- Stale baseline conflicts block before mutation.
- 409/422 conditional conflicts are independently read back and classified as converged or conflicting.
- Transport failure, provider 5xx, and malformed/incomplete 2xx mutation evidence are treated as ambiguous outcomes requiring recovery rather than false failure.
- A file 404 is treated as current absence only after the repository and branch independently resolve; hidden/unresolved scope remains unknown.
- Restoring the original GitHub bytes after an ambiguous write can restore the original blob SHA, so an observed baseline does **not** prove historical non-application and remains `still_unknown`.
- A dedicated serialized GitHub Actions canary performs real repository mutations, deliberately discards one successful provider response, recovers the desired applied state by independent read-back, persists the recovery receipt and version semantics across close/reopen, and proves the original permit cannot reach a second provider write.

### Colossus composition and execution evidence

- Colossus is a required mutation boundary for `SigmaOrchestrator`; direct Commander mutation dispatch is rejected.
- `VerifiedColossusGateway` composes signed approval registration, permit issuance, one-shot transport, durable dispatch recording, execution-attempt ordering, provider confirmation, and reconciliation behind the orchestrator gateway contract.
- Dispatch authority may supply scoped capability/handle data but cannot substitute plan-owned mutation payload or execution subject fields.
- Provider confirmation is bound to durable request, operation, attempt, and envelope identities before it can advance execution state.
- Reconciliation truth is bound to provider-confirmed after-state and the selected observation method; a claimed match must equal the actual fingerprint comparison.
- Proof-gated pre-provider failures may release retry authority only when the repository-internal boundary proof establishes that no provider transport attempt was durably observed.
- Provider-boundary uncertainty and post-reconciliation ledger-completion failure route to recovery-required state instead of unsafe replay.
- Durable execution/reconciliation evidence is append-only, transition-key protected, and hash-chain verifiable across restart.

### Scale integration evidence contract

- Tool-call evidence has one exact machine-readable shape: `tool_selected`, `reason`, `input_fingerprint`, `attempt`, `result`, and `verification`.
- Raw call inputs are not retained in the evidence record; strict canonical input is represented by SHA-256 fingerprint.
- Result and verification evidence reject credential-shaped fields recursively and require strict JSON-compatible data.
- Recovery-target conformance is tested across GitHub, database, filesystem, external-API, and deployment-provider identity classes without claiming those classes share provider semantics.
- This conformance layer does not bypass provider-specific adapter registration, Gatekeeper approval, Colossus dispatch, or independent read-back requirements.

### Colossus adapter and broker boundary

- Adapter routing is registry-only; callers cannot inject an adapter choice.
- Protocol/schema versions, scoped handles, capability/method scope, raw credential-shaped fields, permit persistence, expiry, and exact binding are validated before transport.
- Transport is abort-aware and makes no hidden retry.
- Validated receipts are bound to request, envelope, permit, component, resolved adapter, capability, method, and idempotency key.
- Dispatch receipts cannot overclaim provider confirmation.
- Opaque credential-broker HTTP transport rejects insecure endpoints, redirects, oversized responses, malformed JSON, and broker-detail leakage.

### Local and live runnable proof

- Test-root Commander execution with path containment, symlink escape rejection, idempotency, and compensating recovery coverage.
- Local durable job snapshots and redacted lifecycle receipts avoid persisting raw plan paths or credential-like fields in the tested persistence surfaces.
- Native GitHub Actions runs the full `npm test` suite on Node 22 for pull-request candidates.
- A separate write-scoped GitHub Actions workflow exercises the real GitHub Contents provider recovery contract on the dedicated canary branch and target.

## Explicit boundaries and unresolved production work

- The SQLite ledgers are **single-host durability mechanisms**, not distributed consensus or multi-host exactly-once services.
- The permit fence proves **at-most-once transport entry for one persisted permit**; it does not prove provider-transactional exactly-once execution.
- Provider-aware recovery can prove `confirmed_applied`, `confirmed_not_applied`, or `still_unknown` only to the strength of the provider's read/write consistency and declared version semantics.
- `confirmed_applied` is an effect-state classification; without provider causal evidence it does not prove which actor authored the matching state.
- `confirmed_not_applied` requires monotonic revision evidence; content-addressed or unknown provider versions cannot justify it.
- A durable `started` or migrated `legacy_uncertain` transport attempt remains historical transport evidence even after a separate provider recovery record resolves current provider state.
- `confirmed_not_applied` never reuses the old approval; a new mutation attempt requires a new Gatekeeper authorization.
- The GitHub reference proves one concrete provider contract; other providers require their own idempotency, conditional-write, consistency, version-semantics, and recovery contracts.
- The live canary proves repository-scoped GitHub mutation/recovery behavior, not general live production deployment of Gatekeeper, Colossus, Commander, or every provider adapter.
- Encryption-at-rest, operational key management, backup/restore procedures, a general future schema-versioning policy, multi-host coordination, and production deployment hardening remain separate gates.
- `node:sqlite` is an evolving runtime surface; the repository declares the minimum Node runtime required by the transaction-state API it uses.
