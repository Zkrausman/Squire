# Squire delivery benchmark portfolio and readiness

Research snapshot: 6 October 2026. Proposed case-selection and validity design, audited against public Squire main at [2a28eca3db42d0bd0db2fb4df8c0afeea036b2de](https://github.com/Zkrausman/Squire/commit/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de). No proposed fixtures, applications, provider experiments, model trials, capability probes or benchmarks were executed for this research; ordinary hosted controller CI for this documentation change is separate. No private grading material or private application source was inspected. The examples below are generic proposals, not implemented cases or an authorized campaign.

## Recommendation

Prepare four small development cases covering a Go CLI bug, a Node cross-file feature, a Go failing-test repair and a Node configuration migration. Add one desktop interaction case only when its actual platform and observation route can be supported. First make two cases reproducible with zero-model controls; expand only after their evidence is trustworthy.

Keep these openly discussed cases in development. A later evaluation needs independently selected, frozen case lineages that were not used to build the workflow. A handful of reliable cases can expose delivery failures and qualify a route. It cannot establish broad coding superiority, savings, or the separately required larger-benchmark baseline.

This memo owns case choice, corpus validity and readiness. Reuse the existing [acceptance contract and A5 comparison protocol](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/research/factory-acceptance.md), [recovery and delivery receipts](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/research/factory-recovery.md), and [execution-boundary preflight](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/research/factory-runtime-preflight.md). Do not introduce another runner, receipt store, scoring service, optimizer or leaderboard.

## Historical status and authority

The [v0.1 closure record](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/releases/0.1/baseline-closure.json) is authoritative for the historical program:

- The original combined baseline is closed-incomplete. Three original major runs produced no independently accepted products. Their failures and counters remain historical evidence.
- Microbenchmark construction was incomplete and unscored, with no independent scored trials. It is neither eight scored failures nor successful suite delivery.
- Later manual harness completion was complete-and-calibrated-unscored. It does not become Squire-produced baseline delivery or a model-effectiveness result.
- The owner hold on benchmark and comparative execution remains in effect. This design does not reopen any run or grant new call allowances.

The [archival release README](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/releases/0.1/README.md) contains earlier in-progress text; preserve that snapshot and use the later closure record when stating current historical status. The [frozen public benchmark briefs](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/benchmarks/README.md) also remain unchanged. New cases get new identities; they do not replace an old denominator or repair an old result.

Any future baseline needs separate execution authorization. Specialist, routing and skill optimization retain the [roadmap's completed and independently graded larger-benchmark prerequisite](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/roadmap/README.md). Pith additionally retains A5's output-fidelity and fixed-workflow prerequisites. Calendar time, restored quota, green documentation CI and fixture readiness cannot lift these gates.

## Why validity comes before more cases

Primary sources support a narrow, behavior-first design:

1. **Real patches need repository context.** The original SWE-bench work evaluates changes to existing repositories, including coordination across files. Borrow the repository-level task shape rather than its public instances as supposedly unseen evidence. [Jimenez et al., SWE-bench](https://arxiv.org/abs/2310.06770v3).
2. **Tests and task text can disagree.** OpenAI's 2024 validation identified underspecified issues, tests rejecting reasonable implementations, and environments failing independently of a patch. Its February 2026 follow-up found residual test problems and evidence of exposure to public solutions. The later audit concentrated on difficult residual cases, so its percentages should not be generalized to all tasks or to Squire. Public availability is not evidence of uncontaminated evaluation. [2024 validation](https://openai.com/index/introducing-swe-bench-verified/), [2026 follow-up](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/).
3. **A test-passing patch can still be incomplete.** Wang, Pradel and Liu tested and inspected nominally solved patches, finding developer-test failures and behavioral discrepancies. A difference from a reference patch is not automatically a defect. Use public-contract behavior and preservation to adjudicate alternatives rather than requiring an identical implementation. [Study, version 2](https://arxiv.org/abs/2503.15223v2).
4. **Language and task mix matter.** SWE-bench Multilingual includes Go and JavaScript/TypeScript, checks base-versus-reference behavior and manually reviews task eligibility. Its authors also note that issue mining selects relatively small fixes. That supports including a bounded feature and migration alongside bug repairs; it does not justify importing its scores into an owner's workflow. [SWE-bench Multilingual construction and limitations](https://www.swebench.com/multilingual.html).
5. **Patch grading is an executable process with failure modes.** SWE-bench's harness applies a patch and runs repository tests, retaining the patch, test output and evaluation logs. Its guide distinguishes resolved, unresolved, missing-result and infrastructure-related outcomes, and warns about cached results. For Squire, a tested patch is still only one stage before review, permitted delivery and post-delivery acceptance. [Official evaluation guide](https://www.swebench.com/SWE-bench/guides/evaluation/).

The following selection and control requirements are design recommendations derived from those problems and Squire's existing contracts. They are not externally validated performance thresholds.

## What the portfolio should represent

The target is routine, bounded maintenance for one owner's Go, Node and desktop projects. Use an existing small repository with enough surrounding behavior to make regressions possible. Prefer tasks with one clear owner outcome and a reviewable dependency surface. Do not manufacture difficulty by increasing file count, withholding required facts or introducing random build failures.

Select before observing Squire outcomes. Record language/runtime, work type, affected interfaces, persistence or concurrency risk, required execution profile, expected review burden, and case lineage. Use an independent engineering estimate of scope; neither patch line count nor a model's confidence is a difficulty grade.

The initial four-case core is a coverage checklist, not a representative statistical sample of all work. It deliberately omits large greenfield applications, distributed operations, extensive architecture changes, security-critical production changes and subjective creative quality. The optional desktop case does not establish support for every OS. If the real task mix later requires a missing category, add it prospectively with a new corpus version rather than moving the goalposts after results.

## Proposed exposed development cases

All five descriptions are now exposed development material. No repository, implementation, hidden assertion, reference patch or runnable package is supplied here. Each needs a frozen public task statement and independently checked fixtures before use. The examples specify observable outcomes, not secret expected helper names.

### D1 Go CLI bugfix with truthful failure status

**Example:** A small record-export CLI reports success after encountering malformed input. Fix error propagation so a malformed record produces a nonzero exit and a useful diagnostic; preserve the documented output and successful exit for valid input. The contract must state whether partial output is allowed instead of leaving the grader to invent that rule.

**Tests:** Following errors through parser, command and process boundaries; minimal repair; maintaining stream and exit semantics. This is useful for small owner-used tools without requiring a network service.

**Required observations:** Run the built executable with valid, empty and malformed synthetic input. Inspect exit status, stdout and stderr separately. Include the relevant existing parser/CLI regression suite. No exact diagnostic wording is required unless publicly specified.

**Minimum controls:** Base fails the malformed-input criterion; a reviewed reference passes it and valid-input preservation; an always-success mutant and an always-error mutant are rejected for different reasons. Confirm the failing base result is the intended wrong status, not a compiler or launch error.

### D2 Node cross-file feature with durable behavior

**Example:** Add a named saved query to a local log utility: save a query, restart the utility, and apply it by name. Freeze public rules for duplicate names, unknown names, invalid query syntax and storage location. Reuse the application's existing parser and storage conventions.

**Tests:** Tracing a feature across the command/API boundary, service logic and persistence; ownership planning; adding behavior without damaging an existing stateless path. Aim for a few connected modules, not a new application.

**Required observations:** Save in one real process and apply in a fresh process against disposable storage. Check equivalent results to the existing direct-query operation and preservation of pre-existing saved data. In-memory stubs alone cannot establish restart behavior.

**Minimum controls:** Base lacks the declared feature; a reference passes restart and preservation; a memory-only implementation fails restart; a save implementation that drops unrelated entries fails preservation. Fixture-created records must remain distinguishable from pre-existing synthetic records.

### D3 Go failing-test repair without weakening the contract

**Example:** An existing deterministic cache-expiration test fails at a documented boundary. The public API says an entry expires when the supplied time reaches its expiration instant; the implementation retains it at equality. Restore the contract and keep ordinary reads, updates and non-expired values working.

**Tests:** Reading a failure, checking the specification, finding the responsible implementation and making a narrow repair. This is separate from asking the agent to invent its own reproduction for D1.

**Required observations:** Reproduce the supplied test on the base with a controlled clock, then run independent boundary and preservation checks. Include the package's relevant suite. Test protection and independently controlled checks prevent success through deleting the test, relaxing the assertion or skipping the suite.

**Minimum controls:** The base fails for the intended boundary mismatch; the reference passes; disabling expiration and expiring everything both fail. A fixture relying on real sleeps, machine load or arbitrary timing is not ready. If the public specification is genuinely ambiguous, repair the case before evaluation rather than expecting the candidate to guess.

### D4 Node configuration migration with data preservation

**Example:** Support a documented v1 local configuration alongside a v2 named-profile format. Migrate v1 to the default profile while preserving its effective settings; rereading or repeating migration must not corrupt or duplicate data. Freeze rules for unknown schema versions, malformed input, defaults and failed writes.

**Tests:** Backward compatibility, schema interpretation, filesystem behavior, idempotence and safe failure. This represents a common maintenance change with more consequence than a string-formatting fix.

**Required observations:** Read old and new fixtures through the real application boundary, migrate disposable files, restart and re-read, and repeat migration. Verify malformed or unsupported configurations remain intact under the declared policy. Exercise failed writes using a deterministic supported fixture rather than assuming platform permission bits behave identically everywhere.

**Minimum controls:** Base fails the v2 requirement; a reference satisfies new behavior and preservation; repeated-migration duplication and lost-setting mutants are rejected. Lock application runtime and dependency versions independently of Squire's own Node requirement. If cross-platform path behavior is required, name each platform explicitly before admission.

### D5 Optional desktop UI behavior under stale asynchronous work

**Example:** A file-viewer window can show stale content when a user selects a second file before the first finishes loading. The visible selection and rendered content must agree after either completion order, and cancel/close/reopen must not resurrect an obsolete request. Use synthetic local files and controlled completion ordering.

**Tests:** An actual user-visible state transition across UI and background work; repeated/interrupted flows; correct cleanup. It provides desktop coverage that unit tests cannot supply.

**Required observations:** Interact with the built candidate on the declared desktop runtime. Retain the actual rendered state, interaction assertions and relevant errors; verify cleanup. A browser-only rendering test can support a separately scoped web case, but cannot silently substitute for an admitted Electron or native-host requirement.

**Minimum controls:** The defective base deterministically exhibits the stale state; a reference passes both completion orders and reopen behavior; an implementation that ignores every completion fails the ordinary loading path. Screenshot-only or DOM-only success is insufficient. A missing sandboxed launch/IPC/cleanup route blocks this case; do not disable sandboxing or downgrade the criterion to keep the portfolio full.

## Development cases and untouched evaluation

Maintain a small case registry using the [existing public/private descriptor foundation](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/workflows/benchmark-foundations.md). Add only provenance and split information needed to answer how a case may be used:

- Opaque case/version ID, broad work category, public input digest, base identity and source/license provenance.
- Underlying defect/task-family group, seed ancestry and near-duplicate lineage.
- Development, selection-validation or final-evaluation designation; independent custodian and freeze date.
- Exposure history: who or which workflow saw the task, reference, candidate solutions or detailed feedback, and for what purpose.
- Frozen public requirements and execution-profile references; private evaluator identity remains in its authorized manifest.

Broad categories such as bugfix and migration describe coverage. They do not excuse sharing a defect family across splits. All variants of one underlying defect, source task or reference lineage stay together, including renamed identifiers, translated languages and changed literal values. Follow the [skill design's family-level separation](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/research/factory-skill-improvement.md); use independently sourced families to cover similar broad categories.

**Development:** D1-D5 and any cases whose solutions are used for debugging, instructions or examples. Unlimited manual inspection is compatible with that designation, subject to permissions. Results remain calibration evidence. Public benchmark instances or historical Squire tasks can be useful development references, but their known provenance must stay visible.

**Selection validation:** Only needed when choosing among competing changes. Freeze it separately and recognize that repeated scores influence selection even without detailed feedback. It is not an untouched final test.

**Final evaluation:** The independent custodian selects and validates new families without exposing solutions or evaluator internals to builders, proposers or implementation/review workers. Freeze the chosen workflow before providing case public inputs to its authorized execution workers. Once final results guide a repair, instruction change or new candidate selection, those cases become exposed for that purpose. Retire them from future untouched-holdout claims; do not seek another finalist on the same holdout.

This memo does not select or inspect final holdout cases. A public source plus a private grader is not proof of no training contamination. Record known exposure and residual uncertainty. Remove future-solution artifacts, answer-bearing Git history, prior run traces and cross-arm caches from worker-visible task materialization under the declared policy. Do not promise global isolation or ignorance of public code.

## Minimum zero-model readiness

Zero-model means no model/provider invocation. It still involves code execution, filesystem/process activity and sometimes downloads, so fixture execution needs separate authorization. Nothing in this checklist was run during this research.

Before a case is admitted to any later model campaign, require a retained readiness packet:

1. **Task validity review.** A reviewer can identify the intended behavior from public inputs alone. Every required assertion maps to a public criterion or documented preservation rule. No hidden helper name, unspecified error wording, unrelated PR behavior or reference implementation shape is required.
2. **Reconstructible input.** Pin base commit/tree, public seed digest, dependencies, toolchain and necessary setup. The selected route has a real delivery base and correct workspace mapping. Offline execution is preferred where feasible; any necessary download is pinned and predeclared.
3. **Base and reference controls.** The unmodified base fails the targeted new behavior for the expected reason. Preservation checks pass on the base except for explicitly declared existing failures. A trusted reference passes all required new-behavior and preservation checks on the same profile. Do not confuse an expected test failure with harness startup failure.
4. **Defective controls.** At least one targeted new-behavior defect and one relevant preservation defect are rejected. A no-op patch cannot pass the target criterion. For a new feature, merely detecting a new symbol is insufficient; behavior must be exercised. The reference is a validity control, not the unique allowed answer.
5. **Stable reset.** Repeat the control sequence after a fresh reset and reverse control order to reveal state leakage. Pin locale, timezone, randomness and clock fixtures where relevant. A small repeated check catches obvious instability but does not prove absence of flakes; unresolved flakiness blocks admission.
6. **Exact boundary readiness.** The required P-series receipts cover the actual roles, policy, toolchain, workspace, lifecycle and artifact route. A host-side success does not certify a worker boundary. Native/UI cases additionally need the actual observer route. Missing, denied, unknown or stale required capability stays blocked.
7. **Evidence and grading integrity.** The grader reads trusted definitions and the exact candidate, records all scheduled checks including not-run stages, and exports only allowed summaries. Candidate-authored tests are supplementary. A2/A3 own admissibility and R3 owns retention; this memo adds no duplicate schema.
8. **Privacy and cleanup.** Use synthetic records, disposable stores and explicit roots. No private application contents or sealed answers enter prompts, repair diagnostics, source artifacts or reports. Apply the [trust/disclosure design](https://github.com/Zkrausman/Squire/blob/2a28eca3db42d0bd0db2fb4df8c0afeea036b2de/docs/research/factory-trust-boundaries.md). Current same-user host execution is not hostile-code or private-grader isolation; input materialization alone does not establish that boundary.

A readiness packet can say this case is valid on one profile. It cannot say Squire solves it, the reference was Squire-generated, or that delivery has been observed. Revalidate when the case, oracle, dependency/runtime, policy, executor generation or required observation route changes.

## Paired comparisons without changing the question

Use A5 for scheduling, budgets, accounting and promotion. Case selection adds the following fairness constraints:

- Freeze one research question and change one declared factor. Use the same case version/base, public input, available tools, acceptance, delivery target class and aggregate limits in both arms. If a whole workflow is the treatment, describe that bundle rather than attributing its outcome to one prompt or tool.
- Pair on the same case and predeclared repetition slot. Reset workspaces, storage, conversation state and candidate artifacts between arms. Balanced/randomized arm order reduces time/order effects; it does not eliminate provider drift. Record actual model/runtime identities and capacity events.
- Keep controller overhead, setup, review, repair, failed/interrupted work and permitted owner interventions in total effort. Equal ceilings do not mean equal actual usage. Unknown usage remains unknown.
- Prepare the common fixture once under a symmetric policy. Count arm-specific preparation and helper costs. Do not give one arm a warm solution cache, repaired environment, extra context or uncounted manual rescue.
- Blind independent functional grading to arm identity when feasible. Grade exact candidates against the same frozen oracle and public requirements. Do not use one arm's solution as the other arm's context.
- Preserve every planned assignment. A paired functional-quality analysis may require both arms to have valid observations, but report missing pairs and their causes alongside all assigned outcomes. Workflow non-delivery remains an observed delivery outcome even when no patch can be graded. Complete-pair results alone can be biased when missingness differs by arm; label the subset and retain the all-assignment view. Do not selectively rerun failures, drop inconvenient cases or replace a failed UI case with a CLI success after seeing results.

Report resource use as separate observed quantities: calls by role, input/cached/output/reasoning tokens, wall time, owner time and interventions. Cached input is already part of input; reasoning output is already part of output. Do not add those subsets again. Retain per-arm completeness and unknown-usage counts. Subscription consumption, tool-output bytes and elapsed time do not imply a measured dollar saving. Separate shared fixture/setup effort from arm-specific setup and operating effort, state any allocation rule, and include both in a whole-campaign total when comparable units are available.

Show total expenditure across all assigned attempts as well as per-case paired differences. If reporting cost per accepted delivery, divide the whole arm's known expenditure, including failures and interruptions, by its independently accepted delivery count; never average only successful episodes. With zero accepted deliveries the ratio is undefined. Missing usage prevents a complete cost ratio or savings claim even if observed partial totals are useful. Any amortized setup claim needs an explicit future task count and comparable task mix, not an assumed free setup.

No paired comparison is authorized by this design. In particular, it does not relax the existing Pith protocol or the historical execution hold.

## Invalid evaluations and valid failures

Record validity, functional result and delivery result as distinct facts. Freeze the evaluated workflow boundary and assignment rule before outcomes: fixture qualification before assignment differs from setup or admission performed by an already assigned workflow. A final report should show all assigned outcomes and a separately labeled count of valid graded tasks. Otherwise excluding infrastructure problems can make a workflow appear dependable while it repeatedly fails to deliver. These labels refine A5 reporting; they do not turn a missing functional observation into an optimization score or relax the skill design's pause-on-blocker rule.

| Observation | Classification and consequence |
| --- | --- |
| Independent fixture/profile qualification fails before assignment | Not admitted or blocked; no functional grade. Record screened-out cases and reasons. Fix the fixture/profile only under its own authorization. |
| An assigned workflow fails its own setup or admission on a qualified task/profile | Retain the assigned workflow outcome and cause; no functional grade if no candidate exists. A pre-dispatch failure is not automatically an invalid case. |
| Independent controls show an ambiguous requirement, unrelated failing oracle or broken reference | Invalid case/evaluation. Retain the reason and incurred cost; quarantine the version. Do not count a product pass or fail. |
| Valid environment; candidate does not fix behavior, breaks preservation, fails to build or weakens protected checks | Valid task/workflow failure. A compiler error caused by the candidate is not an infrastructure exemption. |
| Squire generates invalid ownership, fails planning/review, loses its candidate or exhausts its allowed attempts | Failed delivery by the evaluated workflow when the task/profile was valid. Functional grading may be absent, but the assignment must not disappear as an invalid fixture. |
| Functional patch passes, but permitted delivery or post-delivery acceptance fails | Functional result retained; accepted delivery not established. Keep the failed layer and cause explicit. |
| External capacity interruption, owner cancellation or unresolved process settlement | Interrupted/incomplete under the frozen protocol; retain accounting and no accepted-delivery claim. Do not relabel it a measured patch-quality failure without evidence. |
| Candidate-versus-environment cause is unresolved | Unknown attribution and incomplete/blocked grading as applicable. Preserve logs and receipts; do not pick whichever label improves the score. |
| Usage evidence is missing but independent functional observations are complete | Functional result may remain usable; complete cost/savings comparison is unavailable. |

An infrastructure-looking symptom is not its cause. After a valid admission, candidate or workflow actions may themselves break the environment; those remain relevant failures of the evaluated system. Report accepted, observed non-delivery, interrupted/unknown and invalid dispositions against all assigned slots, then any valid-only functional denominator separately. A not-accepted fraction across assignments describes observed delivery yield, not a claim that every missing patch is incorrect. Any independent control recheck must follow the predeclared authorized procedure, retain the original attempt and stay separate from an agent rerun. The historical no-rescue closure is unaffected.

## What a small sample can establish

Four core cases, or five including the desktop case, can test coverage and reveal a concrete failure mode. With one binary outcome per equally weighted case, one case changes the success fraction by 25 percentage points for four cases, or 20 for five. Repeating one case many times estimates within-case variability; it does not create many independent task families or establish generalization to new work.

For a later authorized pilot, report per-case paired outcomes, preservation defects, delivery failures, missing pairs, resource observations and owner effort before any aggregate. Keep work categories visible. A purposive portfolio's average describes that portfolio; it is not an estimate of the owner's entire task distribution without an explicit sampling argument.

Choose any confirmatory sample size prospectively from the decision's minimum useful effect, tolerated quality loss, desired uncertainty level and decision-error tolerance, task-family variability, planned pairing and affordable total budget. Use case/family-aware uncertainty, not a confidence interval treating every retry as an independent task. If the affordable sample cannot distinguish useful improvement from harm, call it a feasibility result and keep the incumbent. No detected difference is not equivalence.

The portfolio does not prescribe a statistically sufficient case count or convert a pilot into the required larger baseline. A future baseline can be complete even with genuine failures: all planned assignments need terminal dispositions and independent grading where valid. It cannot be complete through unfinished harness construction or selective omission.

## Evidence required before a future campaign

The owner-facing authorization packet should be short, with references to these reviewed artifacts:

- Named objective: fixture calibration, first delivery demonstration, fixed-workflow baseline or a specific comparison. State which claim it could establish.
- Exact case/corpus versions, split/provenance/exposure review and independent grading custodian; only authorized public task inputs go to workers.
- Passed zero-model readiness records on the selected execution profile, including controls, cleanup and evidence export. Required R/P/A/T facilities must exist for the claim being made; documentation alone is insufficient.
- Frozen Squire/runtime/model/reasoning identities, allowed tools, workflow and any treatment bytes; no implicit model or API fallback.
- Total budget covering every role, repair, repetition and overhead; capacity assumptions, unknown-usage handling, deadlines, stop rules and permitted intervention policy.
- Planned assignments, repetition/order policy, invalidation/missing-pair rules, analysis and promotion rule, fixed before outcomes are available.
- Exact delivery scope and permissions. Local candidate grading, local Git delivery, remote publication/merge and GUI/native acceptance are different stages; authorization for one is not authorization for all.
- Confirmation that the historical execution hold has been explicitly superseded for this named new campaign, without reopening old runs. Optimization additionally needs the completed, independently graded larger baseline; Pith additionally needs output-fidelity qualification.

The immediate decision is whether to commission a bounded implementation slice. It is not whether to start a model benchmark. If any prerequisite is missing, return the smallest blocker and stop before dispatch.

## Bounded future implementation slices

These BP identifiers are new portfolio work, not historical benchmark IDs. All implementation and execution remain unstarted and separately gated.

### BP0 Freeze the portfolio contract

Add a small case registry specification and public card template using existing descriptors. Review D1-D4 coverage, decide whether desktop coverage is required, and name a holdout custodian. Keep old task inputs and reports untouched.

Gate: each proposed case has a public behavior contract, work category, split/lineage status, required profile and explicit claim limits. No sealed case content is needed. This can remain documentation-only.

### BP1 Build two exposed fixture packages

After explicit implementation and zero-model execution permission, prepare D1 and D4 with disposable public seeds, independent behavior/preservation controls and reset instructions. Use the existing task adapter and reporting foundation; no model, private benchmark or remote delivery target is needed.

Gate: the intended base failure, passing reference, targeted defects and reset behavior are observed on one pinned route, with retained truthful receipts. Failure to achieve this gate stops expansion.

### BP2 Complete the small development portfolio

Add D2 and D3 after BP1 is reliable. Add D5 only if its platform matters and the required real observer/preflight route exists. Exercise the same readiness contract rather than adding a new runner for each case.

Gate: four core cases are individually ready; desktop coverage is either separately ready or explicitly absent. Calibration remains unscored. Fixture success is not model effectiveness or end-to-end delivered application acceptance.

### BP3 Prepare an independent evaluation packet

An authorized independent custodian selects new case families, checks validity and exposure, freezes grading and assembles the campaign packet. Builders receive only the safe manifest needed for planning; they do not inspect holdout answers. If optimization is proposed, preserve separate development, selection-validation and final-holdout roles.

Gate: corpus ownership, all readiness evidence, sampling/uncertainty limits and every execution/delivery permission are reviewable. Preparing the packet does not authorize running it.

### BP4 Conduct only a separately authorized campaign

After explicit approval and all applicable roadmap prerequisites, run the frozen assignments, preserve every disposition and grade exact candidates independently. Reuse A5 and the existing receipt chain. The scope might initially be a feasibility demonstration; label it accordingly.

Gate: publish only the authorized bounded result, with validity counts, functional and delivery layers, full known costs and missing evidence. Inconclusive evidence retains the incumbent and does not trigger unapproved reruns, more cases, skill search or a larger specialist team.

Stop here during research. The useful next artifact is one reliable exposed case package after authorization, followed by a second with a different failure surface. A larger leaderboard, hosted dashboard and new benchmark platform are not prerequisites.
