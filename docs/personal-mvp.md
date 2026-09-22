# Contract → Implement → Verify

There is one delivery path: **owner-approved immutable Linear snapshot → Implement → fresh independent Verify → exact-head App publication → required CI → owner merge evidence**.

The fetched issue is the contract, not a model-authored plan. The controller persists its bounded snapshot and SHA-256 digest before dispatch. A clean run launches exactly two independent Pi sessions. No model may change the workflow.

## Authority

Implement is the only writer. It inspects, edits, builds, tests and commits one candidate descended from the exact base. The worktree must be clean. Durable architecture, workflow, operational and constraint knowledge belongs only in the target worktree's committed `.llm-wiki`. Evaluate the net base-to-candidate diff; report every changed wiki path or a concrete no-update reason. Never use a personal/host vault or include secrets, transcripts or routine status.

Verify starts with a fresh session and home at that exact candidate. It reviews security, correctness, scope and wiki claims and executes all configured tests. It has read/search/command tools, no edit/write tools. Tracked source is root-owned and nonwritable; root-owned sticky ancestors prevent unlink/rename while allowing build outputs. Git metadata is sealed and the unprivileged process runs with `setpriv --no-new-privs`. Config requires a non-root numeric uid:gid. The runner also deterministically executes configured commands, preserves their bounded private output and rejects nonzero or missing exits. The controller independently checks HEAD and cleanliness afterward. Tests requiring source edits are incompatible; fix owner configuration rather than weakening this boundary.

The controller exports and publishes only the verified candidate, validating bundle base, branch, digest and head through the existing GitHub App publisher. It does not merge. Required Node 24 Linux/Windows, native/ACL/filesystem and advanced JavaScript/TypeScript plus Actions CodeQL gates remain authoritative on the published exact head. Model Verify is never CI attestation.

## Failure and evidence

Reports are closed versioned JSON objects: version, outputHead, passed/failed status, bounded summary and phase-specific bounded details. Trusted run/session/profile/input-head identity comes from the controller, not echoed model fields. Reports, process streams and test outputs remain private immutable artifacts. Missing, malformed, contradictory, timed-out or failed output is terminal; preserve the candidate, never promote it.

There are no correction sessions, automatic model remediation, phase replays, supervisor conversations or resume paths. Failed/terminal state cannot be rewritten. The owner may authorize a separate new run, never relabel or manually publish the failed candidate. The only provider-launch retry is the pre-existing typed, zero-effect, pre-result allowlist, at most one generation under the original deadline and exact clean baseline. A returned/accepted phase cannot retry.

Run-state schema 2 records contract, base, candidate, Verify disposition, terminal reason, publication, pending external CI and unmerged disposition independently. External CI and merge are not inferred from publication. Historical schema-1 state has a separate read-only status/watch display; it is never normalized into executable state.

## Configuration migration

`modelPolicy` has exactly `implement` and `verify` profiles. Remove old phase profiles, `escalationPolicy`, `reportCorrectionPolicy`, `promptPolicy` and remediation controls; they fail before launch with migration errors. There is no implicit mapping. Use `squire.config.example.json`. Config and launch evidence are captured before detached handoff, with private outside-repository runtime paths and unchanged Windows native ACL boundaries.

Controller-owned phase parent directories and root-owned read-only input files protect the copied contract and prevent the writer from replacing future phase input paths. Phase homes/sessions are distinct; private host stdout evidence, not model-writable session logs, is authoritative.
