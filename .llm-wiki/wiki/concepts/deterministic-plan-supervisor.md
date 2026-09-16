---
type: concept
created: 2026-09-16
updated: 2026-09-16
domain: engineering
confidence: high
sources: []
---

# Deterministic Plan supervisor

The personal runtime supports two executable prompt-policy selections: empty `plan` retains legacy single-process Plan; exactly `requirements, implementation-design` selects supervised Plan. Partial/reversed selections fail before process launch. The default remains empty; implementation and deterministic integration tests do not constitute live provider rollout acceptance.

The Run Controller starts and monitors one private deterministic supervisor subprocess, not its Pi children. The supervisor has no model session or authority to select models, publish, fetch tickets, or write run state. Its sandbox-side root guard owns the active non-root Pi process and its cancellation/exit observation. Children have only read/grep/find/ls, fresh separate sessions and attempt/subphase-specific input/home/temp paths. They receive no controller IPC endpoint or global state port. The guard control directory is root-only; validated artifact files are root-owned outside the child-writable ticket tree.

Both children use the one persisted Plan profile and exact repository HEAD. Requirements must finish and validate before Design starts. Independent clean/HEAD checks surround each child, including failed exits. No prompt/model recapture occurs between children; [immutable captured policy](immutable-layered-prompt-policy.md) supplies phase/subphase layers after the child-specific trusted contract, and child cores participate in the core digest.

## Delivery artifacts and aggregate

Requirements is a closed, bounded version-1 artifact with input HEAD, problem, acceptance criteria, non-goals, assumptions, dependencies, open questions, and `ready|needs_clarification`. Clarification requires questions, skips Design and blocks Implement visibly with a failed Plan aggregate.

Design consumes only validated Requirements content and its canonical SHA-256 digest. It supplies ordered steps, affected components, tests, risks, exact-head observations and a prospective wiki disposition: `planned` paths/summary or `not_required` reason. Prospective wiki work is not Implement's verified committed `updated` evidence; Implement still reconciles the cumulative run-base-to-HEAD wiki diff.

The aggregate preserves `details.steps` and adds versioned `details.supervision` containing supervisor identity/outcome/launch digest and ordered child identities, sessions, profiles, prompt digests, artifact paths/content/digests and outcomes. Failed children retain diagnostics with no fabricated successful artifact. Artifacts live at `/run/squire-plan-<id>/artifacts` with host staging copies under `<runId>/plan/<attempt>/<id>`. The top-level session slot identifies the deterministic lifecycle, not a model session; the successful compatibility session file contains its aggregate journal.

Only the controller persists acknowledged `planProgress` with `step: plan`. Status renders `Plan / Requirements`, `Plan / Implementation Design`, and clarification blockers. Stale attempt/identity events and late progress are rejected. Immutable `planExecution: supervised-v1` distinguishes new supervised state from readable historical flat Plan records. A new supervised run cannot bypass nested validation with a legacy result.

## Lifecycle and operational limits

Plan is one controller lifecycle, deadline and retry boundary. Validated partial artifacts are evidence, not independent resume checkpoints. There is no generic graph, recovery engine or model escalation.

Cancellation targets the supervisor. Its remote guard sends TERM, escalates to KILL after two seconds and writes a close marker only after observing child close. The supervisor separately requests cancellation and polls that root-owned marker for up to ten seconds: local `sbx` client exit alone is insufficient. Transport/HEAD checks have thirty-second bounds; the controller allows a ninety-second cleanup reserve before failing an unobserved supervisor exit. Missing exit proof fails closed and prevents Design/Implement, but does not claim universal sandbox quiescence after crashes or forced supervisor death. Operators must inspect failed workspace/process evidence before a new run.

Implementation: `src/personal/plan-supervisor*.ts`, `plan-artifacts.ts`, `phase-result.ts`, `controller.ts`, and `json-run-state.ts`. Contracts and operational usage: `docs/personal-mvp.md`. Deterministic acceptance matrix: `docs/plan-supervisor-test-matrix.md`. Tests cover fake command boundaries, real supervisor subprocess ownership, remote child interruption, foreground/detached captured-prompt parity, controller-exclusive progress persistence, artifact forgery and clarification blocking. These are not live rollout claims.
