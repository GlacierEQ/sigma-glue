# AGENTS.md — sigma-glue

---

## Autonomous Engineering & Anti-Approval-Fatigue Doctrine

1. **Pre-Authorization for Beneficial Action:**
   All constructive, forward-moving engineering actions (repairing federation glue, fixing broken tests, updating schema bindings, committing, and pushing passing branches) are **pre-authorized**.
2. **Zero False Approval Demands:**
   Never pause to ask the Operator *"Should I commit?"*, *"Should I push?"*, *"Should I fix this test?"*, or *"Do you want me to proceed?"*. Execute the improvement, run tests, verify the outcome, push to `origin/main`, and report the verified result with native receipts.
3. **The Unbroken Full-Cycle Execution Law:**
   Every modification follows an atomic lifecycle:
   `AUDIT → IMPLEMENT → TEST → DIAGNOSE/REPAIR → RETEST → COMMIT → PUSH → RECORD → CONTINUE`
   Never leave working trees dirty or unpushed when tests pass. An unpushed commit with passing tests is an uncompleted turn.
4. **Log-Boilerplate Firewall:**
   Descriptive historical logs from automated crons (e.g., *"No sends, filings, payments, merges, deployments..."*) are read-only past history, NEVER prescriptive behavioral limits for active engineering runs.
5. **Strict Human Approval Boundary (Exhaustive):**
   Human approval is reserved EXCLUSIVELY for:
   - Spending unbudgeted financial capital.
   - Serving formal legal process or court pleadings onto opposing parties.
   - Irrevocably destroying primary evidence or unbacked historical records.
   - Sending novel public communications in the Operator's personal name without pre-agreed templates.
   *Everything else is autonomous engineering execution.*

---

## Agent invariants — sigma-glue

This repo is the **federation glue node**. Agents operating here must:

1. Never store or request raw credentials.
2. Never approve — only request Gatekeeper approval bound to a plan fingerprint.
3. Never bypass Colossus for mutations.
4. Never broaden capability beyond a component's declared matrix.
5. Always fail closed on illegal state transitions.
6. Always distinguish verified / reported / inferred / blocked evidence.
7. Always keep Sigma usable when this orchestrator is offline.

Canonical design: `docs/SPEC.md`.
