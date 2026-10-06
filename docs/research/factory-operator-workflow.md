# Squire operator visibility and decision workflow

Research snapshot, 6 October 2026. Public-safe source inspection only. All new interfaces, fixtures and implementation slices below are proposed and unexecuted. This audit ran no model/provider calls, capability probes or benchmarks. Ordinary repository CI for the documentation PR is separate and does not execute these proposed fixtures.

See the [research index](README.md) for evidence labels and dependencies and the [roadmap](../roadmap/README.md) for retained commitments. Publishing this memo does not authorize implementation or lift any execution hold.

## Recommendation

Add a small owner-facing projection of Squire's existing state, events and recovery receipts. Its first screen should answer five questions: what is actually running, what last made durable progress, what deliverable remains, what happens next automatically, and what exact decision needs the owner. Start with CLI JSON and a concise text view; let a later dashboard consume that same contract.

This is the operator-facing completion of the existing recovery and P5 status work, not a new recovery engine, scheduler, heartbeat database or general dashboard platform. Recovery owns operation identity and settlement; acceptance owns claims about delivered behavior; preflight owns execution readiness and benchmark invocation correlation. This design owns their concise presentation, the owner decision queue, observation gaps and notification lifecycle.

The first useful outcome is modest: after reopening an interrupted project, the owner can tell whether work is active, waiting, blocked or unknown, inspect the retained candidate, and take one properly scoped next action without reconstructing logs. An always-running controller and frequent messages are not measures of progress.

## Source baseline and existing facilities

