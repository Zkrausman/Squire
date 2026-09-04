---
type: source
title: AIDEV-222 isolated Git workspace
status: insight
category: architecture
created: 2026-09-03
updated: 2026-09-03
slug: aidev-222-isolated-git-workspace
---

# AIDEV-222 isolated Git workspace

AIDEV-222 is implemented on the frozen AIDEV-228-integrated base. The component in `src/git/workspace-service.ts` uses the existing [[Trusted Controller Boundary]] and [[AIDEV-216 and AIDEV-224 Ownership Boundary]] lifecycle authority: generic fenced CAS and RunQuiescenceAuthority preparation leases guard all provisioning, verification, export, retention, and disposal operations. It creates fixed private `/ticket/git/repo.git` and `/ticket/workspace` resources, derives `squire/<ticket-id>-<run-id>`, requires an explicit allowlisted HTTPS repository authorizer whose public DNS answer set is pinned into Git libcurl `http.curloptResolve` while TLS hostname validation and redirect denial remain active, rejects untrusted refs/config/hooks/attributes/submodules/alternates and filesystem substitution, and persists closed Git workspace contracts without changing normalized-ticket v1. Production Git operations require the runtime-authenticated `TrustedFilesystemIsolationAuthority` from the narrow AIDEV-223 composition boundary; its module-private token identity/WeakSet and exact canonical ticket-root, mount-namespace, root-identity, and mount-topology observation reject forged, cross-root, stale, nested-mount, or unavailable evidence, while the operation boundary is rechecked before filesystem/Git/disposal side effects. Node descriptor/st_dev checks remain defense in depth. Offline status/commit, digest-bound single-ref bundle export, immutable retention, and exact idempotent disposal under an already-held terminal fence are covered by temporary-repository tests, including workspace-first and bundle-first disposal across a restarted controller. Retained bundle verification uses a disposal-owned scratch repository after the workspace is gone, and the combined E2E launches real Git readiness, real Pi, real materialization, and ordered teardown. Canonical synthesis: [[syntheses/aidev-222-isolated-git-workspace]]. Remediation record: [[sources/aidev-222-hardened-git-workspace-remediation]]; verification observations: [[sources/obs-2026-09-03-aidev-222-remediation-commit-verified]], [[sources/aidev-222-review-2-remediation-complete]], and [[sources/aidev-222-review-3-isolation-authentication]].

*Category: architecture*

---
*Captured: 2026-09-03*

## Related

_Add links to related pages._
