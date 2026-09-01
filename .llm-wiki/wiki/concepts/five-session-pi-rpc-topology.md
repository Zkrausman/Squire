---
type: concept
created: 2026-09-01
updated: 2026-09-01
domain: engineering
confidence: high
sources: [sources/SRC-2026-09-01-001, sources/SRC-2026-09-01-005, sources/SRC-2026-09-01-006, sources/SRC-2026-09-01-007]
---

# Five-session Pi RPC topology

Orchestrator, Plan, Implement, Review, and Test are five independent top-level Pi RPC processes sharing one ticket workspace but holding distinct JSONL histories and exact role-local session paths. A lifecycle role is never implemented as a session switch or subagent. [Architecture](/sources/SRC-2026-09-01-001.md) · [Viability evidence](/sources/SRC-2026-09-01-005.md)

First startup uses the role's session directory; after `get_state`, the complete returned session ID and canonical JSONL path are registered. Relaunch uses exactly that path, preserving role identity through [idempotent handoff processing](/concepts/immutable-handoff-validation.md). All roles use one Pi runtime installation resolved and observed once for the run, not a repository-wide exact version requirement. [Current architecture policy](/sources/SRC-2026-09-01-006.md) · [Current contract policy](/sources/SRC-2026-09-01-007.md) · [Run-scoped runtime insight](/sources/run-scoped-agent-runtime-resolution.md) This topology is controlled by the [trusted controller](/concepts/trusted-controller-boundary.md).
