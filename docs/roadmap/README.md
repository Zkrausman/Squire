# Squire roadmap

Prioritize dependable delivery for one owner: preserve useful work, report exactly what passed, and ask for input only at real scope, authority or environment boundaries. Keep the single-host controller and fixed-role subscription workflow.

## Current foundations and evidence limits

Squire already has durable SQLite state/events and leases, supervised bounded processes, partial-work recovery, controller-owned candidate commits, exact-candidate verification, fresh read-only review, exact GitHub check matching, merge reconciliation and postmerge checks. These are implemented facilities, not wholly unstarted roadmap items.

The source audit is pinned to [ec98a61](https://github.com/Zkrausman/Squire/commit/ec98a61bd6a0fec89246c0b160ca90d2ff363d68). Existing fixtures cover substantial failure paths; their presence and green controller CI do not establish live-model effectiveness or accepted application delivery. The [research index](../research/README.md) separates source facts, static risks, proposed fixtures and acceptance contracts.

The [v0.1 closure record](../releases/0.1/baseline-closure.json) is authoritative for that program's later status: the original baseline is closed-incomplete; manual harness completion is separately unscored; benchmark/comparative execution remains on owner hold. Preserve those historical inputs, failures, counters and evidence. Future optimization still requires a separately authorized, completed and independently graded larger-benchmark baseline. Documentation does not reopen a run or authorize execution.

## Reliable software-factory foundations: proposed hardening

The design work is documented; the implementation slices and new acceptance fixtures below remain proposed and unexecuted. The gaps are between existing mechanisms, rather than a replacement controller.

1. **Close recovery identity gaps (R1-R2).** Cover planning and GitHub subprocesses in reconciliation; register operations before spawn; journal candidate commits across the Git/SQLite boundary. On uncertain outcomes, reconcile or block before dispatching another writer. Gate: injected crashes converge to one authorized settlement without accepting arbitrary HEAD changes.
2. **Preserve immutable per-job evidence (R3).** Give every physical job its own retained result, raw event spool, artifact manifest and candidate references, including failure, timeout, capacity and no-change outcomes. Gate: corruption/export failure stays visible, failed work survives, and replay cannot overwrite or double-count an earlier attempt.
3. **Recover results and budgets honestly (R4).** Adopt only matching completed receipts; retain durable call reservations, deadlines and current admission restrictions. Define versioned new-run quota/attempt semantics with affirmative evidence before exempting a logical attempt. Gate: no budget reset, duplicate debit, overlapping execution or unknown-usage-as-zero.
4. **Retain the delivery facts already checked (R5).** Record publication intent, selected current check-run/app/head identities, and exact merge/tree/ancestry/postmerge receipts. Preserve all current gates. Gate: lost responses reconcile and stale, skipped, wrong-head or wrong-app evidence cannot advance delivery.
5. **Validate the actual execution route (R6).** Record task-specific toolchain, workspace, sandbox, process, export and GUI/native capabilities at the execution boundary. Gate: unsupported capabilities block before expensive dispatch; changing the environment invalidates its receipt.
6. **Resolve acceptance claims to evidence (A1-A3).** Separate production origin from quality; attach immutable observations to candidate criteria and have fresh review reference them. Keep legacy narrative evidence honestly labeled. Gate: nonexistent, altered, wrong-candidate or incompatible-kind evidence blocks acceptance.
7. **Prove one small end-to-end route (R7; A4 for GUI scope).** Begin with disposable offline failure fixtures, then a separately authorized local/GitHub demonstration after capacity returns. Add one real browser evidence producer only when needed. Gate: the exact candidate passes the required gates and the owner can inspect its result; a preview or mock is never substituted for product acceptance.
8. **Measure before optimizing (A5).** Prepare a fixed-workflow comparison protocol and full accounting without running it. Preserve the baseline/owner-hold prerequisites above. A later Pith output-transform comparison additionally requires output-fidelity validation. Gate: independently graded quality, total resource use and owner recovery effort are measured; incomplete usage, interruption or compressed output alone cannot become a savings claim.

Detailed dependencies, negative cases and unresolved choices:
- [Recovery, artifact retention and delivery receipts](../research/factory-recovery.md)
- [Acceptance, visual evidence and controlled comparisons](../research/factory-acceptance.md)

The first useful outcome is a recoverable interrupted ticket; the next is an auditable delivered result. Share one small receipt format between both workstreams. No distributed workflow service, hosted preview platform or additional agents are prerequisites.

## Other retained commitments

- Squire dashboard overview.
- Host the Squire overview dashboard and store its metrics in an S3 bucket or other durable cloud storage. Keep it behind the dependable local delivery/evidence path; storage choice is not settled by this research.
- Phase-owned evolving specialist teams alongside self-improving skills, after the authorized larger-benchmark baseline prerequisite.
- Intelligent task-aware model selection: low priority and exploratory, behind delivery reliability and benchmark work.

## Phase-owned evolving specialist teams — future, unstarted

Planning, implementation and review should each own a versioned team of specialist subagents. Each phase can identify missing capabilities, propose and define new specialists, refine or retire existing specialists, and improve how it selects and combines them. Team growth is an optimization candidate; it must earn its coordination cost through measured outcomes.

Start only after a separately authorized larger-benchmark baseline has completed and been independently graded. The historical v0.1 baseline remains closed-incomplete, and the recorded benchmark/comparison hold remains in effect; do not reopen or relabel it. Choose the first phase from measured bottlenecks, then trial the smallest useful team in that phase before expanding. Compare against the existing phase and a simple skill or deterministic tool where appropriate, under comparable aggregate budgets. Do not change frozen benchmark configurations or evidence to introduce the trial.

Each specialist needs an explicit purpose, input/output contract, approved skills and tool profile, fixed authorized model and permission ceilings, budget, version, provenance and evaluations. Creation and invocation are bounded by trusted admission and aggregate call/time limits; specialists cannot recursively grow teams or grant themselves additional authority.

Evaluate individual specialists, the whole phase, and independently graded delivered outcomes, including coordination calls, latency, token use, repairs and unknown usage. Use frozen training cases for development, separate validation for selection, and an untouched final holdout after the team and routing/composition are frozen. Specialists cannot grade or promote themselves or receive private evaluator answers.

Require independent admission and promotion, immutable versioned receipts and rollback to the previous team configuration. Preserve controller verification, ownership, protected paths, fresh review, CI, delivery and evidence gates. Keep a change only with credible quality gains or equivalent correctness at lower total cost; adding specialists alone is not progress.

## Model selection sketch — future, unstarted

Task signals → cheap classification (for example, Luna) → simple routing policy informed by public benchmark metadata and Squire outcomes → selected execution model → independent grading feeding future routing calibration.

Keep selection vendor-neutral and start with simple rules before a learned selector. Fall back to the established fixed-role models when classification or evidence is uncertain. Public benchmark scores need local validation: compare delivery quality and token use against the fixed-role baseline, including classification and routing overhead.
