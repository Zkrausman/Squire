# Squire roadmap

Future backlog — unstarted:

- Squire dashboard overview.
- Host the Squire overview dashboard and store its metrics in an S3 bucket or other durable cloud storage.
- Reliable software-factory foundations — recoverable runs, execution-boundary preflight, preserved evidence, verified delivery, and visual proof where useful; prioritize before team growth or model routing.
- Phase-owned evolving specialist teams, alongside self-improving skills — implementation after the current larger-benchmark baseline.
- Intelligent task-aware model selection — low priority, exploratory; behind delivery reliability and current benchmark work.

## Reliable software-factory foundations — proposed, unstarted

Prioritize unattended progress that leaves Zack with a truthful, reviewable result and asks for owner input at real decision points. Strengthen Squire's current run and delivery path before expanding agents or routing. These projects are design references, not platforms to adopt; keep Squire's current workflow and contracts as the baseline.

- **Recoverable runs.** Persist phase and session identity, event cursor, budgets, and output references; reconcile interrupted work before another dispatch, with bounded call/time loops and truthful failed-call accounting. **Evidence gate:** restart fixtures prove one dispatch, no budget reset, retained events/trajectory, and unknown usage remains unknown. [Warren's persisted event stream and replay](https://github.com/jayminwest/warren/blob/main/docs/operations.md#L50-L54) · [mini-swe-agent's failure saves](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py#L98-L121) · [bounded limits](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py#L132-L159).

- **Preserved work and verified delivery.** Keep candidate diffs, logs, and artifacts when work fails or times out; mark candidates unaccepted until fresh review and required checks pass, and distinguish “no change” from delivered. **Evidence gate:** success, failure, timeout, and empty-result fixtures retain the right artifacts and status; delivery has a remote commit/tree receipt and check result. [Warren's recovery and Git-delivery boundary](https://github.com/jayminwest/warren/blob/main/README.md#L55-L64).

- **Execution-boundary preflight.** Declare each runner's workspace/Git base, allowed paths, process/session, shell or GUI support, artifact export, and cleanup capabilities; validate at the same boundary where the agent runs. **Evidence gate:** unsupported or misconfigured capabilities fail before agent dispatch. [Warren's frozen run contracts and provider capabilities](https://github.com/jayminwest/warren/blob/main/docs/architecture.md#L25-L56) · [OpenHands' local and ephemeral workspace options](https://github.com/OpenHands/software-agent-sdk/blob/main/README.md#L30-L38).

- **Phase handoffs and independent review.** Give each phase a bounded, versioned artifact with an owner and acceptance state; keep final review read-only and separate from the writing context, backed by behavioral checks. **Evidence gate:** no result is delivered until review and required checks examine the same candidate revision. [MetaGPT's roles and standard procedures](https://github.com/FoundationAgents/MetaGPT/blob/main/README.md#L41-L44) · [Open SWE's read-only reviewer](https://github.com/langchain-ai/open-swe/blob/main/AGENTS.md#L5-L8) · [behavioral test guidance](https://github.com/langchain-ai/open-swe/blob/main/AGENTS.md#L48-L59).

- **Visual evidence for interface work.** When a task includes a GUI, retain an actual screenshot/recording and preview reference tied to the candidate revision; keep access scoped and time-bounded, and describe a preview as a preview rather than product acceptance. **Evidence gate:** reviewers can open evidence for the candidate and preview access closes on expiry. [Warren's preview lifecycle and security limits](https://github.com/jayminwest/warren/blob/main/docs/previews.md#L68-L80).

- **Keep coordination and model use efficient.** Prefer the fixed-role workflow and existing approved subscriptions; track calls, retries, handoffs, wall time, usage, and owner recovery work. Treat configurable workflows as later controlled comparisons after the larger-benchmark baseline is complete and independently graded; preserve frozen inputs/evidence and keep model routing in its existing deferred, low-priority stage. **Evidence gate:** add coordination or routing only when independently graded delivery quality improves, or is equivalent at lower total cost without more owner interventions. [ChatDev's configurable phases, roles, and replay modes](https://github.com/OpenBMB/ChatDev/blob/main/README.md#L65-L95).

## Phase-owned evolving specialist teams — future, unstarted

Planning, implementation and review should each own a versioned team of specialist subagents. Each phase can identify missing capabilities, propose and define new specialists, refine or retire existing specialists, and improve how it selects and combines them. Team growth is an optimization candidate; it must earn its coordination cost through measured outcomes.

Start after the current larger-benchmark baseline has completed and been independently graded. Choose the first phase from measured bottlenecks, then trial the smallest useful team in that phase before expanding. Compare against the existing phase and a simple skill or deterministic tool where appropriate, under comparable aggregate budgets. Do not change frozen benchmark configurations or evidence to introduce the trial.

Each specialist needs an explicit purpose, input/output contract, approved skills and tool profile, fixed authorized model and permission ceilings, budget, version, provenance and evaluations. Creation and invocation are bounded by trusted admission and aggregate call/time limits; specialists cannot recursively grow teams or grant themselves additional authority.

Evaluate individual specialists, the whole phase, and independently graded delivered outcomes, including coordination calls, latency, token use, repairs and unknown usage. Use frozen training cases for development, separate validation for selection, and an untouched final holdout after the team and routing/composition are frozen. Specialists cannot grade or promote themselves or receive private evaluator answers.

Require independent admission and promotion, immutable versioned receipts and rollback to the previous team configuration. Preserve controller verification, ownership, protected paths, fresh review, CI, delivery and evidence gates. Keep a change only with credible quality gains or equivalent correctness at lower total cost; adding specialists alone is not progress.

## Model selection sketch — future, unstarted

Task signals → cheap classification (for example, Luna) → simple routing policy informed by public benchmark metadata and Squire outcomes → selected execution model → independent grading feeding future routing calibration.

Keep selection vendor-neutral and start with simple rules before a learned selector. Fall back to the established fixed-role models when classification or evidence is uncertain. Public benchmark scores need local validation: compare delivery quality and token use against the fixed-role baseline, including classification and routing overhead.
