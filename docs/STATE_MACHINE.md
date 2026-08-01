# State Machine

## Happy path

```text
received
  → normalized
  → capability_checked
  → planned
  → awaiting_approval
  → approved
  → dispatched
  → attempted
  → provider_confirmed
  → reconciling
  → reconciled
```

## Terminal / exceptional states

| State | Meaning |
|-------|---------|
| `blocked` | Policy or capability prevents progress |
| `failed` | Attempt failed; may be retryable under rules |
| `skipped` | Intentionally not executed |
| `expired` | Plan or approval timed out |
| `recovery_required` | Human or specialized recovery needed |
| `cancelled` | Explicit cancel |

## Transition record (required fields)

Every legal transition must record:

- `from_state`
- `to_state`
- `actor`
- `timestamp`
- `input_fingerprint`
- `policy_version`
- `reason_code`

## Fail-closed rule

Any transition not explicitly allowed by the graph **must be rejected**.  
No silent coercion into a neighbor state.

## Approval binding

`awaiting_approval → approved` is legal only when Gatekeeper returns approval for the **exact** `plan_fingerprint` currently on the job. A mismatch is `blocked` or `expired`, never `approved`.
