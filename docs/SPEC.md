# Sigma Orchestrator Specification

**Status:** Draft v1 — governing design for the federation glue layer.

## Purpose

Sigma Orchestrator is the coordination layer between the Sigma product UI and the preserved independent repositories. It owns integration state and workflow sequencing; it does not become a second product, gateway, classifier, credential store, or execution engine.

```text
Sigma UI
  ↓ user intent
Sigma Orchestrator
  ↓ normalized workflow + capability checks
Gatekeeper
  ↓ exact scoped approval
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

## What the Orchestrator owns

- workflow/job lifecycle and durable state transitions
- component discovery and compatibility checks
- capability negotiation, without broadening capability
- request normalization and correlation IDs
- manifest and plan assembly
- idempotency ledger and retry coordination
- dispatch ordering and dependency handling
- receipt collection and reconciliation scheduling
- platform capability matrix presented to Sigma
- sanitized operation history and diagnostics
- recovery workflow coordination

## What it must never own

- raw provider credentials or unrestricted tokens
- approval authority
- provider-side mutation authority
- file classification policy or model decisions (FILEBOSS owns proposals)
- filesystem execution mechanics (Commander owns narrow execution)
- a competing provider gateway (Colossus remains the single routing foundation)
- an independent user interface or autonomous user-initiated mutations

## State machine

```text
received → normalized → capability_checked → planned → awaiting_approval
  → approved → dispatched → attempted → provider_confirmed
  → reconciling → reconciled
```

Terminal or exceptional states are `blocked`, `failed`, `skipped`, `expired`, `recovery_required`, and `cancelled`. Every transition records actor, timestamp, input fingerprint, policy version, and reason code. Illegal transitions fail closed.

## Dispatch rules

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

## Platform role

The Orchestrator reports capability honestly per platform. A shared interface is not proof of shared power. macOS, iOS, and Android adapters must independently report storage permissions, persistence limitations, provider support, and evidence references.

## Removal and upgrade

Sigma must remain usable for local browse/search/preview if the Orchestrator is disabled. Jobs must be resumable or explicitly marked stranded; no component removal may corrupt Sigma state. Component refs, adapter versions, protocol versions, and migration receipts remain recoverable.

## Definition of done

The Orchestrator is not operationally verified until tests show: exact approval binding; no scope broadening; unsupported-method rejection; stale-plan rejection; one-mutation idempotency; separate provider confirmation and reconciliation; redacted diagnostics; honest three-platform capability reporting; and safe disablement.
