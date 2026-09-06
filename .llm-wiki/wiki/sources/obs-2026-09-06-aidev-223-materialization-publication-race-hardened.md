---
type: source
title: "Observation: AIDEV-223 materialization publication race hardened"
tags:
  - AIDEV-223
  - sandbox
  - concurrency
  - publication
  - race
  - conformance
status: observation
created: 2026-09-06
updated: 2026-09-06
slug: obs-2026-09-06-aidev-223-materialization-publication-race-hardened
relevance: high
observed_at: 2026-09-06T04:36:11.575Z
source_context: Implement AIDEV-223 restricted sandbox
---

# ⭐ Observation: AIDEV-223 materialization publication race hardened

Hardened `src/pi/pi-agent-directory.ts` cross-process retained-allocation and publication handoffs: owner contention now retries only on the authenticated held-owner race, auth/retained-record publication candidates tolerate verified link-settlement races while preserving inode/byte checks. The separate-controller materialization stress passed 10 repeated runs; full validation is 191 tests with 190 pass, 0 fail, 1 skipped. Trusted Docker Sandboxes v0.39.0 host conformance and signed release promotion remain unavailable and are not treated as acceptance proof.

*Relevance: high*
*Context: Implement AIDEV-223 restricted sandbox*
*Tags: AIDEV-223 sandbox concurrency publication race conformance*

---
*Observed: 2026-09-06T04:36:11.575Z*
