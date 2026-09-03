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

AIDEV-222 is implemented on the frozen AIDEV-228-integrated base. The component in `src/git/workspace-service.ts` uses the existing [[Trusted Controller Boundary]] and [[AIDEV-216 and AIDEV-224 Ownership Boundary]] lifecycle authority: generic fenced CAS and RunQuiescenceAuthority preparation leases guard all provisioning, verification, export, retention, and disposal operations. It creates fixed private `/ticket/git/repo.git` and `/ticket/workspace` resources, derives `squire/<ticket-id>-<run-id>`, requires an explicit allowlisted HTTPS repository authorizer with public DNS results and redirects disabled, rejects untrusted refs/config/hooks/attributes/submodules/alternates and filesystem substitution, and persists closed Git workspace contracts without changing normalized-ticket v1. Offline status/commit, digest-bound single-ref bundle export, immutable retention, and exact idempotent disposal under an already-held terminal fence are covered by temporary-repository tests. Retained disposal journals include authenticated contract snapshots, exact child identities, and digests; bundles are owner-non-writable. Final verification recorded 169 passing tests and one platform-conditional skip, contract validation, TypeScript build, audit, Git fsck, diff checks, and native Wiki lint/privacy review. Canonical synthesis: [[syntheses/aidev-222-isolated-git-workspace]].

*Category: architecture*

---
*Captured: 2026-09-03*

## Related

_Add links to related pages._
