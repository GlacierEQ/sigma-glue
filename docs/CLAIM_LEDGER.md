# Durable claim ledger

## Purpose

The claim ledger is the authority handoff between Gatekeeper approval and a future Colossus dispatch adapter. It persists approvals, idempotency claims, and dispatch permits in one file-backed SQLite database.

The atomic write path is:

```text
load recorded approval
→ compare exact execution subject
→ claim idempotency key
→ consume approval
→ persist dispatch permit
→ commit
```

Every step runs inside `BEGIN IMMEDIATE`. A failure at any point rolls the complete transaction back.

## Exact execution subject

A claim is bound to all of:

- approval ID
- job ID
- plan fingerprint
- component ref
- method
- idempotency key
- policy version

The same idempotency key with the same subject returns the original permit. The same key with different content fails with `IDEMPOTENCY_KEY_REUSE_MISMATCH`.

## Concurrency

SQLite admits one writer at a time. Competing processes wait for the write lock, then re-read ledger state. The first valid claimant consumes the approval and creates the permit. Identical later claimants receive that same persisted permit as an idempotent replay.

## Durability controls

- file-backed SQLite
- WAL journal mode
- `synchronous = FULL`
- foreign-key enforcement
- strict tables
- uniqueness on approval, idempotency key, claim, and permit identities
- transactional rollback after partial failure

## Boundary

This is a **single-host durable ledger**, not a distributed consensus service. A shared SQLite file must not be mounted across uncoordinated hosts or network filesystems and described as globally exactly-once.

`node:sqlite` remains under active development in Node 22. The repository pins the minimum runtime needed by this implementation and tests its behavior in CI.

The permit is an exact, expiring authorization envelope. It is not a provider credential and does not itself perform dispatch. Colossus integration must independently validate its fingerprint, status, expiry, and execution subject.
