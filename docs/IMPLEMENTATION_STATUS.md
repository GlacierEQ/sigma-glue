# Implementation status

## Verified in the first runnable slice

- Deterministic JSON-compatible plan fingerprinting (`sha256:` prefix)
- Rejection of undefined, non-finite, and unsupported plan values
- Exact approval binding to approval ID, job ID, plan fingerprint, component ref, method, and idempotency key
- Approval expiry rejection
- Fail-closed illegal state-transition rejection
- Key-order-independent fingerprints
- Component registry protocol/method/operation checks
- Scoped relative-path normalization and traversal rejection
- Test-root Commander execution with idempotency and rollback-on-partial-failure
- Separate provider confirmation and reconciliation
- Separately approved compensating recovery plan
- 17/17 automated tests pass with `npm test`
- Deep-frozen request, plan, and component capability snapshots
- Plan-integrity recheck immediately before dispatch
- Provider-confirmed and reconciled evidence bound to plan, provider, and idempotency key
- Idempotency-key reuse with a different payload rejected
- Duplicate/overlapping item plans rejected before filesystem execution
- Ambiguous non-plain fingerprint inputs rejected
- Symlinked test-root paths rejected without mutation
- Local durable job snapshots with atomic replacement and restart-readable records
- Redacted NDJSON audit receipts for lifecycle transitions, outcomes, and failures
- Persistence tests prove raw plan paths and credential-like fields are not written

## Not yet implemented or verified

- Production-grade durable storage
- Live Gatekeeper and Colossus adapters
- Scope negotiation and no-broadening enforcement beyond registry declarations
- Production idempotency ledger
- Live provider confirmation/reconciliation
- Redacted diagnostics and durable audit receipts
- Platform capability adapters
- Offline/resume behavior
