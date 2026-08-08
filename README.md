# Sigma Glue — Sigma Orchestrator

**Federation glue between Sigma UI and independent component repositories.**

Status: **Implemented control-plane slice** — signed approval, durable one-shot mutation authority, provider/reconciliation evidence, and live GitHub provider ambiguity recovery are runnable and verified. Remaining production and platform gates are explicit below.

---

## Layer 1 — What this is (recruiter / non-technical)

Sigma Glue is the traffic controller for a multi-product federation.

Users work in **Sigma UI**. When they ask for something that needs another system (storage, classification, a provider, a local platform), Sigma Glue:

1. Turns the request into a structured job
2. Checks what is actually allowed
3. Gets exact approval
4. Routes the work through the single gateway
5. Collects the result and shows truthful status back in Sigma

It is **not** another product UI.  
It is **not** a place that holds passwords.  
It is **not** allowed to expand permissions or skip approval.

If Sigma Glue is turned off, Sigma still works for local browse / search / preview. Jobs that were mid-flight are either resumable or clearly marked stranded — never silently corrupted.

---

## Layer 2 — Architecture (masters of the trade)

```text
Sigma UI
  ↓ user intent
Sigma Orchestrator   ← this repository
  ↓ normalized workflow + capability checks
Gatekeeper
  ↓ exact scoped approval (fingerprint-bound)
Colossus Gateway
  ↓ unified routing
component adapter
  ↓ optional execution delegation
Commander / provider / local platform
  ↓ result
Sigma Orchestrator
  ↓ reconciliation + user-visible state
Sigma UI
```

### Owns

| Concern | Detail |
|---------|--------|
| Workflow lifecycle | Durable state machine + transitions |
| Discovery | Component and compatibility checks |
| Capability negotiation | Without broadening capability |
| Normalization | Request shape + correlation IDs |
| Planning | Manifest / plan assembly + fingerprint |
| Idempotency | Ledger + retry coordination |
| Dispatch | Ordering, dependencies, Colossus-only mutations |
| Reconciliation | Receipt collection + scheduling |
| Platform matrix | Honest per-platform capability report to Sigma |
| Diagnostics | Sanitized history only |
| Recovery | Coordination of provider and workflow recovery |

### Must never own

- Raw provider credentials or unrestricted tokens
- Approval authority (Gatekeeper owns this)
- Provider-side mutation authority
- File classification policy or model decisions (FILEBOSS owns proposals)
- Filesystem execution mechanics (Commander owns narrow execution)
- A competing provider gateway (Colossus remains the single routing foundation)
- An independent UI or autonomous user-initiated mutations

### State machine

```text
received → normalized → capability_checked → planned → awaiting_approval
  → approved → dispatched → attempted → provider_confirmed
  → reconciling → reconciled
```

**Terminal / exceptional:** `blocked` · `failed` · `skipped` · `expired` · `recovery_required` · `cancelled`

Every transition records: **actor**, **timestamp**, **input fingerprint**, **policy version**, **reason code**.  
Illegal transitions **fail closed**.

### Dispatch rules (normative)

1. Validate protocol, schema, adapter, and component versions.
2. Resolve the component's declared capabilities and supported methods.
3. Reject unsupported operations; never return a successful no-op.
4. Build a canonical plan and fingerprint it.
5. Ask Gatekeeper for approval bound to that exact fingerprint.
6. Dispatch through Colossus; never bypass it for mutations.
7. Pass only scoped handles and the approved envelope to the adapter.
8. Reuse the same idempotency subject for the same approved attempt; never silently replay an ambiguous provider mutation.
9. Reconcile against the provider or platform after every authorized attempt.
10. Expose verified, reported, inferred, and blocked evidence distinctly in Sigma.

### Provider ambiguity rule

A transport attempt can be locally uncertain after the provider may already have acted. Sigma therefore separates **transport history** from **provider-state recovery**:

```text
ambiguous provider attempt
  -> bounded read-only observation
  -> desired state observed: confirmed_applied, no replay
  -> exact monotonic baseline revision unchanged: confirmed_not_applied, new approval required
  -> content-addressed baseline / absence / divergence / inaccessible state: still_unknown, freeze
```

GitHub blob SHA is explicitly treated as **content-addressed**, not monotonic. Restoring the old bytes can restore the old SHA, so a restored GitHub baseline never proves that the ambiguous mutation did not occur.

