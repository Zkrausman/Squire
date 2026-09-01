---
type: source
title: Fenced first-session allocation
status: insight
category: architecture
created: 2026-09-01
updated: 2026-09-01
slug: fenced-first-session-allocation
---

# Fenced first-session allocation

A renewable lease is insufficient if an external spawn can outlive it. First-session creation must persist a fenced `reserved → spawning → spawned` allocation, renew and verify ownership around every bounded step, and atomically bind registration to the spawned process identity. A stale `reserved` owner can be replaced because it has not declared spawn intent; stale `spawning` or `spawned` state must fail closed until reconciliation because creating another process could duplicate the session. This refines [[Five-session Pi RPC Topology]], [[Trusted Controller Boundary]], and the [[AIDEV-216 and AIDEV-224 Ownership Boundary]], with the motivating evidence in [[sources/SRC-2026-09-01-009]].

*Category: architecture*

---
*Captured: 2026-09-01*

## Related

- [Five-session Pi RPC topology](/concepts/five-session-pi-rpc-topology.md)
- [Trusted controller boundary](/concepts/trusted-controller-boundary.md)
- [AIDEV-216 and AIDEV-224 ownership boundary](/syntheses/aidev-216-and-aidev-224-ownership-boundary.md)
- [Review finding R3-001](/sources/SRC-2026-09-01-009.md)
