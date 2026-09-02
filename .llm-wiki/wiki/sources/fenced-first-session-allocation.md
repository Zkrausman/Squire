---
type: source
title: Fenced first-session allocation
status: insight
category: architecture
created: 2026-09-01
updated: 2026-09-02
slug: fenced-first-session-allocation
---

# Fenced first-session allocation

A renewable lease is insufficient if an external spawn can outlive it. First-session creation must persist a fenced `reserved → spawning → spawned` allocation, renew and verify ownership around every bounded step, and atomically bind registration to the spawned process identity. Resumed generations use the same allocation state with their exact session and target generation.

A stale `reserved` owner can be replaced because it has not declared spawn intent. Process creation is exposed and tracked synchronously before promise settlement. If termination cannot be observed, the process remains in an allocating/live handle registry and exact-token persistence records `termination_failed` with its identity; replacement stays forbidden. Explicit retry/restart cleanup resolves the identity through a supervisor seam and retries reaping. Only observed exit permits idempotent compensation, making resumed generations failed/retryable while an uncertain first session remains `failed` until AIDEV-224 reconciliation. This refines [[Five-session Pi RPC Topology]], [[Trusted Controller Boundary]], and the [[AIDEV-216 and AIDEV-224 Ownership Boundary]], with evidence in [[sources/SRC-2026-09-01-009]], [[sources/SRC-2026-09-01-010]], and [[sources/SRC-2026-09-02-001]].

*Category: architecture*

---
*Captured: 2026-09-01*

## Related

- [Five-session Pi RPC topology](/concepts/five-session-pi-rpc-topology.md)
- [Trusted controller boundary](/concepts/trusted-controller-boundary.md)
- [AIDEV-216 and AIDEV-224 ownership boundary](/syntheses/aidev-216-and-aidev-224-ownership-boundary.md)
- [Review finding R3-001](/sources/SRC-2026-09-01-009.md)
- [Review finding R4-001](/sources/SRC-2026-09-01-010.md)
- [Post-settlement compensation insight](/sources/post-settlement-lease-loss-compensation.md)
- [Review finding R5-001](/sources/SRC-2026-09-02-001.md)
- [Durable non-cooperative process ownership](/sources/durable-noncooperative-process-ownership.md)
