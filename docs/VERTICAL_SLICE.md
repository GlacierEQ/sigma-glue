# Sigma Glue vertical slice

**Status:** local/fixture execution proof with durable control-plane components; not a claim of live provider production execution.

This slice exercises the orchestration, authorization, transport, and evidence boundaries without requiring user credentials or live provider mutation services.

```text
normalized request
  -> deterministic plan fingerprint
  -> exact signed Gatekeeper approval binding
  -> durable idempotency claim + dispatch permit
  -> one-shot permit/envelope transport reservation
  -> Colossus dispatch boundary
  -> durable dispatch + execution-attempt evidence
  -> exact provider confirmation
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
- `VerifiedColossusGateway` composes approval/permit issuance, transport, durable dispatch/attempt ordering, provider confirmation, and reconciliation behind that boundary.
- Plan-owned mutation payloads cannot be replaced by deployment-supplied authority data.
- Provider confirmation must bind the durable request, operation, attempt, and envelope identities.
- Reconciliation match claims are checked against the actual expected/observed fingerprint comparison.
- Proof-gated pre-provider retry distinguishes a provable no-transport failure from provider-outcome uncertainty.
- Durable execution/reconciliation records are transition-key protected and hash-chain verifiable across restart.
- Abort-aware transport performs no hidden retry and validates bounded dispatch receipts.
- Test-root Commander fixture covers path containment, idempotency, symlink escape rejection, and compensating moves.
- Deep-freeze and integrity checks prevent post-approval plan mutation in the tested flow.
- Conflicting item paths, idempotency payload reuse, ambiguous fingerprint values, raw credential-shaped content, and symlinked paths fail closed.
- Local persistence writes restart-readable job/evidence state while tested redaction rules exclude raw plan paths and credential-like fields from those persistence surfaces.
- Native GitHub Actions executes the full `npm test` suite on Node 22 for pull-request candidates.

## Boundary

`TestRootCommander` and injected provider/evidence bridges remain fixtures. The slice is evidence for the control-plane mechanisms above, not proof that live Commander, Gatekeeper, Colossus, macOS, cloud-provider, iOS, or Android integrations are operational.

The SQLite mechanisms are single-host durability, not distributed consensus. The transport fence proves at-most-once entry for one permit, not provider-transactional exactly-once execution. Provider-side idempotency guarantees, encrypted-at-rest production storage, schema migration/backup policy, multi-host coordination, deployment hardening, and operational recovery procedures remain separate gates.
