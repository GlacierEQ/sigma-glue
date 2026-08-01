# Durable execution and reconciliation ledger

## Purpose

The execution ledger records what happens after Colossus accepts a dispatch. It keeps routing acceptance, execution attempt, provider confirmation, and reconciliation as separate evidence states.

```text
dispatched
→ attempted
→ provider_confirmed
→ reconciling
→ reconciled
```

A reconciliation mismatch ends in `recovery_required`, never in a false success state.

## Storage model

The SQLite storage primitive maintains:

- one immutable execution subject per request and idempotency key;
- append-only transition events;
- exact transition-key idempotency;
- provider-confirmation evidence;
- reconciliation results;
- a hash chain linking every event to its predecessor;
- an operation head containing current state, version, and final event fingerprint.

WAL, `synchronous = FULL`, foreign keys, strict tables, uniqueness constraints, and immediate write transactions provide single-host durability and concurrency control.

## Verified evidence façade

`VerifiedExecutionLedger` is the supported write boundary. It adds semantic checks before delegating to `SqliteExecutionLedger`:

- attempted adapter must equal the adapter resolved at dispatch;
- attempted envelope fingerprint must equal the dispatched envelope;
- evidence timestamps cannot predate the previous durable state or postdate observation;
- reconciliation expected state must equal the provider-confirmed after-state;
- reconciliation completion must use the observation method selected when reconciliation began.

The raw SQLite class is the append-only storage primitive and should not be exposed directly to untrusted callers.

## Idempotency and concurrency

Every transition carries a stable transition key. Replaying the same key with identical evidence returns the existing operation. Reusing it with changed evidence fails closed.

Competing processes serialize through the SQLite write lock. Concurrent duplicate attempt reports converge on one event and one state-version increment.

## Provider evidence

Provider request identifiers must be opaque `providerref_...` references. Raw provider URLs, credentials, or secret-bearing response material are not accepted as confirmation identity.

Confirmation stores only:

- opaque provider request reference;
- confirmation method;
- before-state fingerprint;
- after-state fingerprint;
- confirmation timestamp.

Reconciliation compares fingerprints derived from a later provider observation. The ledger does not manufacture provider confirmation; it records evidence supplied by a provider adapter after that evidence passes its own contract.

## Dispatch coordinator

`DurableDispatchCoordinator` persists a validated `dispatched` receipt immediately after Colossus accepts the envelope.

A failure after Colossus acceptance but before durable receipt persistence is reported distinctly as `DISPATCH_RECEIPT_PERSISTENCE_FAILED`, together with a receipt fingerprint. It is not silently retried and is not misreported as a provider failure.

## Boundary

This is a single-host durable ledger, not distributed consensus. It does not implement a provider adapter, prove that a provider actually mutated state, or make a live reconciliation observation. Those claims require direct provider evidence and remain separate integration work.
