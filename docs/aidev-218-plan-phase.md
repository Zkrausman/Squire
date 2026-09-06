# AIDEV-218 Plan phase

The Plan phase is a generic, independently configurable top-level Pi session. `PlanSessionService` derives the current attempt, exact registered `plan` session, phase-input reference, normalized ticket, workflow configuration, and AIDEV-222 workspace observation from trusted controller ports. It does not accept task text, session IDs, heads, branches, or output paths from the model or caller.

## Protocol and authority

The controller exact-reads and validates the phase input, then its single normalized-ticket and workflow-config references. It rejects stale heads, duplicate references, mismatched repository/branch/base identities, non-latest attempts, and a Plan registration that is not exact. The configured Plan profile is normalized using the published v1 compatibility defaults and is compared with the runner profile.

Plan uses the existing `PiRunner`, `AttemptCoordinator`, `WorkflowStore`, `V1ArtifactValidator`, and `PhaseResultAcceptanceService`; it adds no store, transition graph, process lease, Git observer, or runtime resolver. A successful result is accepted only after transitive digest/schema/semantic validation and a clean AIDEV-222 readiness fence. Plan never advances `currentHead`, `implementGeneration`, gates, or remediation counters. The registered Orchestrator remains the transition authority.

## Read-only session surface

The controller-owned Plan policy is appended after repository-configured instructions. The Plan command is run with Pi's fixed tool allowlist: `read`, `grep`, `find`, `ls`, project-only `wiki_recall` when available, and `squire_submit_plan`. `bash`, `edit`, `write`, package/install tools, wiki mutation tools, and arbitrary repository extensions are not enabled. Wiki and footer extensions are loaded in that order around the digest-bound Plan extension; the footer remains last. Run-scoped `HOME` and `WIKI_HOME` are always used.

This is a strict Pi tool boundary, not an OS sandbox. AIDEV-223 is not merged at this base and no OS/microVM/principal guarantee is claimed here. A production composition must supply that stronger boundary before treating a compromised runtime as contained.

## Immutable output

`squire_submit_plan` accepts a closed, bounded implementation-plan-shaped object plus `disposition: "pass" | "blocked"`. Identity fields must equal controller-bound values; paths are repository-relative; step and validation IDs are unique and ordered; required configured validation commands are included; and each step has actionable acceptance criteria. The tool terminates the session and writes only fixed attempt-scoped destinations:

- `artifacts/plan/<attempt>/plan.json`
- `evidence/plan/<attempt>/verification.md`
- `artifacts/plan/<attempt>/result.json` (written last)

The plan and report are canonical, create-only, fsynced, private files. Exact identical retries converge; substitutions, symlinks, hardlinks, non-regular files, or differing bytes fail closed. A pass has no findings/failures, preserves `inputHead === outputHead`, references both domain and report artifacts, and requests `implementing/phase_pass`. A blocked disposition uses the closed v1 `failed` result status, a blocking `PLAN_CONTEXT_BLOCKED` policy failure, bounded actionable questions in report evidence, unchanged HEAD, and `failed/phase_failed`; it is never coerced into a pass or remediation result.

Result discovery examines only the deterministic result path. It does not accept a model path or validate in parallel: all bytes, schema, transitive references, trusted semantics, Git observations, and duplicate acceptance remain in the existing acceptance service.

## Ownership boundaries

AIDEV-223 owns the future OS/microVM/principal/filesystem boundary. AIDEV-224 owns durable SQLite intake, startup reconciliation, and production persistence. AIDEV-217 owns Herdr tabs. These concerns are intentionally not reimplemented by AIDEV-218. The published v1 contracts and the known normalized-ticket/AIDEV-222 branch spelling disagreement are preserved; exact identity comparison fails closed rather than guessing or rewriting either authority.
