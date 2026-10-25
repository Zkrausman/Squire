# Squire roadmap

**Status as of 23 October 2026.** The source baseline for this update is `7c620f40a6f3310dc5c88f18deead8379c4f698d` (tree `d6f2e1977ff1abbc86d592954bd1993478db148a`). The roadmap path is absent from that tree; this dated section states current status ahead of the retained historical material below.

## Current runtime and usable scope

Squire’s current runtime is Codex only. The limited path uses the Codex adapter and bounded coding entrypoint. One separately admitted `ndjson-log-summarizer v5` Codex operation completed one generation, a successful syntax check, and all 17 frozen fixtures. That establishes conformance for that task under its documented direct-child limits. The requested Q218 model was Luna/xhigh; the effective reported model remains unknown. [The Codex adapter limits](https://github.com/Zkrausman/Squire/blob/7c620f40a6f3310dc5c88f18deead8379c4f698d/docs/CODEX-limited-adapter.md) remain applicable. Each new native operation still needs its own admission and fresh readiness evidence; this operation is not the required large benchmark.

The earlier durable SQLite and full-controller features belong to the retired implementation. They are historical facilities, not capabilities of the current replacement. Source preparation, injected simulations, inert entrypoints, and synthetic matches do not establish native execution, app observation, process custody, or benchmark acceptance.

## Source delivery trail

The source history includes [PR 173: offline run summary](https://github.com/Zkrausman/Squire/pull/173), [174: single-JavaScript task preparation](https://github.com/Zkrausman/Squire/pull/174), [175: human-review package](https://github.com/Zkrausman/Squire/pull/175), [176: multifile staging and export](https://github.com/Zkrausman/Squire/pull/176), [177: project candidate path](https://github.com/Zkrausman/Squire/pull/177), [178: inert Blackjack controller](https://github.com/Zkrausman/Squire/pull/178), [179: inert desktop profile](https://github.com/Zkrausman/Squire/pull/179), [180: trusted non-game fixture](https://github.com/Zkrausman/Squire/pull/180), [181: injectable `SOURCE_SIMULATION` harness](https://github.com/Zkrausman/Squire/pull/181), and [182: seeded finite-coverage tests](https://github.com/Zkrausman/Squire/pull/182). PRs 178–180 do not supply a native launcher or qualification; PR180’s synthetic buffer matches do not prove app observation or benchmark success.

PR181’s current summary and simulation add no native adapters. Synchronous polling and canonical `INVALID_CLOCK` behavior remain; Stop failure remains distinct from an independently valid settlement.

The sanitized source-owner capsule reports that PR182 merged as the source-baseline commit above. Its reviewed head was `e65c4d4a55a2b84874db77cf974af71a175f3897`. It adds test-only coverage for the injected harness, with no production changes or new dependencies. The focused suite passed 6 tests and the full suite passed 685; each invocation reported 32 seeds, 356 commands, 32 distinct streams, and one N7 check. Exact-head [CI run 39860660488, attempt 1](https://github.com/Zkrausman/Squire/actions/runs/39860660488) succeeded, and fresh nonauthor review passed for the accepted finite scope. These results are not exhaustive interleaving proof, native qualification, or a benchmark result.

## Offline project-result reporting — 23 October 2026

The offline metadata contract for `SQUIRE2_PROJECT_RESULT_V1` is published in [the project-result reporting contract](../project-result-reporting.md). The source implementation adds a pure projection/formatter API and explicit receipt-path CLI dispatch. Source validation passed 16 focused and 701 full-suite tests; independent source/privacy review and exact-head CI remain required delivery gates. This establishes neither actual producer use nor durable producer compatibility, which remains **UNKNOWN**. Metadata, a staging ACK, final disposition, and task correctness (`NOT_EVALUATED`) remain distinct; `CANDIDATE_STAGED` still reports `NOT_EVALUATED`. Native and benchmark holds remain unchanged.
## Approved offline project-result reporter implementation

Scope: implement the reviewed PR184 offline metadata contract through a pure projection/formatter API and explicit-input routing in the existing report CLI, with no producer persistence or native execution. Reuse the bounded parser/reader and preserve legacy report behavior. Source owner: existing Squire custodian; independent source/privacy review and ordinary tests/PR/CI/merge remain required.

Acceptance: closed finite input/output profiles, complete status/ACK/count correlations, private-field omission, explicit zero/UNKNOWN, replayable synthetic rejection/privacy tests, and no functional-success exit for an unevaluated candidate. CANDIDATE_STAGED remains NOT_EVALUATED. Producer compatibility, actual use and native benchmark readiness are not established by this ticket.

Source entrypoint: `src/project-summary.mjs`, package export `squire/project-summary`, and the existing `bin/squire-report.mjs` explicit-input route. The source tests exercise metadata validation, rejection/privacy and legacy CLI behavior; they do not establish native qualification or benchmark readiness.

## Approved saved-result adapter extension — 24 October 2026

Scope: add an explicit adapter for a caller-supplied live `SQUIRE2_PROJECT_RESULT_V1` result, a bounded private receipt writer, package export, synthetic regressions, and documentation. The adapter captures only the already-approved saved data profile and omits the documented `late_observations` wrapper function without invoking it. It does not change the producer, reporter semantics, task runner, or native route. `CANDIDATE_STAGED` remains `NOT_EVALUATED`; count-zero `LIMITED_SPAWN_FAILED` remains incompatible.

The writer requires an explicit caller-owned mode `0700` directory and injected filesystem capability, creates one exclusive mode `0600` receipt leaf, and verifies bounded same-handle readback. Its acknowledgement concerns receipt bytes only; source authenticity and crash durability remain `NOT_ESTABLISHED`. Raw saved receipts contain private schema fields and must remain in the private route. This extension permits only one explicit private metadata-receipt write per call; it grants no broader raw-capture retention, export, upload, producer, native, benchmark, or admission authority.

Status: source implementation and synthetic/injected compatibility coverage validated with 64 focused and 711 full-suite tests. Independent source/privacy review and ordinary PR/CI/merge are delivery gates owned by the source custodian. Synthetic compatibility coverage does not establish durable producer compatibility or actual native use. Existing reporter behavior, historical roadmap text, and all native, benchmark, access, security, and no-rerun holds remain in force.

## Native and benchmark boundaries

Native release remains held. Requirements still include compatible installed runtime, display, input and capture with app-only bindings; a preventive inclusive eight-process ceiling; identity-safe custody and full owned-process settlement; actual host-support qualification; and scoped admission. Fixed-topology planning remains conditional and deferred, with no implementation or native release. The historical host child-output issue remains unresolved. Historical invocation, source-access, disclosure, denial, unknown-state, and no-rerun holds remain unchanged.

The owner queue remains fresh BlackjackShooter v2, then LocalJobQueue v1, then WindowsLocalLogExplorer v1, before hill climbing. These are sequence markers, not ready engineering tickets. Queue worker, restart, API and UI scope remains separate from Windows target authority and DATA/export bounds; platform implementation is not bundled. No large benchmark is complete and hill climbing has not started.

For each completed major benchmark, retain an inspectable result and standardized evidence for the exact run and artifacts. The owner’s manual score remains pending until the owner supplies it with likes or changes; unknown is never zero, and scores or baselines are not blended or rewritten. This is a reporting requirement, not an implemented scoring pipeline. Remaining human-equivalent effort is unknown; historical planning horizons do not establish work coverage, duration, or savings.

This restoration adds no new research recommendation or implementation ticket. Historical research and tickets are not newly commissioned or made ready by publication. Stronger redesign is deferred.

## Proposed HumanLayer synthesis — 25 October 2026

The owner approved integrating this synthesis into the roadmap as documentation only. The verified canonical PR/commit receipt records whether documentation integration has landed. These six entries remain planning proposals: their implementations are not authorized by this integration, started, or delivered. This documentation does not constitute implementation delivery, native qualification, or benchmark release. No stack, framework, or provider replacement, installation, benchmark, or current native work is authorized.

This is a frozen report-based synthesis, not an independently fetched source conclusion or runtime evidence. Both author tracks cite HumanLayer commit `2f66a45b186d88488fa356862be0117db1ccae9f`. Gemini v4 rests on conditional v3 acceptance plus the sole mechanical two-character hash restoration; it is not a fresh exact-v4 verdict. The OpenAI basis is a sampled static report plus its normalized-replay addendum. HumanLayer links below remain pinned to that commit and were supplied by the reports, not fetched here.

Reuse delivered [PR175](https://github.com/Zkrausman/Squire/pull/175) human-review packages, [PR181](https://github.com/Zkrausman/Squire/pull/181) injected lifecycle harness, [PR185](https://github.com/Zkrausman/Squire/pull/185) reporter, and [PR186](https://github.com/Zkrausman/Squire/pull/186) saved-result adapter. Extend the existing contracts at `docs/project-result-reporting.md`, `docs/human-review-package.md`, and `docs/fixobs-port.md`; do not create replacement reporter, adapter, or lifecycle tickets. Historical R/O/A/T labels below are cross-references only and do not reactivate those proposals.

### HL-SYN-01 — Close lifecycle and event receipt gaps

**Owner/path:** Augment `docs/project-result-reporting.md` and its existing PR181/185/186 reporting seams. **Priority:** P0 candidate. **Status:** Planning proposal; implementation is not authorized, started, or delivered.

**Question:** Which observed event is authoritative for native input acceptance, process start, output custody, and full settlement, and how are replay, missing acknowledgments, and late adverse events represented?

**Bounded output:** Add an authoritative-receipt table, projection rules, scoped event/outbox schema, loss/incompleteness states, and adversarial fixture matrix to the existing reporting and adapter contracts. Use commutative reduction only where domain ordering justifies it.

**Acceptance:** Keep queued, approved, accepted, persisted, process-started, output-captured, and settled distinct; missing evidence is unknown/incomplete, never success. Duplicate, delayed, out-of-order, and lost-ack fixtures cannot create false running or settled reports. Capped terminal or protected events cannot disappear silently. Scope outbox failure to its run/tenant; link events to captured evidence and state completeness. Native observations, not control-plane state, define truth. If the existing Gelt correction is resumed, preserve immutable summary identity and explicit adverse-event/ack semantics; do not import CI status ranking as policy or reopen closed numeric criteria. Gelt-specific changes remain separately owned and conditional; no acquisition or implementation follows.

**Dependencies/hold:** Reuse the delivered injected reporting/adapter work. If native signals are unavailable, publish a bounded missing-evidence result and keep the gate closed; claim neither native settlement nor benchmark readiness.

**Source/report basis:** Supplied pinned references: [approval versus running projection](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/apps/riptide-api/src/orpc/api/approvals/resolve.effect.ts#L35-L128) and [lifecycle/outbox](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/packages/session-sdk-base/src/outbox.ts#L1-L238). Gemini 3.1 and 3.4; OpenAI HL-01 and session annex. Historical refs: R5/A2/A3/O/T.

**Tentative effort:** 3–7 remaining human-equivalent person-days, assuming current injected reporting/adapter work is reused. Native evidence gaps may change this; owner to re-estimate after deduplication.

### HL-SYN-02 — Separate immutable raw custody from derived views

**Owner/path:** Augment the PR175 package design in `docs/human-review-package.md`. PR175 already has byte-bound checks; this proposal does not assert those are absent. **Priority:** P0 candidate. **Status:** Planning proposal; implementation is not authorized, started, or delivered.

**Question:** Can every conclusion and retry be tied to the same authorized original bytes while normalized, truncated, and rendered views remain visibly separate?

**Bounded output:** Specify a raw-byte and derivative manifest for artifacts and transcript/events: source pin, collection authority, SHA-256, byte size, transform chain, completeness, and destination. Add bounded retention/export rules and safe-preview requirements.

**Acceptance:** NUL-containing, non-UTF-8, binary, oversized, renamed, and symlink-related fixtures preserve raw identity or explicitly fail capture. Retries transmit the captured object, not a later file version; each derivative links to raw identity and disclosed transforms. Normalized Fold replay is never original-byte proof; returned envelope checks are not payload-byte verification. Watch-directory membership cannot export secrets/private evidence; preview/export follows explicit destination and active-content policy. Missing originals and omissions remain visible.

**Dependencies/hold:** Missing original bytes, unclear collection authority, unauthorized destination, or unknown retention ownership blocks evidence acceptance/export. Reuse PR175 packaging and existing Gelt G05/G06 contracts only as applicable; crash durability and native provenance authenticity are not assumed delivered. No Gelt implementation or new capture is included.

**Source/report basis:** Supplied pinned references: [artifact normalization](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/apps/riptide-api/src/orpc/daemon/artifacts/upsert.ts#L23-L46), [live mirror/retry](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/packages/session-sdk-artifacts/src/sync.ts#L309-L380), and [normalized Fold replay](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/apps/riptide-api/src/orpc/daemon/fold-session-events/append.effect.ts#L99-L104). Gemini 3.1 and 3.3; OpenAI HL-02, E07–E10, and normalized-replay addendum. Historical refs: R3/T.

**Tentative effort:** 3–8 remaining human-equivalent person-days for reviewed local integration, assuming reusable PR175 packaging and existing Gelt G05/G06 contracts. Owner to refine; this does not assume delivered crash durability or provenance authenticity.

### HL-SYN-03 — Specify generation-fenced ownership and recovery

**Owner/path:** Adapter-neutral planning across `docs/fixobs-port.md` and the current native input/output/settlement/package gates; reuse PR181 harness cases. **Priority:** P1 planning candidate. **Status:** Documentation proposal only; stronger recovery implementation is HELD/DEFERRED, not authorized, started, or delivered, and is not the next implementation.

**Question:** Can stop, retry, or takeover target only its captured run generation, with release only after evidenced finalization or explicit incompleteness?

**Bounded output:** Specify claim/stop/takeover/resume semantics, durable generation model, capability matrix, and restart/side-effect-uncertainty failure fixtures.

**Acceptance:** One authorized owner per generation; stale stop cannot affect its replacement. Timeout is missing observation, not proof subprocesses or side effects stopped. Reconcile crashes before/after side effects before replay; absent resume state fails closed or offers only an explicitly labeled, authorized fresh start. Release follows output capture/durable finalization or an explicit incomplete receipt. Preserve original author/reviewer separation and executor identity.

**Dependencies/hold:** First evidence must close the current MVP native input/output/settlement/package gates; then the owner must separately authorize a bounded next step. If managed execution lacks ownership/settlement signals, record the gap; do not substitute a runtime or launch a benchmark.

**Source/report basis:** Supplied pinned references: [bounded claim/recovery](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/apps/riptide-daemon/src/effects/services/fold-sessions/fold-session-runner.layer.ts#L416-L583) and [finalization before release](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/apps/riptide-daemon/src/effects/services/fold-sessions/fold-session-runner.layer.ts#L377-L405). Gemini 3.1; OpenAI HL-03 and session annex. Historical refs: R1–R4.

**Tentative effort:** 5–12 remaining human-equivalent person-days, including native adapter compatibility, crash/replay tests, and independent review. Reuse existing harness cases; availability of cross-process signals is the main uncertainty.

### HL-SYN-04 — Extend cited rationale and phase evidence

**Owner/path:** Conditional Squire consumption of an existing bounded Q188/Lore concept, registry, or changelog amendment; this roadmap entry does not create a universal checker. **Priority:** P1 high candidate. **Status:** Planning proposal; implementation is not authorized, started, or delivered.

**Question:** Does the current Q188 rationale bridge or a specific Lore publication/extraction step omit a deterministic source-membership check or accepted-revision field that prevents a demonstrated failure?

**Bounded output:** Amend the existing concept/registry/changelog only for a named consumer with a concrete omission; retain decision evidence, alternatives, assumptions, and revisit conditions. Add citation membership or revision/phase evidence only where needed. Keep semantic support and independent acceptance separate from byte/hash validity.

**Acceptance:** Name the exact concept, consumer, omission, and minimum amendment before adding a check; otherwise record no change. For consumed generated citations, fabricated IDs fail deterministic membership validation, while real IDs with unsupported claims still require substantive independent review. Where a phase transition is actually proposed, stale, wrong-type, or unaccepted revisions and duplicate triggers cannot authorize advancement. Reuse current status distinctions rather than inventing a general release gate. Keep authors/reviewers separate, preserve unknowns, alternatives, source and permission boundaries; XML escaping is not a complete prompt-injection defense. Publish through existing concept/registry/changelog without private receipts, new private acquisition, or an inference campaign; do not duplicate PR137 mutation guidance.

**Dependencies/hold:** No concrete named omission means no new checker or work. Missing accepted revision or action authority blocks any actual transition.

**Source/report basis:** Supplied pinned reference: [evidence/citation membership](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/packages/ai/src/agents/context-shards/generate-context-shard-candidates.ts#L60-L196). Gemini 3.3 and 5.2; OpenAI HL-04 and workflow annex. Historical refs: A2/A3.

**Tentative effort:** 2–5 remaining human-equivalent person-days for the narrowed concept/schema/publication amendment, named-consumer fixtures, review, and integration. This supersedes the broader OpenAI 4–10 day phase-engine proposal; if no concrete gap exists, record no change.

### HL-SYN-05 — Preserve review anchors and partial delivery truth

**Owner/path:** New proposed local contract adjacent to `docs/human-review-package.md`; it is not implied by PR175. No current consumer or new implementation path is established by this documentation. **Priority:** P1 high candidate. **Status:** Planning proposal; implementation is not authorized, started, or delivered.

**Question:** Can a finding remain attached to the reviewed version while feedback delivery, comment resolution, fix completion, and verification are tracked independently?

**Bounded output:** Define a minimal version/quote anchor and delivery-state contract or adapter, including exact/outdated/approximate placement, captured comment-root IDs, idempotency keys, and distinct delivered/fixed/verified fields.

**Acceptance:** Changed, removed, moved, or duplicate passages cannot silently inherit a precise anchor or old verdict. Rejected delivery leaves feedback pending; accepted delivery with resolution failure remains a visible partial outcome. Retry after acceptance cannot duplicate the message. Fixing/resolving a UI thread does not certify independent verification. Reviewer disagreement and revision invalidation remain visible and bound to exact source versions.

**Dependencies/hold:** Prefer the small local contract. If there is no current consumer, retain the bounded design; do not import React/Tiptap/Electric/Yjs for its own sake.

**Source/report basis:** Supplied pinned references: [versioned anchors](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/packages/ui/src/artifact-viewer-v2/anchor/resolve.ts#L159-L230) and [partial delivery](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/apps/riptide-ui/src/components/artifact-viewer-v2/delivery/executeBulkArtifactDelivery.ts#L9-L56). Gemini 3.4 versioned diff patterns; OpenAI HL-05 and E14–E15. Historical refs: A2/A3/T.

**Tentative effort:** 4–9 remaining human-equivalent person-days for a small local module. A full collaborative editor is excluded; the OpenAI report estimates 2–4 additional weeks for that alternative.

### HL-SYN-06 — Qualify provenance and a narrow hygiene pilot

**Owner/path:** Provenance/package gate before any proposed local source reuse; exact target file/module and local owner remain to be selected. No code path is authorized. **Priority:** P0 provenance prerequisite; P1 conditional hygiene candidate. **Status:** Planning proposal; implementation is not authorized, started, or delivered.

**Question:** Which small lint and dependency-closure checks prevent actual local mistakes without incompatible tooling, licenses, or broad exemptions?

**Bounded output:** First create an exact-file/source/license/dependency ledger and local compatibility decision. Only if those gates pass, propose a narrow known-value-widening/ternary-depth and lockfile/metafile-closure pilot, with exclusions, owner, update policy, and backout.

**Acceptance:** Every copied file has a pinned source, applicable notices, modification record, and local owner; unknown external-runtime licenses/capabilities remain blockers. Selected rules pass local positive/negative fixtures with acceptable false positives and no blanket suppression of async-test safety checks. Dependency audit accepts only intended closure changes and checks actual local package/bundle topology; do not copy hardcoded HumanLayer version values. No whole-stack install or provider invocation is needed for the initial provenance/design record. Any later implementation requires normal CI and independent review.

**Dependencies/hold:** Unknown license/provenance, incompatible AST/toolchain, unresolved package-evidence gate, or excessive false positives blocks code reuse/enforcement. No stack install or provider invocation is authorized by this proposal.

**Source/report basis:** Supplied pinned references: [closure guard](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/scripts/check-sentry-closures.ts#L1-L118), [release closure audit](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/scripts/verify-agentlayer-release-deps.ts#L1-L273), [known-value widening](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/tools/oxlint/anti-slop/rules/no-known-value-widening.ts#L1-L500), [ternary depth](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/tools/oxlint/anti-slop/rules/max-ternary-depth.ts#L1-L83), [license](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/LICENSE), [rule license](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/tools/oxlint/anti-slop/LICENSE), and [notices](https://github.com/humanlayer/humanlayer/blob/2f66a45b186d88488fa356862be0117db1ccae9f/NOTICE). Gemini 3.5 and 5.2; OpenAI HL-06 and E23. Historical ref: T.

**Tentative effort:** 4–9 remaining human-equivalent person-days: approximately 2–5 for chosen-module provenance/dependency review and 2–4 for bounded local hygiene adaptation, tests, and integration. Overlap requires owner refinement. Future significant upstream updates add roughly 0.5–2 days each, scope-dependent.

All effort ranges are tentative remaining human-equivalent person-days, not agent duration, elapsed schedule, or promises; do not sum them mechanically. The owner must refine estimates. No broader recovery, native work, provider, stack replacement, installation, or benchmark is authorized by these proposals.

## Historical roadmap material and restoration boundary

The text that follows is retained historical roadmap content. Its former current-tense claims and priorities describe the pre-retirement state; the dated status above governs current capability and planning. Historical SQLite and full-controller facilities are not current replacement capabilities.

The removal commit was `284382998baa25312653042af3c9006fb8dfcf43`, parented by `ed119fb43367719daddb264821fb7cbf1cb648c5`. The last-tracked roadmap was 24,246 bytes (blob `7fef1a8d75256f5aab36cabf358dd0376b67fe5d`, SHA-256 `0483e5d7826bcde4c8156b7a796df2ba9fd53ad3988769236aa5e479ded62b86`). The divergent preserved roadmap was 22,529 bytes (SHA-256 `3e31a6e1ae0bfe0502674e34902e092151755615734b1e562d68b5964b600598`). The mechanical union retains all preserved local prose in order and adds four tracked insertion groups; divergent authorship is not inferred. The source owner retains the snapshots and union provenance.

Historical relative links are resolved only to exact files verified at `ed119fb43367719daddb264821fb7cbf1cb648c5`. The `owner-queue-2026-10-17.md` wording is retained as an unpublished reference because it has no tracked target; no public link is fabricated and no separate restoration is implied. Restoration does not reactivate retired facilities or policies.

Prioritize dependable delivery for one owner: preserve useful work, report exactly what passed, and ask for input only at real scope, authority or environment boundaries. Keep the single-host controller and fixed-role subscription workflow.

## Selecting the next outcome

At each meaningful decision boundary, choose the feasible outcome with a ready next slice and the strongest expected value for its full remaining constrained effort, including dependencies, validation and owner work. Record the runner-up and decisive assumption; use qualitative ranges when comparable estimates are missing. Preserve required gates and the committed first-outcome order unless material evidence justifies changing it. The [selection method and initial shortlist](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-value-prioritization.md) cover uncertainty, switching cost and stopping rules.

The 17 October owner queue reconciliation (retained unpublished reference: `owner-queue-2026-10-17.md`) records completed facilities, five independently reviewed delivery-research decisions, the independently reviewed trace-reportability extension and exact held engineering dependencies. Its 3–5-day planning horizon and person-effort estimates are not measured agent duration or implementation/runtime authority.

## Current foundations and evidence limits

Squire already has durable SQLite state/events and leases, supervised bounded processes, partial-work recovery, controller-owned candidate commits, exact-candidate verification, fresh read-only review, exact GitHub check matching, merge reconciliation and postmerge checks. These are implemented facilities, not wholly unstarted roadmap items.

The source audit is pinned to [ec98a61](https://github.com/Zkrausman/Squire/commit/ec98a61bd6a0fec89246c0b160ca90d2ff363d68). Existing fixtures cover substantial failure paths; their presence and green controller CI do not establish live-model effectiveness or accepted application delivery. The [research index](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/README.md) separates source facts, static risks, proposed fixtures and acceptance contracts.

The [policy-amendment decision](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/policy-amendment-evidence.md) retains scoped routing invalidation and consumer-specific evidence identities; it documents source behavior and unrun negative cases without authorizing execution or acceptance claims.

The [v0.1 closure record](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/releases/0.1/baseline-closure.json) is authoritative for that program's later status: the original baseline is closed-incomplete; manual harness completion is separately unscored; benchmark/comparative execution remains on owner hold. Preserve those historical inputs, failures, counters and evidence. Future optimization still requires a separately authorized, completed and independently graded larger-benchmark baseline. Documentation does not reopen a run or authorize execution.

The [project acceptance decision](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/project-acceptance-decisions.md) clarifies that shipped tickets start configured integrated acceptance, while project completion and application acceptance remain separate claims; no operational outcome is established by the source note.

Four source-based documentation decisions record existing semantics and safe reporting boundaries: the [call-reservation ledger](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/call-reservation-ledger.md) distinguishes committed reservations, logical attempts and reported usage; [pause/admission boundaries](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/pause-admission-boundaries.md) document pause acknowledgment separately from cancellation and settlement; [pre-merge policy capabilities](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/premerge-policy-capabilities.md) map adapter observations against server-enforced policy; and the [trace reportability contract](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/trace-reportability-contract.md) limits summary claims to supplied events, separates those claims from complete trace coverage, and links the companion [empty comparison scaffold](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/benchmarks/trace-report-scaffold.md). These pages describe source and fixture definitions without asserting an actual runtime, benchmark or acceptance result; proposed validation of uncovered negative cases and stronger automated enforcement remain separately scoped. The existing execution and benchmark holds are unchanged.

## Reliable software-factory foundations: proposed hardening

The design work is documented. R1 process inventory and fencing prerequisites, the bounded R3 physical-job evidence slice, and the recording-only R2 candidate journal are implemented; the remaining slices and acceptance fixtures below are proposed and unexecuted. The gaps are between existing mechanisms, rather than a replacement controller.

1. **Close recovery identity gaps (R1-R2; partial).** Planning/GitHub process inventory, pre-spawn producer fencing and recording-only candidate checkpoint intents are implemented. Add OS identity and descendant settlement, then restart reconciliation before any automatic intent adoption. Gate: injected crashes converge to one authorized settlement without accepting arbitrary HEAD changes.
2. **Preserve immutable per-job evidence (R3).** Give every physical job its own retained result, raw event spool, artifact manifest and candidate references, including failure, timeout, capacity and no-change outcomes. Gate: corruption/export failure stays visible, failed work survives, and replay cannot overwrite or double-count an earlier attempt.
3. **Recover results and budgets honestly (R4).** Adopt only matching completed receipts; retain durable call reservations, deadlines and current admission restrictions. Define versioned new-run quota/attempt semantics with affirmative evidence before exempting a logical attempt. Gate: no budget reset, duplicate debit, overlapping execution or unknown-usage-as-zero.
4. **Retain the delivery facts already checked (R5).** Record publication intent, selected current check-run/app/head identities, and exact merge/tree/ancestry/postmerge receipts. Preserve all current gates. Gate: lost responses reconcile and stale, skipped, wrong-head or wrong-app evidence cannot advance delivery.
5. **Validate the actual execution route (R6; P0-P5).** After R1/R3, add one zero-model, exact-policy probe route for the prepared workspace, Git base, role-specific toolchain, process lifecycle and artifact return, before call reservation. Add bounded GUI/IPC capability fixtures only when required, retaining browser sandboxing and verifying cleanup; report task, benchmark process and progress separately. Gate: denied, unsupported, unknown or stale required capabilities block; executor/policy/workspace changes invalidate receipts. Capability readiness does not establish application acceptance or authorize a benchmark run.
6. **Resolve acceptance claims to evidence (A1-A3).** Separate production origin from quality; attach immutable observations to candidate criteria and have fresh review reference them. Keep legacy narrative evidence honestly labeled. Gate: nonexistent, altered, wrong-candidate or incompatible-kind evidence blocks acceptance.
7. **Prove one small end-to-end route (R7; A2/A3 for criterion acceptance).** Begin with disposable offline failure fixtures, then a separately authorized local/GitHub demonstration after capacity returns. A delivery-only result leaves criterion acceptance pending; a version-2 accepted result requires A2/A3. Add A4 or the declared native producer only when the task needs it. Gate: the exact candidate passes the required gates and the owner can inspect its result; a preview, mock or synthetic capability fixture never substitutes for actual product observations.
8. **Measure before optimizing (A5).** Prepare a fixed-workflow comparison protocol and full accounting without running it. Preserve the baseline/owner-hold prerequisites above. A later Pith output-transform comparison additionally requires output-fidelity validation. Gate: independently graded quality, total resource use and owner recovery effort are measured; incomplete usage, interruption or compressed output alone cannot become a savings claim.
9. **Make current work and owner decisions explicit (O0-O5).** Start with a passive CLI view of observed activity, last durable progress, pending result and one decision per root blocker. Keep missing observation intervals unknown; reuse R1/R3 and P5 for stronger process facts and R5/A2/A3 for result claims. An optional notification sink follows the local queue, with configured quiet windows and replay-safe delivery. Gate: synthetic replay/interruption cases cannot claim false activity/completion, lose decisions, duplicate unchanged notices or authorize execution.

10. **Make trust and disclosure boundaries explicit (T0-T3).** Document the trusted-owner host-process limit, then separate verifier environments and diagnostic authority, constrain R3 artifact readers/collectors and review destination-specific repair/PR/owner exports. Reuse P-series profiles, A2 references and O-series projections. Gate: inert synthetic markers and wrong-path/link fixtures cannot silently cross the declared boundary; no claim of hostile-code isolation, secret-free output or prompt-injection immunity. These controls and fixtures remain proposed.

The [bounded verification failure-feedback refinement](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-verification-feedback.md) records a 15 October 2026 source check at [fe87da7](https://github.com/Zkrausman/Squire/commit/fe87da73798d327ac3557d2d245146c6dd12ef3f). Its narrow T1 repair projection, reused by T3's explicitly admitted correction path, is implemented with default-withheld per-check classifications and a focused isolated synthetic direct test. This does not complete broader T1/T3 controls, authorize any new destination, or change the committed recovery → preflight → accepted-delivery outcome order; ordinary CI and review remain under the existing route.

Detailed dependencies, negative cases and unresolved choices:
- [Retained delivery-history envelope](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/delivery-history-envelope.md): source-derived limits for complete passive history inspection; delivery gates and retention policy remain unchanged.
- [Recovery, artifact retention and delivery receipts](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-recovery.md)
- [Producer boundary compositions](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/producer-boundary-compositions.md): source assessment for two proposed deterministic Store fixtures; generated model-based exploration is deferred. Neither fixture execution nor broader recovery is authorized or established.
- [SQF04 authority evidence and anchor/worker contract](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/sqf04-authority-evidence-contract.md): planning-only authority/provenance contract. The current adapter still lacks an authenticated authority producer and protected anchor/worker transition; host availability is unevaluated, and there is no runtime admission.
- [Acceptance, visual evidence and controlled comparisons](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-acceptance.md)
- [A3 oracle assurance](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/a3-oracle-assurance.md): entry-definition hashes do not attest dependency closures. [Bounded declared-input verification](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/a3-declared-input-contract.md) is opt-in; complete dependency and loader coverage remain UNKNOWN. Existing acceptance and execution holds remain.
- [Execution-boundary admission and bounded capability probes](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-runtime-preflight.md)
- [Operator visibility, exact decisions and quiet notifications](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-operator-workflow.md)
- [Trust, privacy and safe disclosure boundaries](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-trust-boundaries.md)
- [Delivery benchmark portfolio, corpus validity and readiness](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-benchmark-portfolio.md): BP0-BP4 propose four exposed Go/Node cases, an optional generic desktop case and separately selected evaluation families. Implementation, zero-model execution and campaigns remain separately gated; the small portfolio cannot replace the required larger baseline or reopen historical runs.

After separate execution authorization, pursue three small owner outcomes in order:

1. **Retain one explainable candidate after interruption.** Use R0-R3 and the R4 settlement needed for that route; keep conservative accounting until any exemption has affirmative evidence.
2. **Refuse an avoidable wasted call on one owner-used route.** Add P0-P3 to that registry/retention path, freezing one supported execution profile and its actual role policy before dispatch.
3. **Deliver one small change with an auditable accepted result.** Add R5 and A2/A3, frozen task/check ownership and explicit demonstration permission; require browser/native evidence only as the chosen task demands.

Share one small receipt format across recovery, acceptance and preflight. GEPA, specialists, dashboards, distributed workflow services, hosted previews and a Pith comparison are not prerequisites for these outcomes.

## Other retained commitments

- [SQF07 — Gelt terminal activity and controls](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/sqf07-gelt-terminal-plan.md): accepted text planning for three outcomes; implementation depends on G06’s accepted contracts and separate integrated acceptance. G05’s merged pure rules core does not establish genuine market-shadow acceptance.
- [EmbeddingGemma 2 feasibility](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/proposals/embedding-gemma-integration.md): optional ticket-local Squire retrieval and opt-in offline Pith discovery remain proposed; default synchronous Pith inference is a no-go under the negligible-latency requirement. No implementation, model download or benchmark is authorized by this report.
- Squire dashboard overview.
- Host the Squire overview dashboard and store its metrics in an S3 bucket or other durable cloud storage. Keep it behind the dependable local delivery/evidence path; storage choice is not settled by this research.
- [Self-improving skills](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-skill-improvement.md) and phase-owned evolving specialist teams, after the authorized larger-benchmark baseline prerequisite.
- Intelligent task-aware model selection: low priority and exploratory, behind delivery reliability and benchmark work.

## Gemini development tools: planned research

Explore Gemini as an optional advisory research tool behind the committed reliable-delivery outcomes above. Preserve Squire's single-host controller, fixed-role subscription runtime and existing evidence gates.

1. **Review one public Squire code input first.** Freeze one public file or small diff and a specific behavior question. Produce a short advisory finding list with file/line evidence and proposed regression tests. Gate: a maintainer grades each finding as confirmed, unsupported, already covered or unverifiable. A defensible corner case, test proposal or reproducible defect can justify further use; a supported no-issue result can close the task without a superiority claim. Stop at the graded advice; code changes and test execution remain separately scoped.
2. **Extract one public-PDF methodology card later.** After the code task closes, separately approve an exact public PDF, its canonical identity/version, license and processor. Record method steps, parameters, data requirements, assumptions, limitations and missing details, with page/section, table or equation evidence for consequential claims. Gate: a person checks every decision-changing claim against the exact source, verifies critical equations/tables and leaves missing details unresolved. Stop at the graded card. Paper-to-code conversion and implementation require their own later scope and acceptance.
3. **Consider an adapter only after useful repeat demand.** Inspect the existing extension contract before proposing one narrow optional provider adapter. Keep policy and tool execution outside model output, validate results and expose timeout, refusal, invalid-output and provider-failure states. Integration remains a future, separately approved decision.

Roadmap publication approves planning only. Select exact public inputs, the processor, deliverable and request bounds before separate approval for API setup or inference. Advice and methodology cards do not satisfy controller checks, independent review, CI, delivery or application-acceptance evidence. The recorded benchmark/comparison hold, historical closure and independent-baseline prerequisites remain in force. No implemented provider, accepted application result or measured quality/savings benefit is claimed here.

## Herdr CLI worker: one bounded evaluation

Evaluate Herdr as an optional local process surface for one isolated Codex CLI worker with a separate bounded test/log pane. Freeze one disposable task and compare the current Codex-session/direct-supervisor path with Herdr for stable worker and session identity, blocked-state detection, cancellation and verified descendant cleanup, detach/reattach, server restart, test outcome and durable evidence. Herdr documents that detach leaves processes running; after a server restart, resuming Codex depends on a valid native session reference. Its Codex integration reports session identity while deriving lifecycle state from screen detection. Treat unknown states, stale or missing IDs, interrupted waits and uncertain termination as unresolved, not success. ([agent automation](https://herdr.dev/docs/agent-automation/), [session state and restore](https://herdr.dev/docs/session-state/), [Codex integration](https://herdr.dev/docs/integrations/#codex))

**Gate:** retain Herdr only if the evidence shows that it removes Squire-specific lifecycle machinery without weakening writer ownership, fixed-role policy, cancellation, cleanup or durable evidence. Record exact versions, commands, task identity, outcomes and artifact references in a durable receipt; otherwise close with a no-adoption finding. Keep this evaluation distinct from the existing [active-ticket sidebar-card follow-up](https://github.com/Zkrausman/Squire/issues/72). This roadmap item does not authorize Herdr installation, backend migration, implementation or model inference; each needs separately approved scope.

## Self-improving skills — future, unstarted

The [bounded skill-improvement design](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/research/factory-skill-improvement.md) proposes one advisory implementation-skill text with fixed models, tools, authority, acceptance and delivery gates. GEPA may propose candidates; independent evaluation and review decide whether an exact revision can be selected for future jobs. Its published benchmark gains do not establish a Squire benefit.

First specify immutable skill/recipe identity (S1), frozen task-family splits and allowlisted training feedback (S2), then a zero-model replay fixture for selection, accounting, promotion and rollback (S3). Reuse R3 retention, R1-R4 recovery, A2/A3 acceptance, A5 reporting and R6/P0-P5 readiness wherever applicable. The prototype and all implementation remain unexecuted and need separate authorization.

A real trial (S4-S5) additionally requires the separately authorized, completed and independently graded larger-benchmark baseline. Freeze training, separate selection validation and an untouched final holdout; count proposal, rejected/interrupted evaluation, grading and owner effort in the whole-campaign budget. A frozen finalist needs independent promotion, and rollback selects the prior approved skill for new jobs without rewriting historical receipts. Keep the incumbent when evidence is insufficient. Skill search does not authorize team growth, routing changes, API fallback or reopening the historical baseline.

## Phase-owned evolving specialist teams — future, unstarted

Planning, implementation and review should each own a versioned team of specialist subagents. Each phase can identify missing capabilities, propose and define new specialists, refine or retire existing specialists, and improve how it selects and combines them. Team growth is an optimization candidate; it must earn its coordination cost through measured outcomes.

Start only after a separately authorized larger-benchmark baseline has completed and been independently graded. The historical v0.1 baseline remains closed-incomplete, and the recorded benchmark/comparison hold remains in effect; do not reopen or relabel it. Choose the first phase from measured bottlenecks, then trial the smallest useful team in that phase before expanding. Compare against the existing phase and a simple skill or deterministic tool where appropriate, under comparable aggregate budgets. Do not change frozen benchmark configurations or evidence to introduce the trial.

Each specialist needs an explicit purpose, input/output contract, approved skills and tool profile, fixed authorized model and permission ceilings, budget, version, provenance and evaluations. Creation and invocation are bounded by trusted admission and aggregate call/time limits; specialists cannot recursively grow teams or grant themselves additional authority.

Evaluate individual specialists, the whole phase, and independently graded delivered outcomes, including coordination calls, latency, token use, repairs and unknown usage. Use frozen training cases for development, separate validation for selection, and an untouched final holdout after the team and routing/composition are frozen. Specialists cannot grade or promote themselves or receive private evaluator answers.

Require independent admission and promotion, immutable versioned receipts and rollback to the previous team configuration. Preserve controller verification, ownership, protected paths, fresh review, CI, delivery and evidence gates. Keep a change only with credible quality gains or equivalent correctness at lower total cost; adding specialists alone is not progress.

## Model selection sketch — future, unstarted

Task signals → cheap classification (for example, Luna) → simple routing policy informed by public benchmark metadata and Squire outcomes → selected execution model → independent grading feeding future routing calibration.

Keep selection vendor-neutral and start with simple rules before a learned selector. Fall back to the established fixed-role models when classification or evidence is uncertain. Public benchmark scores need local validation: compare delivery quality and token use against the fixed-role baseline, including classification and routing overhead.

### Deferred resource-assignment research: Rebalancer

[Rebalancer](https://engineering.fb.com/2026/09/21/open-source/rebalancer-generic-high-performance-library-assignment-problems/) is a reference for future coupled placement decisions, not an adopted scheduler or a model-quality predictor. Keep this low-priority exploration behind delivery reliability and the authorized larger-baseline prerequisite. For the current single-host, [fixed-role workflow](https://github.com/Zkrausman/Squire/blob/ed119fb43367719daddb264821fb7cbf1cb648c5/docs/MODEL-ROUTING.md), prefer a simple queue, explicit eligibility checks and resource reservations; revisit a solver only if measured contention shows several placement choices must be optimized together.

Useful design lessons, independently of library adoption:
- Separate non-negotiable eligibility, permission, budget and repository-writer constraints from quality/cost/latency goals. The [constraint policy](https://facebook.github.io/rebalancer/docs/reference/constraint-policy/) defaults to best-effort repair of already-broken constraints without worsening them; `HARD` requires satisfaction or an error. Neither a default-policy result nor a high-priority goal is proof that a safety constraint holds.
- Use explicit [lexicographic priority tiers](https://facebook.github.io/rebalancer/docs/reference/goal-priorities/) when one goal must outrank another; large weights within one tier still allow trade-offs. Hard authority gates remain outside these trade-offs.
- Retain a deterministic heuristic as the comparison and fallback. [OSDI 2024, §7.1](https://www.usenix.org/system/files/osdi24-kumar.pdf#page=13) recommends simple heuristics for short, predictable allocation latency, including high-throughput short-lived jobs; it does not establish a benefit for Squire.

Any later, separately authorized evaluation should compare coupled-placement quality, queue delay, solve time and total overhead against that simple baseline. Treat a solver output as a proposal: independently validate hard constraints, reject stale state/policy/resource snapshots and acquire current reservations before dispatch. Timeout, infeasibility or invalid output must not relax admission; wait/block when no safe fallback is eligible. No framework adoption, implementation, provider/probe/benchmark run or savings claim follows from this research note. The execution hold, historical no-rerun closure and independent baseline/acceptance gates above remain unchanged.