The inspected public main is [3a0f9213e2a98cef3532a34a520b328297716193](https://github.com/Zkrausman/Squire/commit/3a0f9213e2a98cef3532a34a520b328297716193), including PR103's acceptance/admission clarifications. Source claims below are tied to this pin. They describe implementation and existing fixture source, not newly observed runtime behavior.

### Reuse what exists

- The CLI already exposes `status`, `events --after=N`, `doctor`, `pause`, `resume`, selective retry, and guarded recovery/admission commands. `status` returns `publicState(store.get(id))`; `events` emits cursor-addressed records. There is no need to invent another project store. [CLI](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/bin/squire.mjs#L81-L109)
- The local control API exposes the same project snapshots and event cursors, plus pause/resume. It binds to loopback, requires a private token and rejects browser Origin requests. Its in-memory active-controller map is not exposed as workload liveness. Preserve this boundary; do not host the control token or open browser ingress to make a dashboard work. [API](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/api.mjs#L8-L78)
- SQLite stores project state, ordered events and leases. State transitions and their associated events can commit together. Events are globally cursor-numbered; `Store.events` defaults to 200 records per call, and the CLI/API use that default. This is a page size, not a complete-history guarantee or a hard limit on internal callers. [Store](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/store.mjs#L131-L176)
- Scheduling already distinguishes ticket phases, capacity backoff, dependencies, ownership conflicts, repository publication lanes, repair ceilings and terminal project completion. Existing fixtures cover concurrency, serialization, independent blocked slices and capacity waiting. Expose these reasons rather than introducing parallel scheduling rules. [Scheduling](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/controller.mjs#L145-L188), [fixtures](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/test/scheduling.test.mjs)
- The process supervisor retains start/end, exit/timeout/stop/output-limit flags and log paths. The recovery design already proposes stronger registered process identity, immutable manifests and settlement; P5 already proposes controller/invocation/process/progress correlation. Use those records once implemented. [Supervisor](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/process.mjs#L80-L110), [recovery](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/docs/research/factory-recovery.md), [P5 contract](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/docs/research/factory-runtime-preflight.md#task-alive-benchmark-alive-and-progress)
- Benchmark reports already deduplicate jobs, distinguish pending from terminal outcomes, preserve unknown/conflicting usage and keep calibration unscored. Retain that vocabulary. The `sessions` metric is derived from distinct job IDs; it is not a current count of live provider sessions. [Reporter](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/benchmark-report.mjs#L3-L53), [fixtures](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/test/benchmark-report.test.mjs)
- Operations documentation already says event sinks can notify on completion/blockers. The roadmap retains a dashboard and eventual durable cloud metrics, but explicitly places them behind dependable local delivery and evidence. This proposal supplies that sink's minimum contract; it does not replace those commitments with a new platform. [Operations](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/docs/OPERATIONS.md), [roadmap](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/docs/roadmap/README.md#other-retained-commitments)

### Gaps that matter to an owner

1. **Durable state is not current liveness.** A persisted `running` or `implementing` value can outlast its process. `publicState` removes configuration but does not add current observations. PID leases are useful ownership controls, not complete process identity or historical uptime evidence.
2. **Reservation is not launch.** The controller increments the call counter and emits `job.started` before `runtime.execute`; the adapter then performs its own preflight before spawning the job. An old unmatched `job.started` cannot prove a running agent or a free retry. [Dispatch order](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/controller.mjs#L211-L254), [adapter](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/runtime-codex.mjs#L51-L63)
3. **A fresh timestamp is not useful progress.** `Store.update` always refreshes `updatedAt`; waiting loops and propagation call it without completing work. Only selected runtime events are retained in controller state. Generic output, polling and `updatedAt` must not animate a progress indicator. [Store updates](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/store.mjs#L156-L164), [wait loop](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/controller.mjs#L181-L209), [selected runtime events](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/controller.mjs#L228-L251)
4. **Queue reasons are partly implicit.** Capacity and CI timestamps exist, but lease contention, ownership overlap, dependency eligibility and maximum parallelism are mostly scheduler decisions. A snapshot alone cannot distinguish every reason a queued ticket is not launching. Missing reasons should be labeled unknown until the scheduler records them.
5. **A generic retry can be too broad.** The CLI supports `resume --retry --ticket=ID`; the HTTP API only exposes project-level retry. Plain CLI `resume` changes state and exits; API resume also calls `launch`. In a CLI-only session, a resumed queue can still lack a controller. Even selective retry clears project-level blocker/status and requeues failed project acceptance entries; it is not isolated to one ticket's fields. `pause` sets the durable flag; the controller observes it at boundaries and waits for active work to settle. The pause response does not prove quiescence. [CLI resume](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/bin/squire.mjs#L84-L88), [store retry guards](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/store.mjs#L833-L861), [API resume](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/api.mjs#L62-L65), [pause flag](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/store.mjs#L178), [pause boundary](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/controller.mjs#L145-L148)
6. **Events are not a notification delivery ledger.** Each CLI `run` begins emitting from cursor zero; the separate `events` command accepts an explicit `--after` cursor. Durable cursors enable consumers, but do not by themselves deduplicate owner decisions, persist delivery attempts or resolve an accepted message whose acknowledgment was lost. [CLI event emission](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/bin/squire.mjs#L99-L104)
7. **`doctor` is not a passive status query.** It initializes project state and invokes runtime/delivery preflight; runtime preflight runs authentication/catalog operations. Its `ready: true` does not establish actual agent launch, benchmark activity or product acceptance. Never poll it as the operator monitor. Existing `status` also constructs the general Store, whose constructor creates directories/schema; the new observational reader should explicitly open existing state read-only and fail clearly when absent. [CLI doctor](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/bin/squire.mjs#L81-L95), [runtime preflight](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/runtime-codex.mjs#L51-L60), [Store constructor](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/store.mjs#L133-L140)

## Minimal owner status contract

Use a versioned `operatorView` projection, leaving existing project schema/status semantics intact. Proposed CLI names below are examples, not implemented commands: `status --operator` for concise text and `status --operator --json` for consumers. Keep current machine output backward compatible. No model call is needed to produce the view.

Every claim must identify its source and age. A compact record needs:

| Field group | Minimum contents |
| --- | --- |
| Identity and completeness | View version; project/run ID; state-generation identity; relevant contract/config digest; generated time; source snapshot time/cursor; `complete`, `partial` or `unavailable` and reason |
| Controller | `observed_alive`, `observed_stopped` or `unknown`; observed-at time; registered controller/host instance if available; freshness limit; shutdown/lease evidence reference |
| Work disposition | Per-project counts and per-ticket rows for `queued`, `active`, `waiting`, `idle`, `paused`, `blocked`, `terminal` or `unknown`; underlying durable phase; reason code and source |
| Actual operations | Operation/job ID; role and kind such as agent, check, setup, Git, delivery or benchmark; launch state; process observation and age; terminal receipt; cleanup state |
| Durable progress | Last material milestone, source event/receipt ID, time, ticket/candidate identity; separate last lifecycle transition and last activity observation |
| Pending result | Intended outcome; exact candidate or `not yet created`; gates passed/pending/failed/unknown; next retained artifact or delivery milestone; result/evidence references |
| Next step | `automatic`, `owner`, `external` or `unknown`; reason; next check/retry time or condition; applicable deadline and remaining existing budget; linked decision IDs |
| Accounting | Durable calls used/ceiling; reservations versus confirmed launches when available; known/unknown usage; last relevant retry/repair; downtime/coverage labels |

Avoid a giant envelope of raw logs. The default view shows the headline, active operations, the last useful milestone, the next deliverable and decisions. Detailed history remains accessible by stable IDs. Show independent work continuing when one ticket blocks. Project status must not hide a blocked slice or falsely imply the entire project has stopped.

### Interpret the layers separately

- **Controller:** alive as observed means only that the identified controller was observed at that time. An old lease or snapshot produces unknown/stale. A task wrapper or service listener is not an agent.
- **Agent invocation:** reservation/intention, confirmed launched, launch unknown and terminal are separate. A terminal job can coexist with an alive controller performing verification. No terminal receipt leaves the outcome pending/unknown even if the local PID has disappeared.
- **Benchmark invocation:** use P5's admitted run/attempt/config and registered invocation identity. A benchmark spawned inside an agent session is not observed merely because its enclosing agent is alive. With no trusted benchmark hook, report benchmark progress unavailable. If no benchmark was requested/admitted, show not applicable or not admitted, not a stalled benchmark.
- **Process:** running as of a time is process liveness, not useful work or CPU utilization. Terminal workload plus unsettled cleanup must be visible as two facts. Never revive the running label because cleanup is pending.
- **Progress:** milestone and timestamp must come from the relevant work owner and immutable output. Candidate checkpoint retained, a configured verification receipt completed, a matched CI gate satisfied, a benchmark-owned checkpoint advanced and final acceptance recorded are valid kinds. `thread.started` is lifecycle activity; stdout bytes and an unchanged poll are not deliverable progress. A failed check is a useful new finding, shown as such rather than a successful milestone.
- **Completion:** show process completion, delivery and acceptance separately. `project.completed` describes existing configured gates; it does not retroactively establish version-2 criterion acceptance. Keep legacy evidence labels and the accepted/blocked/incomplete layers from A2/A3. A shipped ticket does not alone prove integrated project acceptance.

`idle` has a strict meaning: complete, sufficiently fresh evidence says there is no active operation and no currently eligible admitted work. It may be legitimate. Known queued work lacking a controller is `queued; controller stopped`, or `unknown` if controller evidence is missing. Capacity backoff and CI polling are `waiting` with reasons. An incomplete or inaccessible source is never converted to idle. A pause with a live job displays `pause requested; job settling`, not settled pause.

There is no generic silence-means-hung rule. Configure observation freshness and bounded read-only inspection separately from existing execution deadlines. A stale observation can trigger a limited receipt/identity read with backoff; it cannot trigger a replacement job or reset its deadline. Without a declared trustworthy progress cadence, say `progress unconfirmed` rather than `stalled`. Accept progress sequences only through the declared producer/parser tied to the operation; arbitrary log text cannot change identity, acceptance or authority.

### A concise synthetic example

```text
Project sample: waiting for capacity
Controller: alive as of 14:02:10Z
Agent: last job ended with capacity rejection; no current launch observed
Benchmark: not admitted
Last durable milestone: candidate abc123 retained at 13:46:09Z
Pending result: fresh review, exact-head CI and delivery
Next step: eligible for retry at 14:20Z, within the existing admission
Calls: 7 of 12 reserved; usage incomplete
Owner decisions: none
```

If the observer is stale, replace current-liveness claims with last-observed facts. If the project is under an execution hold, replace the automatic retry statement with `held; no restart scheduled`. A retry timestamp is eligibility, not a promise of dispatch or permission to lift a hold.

## Read consistency and data dependencies

Build the first projection from an existing-state read-only connection. Read the project snapshot and an event high-water cursor in one consistent transaction. Replay only records through that cursor. Paginate until that bounded horizon is covered; do not stop because a page contains 200 events or because global cursor numbers have gaps. Cursors are global, so another project's events legitimately create gaps. A complete bounded query with no remaining project records can finish below the global high-water; never spin waiting for this project's cursor to equal it. Detect wrong generation, unavailable history or import/retention discontinuity through explicit source metadata, not numerical contiguity.

Events do not currently encode every state mutation. The snapshot remains authoritative for durable phase/counters, and receipts for the facts they establish. Do not claim an event-only replay reconstructs all current scheduling state. Add one compact scheduler explanation when its eligibility/wait reason changes, rather than another event every polling tick. Use a shared scheduler decision function or actual recorded decision; do not duplicate a subtly different scheduler in the view.

| Fact | Available now | Additive dependency |
| --- | --- | --- |
| Durable phase, blocker, pause request, counters, retry/CI times, candidates | Project state and existing events | Pure projection and explicit evidence-quality labels |
| One current snapshot plus bounded history | Store primitives exist; CLI/API lack a coherent view envelope | Read-only snapshot/high-water method; state-generation identifier and source completeness |
| Why eligible work is not dispatched | Some inputs available; actual lease/conflict outcome often implicit | Change-only scheduler reason receipt, using existing admission/scheduling code |
| Reliable current controller/child identity | PID lease and active files are incomplete | R1's supported host identity and registered operation lifecycle; bounded observational reads |
| Last retained work and exact delivery facts | Candidate/state references and partial receipts | R2/R3/R5 manifests for stronger claims; missing legacy facts remain unknown |
| Actual benchmark process and progress | Not inferable from an enclosing job | P5's single invocation/process/progress contract; no separate operator implementation |
| Criterion acceptance and readiness | Existing limited gates; proposed stronger receipts | A2/A3 and P0-P5 respectively; absence does not stop basic status rendering |
| Decisions, acknowledgment, notification history | Not represented as a complete lifecycle | Small store-backed decision and delivery records derived from existing evidence |

Observational status must not run `doctor`, acquire controller leases, reconcile/kill processes, launch checks, restart work, change budgets or query a provider to create reassuring freshness. Read operations/manifests under declared managed roots and retain evidence-access errors. Optional remote check refreshes need a separate bounded, authorized observation path; opening the status view must not hide network or execution work.

## Decision queue for low-intervention operation

Create one durable decision per root condition, not one per downstream ticket or repeated event. The queue is a filtered index of actual owner boundaries. Automatic waits remain in status and do not become decisions simply because they last longer than expected.

A decision record needs:

- Stable ID, project/state generation, root operation/ticket/candidate identity and first source cursor.
- Reason code, concise observed consequence, affected dependents, source receipt links and last material revision.
- The smallest owner choice or action, its exact target and prerequisites. State whether it can spend calls, change scope, publish/merge, alter an environment or affect an already delivered revision.
- Existing authority/admission reference and whether new authorization is required. Text generated by a worker or a notification acknowledgment cannot grant permission.
- Status `open`, `acknowledged`, `deferred`, `resolved` or `superseded`; optional owner-chosen revisit time; resolution evidence. Acknowledgment is not resolution or retry approval.
- Priority from a configured, deterministic policy; due time only when backed by a real deadline; notification revision/fingerprint.

Use `(state generation, project, root condition, affected identity)` as the correlation key. If one failed predecessor blocks six dependents, show one root decision with six affected tickets. An independent repository can continue. A new candidate, changed authority or a materially different error creates a revision or superseding decision, not reuse of stale approval.

### Exact escalation rules

| Observed condition | Automatic behavior already permitted | Owner-facing decision or message |
| --- | --- | --- |
| Capacity backoff before `retryAt` | Wait without another agent dispatch; enforce existing counters and later R4 hold limits | No decision unless a real deadline/budget policy needs one; state eligibility time |
| Bounded check/repair or transient GitHub retry remains admitted | Continue existing policy; retain each attempt and next check | No routine interruption; report only a material scope, consequence or policy change |
| Controller/workload observation stale or identity unknown | Bounded read-only inspection; defer overlapping work to R1 reconciliation | Explain what cannot be established. Ask for the one unavailable access/host action only when needed; no guessed PID kill or blind restart |
| Auth, native capability or environment prerequisite missing | Stop affected dispatch; preserve useful candidate and evidence | Name the prerequisite and approved route. After correction, offer the narrow guarded revalidation/resume path; no weaker-sandbox fallback |
| Repair/slice/call ceiling exhausted | Stop under the existing durable policy | Preserve failure and counters. Ask whether to stop or authorize a specific supported admission; never automatically increase the ceiling |
| Scope/ownership/protected-path or frozen contract conflict | Block affected work | Request a scoped decision with the conflicting paths/contract, not broad permission to fix anything |
| Candidate/publish/merge outcome uncertain | Use existing exact-identity recovery when authorized; otherwise block | Show retained evidence and the reconciliation needed; no repeated publication based on an absent response |
| Postmerge check or integrated acceptance fails | Keep the actual delivered identity and halt the relevant lane under existing rules | Clearly say the revision is already delivered and which check failed. Retry only after the prerequisite is resolved; no automatic rollback or new correction admission |
| Process ended but result/acceptance artifact missing | Mark result incomplete and retain artifacts | State the missing manifest or acceptance layer. Do not call it done or start another model just to create a summary |
| Explicit pause, execution hold or closed program | Stay held/closed; read-only inspection is possible | Record the hold and permitted next action. Calendar time, quiet-window end or restored capacity cannot reopen it |

For an ordinary eligible blocked ticket, an action may name the existing selective CLI path `resume project.json --retry --ticket=ID`, but only after validating its current guards, disclosing its project-level acceptance/blocker effects, and checking authority for all work it may reactivate. If no run/serve controller exists, the separate `run` step must be explicit; do not claim the CLI resume starts it. For tickets with an existing interrupted-candidate verification record, retry and re-checkpoint are forbidden. Offer normal resume only when the current state and authorization permit it; otherwise name the precise unresolved guard. The action catalog must honor those guards rather than recommend generic retry. [Recovery guards and retry](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/store.mjs#L833-L861), [one-time checkpoint guard](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/src/store.mjs#L486-L493)

A first implementation can show actions without executing them. If action execution is added later, resolve a fixed action type to existing controller/store operations, re-read evidence and authorization immediately before execution, and compare the exact target/candidate/policy/decision revision. Reject stale or duplicate responses. Never execute a shell command supplied by a log, blocker message or model. A fresh owner reply authorizes only its stated action; it does not authorize every later queue item.

## Honest time and downtime accounting

Report evidence coverage before uptime. A process absence observed now does not establish when it stopped; a fresh heartbeat after a gap does not establish continuous availability. The existing wall-clock `elapsedMs` is elapsed duration, not active runtime, useful work or downtime.

Maintain separate interval ledgers for controller presence and admitted workload occupancy. Within a chosen window, each ledger partitions time into mutually exclusive, evidenced categories and an explicit unknown remainder. Workload categories can include supervised active execution, known automatic wait, owner-held/pause, blocked awaiting action, eligible-but-not-running and unknown. Parallel jobs use the union of execution intervals for wall time; sum per-job durations separately as worker time. Never add controller and job durations into one utilization denominator.

An interval is known only when its boundaries and continuity are supported by a trusted lifecycle receipt or a declared observer contract. Independent point observations do not silently certify the time between them. Terminal supervisor receipts can establish supervised process lifetime after validating launch/exit and clocks; they do not establish continuous model computation or benchmark progress. Launch failure is not a successful process interval. Missing terminal receipts leave an unknown tail until reconciliation supplies evidence.

Record UTC timestamps for display and a monotonic duration/host-boot identity for new same-host observations. Do not subtract monotonic times across boots. Clock rollback, conflicting receipts or invalid intervals become unknown with reasons; never clamp them into a favorable zero. Legacy wall-clock-only durations keep their limitations visible.

Separate these questions:

1. **Observation coverage:** what fraction of the report window has reliable interval evidence?
2. **Known interruption:** how much evidenced time did an expected controller/workload remain unavailable while admitted work was eligible?
3. **Waiting and intervention:** how much evidenced time was capacity/CI/dependency wait, owner pause, external block or owner-decision wait?
4. **Useful advancement:** what durable milestones actually changed, and when? No utilization percentage substitutes for that answer.

Only calculate an availability fraction after defining when operation was expected, which waits are excluded and how unknown time is shown. Prefer `known unavailable 12m; unknown 48m; observed window 2h` to an apparently precise uptime score. Never count the unknown 48m as either healthy or confirmed downtime. An optional lower/upper bound must state its denominator and treatment of unknowns.

For example, a controller observed alive at 10:00 and found absent at 11:00 has an uncertain stop within that gap. With no stronger evidence, report the gap unknown and absence as of 11:00. If reconciliation later imports a valid termination receipt at 10:17, revise the interval with provenance; preserve the prior incomplete report. Even an empty active-operation registry only proves no registered work under its coverage contract, not that no unrelated host process exists.

Owner effort is separate: count substantive requested decisions and interventions from receipts; record owner minutes only when supplied or measured by an explicitly agreed method. Time waiting for a reply is not minutes of owner labor. Do not infer a private schedule from silence.

## Quiet notifications without lost decisions

The proposed CLI decision queue remains the primary interface whenever its local state is accessible. External messages are an optional sink with an explicitly authorized destination and bounded content policy. Reuse existing state/events plus a small local outbox/delivery ledger; no new service, remote token store or cloud metrics dependency is needed.

### Configurable policy

The local operator policy should contain an IANA time zone, quiet windows, digest timing or maximum defer interval, notification categories, optional reminder cadence/ceiling, urgent exceptions and destination identity. Public examples use synthetic values only. Missing configuration means local queue only; do not guess the owner's schedule or send to an inferred channel.

Quiet windows govern messages, not execution authority. A separate run-admission policy governs pauses, deadlines, call ceilings and holds. A quiet-window end neither launches work nor lifts an owner hold. Timestamp computations need tested DST and cross-midnight behavior; choose and document how ambiguous/missing local boundaries resolve.

Normal messages are for a newly actionable decision, a material change to an existing decision, a requested significant milestone or a terminal result with inspectable evidence. Do not send keep-alives, unchanged polls, repeated quota notices or messages suggesting continuous activity. Coalesce related nonurgent changes into the latest concise account. If a blocker resolves before its quiet-window release, suppress its obsolete action request and include the resolved outcome only when useful under policy.

Urgent bypass must be explicit and evidence-based: for example, a verified owned process continuing beyond an authorized cost/runtime ceiling, a credible retained-evidence loss risk, or an actual security/safety incident covered by configured policy. A generic timeout, missing heartbeat, ordinary review rejection, ordinary subscription wait or a postmerge source check failure is not automatically an emergency. A real consequential deadline can qualify when the configured policy says delay materially changes the owner's options. Notification priority never grants repair, financial or security authority. Already authorized safe containment belongs to the controller/recovery policy, not to the message sender.

### Deduplication and uncertain delivery

1. Consume bounded event pages from the persisted consumer cursor. Derive/coalesce decisions and enqueue notification intent in one transaction with cursor advancement. Cursor commit without intent is a lost message risk; intent without cursor must be harmless on replay.
2. Give each intent a stable key from state generation, decision/result identity, material revision, message kind and destination. Unchanged event replays, process restarts and repeated polling cannot generate new keys. A changed wall-clock age is not a material revision.
3. Use a single sender claim or compare-and-swap on the delivery record. Persist an attempt identity before transport. Prefer a destination-supported idempotency key or exact message lookup to reconcile crash-after-send/lost-response windows.
4. If the endpoint has neither idempotency nor reliable readback, exactly-once external delivery is not guaranteed. Mark uncertain attempts `delivery_unknown`, expose them locally, and do not blindly resend. This prioritizes avoiding duplicate messages at the cost of an explicitly visible possibly missed notice. A later deliberate resend must record the reason and possible duplication.
5. Record accepted/sent/provider-ID/error separately from owner acknowledgment. Transport acceptance does not prove read or action. An acknowledgment neither closes an unresolved decision nor authorizes retry.
6. Recheck current decision revision, quiet policy, destination and resolution immediately before sending. A stale outbox item becomes superseded. Serialize or reconcile races with owner responses so an old request does not reappear after resolution.

Reminder policy is opt-in/configured and bounded, with one persistent next-reminder time per decision. Send again only at that approved time or for a material consequence change. Urgent repetition also needs a policy limit and escalation rationale; it cannot bypass deduplication. When multiple projects share a common capacity blocker, a digest can group them while retaining their separate authority and budgets.

If the controller and its local sink are down, neither can promise immediate notification. Report the gap on recovery. A separately approved external watchdog is a later option; do not imply 24/7 monitoring from a local process. A broken notification channel leaves the queue visible and records an actionable delivery problem; it does not justify unapproved fallback outreach.

## Security and disclosure boundary

`publicState` means a control-API view, not permission to publish it to the public internet. Ticket specs, workspace paths, blockers and logs may contain proprietary material. Use an allowlisted export for the owner message: project/ticket alias, outcome, reason code, safe summary, scoped action and verified evidence link. Keep raw prompts, source text, credentials, private evaluator material and local filesystem paths out of external payloads. Access to evidence must be checked for the destination; lack of a shareable artifact becomes a precise local-inspection instruction, not an unauthorized upload.

A future dashboard should render the same versioned projection from an explicitly approved sanitized snapshot or authenticated read boundary. Its initial version is read-only. Cloud storage, retention, permissions and ownership need their own design when that retained roadmap item becomes active. Do not widen today's loopback control API or make dashboard availability a requirement for local recovery.

## Proposed acceptance fixtures

All cases below are deterministic synthetic fixtures for later authorized implementation. They were not executed for this research. Use fake clocks, inert event/receipt records, injected process-observation answers and an in-memory fake notification endpoint; no live provider, benchmark or capability probe is needed for the projection/queue/sink tests.

| Fixture | Measurable required result |
| --- | --- |
| Old `running` snapshot with no current observation | Controller and job liveness unknown; zero active-work claims derived solely from snapshot |
| `job.started`, then preflight failure before launch | One retained call reservation; no confirmed launch; no automatic refund/retry authority |
| Controller alive during capacity wait | Controller alive and workload waiting; exact `retryAt`; zero progress increments and zero owner decisions without another policy trigger |
| Ten thousand unchanged polling/state updates | Milestone time/ID unchanged; zero new notification intents; no artificial percentage advancement |
| Agent live, inner benchmark uninstrumented | Agent observation shown; benchmark process/progress unknown, not inherited |
| Task/controller alive after benchmark process exits | Benchmark terminal result and cleanup/evaluation states shown separately; zero automatic relaunches |
| Active check after agent terminal result | Agent terminal and verification active; no suggestion that the agent is still implementing |
| Pause requested during active work | Settling shown until trustworthy terminal/quiescence evidence; acknowledgment does not claim stopped |
| One blocked predecessor with six descendants and one independent ticket | One root decision, six dependency links, independent ticket remains eligible/active |
| Eligible ticket with stopped controller | Queued, controller stopped and exact launch prerequisite; not idle or running |
| 401 target-project events interleaved with other projects, plus a snapshot change during reading | All relevant records through the captured high-water are considered once; global gaps accepted; snapshot and history remain one declared generation/horizon; an empty final project page terminates below a later global high-water |
| Receipt missing/corrupt, source history partial or generation changed | Explicit partial/unknown result; no fabricated terminal success or cursor reset causing re-notification |
| Reused PID or inaccessible process identity | Unknown identity; no active/terminal inference and zero kills/launches by the view |
| Two parallel jobs overlap for 5 of their 10 minutes each | 15 minutes union wall time and 20 minutes summed worker time, clearly separated |
| Observer absent for 48 minutes | Exactly 48 minutes remain unknown absent later valid receipts; never silently assigned healthy/down |
| Clock rollback or cross-boot duration | Invalid elapsed segment unknown; no negative duration or favorable clamp-to-zero |
| Decision acknowledged while blocker persists | Acknowledged/open obligation retained; zero automatic resume or budget change |
| Candidate or policy changes after an action is displayed | Old action revision rejected/superseded before execution; existing permissions/counters unchanged |
| One-time interrupted-candidate record | Generic retry never offered; correct guarded next path named with unresolved prerequisites |
| Replay same event pages after crash; two consumers race | One decision per root condition and one intent per material revision/destination |
| Crash after transport accepts but before receipt persists | Idempotent/readback endpoint resolves one message; unsupported endpoint remains delivery-unknown with zero blind retries |
| Blocker resolves inside quiet window | Old request not sent; at most one current policy-eligible digest/result |
| Quiet window crosses midnight and DST transitions | Deterministic documented release time in the configured zone; no duplicated reminder or accidental early release |
| Verified urgent ceiling breach during quiet window | One urgent intent if policy permits; unchanged polls add none; containment authority unchanged |
| Ordinary silence or timeout during quiet window | No urgent bypass merely because it looks stalled; normal decision/deadline policy applies |
| Execution hold and closed-incomplete program | Status remains held/closed; zero new admission, resumed run, benchmark or renamed success |
| CLI view read on missing state and on existing state | Missing state returns a clear error; existing read causes zero project/event/call/lease mutations and no subprocess/provider invocations |
| Unsanitized blocker containing a secret/private path | External export omits it, retains safe reason/reference and does not publish raw `publicState` |

The offline exit target is all applicable cases passing with invariant checks for zero unauthorized dispatches, zero duplicate reservations, zero wrong-candidate actions and zero intentional duplicate sends for unchanged intent. A fake endpoint can prove the local deduplication protocol, not a real transport's delivery guarantees.

Also bound the observer itself: declare maximum files/records/bytes per refresh, local observation timeout and idle polling/backoff. A refresh exceeding that budget returns partial with the last valid cursor and an exact continuation point. It never starts a broader host scan, invokes a provider or marks the missing remainder idle. Include a synthetic large-history/output-flood fixture that enforces those bounds.

## Bounded implementation slices

No slice is authorized by this memo. Source analysis and schema/fixture specification can be finished during a research-only period; code changes and all execution require their separate admission.

| Slice | Dependencies | Bounded output and exit condition |
| --- | --- | --- |
| O0 Freeze the operator vocabulary | Existing R0/A1 and P5 designs | Review this schema, state mapping and root-decision examples; remove duplicate ownership with R/P/A designs. Documentation only. |
| O1 Add a passive CLI projection | O0; current state/events | Read-only existing-state reader, coherent snapshot/high-water, JSON schema and concise renderer. Use unknown for missing liveness/progress. Legacy/missing-state/pagination/no-op fixtures pass without process/provider calls. |
| O2 Add decision projection and local acknowledgment | O1; existing blocker/retry guards | One root-condition queue, deterministic action descriptions, revision/precondition handling and no automatic execution. Record acknowledgment/defer separately from authority. Dependency/stale-action/one-time-admission fixtures pass. |
| O3 Consume stronger observation receipts | R1/R3; R2/R5/A2/A3 only for their stronger claims | Add change-only scheduler explanations and interval coverage. Reuse P5 for benchmark correlation rather than implementing it again. Live/terminal/unknown and downtime fixtures pass; no new recovery engine. |
| O4 Add one optional notification sink | O2; one explicitly authorized destination/policy | Transactional intent/cursor, one sender, transport-specific uncertainty handling, quiet/digest/urgent rules and sanitized payloads. Fake transport crash/replay tests pass before separately authorized real sends. |
| O5 Verify one owner workflow | Relevant completed O/R/P/A slices and separate task authorization | On one already admitted owner task, measure correct status, decisions, duplicate messages, evidence coverage and recovery effort. Require inspectable retained work and exact next action; do not require a new benchmark campaign. |

O1/O2 provide value before every recovery hardening slice is complete because unknowns are explicit. O3 must not invent certainty for older runs. O4 can remain absent: a truthful CLI queue is a complete first deliverable. The existing R7 delivery-only versus criterion-accepted distinction remains in force.

For O5, predeclare the observation window and eligible transitions. Record: percentage of assertions supported by resolvable evidence, unclassified/unknown time, actionable root decisions versus raw blocker events, repeated notices for unchanged conditions, stale actions rejected, owner interventions, and owner-reported recovery minutes if available. The target is no unsupported running/completion claims and no duplicate unchanged notifications. Reduced owner burden is a later measured outcome, not established by fixture success or a busier screen.

## Non goals and stopping conditions

- No new workflow service, distributed leases, agent manager, team dashboard, universal host monitor, S3 pipeline or cloud metrics project.
- No replacement for R1-R5 recovery, A2/A3 evidence resolution or P5 benchmark correlation.
- No automatic model selection, skill/team growth, higher budgets, reopened benchmark baseline, quota scraping or provider calls for freshness.
- No automatic repair from every unknown, no timeline interpolation disguised as uptime, no fabricated percentages or ETA, and no notification schedule designed to look continuously busy.
- No new authority from acknowledgment, silence, time passage, a failed check, a suggested action or a notification policy.

The first implementation is done when a single local project can be inspected honestly and its owner can find the exact pending decision, with replay-safe local history. If a stronger fact requires an unimplemented receipt, display that limitation and stop that claim. If the next action needs broader authority or unavailable environment access, leave the bounded decision open. Keep dashboard hosting behind this outcome.

The [historical v0.1 closure](https://github.com/Zkrausman/Squire/blob/3a0f9213e2a98cef3532a34a520b328297716193/docs/releases/0.1/baseline-closure.json) stays closed-incomplete, with separately unscored manual harness completion and the recorded benchmark/comparative hold preserved. Better visibility must never rewrite those facts.
