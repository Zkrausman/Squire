---
type: concept
title: Run-scoped Pi profiles and trusted wiki footer
status: active
category: architecture
created: 2026-09-02
updated: 2026-09-03
domain: engineering
confidence: high
sources: [sources/run-scoped-agent-runtime-resolution]
---

# Run-scoped Pi profiles and trusted wiki footer

A Squire run carries five independently configurable Pi profiles and one separate project-wiki background profile. The defaults are Orchestrator/Plan `openai-codex/gpt-5.6-sol/high`, Implement `openai-codex/gpt-5.6-luna/max`, Review `openai-codex/gpt-5.6-sol/medium`, Test `openai-codex/gpt-5.6-terra/high`, and wiki background `openai-codex/gpt-5.6-luna/high`. Provider, model, and the closed thinking level are passed on every role launch and checked against `get_state` before a session is registered.

The trusted controller resolves Pi and pi-llm-wiki once and persists their exact identities and local roots. Published v1 runtime observations may omit additive capability records, but the materialization boundary requires an exact provider/model reasoning-capability record bound to both installations. It materializes one run-scoped Pi agent directory outside the target worktree with sibling run-scoped `HOME` and `WIKI_HOME` directories, an auditable manifest, and SHA-256-bound settings/footer/entrypoint/package-tree bytes. Settings select the exact local wiki installation, set `llm-wiki.taskModel`, and pin Luna's high thinking level. A restart reuses only matching bytes and private owner/modes; independent controllers use a bounded private preparation lock and converge on one verified winner. Lock readers retain filesystem causes/codes, retry release/replacement and enumeration races, and validate stable directory identities and owner tokens before acting. Every lock, reclaim-marker, staging, and failed-creation cleanup atomically captures the live directory into a fresh private quarantine, revalidates the captured identity/token, and records authenticated run/source/type/identity metadata for the verified capture under the runtime root's private `.pi-agent-quarantine-retained/<runId>` namespace because Node cannot bind recursive deletion to an inode. The ledger is bounded to 32 captures per run and 256 globally; a process-independent retained-allocation mutex makes both bounds atomic across controllers. Metadata-bearing fences have bounded stale reconciliation. Destructive teardown first acquires a durable workflow terminal fence, publishes a matching authenticated filesystem fence outside the removable sandbox, proves preparation quiescence, and moves identity-checked objects into private disposal paths before recursive removal. The terminal fence permanently rejects new role/controller work across restart; interrupted authenticated publications are resumed or safely discarded only by fenced teardown. This keeps replacements untouched while making the finite retained state recoverable. Completed identical waiters use a validated lockless read path rather than serializing package verification. Package or project overrides are rechecked before every spawn. Partial, symlinked, tampered, or project-conflicting state is rejected. Auth is copied only from an explicit ticket-scoped provisioner, never from host home or the worktree; Pi's fixed private runtime cache files are allowed without becoming trusted configuration.

The same controller-owned footer extension follows the wiki extension in every process. In Herdr TUI mode it reads the `llm-wiki` and `llm-wiki-model` status map through the Pi footer API and replaces the stock/separate wiki presentation with the personal complementary one-line model/thinking/wiki/state/access/context/cost footer; routine activity renders as `🧠 <count-or-dash> · <provider>/<model>` while those values and their theme colors remain intact. It also changes only the known healthy `<wiki_status>` capability block in the prompt. Unknown or diagnostic blocks and all warning/error/extension-error/stderr/protocol signals remain complete and observable. The launch gate exercises the same generated extension in a real Pi TUI pseudo-terminal and rejects loader diagnostics before accepting the compact marker.

*Category: architecture*

## Related

- [Run-scoped agent runtime resolution](/sources/run-scoped-agent-runtime-resolution.md)
- [Five-session Pi RPC topology](/concepts/five-session-pi-rpc-topology.md)
- [Trusted controller boundary](/concepts/trusted-controller-boundary.md)
- [AIDEV-216 orchestration control plane](/sources/SRC-2026-09-01-007.md)
