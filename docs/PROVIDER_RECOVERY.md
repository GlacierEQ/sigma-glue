# Provider ambiguity recovery

## Problem

A provider mutation can cross the external boundary successfully even when Sigma never receives a trustworthy success response.

Examples include:

- the provider commits and the connection dies before the response arrives;
- the provider returns a 5xx after accepting work internally;
- the response is malformed or incomplete after the provider may already have acted;
- the local process crashes after transport entry but before durable completion.

The unsafe response to any of these conditions is an automatic replay. The provider may already have committed the mutation.

## Recovery contract

Sigma coordinates recovery; it does **not** become the provider mutation gateway.

The recovery record binds:

- provider identity;
- operation;
- idempotency key;
- request ID;
- exact dispatch-envelope fingerprint;
- desired provider-state fingerprint;
- exact provider target;
- pre-mutation baseline existence, content fingerprint, provider version, and version semantics.

### Provider-neutral target identity

The recovery coordinator preserves the **exact provider target identity** as strict canonical JSON rather than assuming every provider is a GitHub path. Target identities are bounded to 4096 UTF-8 bytes, recursively reject credential-shaped field names, reject unsafe control characters, and are fingerprinted as evidence rather than treated as authorization.

This is an evidence-surface generalization only. It does **not** add a mutation route, select an adapter, grant capability, or weaken the Colossus/Gatekeeper boundary. Each provider adapter must still define its own target schema, version semantics, conditional-write semantics, and read-back contract. The legacy GitHub `owner/repo/branch/path` identity keeps its path-containment checks.

Provider version semantics are explicit:

- `monotonic_revision` — a provider guarantees the compared revision identity cannot recur after an intervening mutation;
- `content_addressed` — the version is derived from content and can recur when identical content is restored;
- `unknown` — the version cannot support historical non-application proof.

The state machine is:

```text
provider outcome uncertain
        |
        v
bounded read-only provider observation
        |
        +-- desired fingerprint observed
        |       -> confirmed_applied
        |       -> desired provider state is currently present
        |       -> do not replay
        |       -> reconcile from observed provider state
        |
        +-- exact original baseline observed
        |       AND baseline + observation versions are monotonic revisions
        |       -> confirmed_not_applied
        |       -> retry requires a NEW authorization
        |
        +-- content-addressed baseline restored
        |       -> still_unknown
        |       -> historical non-application is unproven
        |       -> automatic replay forbidden
        |
        +-- target absent after an absent baseline
        |       -> still_unknown
        |       -> create-then-delete cannot be excluded
        |       -> automatic replay forbidden
        |
        +-- divergent / hidden / unreadable / timed out
                -> still_unknown
                -> freeze
                -> automatic replay forbidden
```

`confirmed_applied` is an **effect-state classification**: the exact desired state is observed. It does not claim that Sigma can cryptographically attribute authorship of that state to the original request when the provider does not expose such causal proof.

A provider observer has a bounded deadline. Timeout or observation failure produces `still_unknown`; it never becomes evidence that a mutation did not occur.

## Durable recovery evidence

`SqliteProviderRecoveryLedger` records the recovery classification separately from the original one-shot transport attempt.

It persists only stable identities and fingerprints, including:

- request and idempotency identities;
- provider and operation;
- dispatch-envelope and desired-state fingerprints;
- target fingerprint;
- baseline existence, content/version evidence, and version semantics;
- recovery state, reason, and retry disposition;
- observed content/version, version semantics, and provider request reference when available;
- observation/record times;
- canonical recovery-record fingerprint.

It does **not** persist provider credentials, mutation payloads, or desired content bytes.

An identical recovery record is idempotent. Reusing the same request identity with different recovery evidence fails closed. Recovery evidence and its proof-strength semantics are restart-readable across close/reopen.

The original permit attempt remains `started` when the original transport outcome was ambiguous. Recovery does not rewrite history by manufacturing a dispatch receipt that never existed.

## GitHub Contents reference provider

The first concrete provider contract is implemented downstream under `examples/colossus/`. This location is intentional: Sigma owns recovery coordination, while Colossus/downstream adapters retain provider mutation authority.

