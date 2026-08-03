# Sigma Glue vertical slice

**Status:** local test-root proof, not production execution.

This slice proves the orchestration boundary without touching user files, provider credentials, or live Commander services.

```text
normalized request
  -> component/protocol check
  -> deterministic plan
  -> exact Gatekeeper approval binding
  -> Commander test-root execution
  -> provider confirmation
  -> separate reconciliation
  -> separately approved compensation
```

## Implemented

- Component registry with exact protocol, method, and operation checks.
- Normalized move request with stable provider/item identities and scoped relative paths.
- Plan fingerprints included in the approval subject.
- Test-root Commander fixture with path containment, idempotency, and compensating moves.
- Orchestrator lifecycle through `reconciled`.
- Separate recovery plan and approval for compensation.
- Tests for changed plans, path escape, repeated idempotency subject, reconciliation, and recovery.
- Deep-freeze and integrity checks prevent post-approval plan mutation.
- Provider and reconciliation evidence must bind to the approved plan subject.
- Conflicting item paths, idempotency payload reuse, ambiguous fingerprint values, and symlinked paths fail closed.
- Optional local persistence writes atomic, restart-readable job snapshots and redacted NDJSON audit receipts.
- Persistence tests verify lifecycle recovery from disk and exclude raw plan paths and credential-like fields.

## Boundary

`TestRootCommander` is a fixture only. It is not evidence that the live Commander, Gatekeeper, Colossus, macOS filesystem, cloud providers, iOS, or Android paths are operational. Durable storage, scoped credential handles, provider adapters, and production recovery remain future work.
