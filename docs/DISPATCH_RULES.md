# Dispatch Rules (Normative)

1. **Validate versions** — protocol, schema, adapter, and component versions must be compatible.
2. **Resolve capabilities** — use only the component's declared capabilities and supported methods.
3. **Reject unsupported** — unsupported operations fail; never return a successful no-op.
4. **Plan + fingerprint** — build a canonical plan and fingerprint it before approval.
5. **Gatekeeper binding** — request approval bound to that exact fingerprint.
6. **Colossus only** — mutations dispatch through Colossus; never bypass.
7. **Scoped handles** — pass only scoped handles and the approved envelope to the adapter.
8. **Idempotent retries** — reuse the same idempotency key on retries.
9. **Reconcile always** — after every authorized attempt, reconcile against provider/platform.
10. **Evidence classes** — expose verified, reported, inferred, and blocked evidence distinctly in Sigma.

## Anti-patterns (forbidden)

- Storing or forwarding raw credentials
- Approving without Gatekeeper
- Broadening capability beyond the declared matrix
- Silent success on unsupported methods
- Mutating outside Colossus
- Collapsing evidence classes into a single "ok"
