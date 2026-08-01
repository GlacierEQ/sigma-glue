# Permit-gated Colossus dispatch adapter

## Purpose

This adapter is the only Sigma Glue path from a durable dispatch permit to Colossus routing. It does not execute provider operations and does not own transport credentials.

```text
persisted dispatch permit
→ exact permit/request comparison
→ version validation
→ registry-only route resolution
→ scoped-handle validation
→ immutable envelope fingerprint
→ one abort-aware Colossus transport call
→ bounded dispatch receipt validation
```

## Trust rules

- A self-hashed permit is insufficient. The adapter re-resolves the permit from the durable ledger and compares every bound field.
- The caller cannot choose an adapter. `componentRef` resolves to `adapterId` only through the constructor-supplied registry.
- Method and capability must both exist in the registered route.
- The request cannot contain unknown top-level fields.
- Payloads and handles cannot contain raw credential-shaped fields.
- Scoped handles are exact, expiring, and may not outlive the dispatch permit.
- Protocol and schema versions must match the adapter's configured versions exactly.
- The transport must be abort-aware. The adapter makes one call and performs no hidden retry.

## Receipt semantics

A `dispatched` receipt means Colossus accepted and routed the immutable envelope. It does **not** mean:

- the component executed successfully;
- the provider confirmed a mutation;
- reconciliation completed.

The receipt must bind the request, envelope fingerprint, permit fingerprint, component, resolved adapter, capability, method, and idempotency key. A dispatch receipt that claims provider confirmation is rejected.

## Boundary

The current transport is injected. No live Colossus endpoint, credential broker, provider adapter, provider confirmation, or reconciliation is included or claimed as verified by this slice.
