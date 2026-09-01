---
type: concept
created: 2026-09-01
updated: 2026-09-01
domain: engineering
confidence: high
sources: [sources/SRC-2026-09-01-001, sources/SRC-2026-09-01-004]
---

# Transition remediation and fresh gates

A phase result's requested destination is validated advice. A separate structurally validated request from the registered Orchestrator session must bind the exact persisted controller-accepted result for that attempt, head, status, and generation before the [trusted controller](/concepts/trusted-controller-boundary.md) executes a legal graph edge. Untrusted caller-supplied phase status is never transition authority. System failure, operator cancellation, and expiry are separately audited terminal origins. [Contracts](/sources/SRC-2026-09-01-004.md)

Review or Test remediation creates a new immutable handoff for the existing Implement session. Implement must change the independently observed head; this invalidates old gates and forces Review then Test at the same new head. A gate can only be projected from its persisted accepted pass and records the matching attempt, completion time, head, and generation. Test remediation never skips Review, and publishing re-verifies both accepted current-generation passes against the independently observed head. [Architecture](/sources/SRC-2026-09-01-001.md)

Finite role deadlines, launch limits, abort escalation, remediation budgets, and terminal compare-and-set ensure late [handoff outputs](/concepts/immutable-handoff-validation.md) cannot reopen a run.
