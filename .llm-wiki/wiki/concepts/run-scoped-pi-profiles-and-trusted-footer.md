---
type: concept
title: Run-scoped Pi profiles and trusted wiki footer
status: active
category: architecture
created: 2026-09-02
updated: 2026-09-02
domain: engineering
confidence: high
sources: [sources/run-scoped-agent-runtime-resolution]
---

# Run-scoped Pi profiles and trusted wiki footer

A Squire run carries five independently configurable Pi profiles and one separate project-wiki background profile. The defaults are Orchestrator/Plan `openai-codex/gpt-5.6-sol/high`, Implement `openai-codex/gpt-5.6-luna/max`, Review `openai-codex/gpt-5.6-sol/medium`, Test `openai-codex/gpt-5.6-terra/high`, and wiki background `openai-codex/gpt-5.6-luna/high`. Provider, model, and the closed thinking level are passed on every role launch and checked against `get_state` before a session is registered.

The trusted controller resolves Pi and pi-llm-wiki once and persists their exact identities and local roots, plus an exact provider/model reasoning-capability record bound to both installations. It materializes one run-scoped Pi agent directory outside the target worktree with sibling run-scoped `HOME` and `WIKI_HOME` directories, an auditable manifest, and SHA-256-bound settings/footer/entrypoint/package-tree bytes. Settings select the exact local wiki installation, set `llm-wiki.taskModel`, and pin Luna's high thinking level. A restart reuses only matching bytes and private owner/modes; package or project overrides are rechecked before every spawn. Partial, symlinked, tampered, or project-conflicting state is rejected. Auth is copied only from an explicit ticket-scoped provisioner, never from host home or the worktree; Pi's fixed private runtime cache files are allowed without becoming trusted configuration.

The same controller-owned footer extension follows the wiki extension in every process. In Herdr TUI mode it reads the `llm-wiki` and `llm-wiki-model` status map through the Pi footer API and renders routine activity as `🧠 <count-or-dash> · <provider>/<model>` without replacing the normal model/thinking/token/context/cost layout. It also changes only the known healthy `<wiki_status>` capability block in the prompt. Unknown or diagnostic blocks and all warning/error/extension-error/stderr/protocol signals remain complete and observable.

*Category: architecture*

## Related

- [Run-scoped agent runtime resolution](/sources/run-scoped-agent-runtime-resolution.md)
- [Five-session Pi RPC topology](/concepts/five-session-pi-rpc-topology.md)
- [Trusted controller boundary](/concepts/trusted-controller-boundary.md)
- [AIDEV-216 orchestration control plane](/sources/SRC-2026-09-01-007.md)
