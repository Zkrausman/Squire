---
type: source
title: Run-scoped agent runtime resolution
status: insight
category: architecture
created: 2026-09-01
updated: 2026-09-01
slug: run-scoped-agent-runtime-resolution
---

# Run-scoped agent runtime resolution

MVP runtime consistency does not require a repository-wide exact Pi or pi-llm-wiki pin. Resolve the selected installations once, persist exact observed versions and installation identities (plus the Pi executable), and launch all [five Pi sessions](/concepts/five-session-pi-rpc-topology.md) from that observation. Never upgrade an active run. This policy belongs to the [trusted controller boundary](/concepts/trusted-controller-boundary.md) and is structurally represented by the v1 `runtime-resolution` artifact.

*Category: architecture*

---
*Captured: 2026-09-01*

## Related

- [Current architecture source](/sources/SRC-2026-09-01-006.md)
- [Current contract source](/sources/SRC-2026-09-01-007.md)
