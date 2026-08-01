# Sigma Glue — Sigma Orchestrator

**Federation glue between Sigma UI and independent component repositories.**

Status: **Draft v1** — governing design for the coordination layer.

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
| Recovery | Coordination of recovery workflows |

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
8. Reuse the same idempotency key on retries.
9. Reconcile against the provider or platform after every authorized attempt.
10. Expose verified, reported, inferred, and blocked evidence distinctly in Sigma.

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

### Definition of done

Not operationally verified until tests prove:

- [ ] Exact approval binding (fingerprint)
- [ ] No scope broadening
- [ ] Unsupported-method rejection
- [ ] Stale-plan rejection
- [ ] One-mutation idempotency
- [ ] Separate provider confirmation and reconciliation
- [ ] Redacted diagnostics
- [ ] Honest three-platform capability reporting
- [ ] Safe disablement

---

## Layer 3 — AI / agent mounting plane

This repository is the **glue node** in the GlacierEQ federation mesh.

| Node | Role |
|------|------|
| **sigma-glue** (this repo) | Workflow orchestration, state, reconciliation |
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
5. **Always** fail closed on illegal state transitions.
6. **Always** distinguish verified / reported / inferred / blocked evidence.
7. **Always** keep Sigma usable when this orchestrator is offline.

### Suggested module map (implementation)

```text
sigma-glue/
  docs/
    SPEC.md                 # canonical specification
    STATE_MACHINE.md
    DISPATCH_RULES.md
  src/
    state/                  # durable job lifecycle
    normalize/              # request → canonical envelope
    capability/             # matrix + negotiation (no broadening)
    plan/                   # plan assembly + fingerprint
    idempotency/            # ledger + retry keys
    dispatch/               # Colossus-only mutation path
    reconcile/              # receipt + confirmation
    platform/               # macOS / iOS / Android honesty matrix
    diagnostics/            # redacted history
  tests/
    approval_binding/
    no_scope_broadening/
    unsupported_rejection/
    stale_plan/
    idempotency/
    reconcile_split/
    platform_honesty/
    safe_disable/
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
```

---

## License

Private / GlacierEQ unless otherwise stated.