See `docs/PROVIDER_RECOVERY.md` for the full contract and live-provider proof boundary.

### Platform honesty

A shared interface is not proof of shared power. macOS, iOS, and Android adapters must independently report:

- storage permissions
- persistence limitations
- provider support
- evidence references

### Removal and upgrade

- Sigma remains usable for local browse/search/preview if the Orchestrator is disabled.
- Jobs are resumable or explicitly marked stranded.
- Component removal must not corrupt Sigma state.
- Component refs, adapter versions, protocol versions, and migration receipts remain recoverable.

### Definition of done — current proof state

- [x] Exact approval binding (fingerprint)
- [x] No scope broadening on verified mutation paths
- [x] Unsupported-method rejection
- [x] Stale-plan / changed-plan rejection
- [x] Durable one-shot mutation authority for one persisted permit
- [x] Separate provider confirmation and reconciliation
- [x] Provider-boundary ambiguity freezes instead of silent replay
- [x] Restart-readable provider recovery evidence
- [x] Real GitHub conditional mutation + lost-response recovery canary
- [x] Redacted diagnostics / no raw provider credentials in durable recovery evidence
- [ ] Fully evidenced three-platform capability matrix
- [ ] Production deployment hardening, operational key management, backup/restore, and multi-host coordination
- [ ] Safe-disablement proof across the complete deployed federation

---

## Layer 3 — AI / agent mounting plane

This repository is the **glue node** in the GlacierEQ federation mesh.

| Node | Role |
|------|------|
| **sigma-glue** (this repo) | Workflow orchestration, state, reconciliation, recovery coordination |
| **Gatekeeper** | Approval authority (fingerprint-bound) |
| **Colossus Gateway** | Single routing foundation for mutations |
| **Commander** | Narrow filesystem / platform execution |
| **FILEBOSS** | Classification proposals (not execution) |
| **ECHO** | Continuity piston (history, receipts, orchestration flow) |
| **AKOS** | Governance pillar (identity, truth, authority, contracts) |
| **the-tower-of-babel** | Technology authority + capability exhibits |

### Invariants agents must respect

1. **Never** store or request raw credentials in this layer.
2. **Never** approve; only request approval with a bound plan fingerprint.
3. **Never** bypass Colossus for mutations.
4. **Never** broaden capability beyond the component's declared matrix.
5. **Never** convert provider ambiguity into an automatic replay.
6. **Always** fail closed on illegal state transitions.
7. **Always** distinguish verified / reported / inferred / blocked evidence.
8. **Always** keep Sigma usable when this orchestrator is offline.

### Current module map

```text
sigma-glue/
  docs/
    SPEC.md
    IMPLEMENTATION_STATUS.md
    PROVIDER_RECOVERY.md
  src/
    approval/                # Gatekeeper signature/trust binding
    dispatch/                # Colossus-only request/receipt boundary
    execution/               # durable execution/reconciliation state
    ledger/                  # approval, permit, claim, attempt ledgers
    orchestrator/            # workflow coordination
    persistence/             # durable job state
    plan/                    # canonical plan fingerprints
    protocol/                # protocol/version contracts
    recovery/                # provider ambiguity classification + durable evidence
    registry/                # component/capability authority
    runtime/                 # verified gateway composition
    state/                   # workflow state machine
    transport/               # opaque broker transport
  examples/
    colossus/                # downstream provider reference adapters
  scripts/
    github-provider-live-proof.mjs
  tests/
    *.test.mjs               # unit, integration, concurrency, restart, failure attacks
```

### Protocol sketch

```text
JobEnvelope {
  correlation_id
  idempotency_key
  actor_ref          # never a raw credential
  plan_fingerprint
  policy_version
  component_ref
  method
  scoped_handles[]
  platform_hints
}

TransitionRecord {
  from_state → to_state
  actor
  timestamp
  input_fingerprint
  policy_version
  reason_code
}

ProviderRecoveryRecord {
  provider + operation
  request_id + idempotency_key
  envelope_fingerprint
  desired_fingerprint
  target_fingerprint
  baseline_version + version_semantics
  observed_version + version_semantics
  state + retry_disposition
  record_fingerprint
}
```

---

## License

Private / GlacierEQ unless otherwise stated.
