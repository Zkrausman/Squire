---
type: source
title: AIDEV-222 deterministic retention tests
status: insight
category: testing
created: 2026-09-04
updated: 2026-09-04
slug: aidev-222-deterministic-retention-tests
---

# AIDEV-222 deterministic retention tests

Review attempt 5 found that the two Git/Pi lifecycle acceptance tests used `Date.now()+100` retention deadlines and 150 ms sleeps, so the complete parallel suite could reach `markRetained` after the deadline. Attempt 6 adds a deterministic [[sources/aidev-222-descriptor-bound-isolation-evidence]]-compatible controllable test clock, injects it through [[sources/aidev-222-isolated-git-workspace]], advances trusted time only after `markRetained` succeeds, and removes equivalent short retention sleeps from bundle/recovery tests. Git supervisor timing tests now use process-exit/spawn synchronization and ample timeout margins. Product retention assertions are unchanged; repeated full suites and focused lifecycle/Git suites pass.

*Category: testing*

---
*Captured: 2026-09-04*

## Related

_Add links to related pages._
