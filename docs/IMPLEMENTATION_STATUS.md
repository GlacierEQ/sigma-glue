# Implementation status

## Verified in the first runnable slice

- Deterministic JSON-compatible plan fingerprinting (`sha256:` prefix)
- Rejection of undefined, non-finite, and unsupported plan values
- Exact approval binding to approval ID, job ID, plan fingerprint, component ref, method, and idempotency key
- Approval expiry rejection
- Fail-closed illegal state-transition rejection
- Key-order-independent fingerprints

## Not yet implemented or verified

- Durable storage
- Gatekeeper and Colossus adapters
- Scope negotiation and no-broadening enforcement
- Idempotency ledger
- Provider confirmation/reconciliation
- Redacted diagnostics
- Platform capability adapters
- Offline/resume behavior
