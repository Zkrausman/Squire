---
type: source
title: Run-scoped agent runtime resolution
status: insight
category: architecture
created: 2026-09-01
updated: 2026-09-02
slug: run-scoped-agent-runtime-resolution
---

# Run-scoped agent runtime resolution

MVP runtime consistency does not require a repository-wide exact Pi or pi-llm-wiki pin. Resolve the selected installations once, persist exact observed versions, installation identities, trusted local roots (plus the Pi executable), and, when available in the additive v1 observation, exact provider/model reasoning-capability records bound to those installations, then launch all [five Pi sessions](/concepts/five-session-pi-rpc-topology.md) from that observation. The materialization boundary requires that exact capability evidence even when a legacy v1 observation omits it. The controller materializes one matching run-scoped Pi agent directory outside the target worktree with sibling run-scoped `HOME` and `WIKI_HOME` directories and never upgrades an active run. This policy belongs to the [trusted controller boundary](/concepts/trusted-controller-boundary.md) and is structurally represented by the v1 `runtime-resolution` artifact.

*Category: architecture*

---
*Captured: 2026-09-01*

## AIDEV-228 implementation fact

Role launches now carry explicit provider/model/thinking profiles. The project-wiki task profile is independent and defaults to Luna/high. The generated settings use the persisted local wiki root and `llm-wiki.taskModel`; they do not install, update, or resolve a latest package. The manifest binds the exact wiki entrypoint and package-tree digests, and the runner repeats those and project-override checks in the fenced pre-spawn step for every role rather than trusting settled preparation. Independent controllers serialize preparation through a private bounded lock, atomic staging, stale dead-owner recovery, and winner verification, so identical requests converge while conflicting requests fail closed. Lock readers preserve filesystem causes/codes, retry disposable release/replacement and enumeration races, and compare stable directory identities and owner tokens before acting. Lock, reclaim-marker, staging, and failed-creation cleanup atomically capture live directories into fresh private quarantines, revalidate the captured identity/token, and retain verified captures with authenticated run/source/type/identity records under the runtime root's private `.pi-agent-quarantine-retained/<runId>` namespace because Node cannot bind recursive deletion to an inode. Retention is bounded to 32 captures per run and 256 globally; a process-independent retained-allocation mutex makes both checks atomic across controllers. Metadata-bearing fences reconcile stale handoffs within bounded owner/identity checks. Destructive teardown first acquires a durable workflow terminal fence, publishes a matching authenticated filesystem fence outside the removable sandbox, proves preparation quiescence, and moves identity-checked objects into private disposal paths before recursive removal. The terminal fence permanently rejects new role/controller work across restart, while interrupted authenticated publications are resumed or safely discarded only by fenced teardown. Replacements remain untouched and fail closed without leaving an unbounded or permanently ownerless lifecycle. Once the verified directory exists, completed identical waiters use a validated lockless read path instead of serializing package verification. A trusted footer extension follows the wiki extension; in TUI mode it reads the two wiki status keys through the footer API and compacts only exact routine activity while preserving diagnostics, including diagnostic text in compact-looking blocks. The real-Pi launch gate uses a pseudo-terminal to observe the generated extension's actual compact render and rejects extension-loader diagnostics/stderr.

## Related

- [Run-scoped Pi profiles and trusted footer](/concepts/run-scoped-pi-profiles-and-trusted-footer.md)
- [Current architecture source](/sources/SRC-2026-09-01-006.md)
- [Current contract source](/sources/SRC-2026-09-01-007.md)
