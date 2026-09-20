---
type: concept
domain: engineering
confidence: high
---

# Report-only format correction

The personal controller can correct an Implement handoff with unexpected `details` fields without rerunning implementation. Strict acceptance is unchanged: only the corrected model-produced bytes can become a result; an analysis projection never can. Every required fact, optional identity echo, original execution producer, candidate HEAD and cumulative original-base-to-candidate wiki disposition must already validate. Failed phase execution, missing/contradictory facts, malformed original JSON, unsupported phases, dirty candidates and ownership/security failures fail closed.

`reportCorrectionPolicy` belongs to existing personal configuration (future AIDEV-294 migration, not repo-owned configuration yet). It requires `maxAttempts` (default policy 1, integer 0–2, 0 disables) and `allowedErrorClasses` (only `implement-unexpected-details-fields`, or an empty list). Each actual Implement attempt has its own allowance; correction charges are persisted before dispatch and never borrow or reset model-stage or Review/Test remediation budgets. The monotonic phase deadline includes correction. No authoritative token/cost cap exists in this runtime; none is inferred from a report.

Correction uses a fresh Pi context with no tools, sessions, extensions, skills or project context, outside the workspace, and a separate auth copy. The controller issues producer identities, binds all original facts and independently checks HEAD/cleanliness after correction, even on failure. Valid correction still requires independent Review, Test, Retro and exact-head publication. Extra claimed verification is evidence only.

Host evidence files are exclusive-create, bounded and outside model-writable storage. Every original/corrected response and controller observation is independently read and compared to its expected content, byte length and SHA-256 before verified persistence or continuation; original evidence is checked again before acceptance. Metadata alone is insufficient. The initial production safe-read adapter uses Linux pinned directory descriptors, no-follow regular-file reads, filesystem identity and before/after checks. Other hosts fail closed for correction until equivalent safe evidence support exists; valid ordinary phase reports remain supported.

State has immutable `reportCorrectionPolicy` and an append-only `reportCorrections` ledger. Events distinguish observed/launched/accepted/stopped correction from phase completion and remediation. On failure, one terminal escalation includes primary validation error, evidence references and human action; reservation cleanup failure remains separate. Historical failed runs are never reopened or promoted.

Implementation: `src/personal/report-correction.ts`, `report-evidence.ts`, `phase-payload.ts`, `controller.ts`, `pi-phase-runner.ts`. Offline synthetic regressions: `test/personal-report-correction.test.ts`. See [immutable handoff validation](immutable-handoff-validation.md) and `docs/personal-mvp.md`.
