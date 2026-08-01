# Implementation status

## Verified core

- Deterministic SHA-256 plan fingerprinting with key-order independence
- Rejection of undefined, non-finite, cyclic, sparse, accessor-backed, symbol-keyed, and non-plain plan values
- Exact approval binding to approval ID, job ID, plan fingerprint, component ref, method, idempotency key, and policy version
- Rejection of expired, future-issued, inverted-window, and non-approved approvals
- Immutable fail-closed state transitions with policy-version binding
- Reachable `skipped` semantics before dispatch
- Separation of provider confirmation from reconciliation

## Verified durable authority handoff

- File-backed SQLite approval and idempotency ledger
- Atomic approval validation, idempotency claim, approval consumption, and permit issuance
- Idempotent replay returns the original persisted permit
- Changed content under a reused idempotency key fails closed
- Approval reuse under a different idempotency key fails closed
- Full transaction rollback after a forced post-consumption insertion failure
- Persistence across database close and reopen
- Eight competing Node processes converge on one claim and one permit

## Verification

```text
17 tests passed
0 tests failed
```

## Not yet implemented or verified

- Gatekeeper transport and authenticity verification
- Colossus adapter and dispatch
- Distributed or multi-host consensus
- Scope negotiation and no-broadening enforcement
- Provider-backed confirmation/reconciliation
- Redacted diagnostics
- Platform capability adapters
- Offline/resume behavior above the ledger layer

The ledger issues an exact expiring permit but performs no provider or filesystem operation by itself.
