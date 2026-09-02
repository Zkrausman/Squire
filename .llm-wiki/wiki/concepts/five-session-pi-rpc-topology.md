---
type: concept
created: 2026-09-01
updated: 2026-09-02
domain: engineering
confidence: high
sources: [sources/SRC-2026-09-01-001, sources/SRC-2026-09-01-008, sources/SRC-2026-09-01-006, sources/SRC-2026-09-01-007, sources/SRC-2026-09-01-009, sources/SRC-2026-09-01-010, sources/SRC-2026-09-02-001, sources/SRC-2026-09-02-002, sources/fenced-first-session-allocation]
---

# Five-session Pi RPC topology

Orchestrator, Plan, Implement, Review, and Test are five independent top-level Pi RPC processes sharing one ticket workspace but holding distinct JSONL histories and exact role-local session paths. A lifecycle role is never implemented as a session switch or subagent. [Architecture](/sources/SRC-2026-09-01-001.md) · [Viability evidence](/sources/SRC-2026-09-01-008.md)

First startup uses the role's session directory and a bounded, renewable, fenced allocation spanning every pre-registration step; resumed generations use the same ownership record with the exact session and target generation. Before spawn, persisted ownership advances `reserved → spawning → spawned`. A synchronous creation callback immediately establishes an allocating handle. If termination cannot be observed, exact-token `termination_failed` persistence retains a provisional identity and forbids replacement. After registration clears that allocation, the exact `live`/`launching` session generation and identity provide equivalent durable ownership. Explicit retry/restart cleanup inspects both forms and resolves the identity through an injected supervisor seam. Only observed exit authorizes compensation or exact-generation failure, after which relaunch resumes the same JSONL. [Review findings R3-001](/sources/SRC-2026-09-01-009.md), [R4-001](/sources/SRC-2026-09-01-010.md), [R5-001](/sources/SRC-2026-09-02-001.md), and [R6-001](/sources/SRC-2026-09-02-002.md) · [Allocation insight](/sources/fenced-first-session-allocation.md)

After `get_state`, the complete returned session ID and canonical JSONL path are registered. Relaunch uses exactly that path and only after the prior process generation has a persisted observed exit/failure; live ownership is keyed by run and role, so release cannot merely forget a live process. Protocol corruption kills and fails that generation. This preserves role identity through [idempotent handoff processing](/concepts/immutable-handoff-validation.md). All roles use one Pi runtime installation resolved and observed once for the run, not a repository-wide exact version requirement. [Current architecture policy](/sources/SRC-2026-09-01-006.md) · [Current contract policy](/sources/SRC-2026-09-01-007.md) · [Run-scoped runtime insight](/sources/run-scoped-agent-runtime-resolution.md) This topology is controlled by the [trusted controller](/concepts/trusted-controller-boundary.md).
