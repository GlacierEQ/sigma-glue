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

## Verification

```text
36 tests expected in this tranche
GitHub merge-commit verification required before merge
```

## Not yet implemented or verified

- Remote Gatekeeper transport and trust-store distribution
- Private signing-key custody
- Live Colossus HTTP transport
- Credential broker integration
- Distributed or multi-host consensus
- Provider adapter execution
- Durable attempt and reconciliation ledger
- Provider-backed confirmation and reconciliation
- Redacted persistent diagnostics
- Platform capability adapters
- Offline/resume behavior above the ledger layer

The adapter verifies and routes a durable permit through an injected Colossus transport. A `dispatched` receipt means routing acceptance only; it is not provider confirmation or reconciliation.
