# Agent invariants — sigma-glue

This repo is the **federation glue node**. Agents operating here must:

1. Never store or request raw credentials.
2. Never approve — only request Gatekeeper approval bound to a plan fingerprint.
3. Never bypass Colossus for mutations.
4. Never broaden capability beyond a component's declared matrix.
5. Always fail closed on illegal state transitions.
6. Always distinguish verified / reported / inferred / blocked evidence.
7. Always keep Sigma usable when this orchestrator is offline.

Canonical design: `docs/SPEC.md`.
