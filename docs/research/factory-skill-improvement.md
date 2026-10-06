# Squire skill improvement: bounded offline search after a valid baseline

Research snapshot: 6 October 2026. Proposed design only. This document records public-source research and an unexecuted prototype specification. Publishing it does not authorize implementation, skill optimization, model/provider calls or benchmark execution. Ordinary documentation-PR CI verifies the unchanged repository suite separately; it is not evidence for any proposed experiment.

## Recommendation

Use GEPA, if later justified, to propose revisions to **one small, explicitly selected implementation-skill text**. Keep Squire's fixed planning/implementation/review workflow, models, tools, authority, checks and delivery policy unchanged. Run the search outside ordinary delivery, then independently evaluate and review a frozen finalist. A higher optimizer score nominates a candidate; it never authorizes promotion.

The first useful deliverable is a zero-model replay specification designed to check candidate identity, split boundaries, feedback filtering, accounting and promotion decisions. Its eventual execution would establish protocol behavior only. A real optimization trial comes later, after explicit execution authorization and a completed, independently graded larger-benchmark baseline.

This is a narrower implementation of the existing self-improving-skills promise. It does not require specialist teams, another orchestrator, an autonomous researcher, learned routing or new provider billing. If measured failures are caused by broken preparation, evidence or recovery, fix those deterministic paths first. A prompt is a poor substitute for a controller invariant.

## Baseline and ownership

