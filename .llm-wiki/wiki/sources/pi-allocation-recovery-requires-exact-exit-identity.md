---
type: source
title: Exact Pi allocation recovery identity
status: insight
category: bugfix
created: 2026-09-05
updated: 2026-09-05
slug: pi-allocation-recovery-requires-exact-exit-identity
---

# Exact Pi allocation recovery identity

[[sources/durable-noncooperative-process-ownership]] — When a tracked Pi process has finally emitted its exit observation, every subsequent cleanup CAS for a first-session allocation must carry the same process identity, including the second pass that removes a durable `failed` allocation. Passing no identity caused five PiRunner noncooperative termination tests to leave the in-memory allocation handle retained; passing the exact exited process preserves the ownership/exit proof and lets cleanup converge. AIDEV-223 fix: `src/pi/pi-runner.ts` now passes `process`/`handle.process` to that second recovery call; focused PiRunner and full suites pass.

*Category: bugfix*

---
*Captured: 2026-09-05*

## Related

_Add links to related pages._