The GitHub Contents reference uses:

- an opaque credential broker; tokens never enter Sigma plans or durable evidence;
- recovery subject binding to exactly `github-contents/v1` + `put`;
- repository + branch + file target identity;
- file content SHA-256 fingerprints for desired/baseline state;
- GitHub file `sha` as the conditional-write provider version;
- explicit `content_addressed` version semantics for GitHub blob SHA;
- read-before-write to bind the exact baseline;
- conditional PUT with the exact previous `sha` for updates;
- independent GET read-back for recovery;
- repository and branch resolution before a file `404` is accepted as a current absence observation;
- no hidden mutation retry.

GitHub blob SHA is content-addressed. If an ambiguous PUT applies and another actor later restores the original bytes, the original blob SHA can reappear. Therefore an observed original GitHub baseline **cannot** prove `confirmed_not_applied`; it remains `still_unknown` unless stronger provider history evidence is introduced in a future adapter revision.

Likewise, observing a missing file after an initially missing file proves current absence only. It does not exclude create-then-delete history, so it cannot prove non-application.

### Outcome handling

| Provider result | Sigma-side interpretation |
|---|---|
| Current file already equals desired fingerprint | Idempotent convergence; no second PUT |
| Current provider state differs from approved baseline | Blocked before mutation |
| PUT returns 409/422 and read-back equals desired | Concurrent idempotent convergence |
| PUT returns 409/422 and read-back does not equal desired | Conditional-write conflict |
| PUT returns ordinary non-2xx client rejection | Failed provider request |
| PUT transport fails, returns 5xx, or returns malformed/incomplete 2xx evidence | Outcome uncertain; recover by read-back |
| Recovery read-back equals desired fingerprint | `confirmed_applied`; no replay |
| Recovery read-back equals original GitHub baseline | `still_unknown`; restored-baseline history cannot be excluded |
| File GET returns 404 while repo + branch both resolve | Current absence observation only; historical non-application remains unproven |
| File/repo/branch scope cannot be resolved | `still_unknown`; no retry authorization |
| Recovery subject names another provider or operation | Reject before provider I/O |

## Live provider canary

`.github/workflows/github-provider-live-proof.yml` exercises a dedicated `provider-canary` branch and `.sigma-provider-canary/state.json` target using GitHub Actions' scoped repository token.

The proof performs:

1. ephemeral Ed25519 Gatekeeper approval setup;
2. signed exact approval and durable dispatch permit;
3. one real GitHub Contents conditional mutation through the one-shot Colossus adapter;
4. independent read-back of the desired fingerprint and `content_addressed` version semantics;
5. a second approved real mutation whose successful provider response is deliberately consumed and discarded;
6. verification that the local transport attempt remains durably `started`;
7. provider+operation-bound independent read-back classifying the ambiguous mutation as `confirmed_applied`;
8. durable recovery-record persistence with baseline and observation version semantics;
9. close/reopen verification of the exact recovery fingerprint and proof semantics;
10. replay of the same permit/request, which must fail at the one-shot fence before another provider PUT.

The workflow is serialized with a repository-level concurrency group so canary runs do not race one another.

## Truth boundary

This layer proves more than a local transport fence but less than provider-transactional exactly-once execution.

Verified mechanism:

```text
exact approval
-> one-shot transport reservation
-> conditional provider mutation
-> ambiguous outcome detection
-> bounded independent read-back
-> proof-strength-aware classification
-> restart-readable recovery evidence
-> no unsafe automatic replay
```

It does **not** claim:

- distributed consensus;
- multi-host locking;
- provider-transactional exactly-once semantics;
- universal provider consistency guarantees;
- causal attribution when only desired-state convergence is observable;
- that current absence proves historical non-application;
- that a content-addressed baseline proves historical non-application;
- that every provider can produce `confirmed_not_applied`;
- that a `confirmed_not_applied` result permits reuse of the old authorization.

Every additional provider adapter must define its own conditional-write, idempotency, lookup, consistency, version semantics, and recovery semantics and must fail closed where those semantics cannot support a truthful classification.
