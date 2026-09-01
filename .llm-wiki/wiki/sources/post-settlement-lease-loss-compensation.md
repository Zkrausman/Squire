---
type: source
title: Post-settlement lease-loss compensation
status: insight
category: architecture
created: 2026-09-01
updated: 2026-09-01
slug: post-settlement-lease-loss-compensation
---

# Post-settlement lease-loss compensation

A fenced async step has two race boundaries: ownership can expire before settlement or after the side effect settles but before post-step renewal returns. Process factories must expose creation synchronously so cleanup owns the process independently of promise scheduling. After observed exit, an idempotent exact-owner/token compensation may only move state toward failed/cleared: resumed generations become retryable, while an already-created first-session allocation stays failed for reconciliation to prevent a duplicate session. This refines [[Fenced first-session allocation]], [[Trusted Controller Boundary]], and the [[AIDEV-216 and AIDEV-224 Ownership Boundary]], based on [[sources/SRC-2026-09-01-010]].

*Category: architecture*

---
*Captured: 2026-09-01*

## Related

- [Fenced first-session allocation](/sources/fenced-first-session-allocation.md)
- [Trusted controller boundary](/concepts/trusted-controller-boundary.md)
- [Five-session Pi RPC topology](/concepts/five-session-pi-rpc-topology.md)
- [Review finding R4-001](/sources/SRC-2026-09-01-010.md)
