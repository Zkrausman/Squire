# Contract → Implement → Verify

AIDEV-316 establishes the sole delivery workflow. The fetched immutable Linear snapshot (bounded ticket plus SHA-256 digest) is the owner-approved contract. There is no model planning authority.

Implement is the sole writer and commits one clean descendant candidate at the exact bound base. It evaluates net durable project-wiki knowledge from that base, updates only committed target-worktree `.llm-wiki`, and reports every changed path or a concrete no-update reason. No personal/host vault, secrets, transcripts or routine status belong here.

Fresh independent Verify combines security/correctness diff review with every configured test command. It has no edit/write tools; tracked source and Git metadata are sealed under root ownership, sticky source ancestors prevent rename/unlink, and command execution uses a non-root uid:gid with no-new-privileges. Ignored build outputs are permitted. The runner independently executes commands and retains private bounded output. Controller pre/post HEAD and cleanliness checks bind acceptance to the immutable candidate.

Only an exact passing candidate is bundled and published through the GitHub App. Required Node 24 build/test, Windows native/ACL, Linux/Windows filesystem and advanced JavaScript/TypeScript plus Actions CodeQL remain exact-head merge gates. The controller never merges or treats model attestation as CI.

Malformed, missing, failed, contradictory or timed-out phase output terminalizes without correction, replay or remediation. Preserve raw private evidence and candidate, never promote or relabel it. A separately owner-authorized new run is the only next execution. The existing typed zero-effect pre-result provider retry remains bounded to one replacement under the original deadline; accepted work cannot replay.

Schema-2 state keeps contract, base, candidate, Verify, terminal reason, publication and external CI/merge dispositions separate. External CI remains pending and merge unmerged until external evidence exists; publication cannot infer either. Historical schema-1 state is read-only display data, never executable. Configuration accepts exactly modelPolicy.implement and modelPolicy.verify; obsolete profiles/prompt/escalation/correction controls fail with migration guidance. Telemetry attributes only these sessions and does not backfill history or broaden the usage parser.

Implementation: `src/personal/controller.ts`, `pi-phase-runner.ts`, `json-run-state.ts`, `historical-state.ts`. Operational contract: `docs/personal-mvp.md`.

Controller-owned phase parent directories and root-owned read-only input files protect the copied contract and prevent the writer from replacing future phase input paths. Phase homes/sessions are distinct; private host stdout evidence, not model-writable session logs, is authoritative.
