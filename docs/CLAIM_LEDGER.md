# Durable claim and dispatch fence ledger

## Purpose

The SQLite claim ledger is the authority handoff between Gatekeeper approval and Colossus dispatch. It persists signed approval authenticity, idempotency claims, and exact dispatch permits in one file-backed database.

`FencedSqliteClaimLedger` adds the transport-entry boundary: before Colossus is called, the same database records which exact immutable envelope is consuming the permit's single transport attempt.

## Approval → permit atomic path

```text
load recorded signed approval
→ verify Gatekeeper authenticity and current key status
→ compare exact execution subject
→ claim idempotency key
→ consume approval
→ persist dispatch permit
→ commit
```

Every step runs inside `BEGIN IMMEDIATE`. A failure at any point rolls the complete transaction back.

### Exact execution subject

A claim is bound to all of:

- approval ID
- job ID
- plan fingerprint
- component ref
- method
- idempotency key
- policy version

The same idempotency key with the same subject returns the original permit. The same key with different content fails with `IDEMPOTENCY_KEY_REUSE_MISMATCH`.

## Permit → transport atomic fence

Before transport entry, the fenced ledger commits:

- attempt ID
- permit ID
- idempotency key
- permit fingerprint
- request ID
- exact envelope fingerprint
- local `startedAt`

`permit_id` is unique in the attempt table. Competing writers use `BEGIN IMMEDIATE`, re-read after acquiring the write lock, and converge on one durable reservation.

The lifecycle is:

```text
issued permit
→ started      exact envelope reserved; provider outcome may be unknown
→ accepted     validated receipt status = dispatched
   or
→ rejected     validated receipt status = blocked | failed
```

A `started` attempt is never automatically released or retried. A crash, timeout, invalid receipt, or lost response after transport entry may have coincided with a real provider-side effect, so recovery must reconcile rather than replay.

Completion stores both:

- a **local completion observation time** used for durable ordering; and
- the provider's `receivedAt` as separate **reported evidence**.

The provider timestamp is never promoted into the local transition clock.

## Concurrency

SQLite admits one writer at a time. The repository verifies two separate concurrency properties:

1. duplicate approval claimers converge on one permit; and
2. independent processes competing to reserve one permit converge on one `started` transport attempt.

This is a single-host serialization mechanism. Lock unavailability fails closed; it does not silently bypass the fence.

## Durability controls

- file-backed SQLite
- WAL journal mode
- `synchronous = FULL`
- foreign-key enforcement
- strict tables
- uniqueness on approval, idempotency claim, permit, and per-permit transport attempt identities
- transactional rollback with explicit rollback-failure reporting
- restart-readable attempt state without raw payload persistence

## Runtime boundary

The repository requires Node.js `>=22.16.0` for the `node:sqlite` transaction-state API used by the ledger, and CI runs the implementation on Node 22.

`node:sqlite` is still an evolving runtime surface. A runtime that does not expose the required transaction-state API fails construction instead of weakening rollback guarantees.

## Truth boundary

This is a **single-host durable ledger**, not distributed consensus. A shared SQLite file must not be mounted across uncoordinated hosts or network filesystems and described as globally exactly-once.

The fence establishes **at-most-once transport entry for one persisted permit**. It does not establish provider-transactional exactly-once execution. Provider-side idempotency, confirmation, and reconciliation remain separate evidence layers.
