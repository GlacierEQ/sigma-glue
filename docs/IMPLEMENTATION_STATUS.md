# Implementation status

## Verified core

- Deterministic SHA-256 plan fingerprinting with key-order independence
- Rejection of undefined, non-finite, cyclic, sparse, accessor-backed, symbol-keyed, and non-plain plan values
- Exact approval binding to approval ID, job ID, plan fingerprint, component ref, method, idempotency key, and policy version
- Rejection of expired, future-issued, inverted-window, and non-approved approvals
- Immutable fail-closed state transitions with policy-version binding
- Reachable `skipped` semantics before dispatch
- Separation of provider confirmation from reconciliation

## Verified Gatekeeper authenticity

- Ed25519-signed canonical approval envelopes
- Issuer and key-ID trust-store resolution
- Active, retired, and revoked key states
- Key signing-validity and retirement windows
- Historical verification under retired keys
- Overlapping old/new key rotation
- Signed-field substitution rejection
- Separate key and signature fingerprints
- Claim-time re-verification so later revocation blocks unconsumed approvals
- Unsigned legacy approval rows cannot authorize claims

## Verified durable authority handoff

- File-backed SQLite approval and idempotency ledger
- Atomic approval validation, idempotency claim, approval consumption, and permit issuance
- Idempotent replay returns the original persisted permit
- Changed content under a reused idempotency key fails closed
- Approval reuse under a different idempotency key fails closed
- Full transaction rollback after a forced post-consumption insertion failure
- Persistence across database close and reopen
- Eight competing Node processes converge on one claim and one permit

## Verified permit-gated Colossus boundary

- Dispatch permits are re-resolved from the durable ledger before routing
- Self-consistent but unpersisted forged permits are rejected
- Exact permit/request binding is enforced before transport
- Protocol and schema versions fail closed on mismatch
- Components, methods, adapters, and capabilities resolve from the registry only
- Scoped handles are exact, unique, expiring, and bounded by permit expiry
- Raw credential-shaped payload or handle fields are rejected
- Dispatch envelopes are canonical, fingerprinted, and deeply immutable
- The transport is abort-aware and receives exactly one call with no hidden retry
- Dispatch receipts are exact-bound and cannot claim provider confirmation or reconciliation

## Verified concrete transport contract

- HTTPS-only Colossus endpoint policy
- Endpoint userinfo, query, fragment, and cross-origin redirect rejection
- Opaque `credh_` broker handles passed separately from HTTP requests
- No authorization or cookie value exposed to Sigma Glue request construction
- Broker-owned authenticated fetch interface
- Canonical POST body and fixed non-secret headers
- Abort propagation and one-attempt behavior
- HTTP status, JSON content type, response shape, and response-size enforcement
- Error-body suppression and broker-error redaction

## Durable execution and reconciliation tranche

- Separate durable states for `dispatched`, `attempted`, `provider_confirmed`, `reconciling`, and `reconciled`
- Reconciliation mismatch terminates as `recovery_required`
- Append-only hash-chained execution evidence
- Exact transition-key idempotency and changed-evidence rejection
- Durable provider-confirmation and reconciliation records
- Eight-process duplicate-attempt convergence
- Event-chain verification across close and reopen
- Verified execution façade binding attempts to the dispatched adapter and envelope
- Reconciliation expectation bound to the provider-confirmed after-state
- Reconciliation completion bound to the selected observation method
- Evidence timestamps bound to prior durable state and observation time
- Coordinator distinguishes dispatch rejection from post-acceptance persistence failure

## Verification

```text
62 tests expected in this tranche
GitHub merge-commit verification required before merge
```

## Not yet implemented or verified

- Remote Gatekeeper transport and trust-store distribution
- Private signing-key custody
- Live Colossus deployment connectivity
- Production credential-broker implementation and token custody
- Distributed or multi-host consensus
- Provider adapter execution
- Live provider-backed confirmation and reconciliation
- Redacted persistent diagnostics
- Platform capability adapters
- Offline/resume behavior above the ledger layer

Sigma Glue can now represent the complete evidence-state chain through reconciliation, but it does not manufacture provider evidence. A provider-confirmed or reconciled state requires direct evidence supplied by a future provider adapter.
