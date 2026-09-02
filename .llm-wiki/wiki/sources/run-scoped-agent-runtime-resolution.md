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

MVP runtime consistency does not require a repository-wide exact Pi or pi-llm-wiki pin. Resolve the selected installations once, persist exact observed versions, installation identities, trusted local roots (plus the Pi executable), and launch all [five Pi sessions](/concepts/five-session-pi-rpc-topology.md) from that observation. The controller materializes one matching run-scoped Pi agent directory outside the target worktree and never upgrades an active run. This policy belongs to the [trusted controller boundary](/concepts/trusted-controller-boundary.md) and is structurally represented by the v1 `runtime-resolution` artifact.

*Category: architecture*

---
*Captured: 2026-09-01*

## AIDEV-228 implementation fact

Role launches now carry explicit provider/model/thinking profiles. The project-wiki task profile is independent and defaults to Luna/high. The generated settings use the persisted local wiki root and `llm-wiki.taskModel`; they do not install, update, or resolve a latest package. A trusted footer extension follows the wiki extension; in TUI mode it reads the two wiki status keys through the footer API and compacts routine activity while preserving diagnostics.

## Related

- [Run-scoped Pi profiles and trusted footer](/concepts/run-scoped-pi-profiles-and-trusted-footer.md)
- [Current architecture source](/sources/SRC-2026-09-01-006.md)
- [Current contract source](/sources/SRC-2026-09-01-007.md)
