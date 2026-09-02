---
type: source
title: Registered-session process recovery
status: insight
category: architecture
created: 2026-09-02
updated: 2026-09-02
slug: registered-session-process-recovery
---

# Registered-session process recovery

Process ownership survives provisional-allocation clearance. A current registered `live` or `launching` generation with an exact process identity is itself durable actionable ownership. Explicit restart cleanup must inspect both this form and `termination_failed` allocations, resolve the identity through the supervisor seam, and repeat bounded termination while unknown/mismatched status stays blocked. Only observed exit permits exact generation/identity failure or exit; a stale cleanup must not clobber a newer generation. Same-role relaunch resumes the exact JSONL only after this proof. This extends [durable non-cooperative ownership](/sources/durable-noncooperative-process-ownership.md), [five-session topology](/concepts/five-session-pi-rpc-topology.md), and the [trusted controller boundary](/concepts/trusted-controller-boundary.md), based on [Review R6-001](/sources/SRC-2026-09-02-002.md).

*Category: architecture*

---
*Captured: 2026-09-02*

## Related

- [Durable non-cooperative process ownership](/sources/durable-noncooperative-process-ownership.md)
- [Five-session Pi RPC topology](/concepts/five-session-pi-rpc-topology.md)
- [Trusted controller boundary](/concepts/trusted-controller-boundary.md)
- [Review finding R6-001](/sources/SRC-2026-09-02-002.md)
