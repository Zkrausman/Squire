---
type: source
title: Durable non-cooperative process ownership
status: insight
category: architecture
created: 2026-09-02
updated: 2026-09-02
slug: durable-noncooperative-process-ownership
---

# Durable non-cooperative process ownership

A kill request or timeout is not an exit observation. Every process must enter an allocating handle registry synchronously at creation. If bounded SIGTERM/SIGKILL cannot observe exit, exact owner/token/generation persistence moves a provisional allocation to `termination_failed` with the process identity and keeps replacement work blocked. If registration already cleared that allocation, the current registered `live`/`launching` generation plus exact process identity is equivalent durable ownership. Explicit retry or restart cleanup inspects both, resolves the identity through an injected supervisor seam, and may repeat termination; unknown or mismatched status remains unresolved. Only observed exit permits idempotent compensation or exact-generation failure, which unwedges exact-session relaunch while preserving fail-closed handling for an uncertain unregistered first session. This extends [fenced allocation](/sources/fenced-first-session-allocation.md), [post-settlement compensation](/sources/post-settlement-lease-loss-compensation.md), and the [AIDEV-216/AIDEV-224 boundary](/syntheses/aidev-216-and-aidev-224-ownership-boundary.md), based on [Review R5-001](/sources/SRC-2026-09-02-001.md) and [Review R6-001](/sources/SRC-2026-09-02-002.md).

*Category: architecture*

---
*Captured: 2026-09-02*

## Related

- [Fenced first-session allocation](/sources/fenced-first-session-allocation.md)
- [Post-settlement lease-loss compensation](/sources/post-settlement-lease-loss-compensation.md)
- [Trusted controller boundary](/concepts/trusted-controller-boundary.md)
- [Review finding R5-001](/sources/SRC-2026-09-02-001.md)
- [Review finding R6-001](/sources/SRC-2026-09-02-002.md)
- [Registered-session process recovery](/sources/registered-session-process-recovery.md)