Squire runtime sources below are pinned to [ec98a61bd6a0fec89246c0b160ca90d2ff363d68](https://github.com/Zkrausman/Squire/commit/ec98a61bd6a0fec89246c0b160ca90d2ff363d68). Current documentation is pinned to [89b0f3b6e668e6c6fe5b3696aaa260d858062d85](https://github.com/Zkrausman/Squire/commit/89b0f3b6e668e6c6fe5b3696aaa260d858062d85), after the docs-only [PR 100](https://github.com/Zkrausman/Squire/pull/100) and [PR 101](https://github.com/Zkrausman/Squire/pull/101). GEPA implementation details use [fb1ed589fd83372caef499cffc2c73173d3b096b](https://github.com/gepa-ai/gepa/commit/fb1ed589fd83372caef499cffc2c73173d3b096b); pin an approved installed version before implementation. The February examples and the later pinned API snapshot may differ.

The [roadmap at this research snapshot](https://github.com/Zkrausman/Squire/blob/89b0f3b6e668e6c6fe5b3696aaa260d858062d85/docs/roadmap/README.md) already requires fixed development cases, separate selection validation, untouched final holdout, independent promotion and rollback, with all coordination cost counted. It retains self-improving skills alongside future specialists; neither is implemented by a documentation promise. The [closure record](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/docs/releases/0.1/baseline-closure.json) keeps the historical v0.1 program closed-incomplete and manual completion separately unscored. The owner hold on benchmark/comparative execution remains in effect. Do not reopen, repair into a new score, or relabel that historical program to satisfy this prerequisite.

Reuse the [PR 100/101 dependency map](https://github.com/Zkrausman/Squire/blob/89b0f3b6e668e6c6fe5b3696aaa260d858062d85/docs/research/README.md):

- Recovery R1-R4 own operation/job identity, immutable retention, reconciliation and honest budget settlement.
- Acceptance A2/A3 own criterion-to-observation resolution and independent acceptance. A5 owns the comparison/report protocol.
- Preflight R6/P0-P5 owns exact-boundary capability admission. A4 owns actual browser evidence when a selected task requires it.
- This slice owns only skill bytes and lineage, corpus/split identity, optimizer feedback admission, and the decision to select a skill version for **future** jobs. Reference the shared receipts; do not duplicate the scheduler, process supervisor, evidence store, grader or capability framework.

All stronger contracts in those research slices remain proposed unless a later implementation and its evidence establish otherwise.

### What qualifies the future baseline

Before optimization, require a separately authorized baseline manifest with frozen public cases, native environment, incumbent recipe, model/reasoning settings, aggregate limits, repetition plan and independently controlled grading protocol. All planned assignments must have a terminal disposition under the predeclared protocol; valid task failures stay in the denominator. A useful baseline need not solve every task, but unfinished construction or post hoc cherry-picking cannot substitute for completing and grading the planned experiment.

Trusted positive/negative controls must establish that the grader detects both required new behavior and preservation defects. Actual application acceptance must use the evidence kind the task requires; controller CI, mocked GUI checks and the implementer's own summary do not supply it. Bind each grade to the exact candidate and retain invalid/environmental outcomes separately. Missing usage may leave a quality observation usable, but it limits cost comparisons and cannot support a complete savings claim. This qualifies evidence; it does not authorize running the baseline now.

## What exists, and what is missing

| Area | Existing source or fixture | Gap relevant to skill improvement |
| --- | --- | --- |
| Prompt composition | Controller builds planning, implementation and review instructions inline. Ticket acceptance, preparation, protected paths and optional public-contract bytes enter those prompts. The runtime appends attempt/temp/platform constraints and saves prompt.txt. [Controller](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L16-L19), [role prompts](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L267-L268), [implementation/review](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L354-L394), [runtime](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L61-L94) | No first-class Squire skill-version slot, controlled candidate loader, optimizer, evaluation registry or promotion path is exposed here. Applicable AGENTS.md remains contextual input; absence of a Squire registry does not prove the underlying harness cannot discover skills. |
| Fixed execution contract | Job roles are plan, implement and review. Strict runtime configuration allows role model/reasoning overrides, not arbitrary skill or optimizer fields. Subscription authentication, clean user configuration and read-only planning/review are explicit. [Ports](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/ports.d.ts#L1-L23), [validation](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/contracts.mjs#L91-L139), [runtime settings](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L25-L73) | A skill reference needs an explicit reviewed contract extension. GEPA's default API-backed reflection model is not an installed Squire runtime or permission to switch billing. |
| Public context integrity | Controller rechecks approved public bytes before spending each call. Fixtures cover planner, implementation, repair and fresh-review byte identity, missing/drifting contracts and rejected private-path declarations. [Dispatch](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L211-L227), [fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/public-contract.test.mjs) | Reuse this pin-and-recheck pattern for a separate advisory skill artifact. Do not rewrite the frozen public goal, use it as an optimizer-controlled field, or imply a text hash proves behavioral safety. |
| Public/private case materialization | Descriptor adapter copies explicit regular public files, excludes private locations and rejects links/unsafe overlaps. It preserves subscription execution and clamps job/session ceilings. [Task contract](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/benchmarks/contracts/task.mjs), [fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/benchmark-contracts.test.mjs) | This is input separation, not an OS security boundary. There is no split registry, task-family leakage audit, feedback export policy or private-grader isolation established by these tests. |
| Acceptance and preservation | Fresh reviewer must identify the exact head and cover structured checklist criteria. Repair/base changes invalidate prior gates; tests include policy protection and rejected implementation-session reuse. [Review validator](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/contracts.mjs#L197-L220), [controller fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/controller.test.mjs#L602-L646) | Existing checklist evidence is narrative. Use A2/A3 for admissible observations; the optimizer must not become a second grader or turn convincing prose into an acceptance receipt. |
| Usage and experiment reports | summarizeTrace deduplicates native job IDs, separates pending/unknown/conflicting usage and avoids cached/reasoning double counting. Calibration keeps new behavior and preservation distinct and is explicitly unscored. [Reporter](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/benchmark-report.mjs), [fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/benchmark-report.test.mjs) | Reflection calls, corpus construction, repeated validation, final grading and owner effort are not automatically represented by native Squire job totals. A campaign report must join those receipts without converting estimates or missing usage into measured totals. |

These are source observations and existing test definitions, not results of new test execution.

## What GEPA contributes, and what its examples do not establish

The [optimize_anything introduction](https://gepa-ai.github.io/gepa/blog/2026/02/18/introducing-optimize-anything/) describes search over text artifacts using evaluator scores plus diagnostic feedback, with training and validation inputs for generalization. Its useful contribution here is focused candidate generation and selection, not authority over Squire's checks. The [gskill study](https://gepa-ai.github.io/gepa/blog/2026/02/18/automatically-learning-skills-for-coding-agents/) applies that loop to repository instructions and evaluates held-out tasks. It also notes that its generated bug-fixing tasks are simpler than broader software work. Reported gains on its repositories/models do not predict gains, cost savings or cross-model transfer for Squire.

Important implementation differences to preserve:

1. **Validation participates in search.** Current API describes valset as candidate-selection data. The eval server registers both train and validation examples in its visible pool. Do not label that pool an untouched test set or assume validation contents are secret from every engine. Use opaque public case references and a constrained proposer; keep the final holdout entirely outside the optimizer. [API](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/optimize_anything.py#L94-L176), [pool](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/oa/eval_server.py#L195-L231).
2. **Built-in test_set is not a Squire grading contract.** Current code scores the seed and selected candidate on test examples outside the eval budget, reusing the seed pass when unchanged, and converts test-evaluator exceptions to zero scores. That routing keeps tests outside the engine's eval pool, but it does not establish process/filesystem isolation, Squire's all-work budget, or its invalid-versus-rejected distinction. For this first integration, omit test_set and use the independently operated final grader with its own reserved budget and typed outcome. [Test path](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/optimize_anything.py#L341-L430).
3. **Library budgets are not aggregate job admission.** max_evals counts candidate/example evaluation attempts; max_token_cost concerns proposer spend in USD. A single evaluator invocation can contain several Squire jobs. The eval server documents batch overshoot, and its single-evaluation path checks before work and records afterward. Use serial evaluation initially and a Squire-owned admission ceiling before any child job or proposer call. No callback after a batch can undo spent capacity. [Config](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/oa/config.py#L23-L107), [evaluation](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/oa/eval_server.py#L233-L279).
4. **Feedback is an export surface.** gskill's example fitness function places agent traces, patch excerpts and test output into side information, and converts setup exceptions to failure scores. Squire should not copy that behavior for private graders or environmental failures. Disable automatic stdout/stderr capture, use a minimal allowlisted feedback projection and preserve the full trusted receipt separately. The wrapper can still inject oa.log() output when stdio capture is off, so that logging path must accept only already-sanitized feedback. [Log injection](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/gepa_launcher.py#L1028-L1100). [Fitness function](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/gskill/gskill/swe_fitness_fn.py#L118-L187), [capture options](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/gepa_launcher.py#L459-L531).
5. **A library result is not durable evidence.** Persisted per-evaluation JSON records contain candidate and info; artifact-write exceptions can be swallowed. Its total_cost adds reported eval cost and adapter cost, with missing eval cost defaulting to zero. Keep authoritative retention/completeness in R3/A5 rather than infer it from a GEPA summary file. [Persistence/accounting](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/oa/eval_server.py#L540-L594), [result aggregation](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/optimize_anything.py#L367-L395).

The first experiment should explicitly select the in-process GEPA search engine, one text component and one mutation at a time. Disable optional refiners, candidate merging, parallel proposals, warm-start solutions, external tracking and agent-readable state dumps. These features are not inherently invalid; they add variables and hidden work that this question does not require. In particular, per-example refinement can score a repaired artifact instead of the frozen reusable skill. [Search configuration](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/gepa_launcher.py#L486-L535), [refiner behavior](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/gepa_launcher.py#L804-L823).

## Proposed learning boundary

### One advisory skill, no mutable policy

Choose the target from the valid baseline's recurring, instruction-addressable bottleneck. An initial candidate could explain how to find a repository's existing regression tests, inspect a failing assertion and verify a minimal owned change using already-configured commands. This is a hypothesis to select after measurement, not a finding that this is today's limiting factor.

The optimized body may change concise repository-navigation or debugging advice. It may not change public requirements, ownership, permissions, authentication, runtime/provider/model choices, required tests, grading rules, prompt authority, attempt/call limits, evidence retention, shipping rules or the review prompt. No executable skill scripts, hooks, network endpoints, dependencies or hidden attachments in the first experiment.

Give the artifact a small fixed UTF-8 byte ceiling, for example 8 KiB as a proposed reviewable default. Start from the approved incumbent text, including an explicitly empty advisory skill if that is the actual baseline. Retain core controller/runtime instructions unchanged. Do not compare a new loader plus a new skill against an unrelated prompt bundle and attribute the difference solely to GEPA.

Prompts are not a security boundary. Text lint and independent review catch obvious attempts to weaken gates but cannot prove the absence of malicious instructions. Actual controller checks, workspace scope and the selected execution isolation must still enforce authority. The existing same-user trust limitation remains relevant.

### Immutable recipe and provenance

A proposed SkillRevision record contains:

- Stable skill ID, immutable revision and parent revision; exact body digest and byte count; one declared target role.
- Approved repository/task-family applicability, source/base snapshot and compatible prompt/runtime interface versions.
- Origin: manual incumbent, deterministic fixture or GEPA proposal; proposer implementation/model identity where known; source feedback receipt IDs and permitted training split digest.
- Fixed instruction-template digest, experiment/protocol ID and applicable evaluation/promotion references.

A separate controller-owned decision records status: proposed, selected_for_final_evaluation, approved_for_future_jobs, rejected or revoked. The proposer cannot write it. A candidate does not become approved merely by entering GEPA's Pareto pool.

Keep **evaluation-only admission** separate from **approved_for_future_jobs**. A trusted admission receipt authorizes exact candidate bytes only within a named, bounded experiment, with fixed role, applicability, protocol and budget. It can admit a proposed revision for its permitted evaluation, but does not change the ordinary-job selector or grant production approval. Ordinary delivery selects only the approved incumbent or a separately promoted revision. The optimizer cannot create either evaluation admission or production approval; final-holdout access still requires the independently selected, frozen finalist and protocol below.

Before dispatch, the trusted loader resolves the exact bytes authorized for that job's evaluation-only or ordinary-delivery scope and freezes them into the job recipe. R3's manifest carries skill/template digests alongside job, logical attempt, project and candidate identities. Recheck bytes before reservation using the existing public-contract pattern. Resume uses the same recipe; a moving current-version pointer cannot alter an in-flight job. A later prompt/model/harness change creates a new evaluated recipe instead of silently inheriting an old result.

The first role is implementation only. Planner/reviewer skill tuning would be a separate experiment because changing the judge or decomposition simultaneously destroys attribution. The reviewer receives the unchanged acceptance context, not training answers or a request to validate the optimizer's claims.

### Three different data roles

1. **Training/development cases.** Frozen before search; allowed for repeated optimization and controlled diagnostic feedback. Include both new-behavior and preservation requirements. Task outcomes and rubric are fixed; neither proposer nor worker authors their scoring oracle.
2. **Selection validation.** Frozen separately before search. Used repeatedly to compare candidates; return only the minimum declared selection information. It is development evidence and carries multiple-comparison/overfitting risk even when the proposer is not directly shown detailed outputs.
3. **Final holdout.** Independently owned and absent from optimizer-accessible data, logs, caches, background text, examples and workspaces throughout search. After the skill, search budget, reporting and promotion rule are frozen, grade the incumbent and one finalist using the same planned repetition/ordering protocol. Only that independent evaluation supplies the final cases' public inputs to its execution workers; private graders stay inaccessible, and holdout feedback does not return to the optimizer. Do not select a second finalist or tune the first from those results. If used for later debugging, retire those cases from holdout status and obtain a fresh future holdout.

Split by underlying task family, bug origin, source snapshot and near-duplicate lineage, not merely shuffled row ID. Variants derived from the same defect/reference belong in one split. Record public-case content digests and provenance; keep private oracle/reference identities in the trusted grader manifest. Maintain a contamination ledger for cases already seen by the builder, proposer, reviewer or human editor. Previously inspected solutions are not unseen test evidence.

Generalization is scoped. A same-repository held-out defect experiment supports claims about that declared task distribution, not arbitrary greenfield GUI products, all repositories or another model. Diverse cross-repository/GUI tasks require a later corpus and its applicable acceptance capabilities.

### Grader and feedback separation

Keep public inputs and private graders on distinct authorized paths/runners. The worker receives only the public descriptor/materialized seed and frozen skill. The proposer receives the skill and an allowlisted training feedback record such as public criterion ID, observed pass/fail class, approved public-test diagnostic and receipt reference. It does not receive oracle code, expected hidden values, reference patches, private paths, credentials, other candidates' solutions or final-holdout outcomes.

Do not send the full private descriptor as an opaque Python example and assume the library will never serialize it. Pass a public case handle and let a trusted evaluator resolve private data internally. All optimizer logs, callbacks, caches, screenshots and side information inherit the same export policy. Disable automatic capture; truncating a private stack trace still leaks private material. Treat tool output as data, and reject feedback instructions that attempt to change scope or reveal the grader.

Input filtering alone is insufficient for adversarial candidate code. If the selected runner cannot keep private oracles out of worker/proposer reach, block that private-evaluation claim or choose an explicitly authorized isolated route. Do not invent an isolation guarantee from the current task materializer or preflight. The zero-model prototype uses inert synthetic markers and does not require private benchmark material.

### Evaluation outcome, then score

Use A2/A3's observations to distinguish:

- Valid accepted outcome: required new behavior, preservation, authority and applicable delivery/acceptance gates all passed for the exact revision.
- Valid rejected outcome: a completed, valid evaluation found a criterion failure or violation.
- Invalid/blocked/incomplete evaluation: environment failure, unknown cleanup, exhausted capacity before the required work, missing receipt, unavailable grader, interruption or contract mismatch.

Only the first two have a declared optimization score. Do not make an infrastructure exception a product-quality zero or a missing observation a success. In the pinned in-process GEPA route, explicitly retain capture_stdio=False and raise_on_exception=True under engine_config's nested engine configuration, and let the trusted bridge persist a typed blocker when evaluation fails. Those flags neither sanitize feedback nor replace the bridge's outcome contract. [Configuration routing](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/oa/engines/gepa.py#L38-L52), [wrapper options](https://github.com/gepa-ai/gepa/blob/fb1ed589fd83372caef499cffc2c73173d3b096b/src/gepa/gepa_launcher.py#L1328-L1336). An invalid episode still appears in the assignment/usage ledger. Pause the optimization campaign with a typed blocker instead of repeatedly searching around bad infrastructure. Any bounded retry retains its original lineage and expenditure.

For the first trial, use independently accepted outcome as the primary scalar and retain new-behavior/preservation/authority dimensions separately. Do not allow a weighted average of speed and correctness to reward bypassing a required check. Hard violations disqualify a candidate regardless of average score. A Pareto frontier is a search aid, not permission to ship a specialist that fails essential cases.

## Regression corpus and comparison controls

Keep two corpora distinct:

- **Controller/adapter regression fixtures:** prove recipe identity, admission, leakage filtering, missing-evidence rejection, fresh-review and rollback semantics. Existing tests are reused; proposed additions exercise the new connection between them.
- **Task-outcome corpus:** compares the incumbent and candidate's independently accepted products, including preservation failures. New public failure cases can join the next development corpus only after being reviewed, de-duplicated and versioned. Do not quietly mutate a frozen evaluation corpus mid-search.

Add negative controls that expose metric gaming: a candidate that passes only the new test while breaking prior behavior; edits a required check; claims success without an artifact; returns a wrong-head review; copies a training answer; embeds a private canary; or recommends a permission/budget bypass. The first four should remain failures of existing/A2-A3 gates, not newly implemented optimizer-specific acceptance rules.

Hold Squire version, prompt template, skill-loader behavior, explicit tickets or planning mode, models/reasoning, toolchain, environment, check commands, case bases, repair policy, budgets and owner-intervention rules fixed. Use paired assignments and balanced/randomized arm order as A5 specifies. Compare with the incumbent first; a later manually written short skill is a useful low-cost control before claiming the search itself adds value. Do not add that third arm without budgeting it.

## All-work accounting and stopping

An evaluator call is not a model call, and a model call is not necessarily an accepted task. Extend A5's report to include the following linked categories without changing summarizeTrace's known-versus-unknown semantics:

- Corpus/fixture engineering and human review effort, explicitly labeled setup cost.
- Proposal/reflection calls, including malformed/duplicate/rejected proposals and any model-backed sanitization or judging.
- Every Squire plan, implementation, repair and fresh-review job in training, selection and final evaluation, including failed and interrupted assignments.
- Trusted checks, environment preparation, tool/helper work, artifact transfer/storage and elapsed time; distinguish overlapping elapsed time from summed process time.
- Independent grading, promotion review, owner decisions/recovery minutes and rollback work.
- Input/cached/output/reasoning usage when observed; unknown/incomplete usage and requested-versus-reported model identity separately.

GEPA's [cost documentation](https://gepa-ai.github.io/gepa/guides/cost-tracking/) warns that plain callable reflection models can have estimated token counts and zero reported cost, so a monetary stopper may never trigger. That is especially relevant to a future subscription-backed proposer adapter. Use hard call/episode/proposal/time ceilings and trusted reservations; retain dollar cost as unavailable when it is not measured. Subscription usage is not free merely because there is no marginal API invoice.

Define and reserve the **whole campaign** envelope before work: maximum distinct skill proposals, physical evaluator invocations, model jobs by category, per-job time and overall duration, retry allowances, final-grading reserve and permitted owner effort. Simple initial admission can reserve each case's full existing Squire call ceiling before starting it, plus proposer calls; reclaim unused reservations only after terminal settlement is established. This can reuse the existing store/receipt authority without constructing a second scheduler. Never let separately bounded child projects multiply into an unbounded campaign.

Initially evaluate serially. Disable evaluation caching for stochastic effectiveness measurements; exact replay caching is acceptable for protocol tests but is not another independent sample. A future cache key must bind skill bytes, case/split/repetition, base, recipe, grader/protocol and environment identity. Do not reuse a prior candidate answer or stale receipt as fresh performance evidence.

Stop at the first exhausted hard ceiling, revoked authorization, privacy/authority violation, unresolved infrastructure failure or final frozen decision. No quota resets, new budget admissions or API fallback are implicit. Report an unfinished search as incomplete; keep the incumbent.

Report setup cost and future per-task operating cost separately. Any amortized claim needs an explicit number of future comparable accepted tasks: total effort includes optimization and validation setup plus their downstream operating effort. A smaller prompt, fewer output bytes, a better training score or faster successful-only episodes cannot establish net savings. This memo supplies no monetary or performance estimate.

## Promotion and rollback

Use this sequence, with immutable references at every transition:

1. Propose bounded text from permitted training feedback.
2. Independently admit the candidate's exact bytes/scope for evaluation only in the named, bounded experiment, then evaluate under the fixed protocol. This leaves ordinary-job selection unchanged. Preserve unsuccessful candidates and their costs.
3. Select exactly one finalist from training/selection evidence under a predeclared tie-breaker. Freeze it and the decision before final grading.
4. Independently grade incumbent/finalist on untouched holdout; apply the predeclared quality/preservation, cost and owner-effort rule. Initial small pilots can establish feasibility only. A lack of detected difference in a small sample is not equivalence.
5. Obtain the required owner/reviewer approval of the exact skill diff and applicability. Store a promotion receipt naming both revisions, evidence completeness, protocol and reason. No self-promotion and no blanket permission to alter future prompts.
6. Select the approved revision for newly admitted jobs only. Existing jobs keep their recipe and evidence. The first authorized deployment can have a small declared observation window with existing acceptance gates and a clear rollback rule.

Rollback changes the future selected skill to the prior approved revision and marks the problematic revision revoked. Stop new admissions for that revision, retain all historical candidate/job/grade records and report affected jobs. Do not rewrite old receipts, reset consumed budgets, switch a running job's prompt, or automatically revert already delivered application code. Code recovery remains the ordinary separately authorized delivery/recovery workflow.

Any hard privacy/authority/preservation failure blocks promotion regardless of mean improvement. Broader deployment requires credible quality gains, or a predeclared quality-equivalent result with lower total resource/owner burden. If evidence is insufficient, the decision is keep incumbent, not silently widen the sample until a favorable score appears.

## Small offline prototype: design only

“Offline” here means outside production delivery. The first prototype below additionally uses **zero model/provider calls**. A later real optimization still consumes quota and needs separate authorization; nothing in this section authorizes execution now.

### Fixed inputs

- One toy implementation-skill body and two predetermined candidate revisions: one apparently improved and one deliberately invalid. No generated executable code.
- Twelve inert case identities, four each for training, selection and final holdout, grouped by synthetic task family with no shared family across splits. These counts are a protocol fixture, not a statistically adequate performance study or a proposed live-run allowance.
- Scripted trusted observations and native-shaped usage/process receipts for accepted, rejected, unknown, duplicate and interrupted episodes. Include synthetic private-marker fields confined to the fake grader.
- Fixed recipe/protocol/skill/case digests, an explicit tiny fixture budget and one promotion policy. The fake proposer can return only the two predetermined strings; it has no filesystem, shell, network or provider capability.

### Proposed flow

Feed public case handles and sanitized scripted training feedback through the candidate/evaluator bridge. Record proposed skill revisions, join episode/job identities, and simulate selection. Freeze one finalist and invoke the fake independent holdout authority through a separate interface. Record approve/reject/keep-incumbent, then simulate a future-job selector rollback. No live Squire delivery target, private benchmark suite, GEPA model default or external experiment tracker is configured.

First test the narrow bridge with a scripted search driver; a later authorized compatibility test may bind the pinned GEPA engine using the same fake proposer/evaluator. Neither path establishes that GEPA improves software. A malformed library config or missing dependency is a blocker, not a reason to enable a default API model.

### Required negative scenarios, unexecuted

1. Unknown/extra skill fields, oversized bytes, wrong role or changed template/skill digest reject before call reservation.
2. Duplicate task-family/seed lineage across splits rejects corpus admission.
3. Hidden canary in raw grader output, exception text, nested side information or serialized example never reaches proposer input, public logs or candidate artifacts. Filter from a schema allowlist rather than a secret-word denylist.
4. An optimizer request for final-holdout IDs is rejected; detailed validation feedback is suppressed according to the fixed export contract.
5. A passing scalar with failed preservation, wrong candidate or missing required observation cannot promote.
6. Environment/grader failure stays invalid, pauses selection and still contributes any incurred cost. An unchanged unknown result does not become a zero-cost retry.
7. Duplicate native usage receipts count once; conflicting usage remains unknown; proposer and final-grading work are included separately.
8. Concurrent/batch requests cannot overdraw the campaign envelope; disabled refiners/merge/proposal fan-out cannot silently introduce extra jobs.
9. Changed grader/recipe/environment/case invalidates a cached or resumed evaluation. Repetition identity prevents reuse as another sample.
10. An interrupted proposal/evaluation is reconciled using the recovery design's shared R1-R4 settlement contract before new work; this fixture checks integration, not a second recovery implementation or a claim that those proposed slices have shipped.
11. An evaluation-admitted proposed revision can run its authorized experiment but is rejected by ordinary-job selection. GEPA's best-candidate label grants neither evaluation admission nor production selection; ordinary selection still requires an independent promotion receipt.
12. Rollback restores the prior version for new jobs while preserving in-flight recipe identity, historical evidence and all counters.

Prototype completion means these contracts have an implementable fixture inventory and, after future authorization, verified replay results. It does not mean a valid model baseline, a measured skill improvement, production readiness or permission for a real experiment.

## Ordered roadmap slices

| Slice | Small deliverable | Dependencies and exit condition |
| --- | --- | --- |
| S0: clarify the promise | Link this research to the existing skills commitment and mark implementation/effectiveness as unstarted. | Docs review only. Preserve historical closure and owner execution hold. |
| S1: pin one advisory skill | Reviewed opt-in contract proposal, exact-byte loader/recipe design and proposed role/digest fixtures. | Reuse R3 manifest and current public-contract pinning; strict version-1 configs must not silently accept new fields. No optimization. |
| S2: freeze corpus and feedback | Public-case/split provenance, typed evaluation outcome, private-feedback projection and contamination policy. | Reuse task descriptors and A2/A3/A5. Synthetic markers only for initial fixtures; prove private boundaries before real private graders. |
| S3: replay the bridge | Scripted candidate/evaluation/promotion/rollback test plan, then separately authorized offline implementation. | S1/S2 and R1-R4/R6 integration where physical jobs would occur. No model or benchmark performance claim. |
| S4: prepare one future trial | Exact target skill, fixed incumbent/recipe, bounded proposer path, representative splits, repetition plan, full budget and promotion rule. | Explicit execution approval plus a separately completed, independently graded larger-benchmark baseline; required recovery, capability and acceptance evidence must be available. Current quota/hold blocks live work. |
| S5: evaluate and decide | Later authorized search, frozen-finalist independent grading and keep/promote/reject decision. | S4. Inconclusive retains incumbent. Any rollout/rollback applies only within separately authorized scope. |

For the current research window, limit work to S0-S2 design, the S3 fixture specification and reviewed documentation publication. Those documents do not close an implementation or fixture-execution gate. Do not spend model capacity or run a proposed experiment to manufacture evidence for a roadmap.

## Defer or reject

**Defer until a narrow measured benefit exists:** optimizing more than one skill or role; specialist teams and composition; model/routing search; cross-model transfer; synthetic task generation at scale; agentic proposers; executable skills; parallel proposals; refiners/merging; a persistent optimizer service; dashboards/cloud storage for experiments; online continuous learning and automatic promotion. Existing dashboard/specialist commitments remain in their roadmap order.

**Reject for this design:** mutating frozen benchmark history; treating manual harness engineering as a Squire baseline; training on holdout answers; shipping private grader/reference material to a proposer or public document; using optimizer-authored tests as the sole oracle; rewarding self-reported completion; changing acceptance or authority to improve scores; mapping infrastructure uncertainty to product failure or success; zero-filling unknown usage; relying only on GEPA's counters for total cost; claiming another paper's gains transfer; starting API billing or provider runs because subscription quota is exhausted.

## Decisions to settle before implementation or a real trial

1. Which measured bottleneck is instruction-addressable, and can a deterministic fix or a short manually authored skill address it more simply?
2. What exact skill/template interface and byte ceiling remain stable across incumbent and candidate?
3. Which case families are eligible, which have already been exposed, and who controls the independent grader and final holdout?
4. Which supported authorized runtime can propose bounded text without unapproved API billing or broader tools? Current Squire has no GEPA proposer adapter.
5. What aggregate envelope, repetitions and meaningful quality/equivalence threshold are affordable, including setup, final evaluation and owner effort?
6. Who approves the exact version for future jobs, and what observed failure triggers revocation without changing running or historical work?

Until those decisions and the baseline prerequisite are satisfied, the dependable fixed-role workflow remains the product. Skill search is a proposed experiment, not a new standing autonomy level.
