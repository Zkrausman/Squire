---
type: source
title: "Observation: Directory identity race fixed in intake artifact setup"
tags:
  - AIDEV-224
  - intake
  - filesystem
  - race
  - security
status: observation
created: 2026-09-06
updated: 2026-09-06
slug: obs-2026-09-06-directory-identity-race-fixed-in-intake-artifact-setup
relevance: high
observed_at: 2026-09-06T05:29:52.725Z
source_context: Fixing concurrent immutable normalized-ticket artifact publication
---

# ⭐ Observation: Directory identity race fixed in intake artifact setup

Concurrent single-ticket intake could race while multiple callers initialized the same private artifact directory: chmod changed directory ctime between inspectResource's lstat and descriptor checks, producing a false "resource changed during descriptor identity inspection" error. Directory identity validation now compares stable type/device/inode/mode/link metadata while intentionally ignoring directory size and timestamps, which can change during legitimate concurrent child creation or chmod. Added a 64-way concurrent initialization regression test in test/git-paths.test.ts.

*Relevance: high*
*Context: Fixing concurrent immutable normalized-ticket artifact publication*
*Tags: AIDEV-224 intake filesystem race security*

---
*Observed: 2026-09-06T05:29:52.725Z*
