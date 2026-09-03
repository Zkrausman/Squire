---
type: source
title: AIDEV-222 hardened Git workspace remediation
status: insight
category: architecture
created: 2026-09-03
updated: 2026-09-03
slug: aidev-222-hardened-git-workspace-remediation
---

# AIDEV-222 hardened Git workspace remediation

The AIDEV-222 implementation now uses a closed immutable workspace spec and manifest, deterministic `squire/<ticket-id>-<run-id>` identity, explicit public source authorization, descriptor-safe filesystem operations, persisted Git operation recovery, mandatory Pi readiness, offline status/commit, digest-bound single-ref bundle export, and exact terminal-fenced disposal. Retained bundle and manifest proofs are independently revalidated rather than trusting journal text. The implementation preserves AIDEV-228 runtime/footer state and leaves normalized-ticket v1 unchanged. Verification completed at commit `3e5eabb21f7b59a962ef94c9564b65914dbfc4e3` with 169 passing tests and one platform-conditional skip. See [[sources/aidev-222-isolated-git-workspace]].

*Category: architecture*

---
*Captured: 2026-09-03*

## Related

_Add links to related pages._
