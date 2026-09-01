---
type: source
title: Stable-history trigger resend proof
status: insight
category: architecture
created: 2026-09-01
updated: 2026-09-01
slug: stable-history-trigger-resend-proof
---

# Stable-history trigger resend proof

Original-trigger recovery must fail closed unless two complete `get_entries` history snapshots have identical leaves and entries and both prove the deterministic marker absent. A marker in either scan means continue waiting; any history change means rescan rather than resend. Dispatch lease renewal and fencing must remain valid throughout history reads and the eventual prompt. This refines [[Immutable Handoff Validation]] and [[Trusted Controller Boundary]] while preserving the [[AIDEV-216 and AIDEV-224 Ownership Boundary]]. The invariant implements the recovery and immutable-handoff requirements in [Squire MVP Architecture](/sources/SRC-2026-09-01-001.md) and [AIDEV-215 Workflow and Handoff Contracts](/sources/SRC-2026-09-01-004.md).

*Category: architecture*

---
*Captured: 2026-09-01*

## Related

- [Immutable Handoff Validation](/concepts/immutable-handoff-validation.md)
- [Trusted Controller Boundary](/concepts/trusted-controller-boundary.md)
- [AIDEV-216 and AIDEV-224 Ownership Boundary](/syntheses/aidev-216-and-aidev-224-ownership-boundary.md)
