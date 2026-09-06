---
type: source
title: AIDEV-218 Plan Path Scope Remediation
status: insight
category: security
created: 2026-09-06
updated: 2026-09-06
slug: aidev-218-plan-path-scope-remediation
---

# AIDEV-218 Plan Path Scope Remediation

AIDEV-218 Plan must not expose Pi stock filesystem tools that accept absolute paths. The remediation uses generated controller-owned squire_plan_read, squire_plan_grep, squire_plan_find, and squire_plan_ls tools with repository-relative paths, project-only wiki scope, retained no-follow descriptors, single-link/type/size checks, stable identity checks, and a controller policy digest. The Pi allowlist remains a strict tool boundary rather than an OS sandbox; AIDEV-223 owns any stronger isolation. [[sources/aidev-218-plan-phase-boundary]] and [[sources/persisted-acceptance-authority-chain]] remain the relevant authorities.

*Category: security*

---
*Captured: 2026-09-06*

## Related

_Add links to related pages._
