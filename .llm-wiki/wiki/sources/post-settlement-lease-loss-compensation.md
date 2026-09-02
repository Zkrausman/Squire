---
type: source
title: Post-settlement lease-loss compensation
status: insight
category: architecture
created: 2026-09-01
updated: 2026-09-02
slug: post-settlement-lease-loss-compensation
---

# Post-settlement lease-loss compensation

A fenced async step has two race boundaries: ownership can expire before settlement or after the side effect settles but before post-step renewal returns. Process factories must expose creation synchronously so cleanup owns the process independently of promise scheduling. Exposure alone is insufficient: if bounded termination does not produce observed exit, the runner retains the handle and persists exact-owner/token identity in `termination_failed` state for explicit retry/restart reaping. After observed exit, idempotent compensation may only move state toward failed/cleared: resumed generations become retryable, while an uncertain first-session allocation stays failed for reconciliation. This refines [[Fenced first-session allocation]], [[Trusted Controller Boundary]], and the [[AIDEV-216 and AIDEV-224 Ownership Boundary]], based on [[sources/SRC-2026-09-01-010]] and [[sources/SRC-2026-09-02-001]].

*Category: architecture*

---
*Captured: 2026-09-01*

## Related

- [Fenced first-session allocation](/sources/fenced-first-session-allocation.md)
- [Trusted controller boundary](/concepts/trusted-controller-boundary.md)
- [Five-session Pi RPC topology](/concepts/five-session-pi-rpc-topology.md)
- [Review finding R4-001](/sources/SRC-2026-09-01-010.md)
- [Review finding R5-001](/sources/SRC-2026-09-02-001.md)
