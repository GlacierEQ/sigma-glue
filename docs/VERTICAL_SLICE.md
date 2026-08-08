# Sigma Glue vertical slice

**Status:** local/fixture execution proof with durable control-plane components; not a claim of live provider production execution.

This slice exercises the orchestration and evidence boundaries without requiring user credentials or live provider mutation services.

```text
normalized request
  -> component/protocol check
  -> deterministic plan fingerprint
  -> exact signed Gatekeeper approval binding
  -> durable idempotency claim + dispatch permit
  -> one-shot permit/envelope transport reservation
  -> Colossus dispatch boundary
  -> validated dispatch outcome
  -> durable execution evidence
  -> provider confirmation
  -> separate reconciliation
  -> separately approved compensation
```

## Implemented and exercised

- Component registry with exact protocol, method, operation, and capability checks.
- Normalized move request with stable provider/item identities and scoped relative paths.
- Deterministic plan fingerprints included in the exact approval subject.
- Ed25519 Gatekeeper approval verification and persisted authenticity evidence.
- SQLite approval consumption, idempotency claim, and exact dispatch-permit issuance.
- Cross-process duplicate claimers converge on one permit.
- One-shot transport fence records the exact request ID and immutable envelope fingerprint before Colossus transport entry.
- Sequential, cross-connection, and independent-process permit replay attacks fail closed.
- Timeout or invalid-receipt uncertainty remains durably `started`; automatic replay is prohibited.
- `dispatched` outcomes complete as `accepted`; explicit `blocked`/`failed` outcomes complete as `rejected`.
- Required Colossus gateway boundary; the orchestrator cannot dispatch directly to Commander.
- Abort-aware transport with no hidden retry and bounded receipt validation.
- Durable execution/reconciliation evidence across dispatch, attempt, provider confirmation, and reconciliation states.
- Test-root Commander fixture with path containment, idempotency, symlink escape rejection, and compensating moves.
- Deep-freeze and integrity checks prevent post-approval plan mutation in the tested flow.
- Provider and reconciliation evidence must bind to the approved execution subject.
- Conflicting item paths, idempotency payload reuse, ambiguous fingerprint values, raw credential-shaped content, and symlinked paths fail closed.
- Local persistence writes restart-readable job/evidence state while tested redaction rules exclude raw plan paths and credential-like fields from those persistence surfaces.
- Native GitHub Actions executes the full `npm test` suite on Node 22 for pull-request candidates.

## Boundary

`TestRootCommander` remains a fixture. The slice is evidence for the control-plane mechanisms above, not proof that live Commander, Gatekeeper, Colossus, macOS, cloud-provider, iOS, or Android integrations are operational.

The SQLite mechanisms are single-host durability, not distributed consensus. The transport fence proves at-most-once entry for one permit, not provider-transactional exactly-once execution. Live provider adapters, provider-side idempotency guarantees, encrypted-at-rest production storage, deployment hardening, and operational recovery procedures remain separate gates.
