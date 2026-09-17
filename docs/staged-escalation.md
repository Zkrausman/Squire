# Opt-in staged model policies

`escalationPolicy` is optional **user-global** configuration. Without it, Squire
uses the existing `modelPolicy`, deterministic two-bucket Plan assignment, and
fixed-profile control flow; a failed phase is not automatically retried. Omitted
phases retain that behavior. The approved global model defaults have not changed.

This example is illustrative, not a model hierarchy or provider recommendation:

```json
{
  "escalationPolicy": {
    "implement": {
      "stages": [
        { "provider": "YOUR_PROVIDER", "model": "YOUR_INITIAL_MODEL", "thinking": "medium", "maxAttempts": 2 },
        { "provider": "YOUR_PROVIDER", "model": "YOUR_NEXT_MODEL", "thinking": "high", "maxAttempts": 1 }
      ]
    }
  }
}
```

The same illustrative block is in `squire.config.example.json`: **remove it for
fixed-profile behavior**, or replace the placeholders with profiles available to
your controller-owned credential bridge. Names, order, efforts and allowances
are user choices. Stages may use the same model, decrease effort, or name another
provider explicitly; Squire does not rank models or insert provider fallbacks.
Never edit an active run to apply this policy; it applies only to new launches.

## Closed configuration

Only `plan`, `implement`, `review`, `test`, and `retro` keys are accepted. A present
phase is exactly `{ "stages": [...] }`. Each stage has exactly `provider`, `model`,
`thinking`, `maxAttempts`. Provider/model are safe nonempty strings (at most 256
characters); thinking is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`. Each stage allows **1–16 integer attempts**, with **1–8 stages** and **at
most 32 total attempts per configured phase**. Empty policies, empty schedules,
unknown fields and malformed profiles fail before reservation/adapter launch.

## Accounting and triggers

One attempt is consumed when the controller durably reserves a schedule slot and
increments the existing phase counter, immediately before adapter invocation.
Controller configuration, clean-workspace and exact-HEAD preflight happen first;
a failure there consumes no slot. Every post-reservation outcome consumes that
one selected slot, including a crash with an open reservation. There are no
refunds, resumed attempts, failed-run imports or terminal-state reopening.

| Outcome | Automatic same-phase retry? |
| --- | --- |
| Structurally and provenance-valid `failed` result, clean workspace and exact observed HEAD | Yes, while slots remain |
| Supervised Plan `needs_clarification` | No; resolve the questions |
| Review/Test `remediation_required` | No unchanged gate retry; existing remediation sequence only |
| Cancellation | No; interrupted |
| Timeout, authentication, infrastructure/transport/sandbox failure | No; failed |
| Parser, protocol, profile/session/HEAD mismatch or other ambiguous/unknown error | No; failed closed |

Only validated failed results are retry-eligible—not process exit codes, text
that mentions an error, or unvalidated model output. Trusted adapters use closed
error classifications; where no machine classification exists, failure remains
`unknown`, terminal. Authentication is never guessed from stderr. No failure in
these terminal classes automatically launches or consumes a later stage.

Eligible failures start a fresh session, consuming remaining slots in the same
stage before advancing. Feedback comes only from the immediately preceding
applicable result in this run (up to 20 entries of 2,000 characters); prior phase
results remain task data, not acceptance. A failed Implement may leave a clean
committed HEAD: that observed HEAD becomes the next attempt's input, but the
result remains failed and does not grant acceptance. Other phases cannot change
HEAD. Project-wiki reconciliation remains mandatory.

Review and Test still have **one remediation each**, not one per stage or retry.
A remediation result consumes its gate slot. Required Implement and gate slots
are checked before starting the remediation sequence; every actual invocation
uses its next global slot. Automatic failed-result retries never reset either
remediation counter. Staged totals and remediation caps intersect, rather than
multiply. Exhaustion is terminal, naming phase, policy digest, last zero-based
stage, consumed/configured totals and trigger. Correct the issue and explicitly
launch a new run if appropriate; no accepted result is manufactured.

## Immutable evidence and unchanged gates

Launch capture freezes a detached schedule and domain-separated SHA-256 digest.
State persists the schedule, digest and append-only reservation/closure journal:
global attempt, zero-based stage index, within-stage attempt/maximum, selected
profile, consumed/remaining counts, reason, classification and validated result.
Legacy v1 state without these fields remains readable. Detached handoff verifies
the persisted schedule/digest against captured material; config changes cannot
alter either foreground or background execution.

Plan's deterministic baseline selection evidence remains unchanged. For each
configured top-level Plan attempt both fresh independent children receive the
same selected profile. There is no mid-child or mid-attempt profile change.

`squire status` displays current/latest selection, provider/model/thinking,
one-based stage position, consumed/remaining totals, selection reason and digest.
Filesystem-driven `watch` emits bounded `staged_reserved`/`staged_closed` events;
missed events can be reconstructed from the journal without inventing historical
passes. An open reservation reports consumption, not success. No model polls.

Escalation changes capability, never standards: credentials, permissions, parsers,
cleanliness, exact HEAD, independent Review, fresh Test, Retro-after-Test and
publication gates remain controller-owned. This feature supplies no arbitrary
workflow graph, automatic ranking, generic budgets, failover or recovery system.
