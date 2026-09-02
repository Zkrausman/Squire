---
type: concept
created: 2026-09-01
updated: 2026-09-02
domain: engineering
confidence: high
sources: [sources/SRC-2026-09-01-001, sources/SRC-2026-09-01-004, sources/SRC-2026-09-01-009, sources/SRC-2026-09-01-010, sources/SRC-2026-09-02-001, sources/SRC-2026-09-02-002, sources/obs-2026-09-01-fenced-dispatch-authority-invariant]
---

# Trusted controller boundary

The [Squire](/entities/squire.md) controller is trusted infrastructure, not the Pi Orchestrator. It observes state and Git independently, validates immutable artifacts and requested transitions, applies compare-and-set mutations, and emits typed side-effect directives. Transition authority comes from the exact persisted, role-local Orchestrator registration—not a caller-supplied expected session ID. It does not infer pass/fail from chat or replace Orchestrator reasoning. [Architecture](/sources/SRC-2026-09-01-001.md) · [Contracts](/sources/SRC-2026-09-01-004.md)

Persistence, process creation/identity resolution, filesystem access, time, and Git observation remain injected seams. Long-running dispatch uses renewable leases with monotonic fencing tokens; every workflow mutation, result acceptance, terminalization, and RPC side effect must retain the current token. Process allocation applies the same rule through exact-session registration. A process that survives bounded termination remains owned in memory and either as an exact-token `termination_failed` allocation or an exact registered live/launching generation and identity; unknown supervisor status remains blocked. Explicit cleanup may resolve and repeatedly reap either form across runner restart, but only observed exit permits monotonic compensation or exact-generation failure. Identity/generation changes make stale cleanup fail without clobbering newer ownership, and no cleanup path authorizes replacement work. [Allocation-race sources](/sources/SRC-2026-09-01-009.md) · [Settlement-race source](/sources/SRC-2026-09-01-010.md) · [Termination-failure sources](/sources/SRC-2026-09-02-001.md) · [Registered-recovery source](/sources/SRC-2026-09-02-002.md) [Fenced dispatch insight](/sources/obs-2026-09-01-fenced-dispatch-authority-invariant.md) This supports deterministic tests and preserves the [AIDEV-216/AIDEV-224 boundary](/syntheses/aidev-216-and-aidev-224-ownership-boundary.md). It also governs [transition and gate invariants](/concepts/transition-remediation-and-fresh-gates.md).
