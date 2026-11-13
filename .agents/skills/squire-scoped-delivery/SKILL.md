---
name: squire-scoped-delivery
description: Prepare a scoped Squire project delivery and classify its observed outcome from source and run evidence. Use for native project entrypoint preparation, scope-directory failures, or separating generation, candidate, and harness outcomes; not for target implementation or general benchmark research.
---

# Squire scoped delivery

Use the current checkout's entrypoint and evidence to prepare or explain the requested delivery. Preserve existing authorization, holds, active operations, and adopted results. This skill grants no execution permission and adds no blanket approval gate. Preparation does not itself authorize generation, retries, candidate execution, or configuration changes.

## Prepare the selected route

Identify the exact wrapper/function the request uses and inspect its current call path before touching a scope. Read applicable repository instructions and distinguish native wrappers from inner runners and injected fixtures. Record source identity and the selected configuration/profile privately when needed to make the result reproducible.

For `runProjectOneCaseNative` in [acceptance/project-entrypoint.mjs](../../../acceptance/project-entrypoint.mjs), the wrapper calls nonrecursive `mkdir(c.scope, {mode: 0o700})` **before** `runProjectCodexTask`. Its scope leaf must be absent when that wrapper starts. Verify this read-only; do not pre-create that leaf. Its parent and protected Git context must already satisfy the current source checks. The inner runner validates an existing scope and searches scope/ancestors for a protected Git marker before spawning; those contracts explain why an inner-runner fixture can legitimately create a scope first.

Read [src/project-runner.mjs](../../../src/project-runner.mjs) (`runProjectTask`) and [src/internal/multifile-core.mjs](../../../src/internal/multifile-core.mjs) (`validateProjectScopeAncestry`, `requireProjectGitContext`) for the actual ancestry, ownership, mode, and Git-marker checks. Do not generalize the native absent-leaf requirement to every Squire API. For desktop/readiness routes, inspect their own wrapper and [docs/desktop-readiness-artifact-checks.md](../../../docs/desktop-readiness-artifact-checks.md).

For a route requiring an absent leaf, if that scope already exists, report the mismatch and preserve its contents. Do not delete it, move it, or silently substitute a new scope/job. A changed scope can change bound configuration/admission; prepare a correction only within the user's authorized scope and existing nonreuse/hold restrictions. Do not test readiness by launching generation.

## Classify what the evidence establishes

Report the observed status separately from its explanation. Bind evidence to the same operation and source/profile; do not mix a later rerun's receipts into an earlier attempt.

- **Pre-generation failure:** evidence establishes a failure before the generation invocation. A confirmed native scope-creation failure precedes the inner runner and provider spawn. An existing scope plus source ordering explains a possible failure; a generic exit-2 error alone does not establish the actual first failing syscall or errno.
- **Generation or generated-artifact failure:** identify whether generation was invoked, whether output bytes were captured, and which validation failed. Distinguish provider/lifecycle failure, envelope rejection, staging failure, and a candidate failing a verified applicable behavioral check. `CANDIDATE_STAGED` means staging succeeded; the runner still reports task correctness as unevaluated and runtime as unadmitted.
- **Harness/profile failure:** identify the faulty check or profile separately from the candidate. A corrected harness result on unchanged candidate bytes is new harness evidence, not a model improvement. Preserve the original grade/adoption and report any separately reviewed correction with its exact case scope.
- **Unknown:** retain uncertainty when receipts, dispatch history, or binding evidence are insufficient. Missing files or idle metadata do not prove an old dispatch never ran. An invocation counter describes the source-defined invocation boundary; it is not by itself proof of a completed provider request or generated output.

Give the narrow finding, supporting source/evidence, unresolved uncertainty, and authorized next step. Share sanitized conclusions and public source references; keep private paths, raw receipts, operation/account identifiers, and credentials out of reusable skill content and publication.
