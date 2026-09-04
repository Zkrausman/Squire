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

The AIDEV-222 implementation now uses a closed immutable workspace spec and manifest, deterministic `squire/<ticket-id>-<run-id>` identity, explicit public source authorization, descriptor-safe filesystem operations, persisted Git operation recovery, mandatory Pi readiness, offline status/commit, digest-bound single-ref bundle export, and exact terminal-fenced disposal. Review-attempt-2 remediation makes retained bundle proofs independent of the disposed workspace by using a disposal-owned scratch repository, binds approved HTTPS DNS answers into Git's `http.curloptResolve` transport with redirects disabled, requires the opaque AIDEV-223 trusted filesystem-isolation capability rather than treating `st_dev` as mount proof, and adds combined real Git/real Pi launch-readiness coverage. Retained bundle and manifest proofs are independently revalidated rather than trusting journal text. The implementation preserves AIDEV-228 runtime/footer state and leaves normalized-ticket v1 unchanged. See [[sources/aidev-222-isolated-git-workspace]] and [[sources/obs-2026-09-04-aidev-222-review-2-blockers-remediated]].

*Category: architecture*

---
*Captured: 2026-09-03*

## Related

_Add links to related pages._
