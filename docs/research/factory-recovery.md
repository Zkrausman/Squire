# Squire recovery and delivery hardening

Research snapshot: 6 October 2026. Implementation update: 7 October 2026. Status: proposed hardening with R1 active-evidence inventory and a conservative pre-spawn registration/producer-fencing prerequisite implemented. OS process identity, descendant settlement, automatic result reconciliation and the other slices remain proposed.

See the [research index](README.md) for evidence labels and the combined dependency order, and [acceptance design](factory-acceptance.md) for criterion-to-proof resolution.

## Recommendation

Keep Squire's existing local controller and strengthen the small gaps between durable state and external effects. The first useful milestone is a restart that can explain every outstanding operation, preserve its work and counters, and either resume the next valid gate or stop with an exact blocker. Adding another orchestration platform or more agents would not address these gaps.

The highest-priority changes are:

1. Journal controller-created candidate commits so a crash between Git commit and SQLite update does not look like an agent changed history.
2. Reconcile every supervised operation, including planning and GitHub subprocesses, before replacement work starts.
3. Preserve an immutable job result and artifact manifest so completed or failed work can be recovered without guessing from status or spending another agent call.
4. Retain the exact remote check and merge facts used by delivery, rather than only the final ready state.
5. Make quota waits, unknown usage and restart budgets visible without changing frozen benchmark accounting.

This remains an implementation design except for the R1 inventory and registration/fencing prerequisites described below. Deterministic offline fixtures exercise process inventory, grants, malformed records, accounting, lease turnover and persistence failures; they do not prove live provider recovery or remote-effect settlement. No provider, application or benchmark execution was performed for this source audit or that improvement. The remaining proposed fault-injection fixtures were not executed. The other crash windows below are deductions from the pinned code, not reproduced failures.

## Source baseline and limits

