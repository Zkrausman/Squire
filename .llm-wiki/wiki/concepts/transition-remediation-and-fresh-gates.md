---
type: concept
created: 2026-09-01
updated: 2026-09-01
domain: engineering
confidence: high
sources: [sources/SRC-2026-09-01-001, sources/SRC-2026-09-01-004]
---

# Transition remediation and fresh gates

A phase result's requested destination is validated advice. A separate request from the registered Orchestrator session must bind the exact controller-accepted result before the [trusted controller](/concepts/trusted-controller-boundary.md) executes a legal graph edge. System failure, operator cancellation, and expiry are separately audited terminal origins. [Contracts](/sources/SRC-2026-09-01-004.md)

Review or Test remediation creates a new immutable handoff for the existing Implement session. Implement must change the independently observed head; this invalidates old gates and forces Review then Test at the same new head. Test remediation never skips Review, and publishing requires both current-generation passes. [Architecture](/sources/SRC-2026-09-01-001.md)

Finite role deadlines, launch limits, abort escalation, remediation budgets, and terminal compare-and-set ensure late [handoff outputs](/concepts/immutable-handoff-validation.md) cannot reopen a run.
