---
type: concept
created: 2026-09-01
updated: 2026-09-01
domain: engineering
confidence: high
sources: [sources/SRC-2026-09-01-001, sources/SRC-2026-09-01-004, sources/SRC-2026-09-01-009, sources/SRC-2026-09-01-010, sources/obs-2026-09-01-fenced-dispatch-authority-invariant]
---

# Trusted controller boundary

The [Squire](/entities/squire.md) controller is trusted infrastructure, not the Pi Orchestrator. It observes state and Git independently, validates immutable artifacts and requested transitions, applies compare-and-set mutations, and emits typed side-effect directives. Transition authority comes from the exact persisted, role-local Orchestrator registration—not a caller-supplied expected session ID. It does not infer pass/fail from chat or replace Orchestrator reasoning. [Architecture](/sources/SRC-2026-09-01-001.md) · [Contracts](/sources/SRC-2026-09-01-004.md)

Persistence, process creation, filesystem access, time, and Git observation remain injected seams. Long-running dispatch uses renewable leases with monotonic fencing tokens; every workflow mutation, result acceptance, terminalization, and RPC side effect must retain the current token. Process allocation applies the same rule across runtime resolution through exact-session registration and persists provisional ownership before first spawn; uncertain spawn outcomes fail closed rather than permitting a replacement process. Exact-token compensation is permitted only as a monotonic cleanup after a returned process is observed exited; it cannot authorize new work. [Allocation-race sources](/sources/SRC-2026-09-01-009.md) · [Settlement-race source](/sources/SRC-2026-09-01-010.md) [Fenced dispatch insight](/sources/obs-2026-09-01-fenced-dispatch-authority-invariant.md) This supports deterministic tests and preserves the [AIDEV-216/AIDEV-224 boundary](/syntheses/aidev-216-and-aidev-224-ownership-boundary.md). It also governs [transition and gate invariants](/concepts/transition-remediation-and-fresh-gates.md).
