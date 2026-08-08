# Permit-gated Colossus dispatch adapter

## Purpose

This adapter is the Sigma Glue boundary from a durable dispatch permit to Colossus routing. It does not own provider credentials and it does not claim provider execution success.

```text
persisted dispatch permit
→ exact permit/request comparison
→ version validation
→ registry-only route resolution
→ scoped-handle validation
→ immutable envelope fingerprint
→ atomic one-shot attempt reservation
   (permit + request ID + envelope fingerprint)
→ one abort-aware Colossus transport call
→ bounded dispatch receipt validation
→ durable local outcome completion
   accepted: dispatched receipt
   rejected: blocked/failed receipt
```

## Trust rules

- A self-hashed permit is insufficient. The adapter re-resolves the permit from the durable ledger and compares every bound field.
- The caller cannot choose an adapter. `componentRef` resolves to `adapterId` only through the constructor-supplied registry.
- Method and capability must both exist in the registered route.
- The request cannot contain unknown top-level fields.
- Payloads and handles cannot contain raw credential-shaped fields.
- Scoped handles are exact, expiring, and may not outlive the dispatch permit.
- Protocol and schema versions must match the adapter's configured versions exactly.
- Before transport, the fence durably binds the permit to the exact request ID and immutable envelope fingerprint.
- The transport must be abort-aware. The adapter makes one call and performs no hidden retry.
- Arbitrary permit-store errors are not copied into the public dispatch error message or code surface.

## One-shot transport semantics

A permit may create at most one durable transport attempt.

- no prior attempt: record `started`, then enter transport;
- prior `started`, `accepted`, or `rejected`: fail closed before transport;
- timeout, crash, lost response, or malformed receipt after transport entry: leave `started` for recovery and prohibit automatic replay;
- valid `dispatched` receipt: complete the attempt as `accepted`;
- valid `blocked` or `failed` receipt: complete the attempt as `rejected`.

The attempt stores no payload. Recovery evidence is limited to stable identities and fingerprints: permit identity, request ID, envelope fingerprint, receipt fingerprint/status, local completion time, and provider-reported receipt time.

## Receipt semantics

A `dispatched` receipt means Colossus accepted and routed the immutable envelope. It does **not** mean:

- the component executed successfully;
- the provider confirmed a mutation;
- reconciliation completed.

The receipt must bind the request, envelope fingerprint, permit fingerprint, component, resolved adapter, capability, method, and idempotency key. A dispatch receipt that claims provider confirmation is rejected.

Provider `receivedAt` is retained as **reported evidence**. It never becomes the locally verified completion clock; Sigma Glue records its own local observation time separately.

## Boundary

This mechanism provides an **at-most-once transport-entry fence**, not provider-transactional exactly-once semantics. A durable `started` attempt is intentionally an uncertainty state because the provider may already have acted.

The current transport remains injected. No live provider adapter, provider-side duplicate-suppression contract, or distributed consensus service is claimed by this slice.
