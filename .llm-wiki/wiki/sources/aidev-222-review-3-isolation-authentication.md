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

Review-attempt-3's forgeable duck-typed filesystem capability was replaced by a runtime-authenticated `TrustedFilesystemIsolationAuthority` in `src/git/trusted-isolation.ts`. The token has module-private construction/identity, private `WeakSet`/`WeakMap` authentication, no public runtime constructor or assertion-based mint, and an observation bound to the exact canonical ticket root, mount namespace, root identity, and descriptor-backed mount topology. Trusted composition pre-opens procfs root, mount-namespace nsfs, and procfs mountinfo descriptors at issuance; operation checks fstat their retained identities and read live topology only from the held mountinfo descriptor, so pathname bind-over substitution, descriptor closure/error, malformed data, and bounded-read overflow fail closed. The explicit authority owner closes descriptors idempotently. `GitWorkspaceService` authenticates the token at construction and checks the operation boundary before create, filesystem, Git, bundle, and disposal side effects. `test/git-trusted-isolation.test.ts` includes non-skipped unprivileged `unshare -Urnm` production probes, including the exact saved-mountinfo bind-over with four artifact binds: createSpec, real Git provisioning, bundle publication, and disposal all reject and external bind sources remain unchanged. When namespace mounting is unavailable it runs explicit forgery and unavailable-evidence fallback assertions without treating the environment limitation as isolation evidence. The trusted controller and untrusted phase processes are separate security principals; namespace and identity provisioning belong to AIDEV-223. [[sources/aidev-222-isolated-git-workspace]] and [[syntheses/aidev-222-isolated-git-workspace]] document the boundary, while normalized-ticket v1 and AIDEV-228 runtime/footer state remain unchanged.

*Category: security*

---
*Captured: 2026-09-04*

## Related

_Add links to related pages._
