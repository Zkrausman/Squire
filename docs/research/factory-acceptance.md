# Squire acceptance and evidence hardening design

Research snapshot: 6 October 2026. Status: proposed hardening. This source audit did not execute the proposed fixtures, model runs or benchmarks; ordinary repository CI for the documentation PR is separate. The implementation proposals below remain unstarted.

See the [research index](README.md) for evidence labels and the combined dependency order, and [recovery design](factory-recovery.md) for operation identity, retention and delivery receipts.

## Recommendation

Build on Squire's existing candidate identity and delivery gates. The next acceptance improvement should make each required criterion resolve to an actual, candidate-bound check or artifact, with explicit limits on what that evidence establishes. Keep the fixed-role workflow and subscription runtime. A second orchestration platform, larger specialist team, new database and hosted dashboard are unnecessary for this step.

The desired owner experience is a short result stating what changed, whether it was accepted, which revision was evaluated, and what remains blocked. Screenshots, executable checks and delivery receipts should be reachable from that result. An implementation summary, a green mock test, a preview URL or an interrupted run must never silently become product acceptance.

## Source baseline and existing foundations

This audit is pinned to [ec98a61](https://github.com/Zkrausman/Squire/commit/ec98a61bd6a0fec89246c0b160ca90d2ff363d68), which merged [PR 99](https://github.com/Zkrausman/Squire/pull/99). Its reliability heading described the whole area as unstarted, although substantial mechanisms already exist. The updated roadmap distinguishes source implementation, fixture coverage, real-runtime validation and accepted application outcomes.

### Existing implementation and source evidence

- **Exact candidate verification.** Controller verification records the candidate head, tree and check-policy digest. The Git-visible workspace must be clean and match the recorded HEAD/tree at the before/after checks. This does not establish hermetic dependencies, unchanged ignored files or uninterrupted immutability. Publication requires those same identities. Candidate normalization or base movement invalidates gates and requires checking/review again. [Controller verification and publication](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L374-L413), [workspace identity](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/workspace.mjs#L79-L89).
- **Fresh read-only review.** Codex review uses an ephemeral read-only session and structured output. The controller rejects reuse of that ticket's current or previously recorded implementation session IDs. For tickets with an execution contract, passing reviews must contain every required checklist ID and nonempty passing evidence text. Legacy tickets do not require that criterion coverage. All passing reviews must have no unresolved findings. This is session/tool separation, not global session-history isolation or proof that two model judgments are statistically independent. [Runtime boundary](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L61-L79), [review gate](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L382-L397), [review validation](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/contracts.mjs#L197-L220).
- **Exact delivery and postmerge checks.** GitHub checks are matched by name, application identity and head, including validated synthetic merge identities. Merge uses the expected head and validates delivered tree and ancestry. The current adapter also requires strict classic branch protection enforced for administrators and rejects merge queues; this audit did not exercise a live repository policy or delivery. Per-ticket postmerge checks run against the delivered commit. Once tickets ship, project acceptance runs configured service checks plus optional acceptance commands against each service's current remote head, then checks that those heads stayed unchanged. This is only as broad as the configured commands; it does not automatically establish GUI or product acceptance. [Delivery adapter](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/delivery.mjs#L90-L150), [postmerge](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L438-L449), [project acceptance](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L515-L533).
- **Meaningful fail-closed fixtures already exist.** Tests cover rejected review, same-session review, exhausted repair budgets, protected paths, candidate normalization, moving bases, postmerge failure, wrong-head/skipped/spoofed CI and merge ancestry. These are valuable behavioral tests of the controller and adapter. Their presence does not show that a live model produced an accepted application. Their source was inspected during this research; the new proposed negative fixtures remain unexecuted. [Controller fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/controller.test.mjs), [delivery fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/delivery.test.mjs).
- **Honest benchmark-report foundations.** Unique jobs, rework, timeouts, known tokens and unknown/pending usage are already represented. Conflicting usage becomes unknown. Calibration reports distinguish new behavior from preservation and explicitly remain unscored. Public task materialization separates allowlisted inputs from private grader/reference locations, without claiming an OS security boundary. [Reporting implementation](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/benchmark-report.mjs), [foundation limits](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/docs/workflows/benchmark-foundations.md).

### Actual remaining gaps

1. **Evidence text is not an evidence resolver.** `validateReview()` accepts a nonempty string such as “observed in the test.” It does not resolve a check ID, verify an artifact hash or establish that the cited observation exists. The prompt correctly forbids inferring GUI validation from mocks, but the schema cannot enforce that distinction.
2. **Criterion coverage is narrative.** Trusted commands run, but the controller cannot show which required criterion each command/observation proves. Candidate-authored tests and independently controlled acceptance tests are not typed separately. Configuring a command does not make every assertion it executes independent of the candidate.
3. **Visual/native proof has no first-class contract.** There is no generic screenshot/play-session receipt or requirement resolver in the inspected contracts. Windows runtime instructions explicitly leave real Electron/visual acceptance to a trusted host and report it pending inside isolated workers. That limitation is already recognized and should remain explicit. [Windows runtime instructions](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L81-L89).
4. **Retrospective proof is thinner than the gate logic.** Successful GitHub check selection is not returned as a complete durable check-run receipt. Archive that evidence through the [recovery/artifact workstream](factory-recovery.md#exact-delivery-receipt-chain), rather than reimplementing the existing live gate.
5. **Production origin and outcome are easy to conflate.** A direct engineering change can improve Squire without being produced by Squire. A Squire-created candidate can fail acceptance. Current calibration already avoids performance claims; extend that discipline to all result summaries.
6. **Observed reliability remains a separate claim.** A schema and synthetic fixture cannot establish unattended reliability on actual owner tasks. Preserve historical evidence and label the narrow boundary each later trial exercises.

## Proposed acceptance contract

Use a small, versioned receipt stored alongside existing project state and artifacts. Avoid a new service. The trusted controller records identity and provenance; the worker/reviewer may reference receipts but cannot declare that a receipt exists or change its status.

### Three linked records

**Candidate manifest**

- Project, ticket, logical attempt and candidate ID
- Source repository identity, base/head/tree SHAs and contract digest
- Controller/runtime versions and required environment profile
- Origin: `direct-engineering`, `squire-run`, `mixed`, or `unknown`
- Squire job/session references when present; separately recorded owner/coordinator interventions

Origin is factual provenance, never a quality score. Git author names are insufficient. If someone edits a Squire candidate outside its controlled run, retain the ancestry and intervention and mark the result mixed. Never relabel old evidence as Squire-produced retrospectively.

**Observation receipt**

- Immutable receipt ID and source: controller check, configured CI check, trusted host observation, or externally supplied observation
- Candidate head/tree, execution-contract digest and check/policy digest
- Actual environment identity and limitations, check-definition/oracle version and, when applicable, built-artifact hash
- Check name/command identity, attempt ID, start/end times, exit code and timeout/cancel/output-limit/launch flags
- Result: passed, failed, blocked, or not run
- Evidence kind: code assertion, integration behavior, browser interaction, native-platform observation, screenshot/recording, or human product judgment
- Artifact references with content hashes, producer authority, access classification and retention state (complete, partial, missing or corrupt)
- Whether the assertion/oracle is candidate-editable, independently controlled, or unknown

The initial implementation can add stable IDs around existing `VerificationRunner` results and the UUID-named subprocess request/output/receipt files. Those already retain command identity, timing, exit and stop/timeout/output-limit/launch facts. Normalize and bind them rather than build another subprocess receipt system. Verification stops at the first failed check, so record its later checks as not run rather than missing/corrupt. [Process receipts](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/process.mjs#L55-L109), [verification short circuit](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/verification.mjs#L7-L18). It need not introduce a separate assertion framework. A configured command receipt proves that a command ran and how it ended. Criterion mapping still needs a reviewed, independently controlled check definition or an explicit trusted observation.

**Acceptance decision**

- Candidate manifest ID and reviewer job/session identity
- For each criterion: required evidence kinds, referenced observation IDs, result and concise explanation
- Separate functional correctness, preservation, delivery and experiential/creative judgments
- Decision: accepted, rejected, blocked, or incomplete
- Missing evidence list, unresolved findings and the smallest next step

A version-2 contract can introduce these fields without mutating frozen version-1 task inputs. Old runs retain their original narrative-only evidence label. Do not automatically upgrade historical acceptance by parsing prose.

### Rules enforced by the resolver

- Resolve references from controller-owned state, not arbitrary worker paths or URLs. Verify retained bytes against the manifest. A hash identifies content; it does not prove the observation was honest, so producer identity also matters.
- Every required criterion needs an admissible observation for the current candidate and environment profile. Unknown IDs, missing files, altered content, old candidates and mismatched check policy produce incomplete/blocked acceptance.
- A fresh review may explain why evidence is relevant. It cannot turn absent, failed or not-run observations into passing evidence.
- A code/mock assertion cannot satisfy a criterion requiring real browser rendering or native-platform behavior. A screenshot can establish visible state; it cannot alone prove persistence, concurrency, security or interaction behavior.
- Any candidate change invalidates evidence unless an explicit, reviewed rule establishes equivalence. Continue using the existing exact-head recheck path by default. Squash delivery may have a different commit SHA while preserving the already verified tree and required ancestry; retain both identities.
- A repair changes the candidate and consumes existing budgets. A missing browser/native capability is an environment blocker; do not spend application repair attempts repeatedly trying to cure it in code.
- Artifact visibility remains scoped. Retain private raw evidence privately, publish only an approved sanitized derivative, and record that it is a derivative. Raw logs must not leak credentials or private evaluation material.
- Completion requires the configured checks, resolved criterion evidence, fresh review, permitted delivery and postmerge/integrated acceptance. The report lists the unproven layers even when earlier layers passed.

## Behavioral validation that earns its cost

Prefer a few targeted tests protecting concrete failure modes. Keep existing controller fixtures, because they exercise real state transitions and local Git behavior. Adapter mocks are appropriate for exact wrong-head/app/merge cases, but a mocked GitHub response cannot establish real server policy or live delivery.

For each task, nominate the smallest regression that would fail on the incorrect behavior and pass on the fix. Also nominate the preservation check for behavior that must remain unchanged. Where a new test can fail on the base revision for an unrelated environment problem, record and resolve that problem instead of counting it as a successful reproduction.

Use four practical profiles:

1. **Offline code or CLI.** Actual subprocess behavior, deterministic inputs, exact outputs/status, and a focused regression plus relevant existing suite. Assert stream/exit semantics at the shipped CLI boundary when they matter.
2. **Local service or storage.** Real built process and disposable storage, request/response and restart behavior, relevant concurrency/error cases, and process cleanup. In-memory mocks can supplement the suite but cannot prove durable restart behavior.
3. **Browser interface.** Real browser on the built candidate with synthetic data, user-relevant interaction assertions, screenshot evidence and console/page-error capture. Cover the changed flow and its important interruption, repeat-click or stale-state path.
4. **Native-host feature.** Run the required supported OS/runtime behavior, with candidate-bound receipts. Cross-platform mocks are development evidence only. Keep unavailable host validation explicitly pending.

The profile is a minimum evidence requirement chosen at admission, not an excuse to run every kind of test for every patch. Documentation-only work can use source/link review without inventing a test quota. Security and data-integrity tasks may need additional independent negative cases; the task's actual risk determines them.

Open SWE offers a useful design precedent: separate review capabilities and small behavioral regressions, rather than mock-call or implementation-shape tests. Squire already has the separate review session, so borrow the testing discipline rather than its orchestration stack. [Pinned reviewer setup](https://github.com/langchain-ai/open-swe/blob/ff585cabe838636e5b608d621be250864763f705/agent/reviewer.py#L1-L15), [pinned testing guidance](https://github.com/langchain-ai/open-swe/blob/ff585cabe838636e5b608d621be250864763f705/AGENTS.md#L49-L60).

Passing a fixed test set should remain a bounded claim. An empirical SWE-bench study found benchmark-passing patches that failed additional developer tests or diverged behaviorally. Divergence alone does not always establish incorrectness; the lesson here is to check preservation and acceptance scope, not to transfer that study's percentages to Squire. [Wang, Pradel and Liu, version 2](https://arxiv.org/abs/2503.15223v2).

## Visual and playable evidence

For a GUI task, retain a browser/native session receipt that names the candidate tree, build hash, environment, browser/version, viewport, synthetic fixture version, scenario and observed state. Keep screenshots and any recording as hashed artifacts outside candidate-controlled source. Capture actual pixels from the running candidate; generated mockups and DOM-only simulations have a different evidence label.

For a game or interactive app, a reviewable bundle should contain:

- A runnable build or scoped preview and the exact build/candidate identity
- A short interaction trace or recording for the core loop and an important recovery/restart path
- A screenshot of the key visible state
- Functional assertions and separately labeled usability/creative judgment
- Known limitations and any unplayed/unverified requirement

A preview URL is convenience, not acceptance. Prefer a local loopback preview initially, with startup/stop commands and artifact export already supported by the runner. If later remote preview access is required, add explicit authentication, expiry and teardown checks. Do not build preview hosting just to satisfy the first receipt slice. If the viewer cannot reach the preview, downloadable evidence can still support review, while interactive review stays pending.

The observer should be isolated from implementation context where practical and receive the public contract plus candidate evidence, not the implementer's claimed verdict. Synthetic controls are suitable for checking the proof pipeline without consuming provider quota. Later real product trials are needed to establish usability and model effectiveness.

## Fixed workflow baseline and Pith comparison

This is a future experiment design, not permission to run it now. The [v0.1 closure record](../releases/0.1/baseline-closure.json) preserves the original baseline as closed-incomplete, separately records manual harness completion as unscored, and retains the owner hold on benchmark/comparative execution. Do not reopen or rewrite those attempts. Preserve the roadmap prerequisite: complete and independently grade a separately authorized larger-benchmark baseline before specialist or routing comparisons. Pith effectiveness comparisons also wait for an approved fixed-workflow baseline and output-fidelity prerequisite.

Pith should be a single-variable output-transform experiment. Pin Squire, Pith, task seed/base, public contract, model and reasoning settings, runtime versions, tools, environment and aggregate budgets. Use the same command helper in both arms; only `pith pi transform`'s `rawBypass` setting differs. Hold mandatory redaction, parser configuration and telemetry settings fixed. Raw bypass still redacts, so an unredacted raw-output control would change more than compression. [Request/response contract](https://github.com/Zkrausman/pith/blob/6939184b197085c2e3d2dd484e169123fb7a70c6/pkg/pi/hook.go#L15-L47), [raw bypass](https://github.com/Zkrausman/pith/blob/6939184b197085c2e3d2dd484e169123fb7a70c6/pkg/pi/hook.go#L103-L117). Capture the original command status independently because the transform response does not return it. Keep eligible raw output under the same access/retention policy; the transform does not retain it by default or recover output lost upstream. Pith's transform success is not the executed command's success. Its README describes output provenance and a characters-per-token heuristic; those are not measured provider-token or monetary savings. [Pinned Pith provenance and analytics](https://github.com/Zkrausman/pith/blob/6939184b197085c2e3d2dd484e169123fb7a70c6/README.md).

Before an effectiveness comparison, require the separate Pith output-fidelity workstream to show the chosen transform preserves failure status, warnings, final test summaries, diffs, machine-readable output and raw-output recovery semantics. Passing that prerequisite establishes safe integration behavior, not improved coding results. Direct CLI wrapping and a completed-result transform have different semantics and must be separate experiments. Do not claim automatic Codex hook integration from an explicit helper path.

### Measurement plan

- Freeze a small, representative development case set for pipeline calibration; label it unscored. Select and freeze separate validation and final holdout sets before optimization. Keep private graders, reference answers and previous solutions outside agent inputs and exported artifacts.
- Use paired cases and the same planned repetition count in both arms, with arm order balanced or randomized. A small pilot establishes feasibility only. Choose the final sample size after measuring variance and the affordable aggregate budget; do not call a few wins statistically established savings.
- Apply equal aggregate call/time limits across planning, implementation, review, retries, helper overhead and repairs. Treat maximum parallelism and allowed owner interventions as part of the fixed workflow. Equal ceilings do not imply equal actual resource use; record both.
- Grade without exposing the arm label or model identity to the reviewer where feasible. Freeze acceptance rules before trials. Separate product rejection from environment blocks, interruption and invalid evaluation; preserve every assigned attempt in the accounting.
- Record independently accepted outcomes, preservation failures, security/authority violations, reviewer findings, calls by role, retries/handoffs, timeouts, total elapsed time, active owner recovery time and interventions, plus known input/cached/output tokens and missing-usage counts.
- Measure compressed tool bytes/lines separately from full provider token usage. Extra raw retrievals and compression/helper calls count. Under subscription execution, report quota/capacity effects only when measured; do not fabricate dollars saved from an assumed API price.
- Interrupted arms remain interrupted/inconclusive. Never turn their partial output reduction into an accepted-task efficiency result. If usage completeness differs, publish the limitation rather than ranking total savings from incomplete totals.

### Promotion gate

The hard gate is no weakened authority, lost failure evidence, false acceptance or private-material exposure. Then compare independently accepted delivery quality and total effort. Keep a change only for a credible quality improvement, or a predeclared quality-equivalent result with lower total resource/owner burden. “No detected quality difference” in an underpowered sample is not equivalence. If the evidence is inconclusive, keep the fixed baseline and report that conclusion.

METR's controlled study and its later measurement update support including real owner time and selection effects in the design. They do not establish a current speedup or slowdown for Squire or Pith. [2025 study, version 2](https://arxiv.org/abs/2507.09089v2), [2026 measurement limitations](https://metr.org/blog/2026-02-24-uplift-update/).

## Small implementation slices after research

The following is an ordered backlog, not a commitment to implement it during the quota-constrained three-day research window.

### A1 Correct status and define result provenance

Scope: docs and a small result-envelope proposal. Classify existing facilities, record origin separately from acceptance, and define evidence levels without rewriting historical outcomes.

Dependencies: none beyond this source audit.

Acceptance: every roadmap item says whether it exists, what source/fixture supports it, and what remains unvalidated. Example summaries distinguish direct engineering, mixed work, Squire candidate, accepted delivery, environment block and unscored calibration. No performance or savings claim appears without the required measurement.

### A2 Add immutable check and artifact references

Scope: additive receipt IDs/digests around existing verification results and retained artifacts; share the manifest format with recovery work. Preserve check identity and final process flags. Add a read-only resolver.

Dependencies: [R3's per-job artifact identity/retention contract](factory-recovery.md#dependency-sequence-and-small-implementation-slices); no new hosted storage is required.

Acceptance: current-candidate records resolve; missing/altered artifacts, wrong candidates, failed/not-run checks and mismatched policy cannot satisfy acceptance. Tests exercise these observable outcomes through the resolver, not only JSON shape. Existing delivery behavior remains unchanged until A3 explicitly enables the stronger contract.

### A3 Enforce criterion proof in fresh review

Scope: opt-in version-2 execution/review schema and controller gate. The trusted contract maps criteria to required evidence kinds; reviewer output references records. Preserve version-1 compatibility and frozen evidence as narrative-only.

Dependencies: A2 and an admission path that freezes evidence requirements before implementation.

Acceptance: a reviewer returning convincing prose with nonexistent evidence is blocked; a wrong-head or incompatible-kind receipt is rejected; every required criterion resolves; repair invalidates old proofs; same implementation session still fails review. A narrative version-1 report never gains a version-2 verification label automatically.

### A4 Add one real browser evidence producer

Scope: one existing supported local runner and one synthetic browser fixture. Export a screenshot and interaction result with candidate/build identity. Classify unavailable GUI capability separately. Defer hosting and native-OS expansion.

Dependencies: A2, A3 and [R6's execution-boundary capability/preflight work](factory-recovery.md#execution-boundary-preflight).

Acceptance: a real rendered fixture and its changed interaction are recorded; stale screenshot/build and DOM-only replacement cannot satisfy the browser criterion; failed interaction prevents acceptance; all processes stop and access ends as declared. A native-specific task remains pending until its required native producer exists.

### A5 Add a comparison report and freeze the experiment

Scope: report schema and operator checklist reusing `summarizeTrace`; no provider run. Add explicit unknown/inconclusive states, owner effort, provenance and paired assignment records.

Dependencies: A1-A3, output-fidelity prerequisite for Pith, and a separately authorized, completed and independently graded baseline before the actual comparison.

Acceptance: synthetic reports include all assigned attempts and overhead, never score calibration, never infer unknown usage as zero, never label interrupted arms as accepted, and never equate output compression with dollar savings. The final experiment configuration and stopping/promotion rules are recorded before execution.

## Research work to finish before implementation

1. **Status and scope:** source-backed status correction, evidence vocabulary and dependency order are documented here. Preserve the public baseline closure and its hold without exporting private graders.
2. **Contract detail:** turn the receipt/resolver proposal and negative cases into a reviewed schema, criterion-to-proof examples and a browser/native capability matrix. Choose one small initial profile without publishing private repository details.
3. **Readiness for implementation:** independently critique the contracts, resolve their open choices and freeze any later comparison protocol with explicit blockers. End with implementable slices and unresolved decisions, not an invented completion or efficiency result.

The priority remains one owner receiving truthful results with little recovery work. Add the least machinery that makes the next decision auditable, then measure it before expanding.
