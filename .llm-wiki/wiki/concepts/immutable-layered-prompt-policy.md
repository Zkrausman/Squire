---
type: concept
created: 2026-09-16
updated: 2026-09-16
domain: engineering
confidence: high
sources: []
---

# Immutable layered prompt policy

The personal controller separates prompt policy from runtime authority and deterministic Plan A/B model selection. User-global `promptPolicy` version 1 selects the built-in `default` or a matching host-owned manifest ID at an absolute root outside the target repository. Its ordered, unique `plan` list accepts only `requirements` and `implementation-design`. The default list is empty. Execution supports only the empty legacy selection or the dependency-valid Requirements → Implementation Design sequence under a [deterministic Plan supervisor](deterministic-plan-supervisor.md). Partial/reversed sequences fail before launch. No generic workflow graph is introduced and live rollout remains separate.

Policy composition is trusted core/output contract → captured phase text → optional selected subphase text. Supervised children have distinct trusted artifact contracts, included alongside phase cores in core-digest coverage. Core has no configuration replacement slot. Pi receives policy through `--system-prompt`; the append-system-prompt option is omitted (no empty sandbox argument), and project/resource loading is disabled. Ticket text, feedback, and configured test commands remain input data. Prompt wording cannot grant tools or replace controller-owned output validation, transitions, retries, timeout, credentials, or exact-head gates.

## Capture and binding

The launch captures the exact raw configuration once and resolves environment-dependent configuration once. Selected manifest and prompt files are captured once per filename. Captured bytes are immutable base64 strings; material validation makes a defensive deep-frozen copy rather than exposing mutable Buffers. Closed nested schemas, canonical base64, core identity, and combined digest checks apply on detached deserialization.

`launchEvidence` persists a version, combined digest, core digest, prompt-set ID, and ordered subphase IDs. The combined domain-separated SHA-256 covers exact configuration/manifest/prompt bytes and normalized configuration; run-specific binding is separate so identical launch inputs have identical digests in foreground/background modes. Phase inputs also record the effective system-prompt digest. These fields are controller-authored, not new model result fields.

Detached launch material lives in the host state directory, in a restrictive atomically published `launch-material/<runId>.json`. Its binding includes run/ticket, repository/source identity, state location, config pathname/digest, and launch evidence. Missing, corrupt, or wrong-binding material fails before claim/adapter work, including direct `runReserved`. Children never reread original configuration/prompts or renormalize paths from their environment. Historical state can be inspected but cannot bypass this requirement. See [background lifecycle](/concepts/background-run-state-and-status.md).

## Source trust and tested limits

External manifests map all five phases and selected recognized subphases to direct files beneath the selected root. Unknown fields/IDs, missing or malformed files/manifests, traversal, symlinks, repository roots/aliases, nonregular/hardlinked files, unsafe ownership, and writable prompt roots/files fail closed. Files must be bounded nonempty UTF-8. Shared sticky ancestors are allowed; external capture requires host support for descriptor-relative directory access.

Initial directory-chain identities are compared with retained opened descriptors; descendant/file opening is relative to those pinned objects, not replacement pathname trust anchors. Open-file identity and high-resolution metadata checks guard partial descriptor reads against replacement, in-place writes, and truncation. Deterministic tests cover real pre-pin/pre-open boundaries and replacement-and-restore attempts. This does **not** claim universal filesystem-history detection: transient rename/restore that leaves pinned bytes unchanged is distinguishable from accepting substituted bytes and may succeed. Privileged metadata forgery or a hostile same-UID controller process remains outside this personal-host boundary. Built-in policy and config/status parsing are not globally Windows-rejected because an unrelated adapter is Linux-specific.

The foreground/detached CLI integration harness deletes original configuration/prompts after capture, changes the child environment, reaches both supervised Plan child launch argument sets and the remaining phases with external services stubbed, and compares system policy/digests. It tests bootstrap parity, not live provider or production rollout acceptance. Publication still requires independent normal Review, Test, and Retro gates on the candidate HEAD.

Implementation: `src/personal/prompt-policy.ts`, `prompt-core.ts`, `launch-material.ts`, `pi-phase-runner.ts`, `cli.ts`, and `controller.ts`. Operator schema/examples: `docs/personal-mvp.md`. Focused evidence: `test/personal-prompt-policy.test.ts`, `personal-prompt-races.test.ts`, and `personal-launch-material.test.ts`.