The inspected Squire main commit is [ec98a61](https://github.com/Zkrausman/Squire/commit/ec98a61bd6a0fec89246c0b160ca90d2ff363d68), which merged [PR 99](https://github.com/Zkrausman/Squire/pull/99). PR 99 labeled the reliability section unstarted, although many mechanisms it names already exist. The updated roadmap distinguishes implemented foundations, proposed hardening and unproven live acceptance.

This memo uses Squire and public primary sources only. Application examples are generic capability profiles; no private application or evaluation material is included.

The external comparison is limited to Warren, mini-swe-agent and Temporal. All implementation references are commit-pinned. Their patterns are design inputs, not audited runtime guarantees or proposals to adopt their infrastructure.

## What Squire already provides

| Area | Implemented evidence | Remaining distinction |
| --- | --- | --- |
| Durable controller state | SQLite WAL and FULL synchronization; project state and ordered events change together under an immediate transaction; configuration identity is checked on reopening. [Store](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/store.mjs#L131-L176) | A project envelope and event cursor do not yet give each external effect a recoverable, uniquely correlated intent/result record. |
| Single-host ownership | Controller and repository/ticket leases; structured ownership permits isolated work while publication remains serialized. [Scheduling](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L117-L175) | PID-based liveness needs explicit uncertainty handling; it is not a distributed lease or proof of process identity. |
| Process supervision | Shell-free argv, parent lifeline, bounded timeout/output, process-tree termination, stdout/stderr and process receipts. Startup waits for known active processes to settle. [Process supervisor](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/process.mjs#L22-L111) | Receipts live on disk and process IDs are separately generated. Reconciliation does not yet adopt all completed results into the controller. |
| Partial-work recovery | Interrupted implementation re-enters recovery, checks the pre-agent head, checkpoints dirty work, then repeats verification and review. Explicit recovery/continuation paths preserve authority and counters. [Controller recovery](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L329-L372), [fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/controller.test.mjs#L375-L421) | Successful recovery of edited files is different from recovery of a completed provider result or a half-persisted controller commit. |
| Candidate authority | Controller owns Git history, checks protected and owned paths, rejects submodule changes, and rejects an empty change. [Checkpoint](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/workspace.mjs#L90-L103) | The Git side effect and SQLite transition are separate crash boundaries. |
| Exact delivery gates | Verification binds head/tree/check policy; review binds head and a fresh session; changed bases invalidate gates; GitHub requires exact check name/app/head and successful conclusion; merge pins head and validates merge tree/ancestry; postmerge checks precede shipped. [Controller](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L374-L449), [GitHub adapter](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/delivery.mjs#L97-L148) | Passing the live gate is stronger than the compact durable receipt currently retained about it. |
| Lost merge response | Delivery reads the PR before retrying merge; an already-merged PR is verified, not merged again. Local Git has a lost-receipt fixture. [Merge reconciliation](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/delivery.mjs#L131-L148), [fixture](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/controller.test.mjs#L610-L617) | Preserve this boundary while improving publication intent and retrospective evidence. |
| Bounded spending and truthful metrics | Calls increment transactionally before execute; limits bound calls, repairs, rebases, each job and CI; quota produces a durable wait. Usage reports distinguish missing and conflicting values from observed zero. [Calls](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L211-L254), [limits](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/contracts.mjs#L137-L140), [telemetry tests](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/telemetry.test.mjs) | Reservation, actual launch, logical implementation attempt and known usage should be separately explainable. No new token or monetary budget should assume missing subscription usage is zero. |

## Concrete hardening gaps

### Candidate commit can outlive its state transition

The controller calls workspace checkpoint and then writes the new head/tree into ticket state. Checkpoint performs a Git commit. If the process dies after commit but before the transition, the durable ticket still says implementing and retains the old before-agent head. Startup converts it to recovering; recovery then rejects the new HEAD as agent-changed history. This protects against accepting arbitrary history changes, but it can also block a legitimate controller commit whose state write was lost. [Checkpoint and transition](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L332-L372), [Git side effect](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/workspace.mjs#L90-L103).

Proposed fix: add a candidate operation record before changing the managed branch. Record the exact parent, validated index tree, ticket/workspace generation, job, policy digest and operation ID. Use a prepared commit object plus compare-and-swap ref update, or an equivalently recoverable commit receipt. If commit-object creation is repeatable, freeze its metadata as part of the intent. On restart, only adopt the exact expected object and parent/tree. Any other HEAD remains blocked. Apply this journal to normal, automatic-recovery and explicit-recovery checkpoint paths. This is controller bookkeeping, not permission for agents to commit.

### Process inventory and pre-spawn registration are implemented; settlement remains proposed

The audited baseline scans jobs, checks, git-logs, auth-checks and catalog. Planning jobs use planning/<attempt>/job, and GitHub API commands use github-logs. Neither directory was in that list. Parent-death supervision still attempts to terminate those commands, so this was an uncovered settling window rather than proof of duplicate remote effects. [Baseline scanned directories](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/process.mjs#L23-L42), [planning directory](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L256-L280), [GitHub directory](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/delivery.mjs#L5-L16).

Implemented narrow R1 improvement: the [reconciler](../../src/process.mjs) now includes github-logs and the immediate files in planning/<numeric-attempt>/job, and rejects invalid JSON or missing/invalid positive integer supervisor PID, child PID or startedAt fields with the active-file path. A missing child PID, including a launch failure interrupted before its active file is removed, remains unknown and blocks. Only .active.json files in the known process locations are considered; request files, receipts, logs, sibling planning service workspaces and job temporary subdirectories are not process authority. Existing paused/completed-project and controller-lease guards stay in place, as do counters and dispatch policy. [Process fixtures](../../test/process.test.mjs) and [controller restart fixtures](../../test/controller.test.mjs) cover these boundaries and repeated reconciliation.

The standalone legacy scanner remains observation-only, with the existing 50-probe bound and 200 ms waits. It never sends a terminating signal or imports a receipt. Production controller admission now additionally refuses unregistered legacy evidence outright, as described below. A live PID, including one that may have been reused or belong to an unrelated process, prevents progress; permission-denied liveness probes also remain live/unknown. A settled or removed record retains the existing behavior. The stored startedAt is validated for shape only: it is **not** an OS process-start identity, ownership proof or executor identity. No PID-reuse detection or full R1 reliability claim is made.

The existing service-name collision with the reserved-in-practice planning job directory is unchanged: a service named job shares its checkout path with planner artifacts. This slice does not add a service-name policy or migrate that namespace.

The next implemented prerequisite closes the unregistered outer-spawn window using [producer scopes and process operations](../../src/operation-store.mjs) in the existing SQLite store. Each operation is registered before the outer supervisor starts. Compare-and-swap grants admit one supervisor and one target launch; lease turnover cannot grant another launch. Canonical terminal/not-started records are immutable and bind the existing private receipt by digest. Registry rows contain identifiers, paths, hashes and terminal metadata, not prompts, argv or credentials. Call reservation and debit share the existing accounting transaction, with registrations linked to that reservation.

The [controller](../../src/controller.mjs) keeps the producer scope open through its caller's outcome persistence, including all planning, ticket, acceptance, CLI preflight/configuration and explicit recovery producers. Terminal-but-unprojected work blocks a replacement even with a new operation ID. Scope closure requires durable caller outcome and no unresolved operations; final project completion and scope closure are atomic. Persistence failures remain fenced even if a callback catches their error. Registered active evidence uses its scope, not PID death, as authority; malformed or unregistered legacy evidence remains blocked. Standalone test/helper contexts are explicit and never selected through an environment switch.

[Store fixtures](../../test/operation-store.test.mjs), [process fixtures](../../test/registered-process.test.mjs) and [caller fixtures](../../test/producer-controller.test.mjs) cover repeated reopen boundaries, grant duplication, nonzero results, missing executables/invalid cwd, lease turnover, failed registration/terminal/outcome persistence, independent lanes and retained accounting/evidence. Only fake executables, disposable local Git and SQLite are used. Existing states without the new protocol marker refuse automatic producer execution. No unknown scope clearing, replay, automatic terminal import, candidate reconciliation, OS identity proof or descendant settlement is implemented. The proposed replay/import decisions later in this memo remain future design, not current behavior; see [operations](../OPERATIONS.md).

### Completed results and raw events are not a replayable job record

The adapter saves prompt/result files and process logs. The controller persists only selected runtime events and emits job.finished, then separately updates phase state. A crash can therefore leave useful disk evidence beyond the database cursor. Restart generally repeats a phase instead of reconciling a complete job result. Fresh review after interruption is safe, but may spend another call despite an intact completed result. [Selected events](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L222-L254), [adapter outputs](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L61-L119).

Keep the raw JSONL spool. Add job ID, process operation ID, byte/record cursor, last parsed event, session identity, normalized result and file digests to a versioned manifest. On restart, replay complete records after the durable cursor and deduplicate by job plus spool position, verifying the prefix identity. Truncated final records remain incomplete. Result adoption must validate the full process outcome, result schema, workspace identity and current authority. A terminal text message alone cannot establish completion.

The current adapter declares resume false. The immediate design should remain stop-and-reconcile for local Codex sessions. Reattaching a live remote agent is a later adapter capability, not a prerequisite.

### Historical artifacts can be overwritten or detached from their attempt

Process logs have UUID filenames, but prompt.txt, result.txt and worker-temp use the caller's job directory. An explicitly continued logical attempt can revisit that same directory after capacity waiting. schema.json is also directory-scoped, but only planning/review write it; the concrete continuation collision concerns the implementation files. A working directory also changes during repair. This makes a per-job immutable manifest more useful than relying on directory names or a later snapshot of the workspace. [Directory choice](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L352-L365), [file writes](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L63-L90).

Use a unique directory per physical job ID. Preserve a manifest for every terminal outcome, including no change, timeout, cancellation, capacity and failure. Final manifests should be write-once; later reconciliation appends a new receipt that points to the original. Do not overwrite the failed attempt when a retry works.

### Bounded R3 physical-job evidence

Controller dispatch now allocates `jobs/physical/<job UUID>` for every physical call, including planning and repeated capacity waits of one continuation. Logical attempts, repair counts, call reservation/debit and role/model policy are unchanged. An exclusive intent records the current job, producer scope, role/runtime, ticket, attempt, continuation and caller-observed source identities; missing identity is explicit null, never borrowed from an older successful implementation.

The controller exports a write-once `terminal.json` before projecting `job.finished`, whose event binds its digest. Metadata is limited to 128 KiB. A separate private normalized result (including explicit absence for compatible version-1 adapters) is limited to 1 MiB. Known Codex prompt/result/schema and process receipt/stdout/stderr files are referenced by byte count and SHA-256; each artifact is bounded to 16 MiB. Process evidence is checked against its registered job/scope and canonical receipt. The JSONL spool records its complete byte/record cursor; malformed or trailing partial records refuse completion. Manifests omit prompt/result text, arguments, environment, tokens and free-form diagnostics. Private raw artifacts retain their existing sensitivity and must not be published as logs.

Runtime completed, failed, timeout, cancellation and capacity outcomes remain separate. Implementation checkpoint writes a separate immutable `candidate.json` referencing the terminal digest, distinguishing a candidate from no-change or checkpoint failure. A completed runtime manifest alone does not establish a candidate; missing disposition remains unknown. Failed/missing/malformed/conflicting exports leave the existing producer fence held. Atomic no-replace publication uses a synced temporary file and hard link; unsupported filesystems fail closed. This is not a power-loss durability guarantee for directory metadata.

The bounded manifest inventories only these known files, not arbitrary workspace or worker-temp contents. Per-job worker-temp directories are retained without reuse; there is no recursive snapshot/export, cleanup, credential search, artifact platform, receipt import, automatic result adoption/replay, scope release, OS process identity or descendant settlement. Crash fixtures and fake CLI tests provide local evidence only. R3's larger recovery design and R4 remain incomplete; historical benchmark evidence stays frozen.

### The delivery decision is more exact than its stored CI receipt

GitHub inspect selects the latest matching run by descending check-run ID for each required name/app and candidate identity, preferring matching validated synthetic-merge checks, then requires completed/success. It never substitutes an older success for a newer failure. The ready result returns only state and head. The controller transitions to merging without preserving the selected check IDs, app identities or check commit. Publication stores PR number/URL/branch/head; verifyMerge returns merge/tree. Raw subprocess logs may hold additional evidence, but there is no compact normalized chain to review later. [Check selection](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/delivery.mjs#L97-L129), [state update](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L414-L436).

Return and persist the facts used for each decision. Persist a new observation when checks rerun; never mutate the original receipt. Revalidate current gates immediately before merge. Historical success remains evidence of what was seen, not authorization to ignore a newer failed check.

## Minimal durable operation model

Use the existing SQLite database, event stream and local evidence directory. Add a small jobs/operations table with unique operation keys and versioned JSON payloads; do not rewrite the whole controller as event sourcing. Transactionally link ticket transitions to operation creation/settlement.

Each record needs:

- Identity: schema version, operation ID, project, ticket or plan phase, logical attempt, physical job ID, workspace generation, controller build and adapter version.
- Frozen input: config/ticket/check policy digests, authorized role and limits, base/head/tree where applicable, model selection, execution-boundary receipt, input artifact digests.
- Lifecycle: prepared, launch intent recorded, running observed, settling, reconciled terminal, or outcome unknown. Keep provider/session identity separate from controller identity.
- Process facts: registered request/active/receipt references, host boot identity and process start identity where available, controller generation, deadline, stop reason and whether launch was observed.
- Events and artifacts: last durable spool position, normalized event cursor, result/manifest digest, patch or candidate ref, observer identity/provenance, evidence kind, candidate/build hashes, and explicit missing/truncated/export-failed states. Private evaluator inputs and answer material never enter the exported manifest or worker context.
- Accounting: reservation recorded once, logical attempt counters, retry reason, known usage by field, unknown/conflicting usage flags, and any explicit operator admission.

Enforce uniqueness at the store boundary. An operation cannot be settled twice with incompatible results. An expired or missing heartbeat is a reason to inspect; it is not proof that an operation never happened.

### Restart decision order

1. Acquire the project and relevant repository lane. Verify the state schema and frozen authority before considering dispatch.
2. Enumerate all nonterminal registered operations. Establish whether the prior supervisor/child is live, dead or unknown using supported host identity. Never kill an unrelated PID because its number was reused.
3. If live and still within its deadline, let the existing supervisor settle. If cancellation is authorized, cancel through that registered operation and await bounded cleanup. If identity remains unknown, block instead of overlapping writers.
4. Reconcile durable process receipt, raw event spool and normalized result. Import complete evidence once. Do not allocate another job or charge for reading existing evidence.
5. Reconcile candidate operation, pushed branch, PR and merge through their exact identities. Query first after an uncertain response; do not assume the write failed.
6. Preserve artifacts and unknown fields, then move to the next valid gate. Only dispatch a replacement when prior work is terminal, the repair/continuation policy permits it and budgets remain.

| Observed condition | Recovery action | Explicitly prohibited conclusion |
| --- | --- | --- |
| Intent exists and the launch registry affirmatively proves no process started | Resume the same operation identity through a fenced, exclusive launch path; record that proof | Absence of a session ID or active file alone proves no call occurred |
| Process still live | Wait/cancel through supervisor; keep the lane held | Dispatch another implementation because the UI looks stale |
| Complete successful process and bounded result exist | Validate and import the result; rerun any gates whose applicability changed | Agent completion equals delivered |
| Stopped or failed process with owned dirty files | Freeze an unaccepted artifact snapshot; follow existing bounded recovery rules | Partial code is implementation success |
| Controller candidate ref already updated | Adopt only a matching journaled parent/tree/commit operation | Any clean commit is an authorized candidate |
| PR creation response lost | Search the stable exact repository/head/base identity; adopt one match or block on ambiguity | Create a second PR immediately |
| Merge response lost | Read PR, verify actual merge commit/tree/ancestry, then postmerge checks | Retry implementation or report unmerged from the missing response |
| Receipt corrupt, process identity uncertain, or evidence unavailable | Retain state and report outcome unknown with the needed inspection | Unknown becomes failure, zero usage or success |

The proposed target invariant is one accepted settlement for each operation and no overlapping dispatch for a live or ambiguous job. It is not a claim of exactly-once remote execution. A UUID alone cannot make a provider idempotent.

## Budget and capacity behavior

Preserve the current pre-dispatch call charge as a conservative ceiling. Separate it from observed process launches and logical implementation attempts. A crash after reservation must not reset the charge. Replaying the same job receipt must not charge again. Historical counters and frozen benchmark reports retain their original meanings; new fields need an explicit schema/accounting version.

Capacity rejection is already separated from repair failure, but the implementation attempt is incremented before execute. A structured maxAttempts ceiling can therefore interact with a capacity-only failure even when repairs remain unchanged. Add a focused maxAttempts=1 quota fixture before deciding policy. The existing capacity test checks repair preservation, not this structured-attempt boundary. [Attempt accounting](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L344-L365), [current fixture](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/controller.test.mjs#L618-L625).

Recommended new semantics:

- Only affirmative adapter evidence of rejection before useful execution leaves the logical attempt open; missing or ambiguous evidence does not. Today's capacity classification does not establish this fact, so the new behavior requires an explicit adapter proof. The physical dispatch remains recorded and charged against the call ceiling.
- A response after partial work preserves that work and follows the partial-attempt contract. Do not relabel it as a free retry because it also mentions capacity.
- A persisted retryAt survives restart. Capacity polling before that time uses no agent call. Add a bounded capacity-probe count and an owner-resumable hold so days of exhaustion do not burn the whole call budget.
- Persist an optional run deadline and consumed active runtime. State separately whether owner pause and capacity wait count toward that deadline. The recommended default is bounded active execution plus a separate calendar deadline, rather than silently forgiving elapsed time on restart.
- Missing or conflicting usage remains unknown. Retain known fields without manufacturing a total. Subscription quota availability is not derivable from token totals.
- Budget increases and continuation remain explicit durable admissions under existing authority, including their one-lifetime-admission limits and expected-state checks. Continuation still requires a paused/settled project and eligible recovered partial candidate, with no completed implementation or publication/merge. Recovery itself cannot enlarge a budget. [Continuation guards](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/store.mjs#L601-L677), [budget guards](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/store.mjs#L202-L238).

## Artifact retention and cleanup

Retain enough evidence to recover work and explain every terminal outcome:

- Original job input digest, normalized configuration and role; raw runtime spool; process receipt; bounded result; exact source identity.
- Binary-capable patch or retained candidate commit/ref; inventory and hashes of newly created owned files; generated evidence explicitly declared by the task.
- Verification/review/delivery receipts and any earlier failed or superseded candidate manifests.
- A retention result stating complete, partial, truncated, unsupported or failed. An export failure is a separate fact from implementation failure.

Logs and the existing managed workspace remain the first recovery layer. Add the manifest and durable candidate/patch references before introducing compression, cloud uploads or garbage collection. A tracked diff alone misses untracked files. Do not harvest the whole home directory, ignored owner data, credentials or production databases. Artifact collection must stay under declared managed roots, account for symlinks/reparse points, and apply bounded byte/time limits.

Finalize evidence after the writer has settled so hashes describe stable bytes. Write temporary manifests, flush and atomically publish them using a tested platform-specific implementation; validate both process-crash behavior and the limits of the storage guarantee. On disk-full or export timeout, preserve the local workspace and expose the incomplete manifest. Do not keep a process alive indefinitely just to export files.

Default retention for the first milestone is conservative: no automatic deletion of unresolved or failed evidence. Add a later dry-run cleanup command that lists exactly which disposable caches or redundant workspaces would be removed and why their required evidence survives. Frozen benchmark artifacts remain outside that cleanup policy.

## Exact delivery receipt chain

The following records supplement the current gates. They do not replace behavioral acceptance or grant merge authority.

| Receipt | Required identity and result |
| --- | --- |
| Candidate | Project/ticket/logical attempt/job; workspace generation; source repository; base and pre-agent head; controller checkpoint operation; candidate head/tree; changed-path inventory; policy/input digests; nonempty-change result |
| Local verification | Candidate head/tree; check-policy digest; ordered configured check names and resolved argv; working directory identity; process receipt IDs; start/end; exit/timeout/stop/output-limit status; each result and an explicit not-run tail |
| Review | Candidate head; fresh reviewer session/job; review schema/version; bounded verdict/findings/checklist; result digest and role model metadata |
| Publication | Canonical repository and base branch; stable branch; observed remote head; PR number/URL/head/base; operation key; observation time; reconcile/create disposition |
| CI observation | PR identity; candidate head/base/tree; required-check policy digest; each selected check-run ID, name, app ID, source commit, status, conclusion and URL; synthetic merge SHA/parents/tree when used; observed time |
| Merge | Expected head and method; merge-operation identity; response or reconciliation provenance; observed PR merged state; actual merge SHA/tree/parents; policy/preflight digest; observation time |
| Delivered verification | Exact merge SHA/tree; postmerge check-policy digest and process receipts; clean-worktree result; final acceptance references; shipped time only after required gates pass |

Store receipts as immutable snapshots linked by digest and operation ID. Preserve a compact safe export for owner review, with local paths normalized and no credentials. Exact matching proves which source and evidence were used; it does not prove the tests were sufficient. That remains the [acceptance design's](factory-acceptance.md#proposed-acceptance-contract) responsibility.

For publication, keep the stable ticket branch and force-with-lease protection. An explicit publication intent should exist before push/PR creation. A recovered PR whose response was lost can then be inspected even if it was closed or merged before local state caught up. A mismatching branch or multiple PR matches stays blocked. [Current publication safeguards](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/delivery.mjs#L72-L95).

## Execution boundary preflight

Current preflight checks Codex subscription authentication/catalog and delivery policy; job construction selects the intended sandbox. The optional Codex smoke separately proves command execution and file creation. These are useful existing layers, but an authentication check is not proof that the actual task boundary supports its required commands or GUI. [Runtime preflight](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L51-L88), [optional smoke](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/scripts/smoke-codex.mjs).

Add a versioned boundary receipt with adapter/build identity, OS/architecture, actual Node/Git/tool paths and versions, workspace/base identity, allowed roots, selected sandbox, shell/process capabilities, GUI capability, artifact export and cleanup support. Resolve the runtime command/model first; validate the exact contract before reserving expensive work when the probe itself costs no agent call. Cache only while its dependency fingerprint remains unchanged. Any agent-backed smoke remains separately budgeted and authorized.

For an application with multiple toolchains or native requirements, make the route explicit:

- Keep Squire's controller runtime separate from the application's configured runtime and toolchain. A controller version receipt cannot substitute for application prerequisites.
- Run setup and discovery serially when one command mutates paths another scans. Independent checks can run concurrently only in isolated workspaces or after their shared prerequisites settle.
- Mark native operating-system and actual GUI/browser checks as supported only on the verified route. Mocks on another platform and builds cannot settle those gates. Do not widen sandbox permissions or repair ACLs to make a preflight pass.
- Use synthetic records and test-owned private directories in factory acceptance. Do not remove production ownership markers, copy private databases as build artifacts or treat a software retry as authority to retry consequential product actions.

Factory recovery and product recovery are separate contracts. Improving source delivery must not activate application capabilities, alter production data or weaken a product's stricter reconciliation and owner-approval requirements.

## Useful patterns from three primary sources

### Warren

Borrow its stable run identity, replay cursor and explicit finalization boundary. Its [stream recovery](https://github.com/jayminwest/warren/blob/e0777328fae8442294cfb85b930fa1a4338078c4/src/runs/stream/recover.ts#L1-L55) reconnects known runs from retained sequence state and exposes malformed partial spawns. Its [outcome facts](https://github.com/jayminwest/warren/blob/e0777328fae8442294cfb85b930fa1a4338078c4/src/runs/reap/outcome-facts.ts#L111-L145) distinguish measured empty work from unmeasurable work. Squire can use those ideas with local files and SQLite.

The [finalization recovery implementation](https://github.com/jayminwest/warren/blob/e0777328fae8442294cfb85b930fa1a4338078c4/src/runs/finalize-recovery.ts#L1-L57) also shows why in-memory completion promises and rotated logs need independent reconciliation. Its [fallback implementation](https://github.com/jayminwest/warren/blob/e0777328fae8442294cfb85b930fa1a4338078c4/src/runs/finalize-recovery.ts#L245-L278) can default an unknown exit to succeeded behind other guards. Squire should retain outcome unknown instead. Warren's [documented pushed-branch boundary](https://github.com/jayminwest/warren/blob/e0777328fae8442294cfb85b930fa1a4338078c4/README.md#L62-L65) is also weaker than Squire's reviewed, checked and postmerge-verified delivery contract. Keep Squire's stronger contract. Do not import Kubernetes, remote finalize handshakes, agents committing their own work, or a new runtime merely to obtain durable receipts.

### mini swe agent

Borrow the small, auditable pattern of saving trajectory in a finally block and recording cost from failed parsing. Its [agent loop](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py#L90-L159) counts calls before model invocation and checks call, cost and elapsed limits. That supports a Squire terminalization path that retains evidence on every exit.

Do not copy the loop as a recovery guarantee: finally does not run after a hard process kill, and the [save implementation](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py#L182-L189) writes a JSON file rather than a transactional external-effect journal. Squire needs its existing supervisor and durable operation reconciliation in addition to failure saves. Its subscription accounting should not manufacture dollar cost from unavailable provider data.

### Temporal

Borrow the distinction between durable workflow state and potentially repeated external activities. Temporal's [pinned activity guidance](https://github.com/temporalio/documentation/blob/818bbca5c6897295c5df864f5a2ba565640ef9eb/docs/encyclopedia/activities/activity-definition.mdx#L176-L234) explains the crash-after-effect-before-receipt problem and service-enforced idempotency keys. The useful application is to isolate candidate creation, publication and merge into small reconciliable operations, not restart the entire delivery job.

Do not add Temporal for one owner on one host. Its documented activity retries may reexecute work; they would not make a non-idempotent Codex dispatch or uncertain publication magically safe. Squire needs bounded policies and endpoint-specific reconciliation regardless of framework. Keep this comparison conceptual; no Temporal runtime was evaluated.

## Dependency sequence and small implementation slices

The R1 inventory, malformed-evidence refusal and registration/fencing prerequisites above are implemented; the remaining work in these slices is proposed. Each should be a small independently reviewed change with offline tests first; combine only if the resulting diff remains easy to audit. Historical benchmark configurations, outcomes and artifacts stay frozen. The [v0.1 closure record](../releases/0.1/baseline-closure.json) remains closed-incomplete, and the recorded benchmark/comparison hold remains in force. A future baseline or live demonstration needs separate authorization; no run resumes merely because documentation is ready.

| Slice | Depends on | Narrow implementation | Evidence required to close |
| --- | --- | --- | --- |
| R0 Document current contracts | None | Mark existing vs proposed mechanisms; record source pins and invariants; define job/receipt schema without changing behavior | Review confirms no existing delivery or budget gate weakened |
| R1 Cover process reconciliation (partial) | R0 | Implemented: planning/GitHub inventory, malformed-record refusal, pre-spawn registration, one-use grants and conservative producer fencing. Proposed: OS identity and descendant settlement | Offline inventory/malformed-record/restart guards are covered; full identity and crash-window acceptance remains open, with no unrelated PID termination |
| R2 Journal candidate checkpoint | R1 | Candidate intent, prepared commit identity, CAS ref transition and restart adoption | Crash at every candidate boundary converges to one authorized candidate or an exact blocker |
| R3 Make job artifacts immutable | R1 | Unique job directories, atomic terminal manifest, normalized completed result and spool cursor | All outcomes retain usable evidence; corruption/truncation stays explicit |
| R4 Recover job outcomes and budgets | R2 and R3 | Idempotent receipt import, terminal settlement, quota/logical-attempt distinction, preserved deadlines | No duplicate call debit/import; no restarted budget; bounded capacity hold |
| R5 Record delivery evidence | R2 and R3 | Publication intent; selected CI check facts; merge provenance and immutable receipt chain | Lost push/PR/merge responses reconcile; stale/wrong-app/check-head evidence blocks |
| R6 Add exact-boundary readiness | R1 and R3 | Capability/preflight schema and fingerprint; deterministic task-specific probes; explicit native/GUI exclusions | Unsupported route fails before agent dispatch; changes invalidate receipt |
| R7 Run one authorized demonstration | R4, R5 and R6; A2/A3 for version-2 criterion acceptance | Tiny disposable local project, then separately approved scratch GitHub flow on restored subscription capacity | Same candidate passes every gate required by the admitted contract; retained receipts prove actual remote delivery at an explicitly labeled acceptance level |

R7 without [A2/A3](factory-acceptance.md#small-implementation-slices-after-research) proves the existing delivery/recovery route only: report, for example, **remote delivery verified; criterion acceptance pending**. Claiming version-2 criterion acceptance additionally requires A2/A3 and resolved observations for every required criterion; narrative review alone cannot supply them. GUI/native claims also require the task-specific evidence producer and actual candidate observations. A4's synthetic browser fixture can establish the producer pipeline, not arbitrary application acceptance. All existing verification, fresh-review, CI, delivery and postmerge gates remain required.

This sequence intentionally prioritizes a lost candidate or duplicate side effect over dashboards, cloud metrics, specialist teams and model selection. Follow the [roadmap's first three owner outcomes](../roadmap/README.md#reliable-software-factory-foundations-proposed-hardening), retaining the chosen task's platform-specific acceptance requirements.

## Failure injection acceptance matrix

Use deterministic fake runtimes and temporary local bare repositories first. Where process behavior matters, use real disposable child processes after execution is authorized. No proposed offline fixture below requires a live model or production system. GitHub write tests initially use the existing fake client; a later separately authorized scratch-repository test proves the composed remote route.

| Fault boundary | Required assertion |
| --- | --- |
| Crash after call reservation, before spawn | Same operation is reconciled; call reservation remains once; no second overlapping dispatch; never infer provider usage zero |
| Crash after spawn, before session event | Registered child is found or outcome is unknown; no replacement until it settles; a missing session ID never authorizes duplicate work |
| Controller dies while planning or gh API subprocess is settling | Reconciler covers those directories/registered operations; remote writes are queried before retry |
| Reused PID or unreadable active record | No unrelated process killed; deterministic identity blocker; original artifact references retained |
| Raw terminal event reaches disk before SQLite cursor | Restart imports it exactly once; usage does not double count; invalid trailing bytes remain incomplete |
| Complete result saved before phase state | Validate and adopt the matching result without a new agent call; changed policy/head prevents adoption |
| Crash after candidate tree/commit/ref, before ticket transition | Each injected boundary yields the one expected candidate or safe pre-effect state; arbitrary HEAD still fails |
| Timeout with tracked edit, untracked source and binary artifact | Each permitted item is retained and hashed; status remains unaccepted; secrets/out-of-root links are excluded or explicitly rejected |
| Provider says completed with empty diff | Retain result/logs; no_candidate remains non-delivery; no merge or dependency unlock |
| Affirmatively proven pre-execution quota rejection with maxAttempts=1 | Durable wait, unchanged logical attempt under the new accounting version, physical dispatch recorded; no repair consumption or eager polling |
| Quota after partial edits | Retain partial snapshot; do not erase counters or claim a free untouched retry |
| Repeated capacity wake across restart | retryAt and probe ceiling survive; eventual owner-resumable hold; no provider calls before allowed time |
| Disk full or manifest write interrupted | Required evidence never appears complete; workspace retained; no cleanup destroys the only copy |
| Push succeeds but response is lost | Inspect exact remote branch; reuse intended head; no unsafe force update |
| PR created, receipt lost, then PR closes or merges | Reconcile the one exact PR through publication intent; no duplicate PR; correct merged/closed disposition |
| Check rerun, wrong app, skipped check or moved base | Persist the actual selection; only exact successful current evidence can advance; old receipt never authorizes merge |
| Merge succeeds but response/state save is lost | Verify merge tree/ancestry; no second PUT required once merged is known; implementation count unchanged |
| Postmerge check fails | Retain merge identity; halt repository lane and dependent work; never report rollback or shipped |
| Preflight fingerprint changes or required GUI/native route unsupported | Fail before costly dispatch; no sandbox or ACL bypass; missing capability is visible |
| Reopen twice after every injected crash | Stable terminal state, same receipt identities/counters, no extra side effects; repeated recovery is itself idempotent |

Existing fixtures already cover dirty-work recovery, lost local merge receipt, moved bases, quota repair preservation, stale review sessions, spoofed GitHub check apps and postmerge lane halts. Extend those tests rather than building a separate acceptance framework. [Controller fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/controller.test.mjs), [delivery fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/delivery.test.mjs), [process fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/process.test.mjs).

## Choices to settle in the roadmap review

1. Approve the small operation journal and immutable manifests while retaining the project state envelope. A full event-sourced rewrite has substantially more migration risk without a demonstrated need.
2. Choose stop-and-reconcile for current Codex execution. Add live session resumption only when an adapter can prove inspect/cancel/event replay and idempotent start semantics.
3. Define capacity attempt semantics for new runs. Preserve historical accounting and retain a hard physical call ceiling even when a logical attempt waits.
4. Choose the minimal owner-facing recovery receipt: outcome, retained candidate, exact gates, budgets and next permitted action. A new dashboard is optional.
5. Keep automatic cleanup out of the first milestone. Retention limits should produce visible storage blockers until a reviewed policy can prove that required evidence survives.

Success is less owner reconstruction after an interruption, with no weaker acceptance, hidden spend, duplicated effects or lost work. Measure those outcomes on the existing workflow before adding team growth or model routing.
