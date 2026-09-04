---
type: source
title: AIDEV-222 descriptor-bound isolation evidence
status: insight
category: security
created: 2026-09-04
updated: 2026-09-04
slug: aidev-222-descriptor-bound-isolation-evidence
---

# AIDEV-222 descriptor-bound isolation evidence

Review 4 exposed that rereading `/proc/<pid>/mountinfo` by pathname was forgeable through an unprivileged saved-mountinfo bind-over. The remediation binds [[concepts/trusted-controller-boundary]] and [[sources/aidev-222-review-3-isolation-authentication]] to pre-opened procfs root, nsfs mount-namespace, and procfs mountinfo descriptors at authority issuance. It records exact kernel descriptor identities, reads bounded live topology with positioned reads from the retained mountinfo descriptor, verifies descriptor identities before and after reads, rejects closure/errors/malformed or overflowing data, and exposes an explicit idempotent close lifecycle. The unprivileged probe bind-mounted saved mountinfo plus four external artifact roots; createSpec, real Git provisioning, bundle publication, and terminal-fenced disposal all rejected with unchanged external sources. The trusted controller and untrusted phase processes are separate security principals; namespace and identity provisioning remain AIDEV-223 scope. [[syntheses/aidev-222-isolated-git-workspace]]

*Category: security*

---
*Captured: 2026-09-04*

## Related

_Add links to related pages._
