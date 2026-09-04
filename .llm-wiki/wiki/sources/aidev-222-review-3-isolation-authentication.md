---
type: source
title: AIDEV-222 runtime isolation authentication
status: insight
category: security
created: 2026-09-04
updated: 2026-09-04
slug: aidev-222-review-3-isolation-authentication
---

# AIDEV-222 runtime isolation authentication

Review-attempt-3's forgeable duck-typed filesystem capability was replaced by a runtime-authenticated `TrustedFilesystemIsolationAuthority` in `src/git/trusted-isolation.ts`. The token has module-private construction/identity, private `WeakSet`/`WeakMap` authentication, no public runtime constructor or assertion-based mint, and an observation bound to the exact canonical ticket root, mount namespace, root identity, and mount topology. `GitWorkspaceService` authenticates the token at construction and checks the operation boundary before create, filesystem, Git, bundle, and disposal side effects; stale root replacement, nested mounts, cross-root tokens, unavailable evidence, and lookalikes fail closed. `test/git-trusted-isolation.test.ts` includes a non-skipped unprivileged `unshare -Urnm` production-constructor bind-mount probe; when namespace mounting is unavailable it runs explicit forgery and unavailable-evidence fallback assertions without treating the environment limitation as isolation evidence. [[sources/aidev-222-isolated-git-workspace]] and [[syntheses/aidev-222-isolated-git-workspace]] document the AIDEV-223 composition boundary, while normalized-ticket v1 and AIDEV-228 runtime/footer state remain unchanged.

*Category: security*

---
*Captured: 2026-09-04*

## Related

_Add links to related pages._
