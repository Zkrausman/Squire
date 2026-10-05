# Squire roadmap

Future backlog — unstarted:

- Squire dashboard overview.
- Host the Squire overview dashboard and store its metrics in an S3 bucket or other durable cloud storage.
- Phase-owned evolving specialist teams, alongside self-improving skills — implementation after the current larger-benchmark baseline.
- Intelligent task-aware model selection — low priority, exploratory; behind delivery reliability and current benchmark work.

## Phase-owned evolving specialist teams — future, unstarted

Planning, implementation and review should each own a versioned team of specialist subagents. Each phase can identify missing capabilities, propose and define new specialists, refine or retire existing specialists, and improve how it selects and combines them. Team growth is an optimization candidate; it must earn its coordination cost through measured outcomes.

Start after the current larger-benchmark baseline has completed and been independently graded. Choose the first phase from measured bottlenecks, then trial the smallest useful team in that phase before expanding. Compare against the existing phase and a simple skill or deterministic tool where appropriate, under comparable aggregate budgets. Do not change frozen benchmark configurations or evidence to introduce the trial.

Each specialist needs an explicit purpose, input/output contract, approved skills and tool profile, fixed authorized model and permission ceilings, budget, version, provenance and evaluations. Creation and invocation are bounded by trusted admission and aggregate call/time limits; specialists cannot recursively grow teams or grant themselves additional authority.

Evaluate individual specialists, the whole phase, and independently graded delivered outcomes, including coordination calls, latency, token use, repairs and unknown usage. Use frozen training cases for development, separate validation for selection, and an untouched final holdout after the team and routing/composition are frozen. Specialists cannot grade or promote themselves or receive private evaluator answers.

Require independent admission and promotion, immutable versioned receipts and rollback to the previous team configuration. Preserve controller verification, ownership, protected paths, fresh review, CI, delivery and evidence gates. Keep a change only with credible quality gains or equivalent correctness at lower total cost; adding specialists alone is not progress.

## Model selection sketch — future, unstarted

Task signals → cheap classification (for example, Luna) → simple routing policy informed by public benchmark metadata and Squire outcomes → selected execution model → independent grading feeding future routing calibration.

Keep selection vendor-neutral and start with simple rules before a learned selector. Fall back to the established fixed-role models when classification or evidence is uncertain. Public benchmark scores need local validation: compare delivery quality and token use against the fixed-role baseline, including classification and routing overhead.
