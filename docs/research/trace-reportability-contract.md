# What the current trace summary can establish

Source decision based on the tree at `50cbf10580670be193d6035763e4c2b9a1a497fa`, 17 October 2026. This contract examines source and fixture definitions only; no function or fixture was run, no runtime or model was launched, and no operational data was acquired.

## Decision

Use `summarizeTrace` as a summary of **supplied events**, not a certificate of complete arm accounting. A future comparison report must separately establish trace scope/coverage and interpret each completeness flag before claiming a total. Keep the existing unscored calibration result distinct from benchmark acceptance. No implementation or frozen comparison protocol is changed by this decision.

The [reservation ledger](call-reservation-ledger.md) establishes how reservations and attempts arise. This contract examines aggregation behavior and the [existing foundations guide](../workflows/benchmark-foundations.md) describes known-only usage and duplicate/conflict behavior; neither establishes coverage or claim admissibility for an arbitrary supplied event window.

| Current output | Source meaning | Permitted report wording / unsupported inference |
| --- | --- | --- |
| sessions / sessionsByRole | [Map keyed by event.jobId](../../src/benchmark-report.mjs#L3-L23); events without a jobId do not create a job entry. Role metadata can be overwritten by later supplied events. | Observed unique job IDs by reported role. This is not deduplication by provider sessionRef, proof of runtime execution, or all arm calls without external coverage evidence. |
| pendingSessions / unknownUsageSessions | [No outcome](../../src/benchmark-report.mjs#L25-L31) counts pending; missing/conflicting usage increments unknown only for a job with a truthy outcome. | Report both counts. Zero unknown terminal usage does not imply zero pending or unobserved jobs. |
| tokenTotalsComplete | [Input/output/cache validation](../../src/benchmark-report.mjs#L33-L43) and pending/missing/conflicting usage govern this flag. It is initially true. | Completeness within this supplied summary's checked dimensions. Empty supplied events leave it true with zero jobs; that is not evidence of an empty or fully accounted run. |
| reasoningUsageIncomplete | [Reasoning validation](../../src/benchmark-report.mjs#L45-L46) sets a separate flag and does not itself change tokenTotalsComplete. | A true tokenTotalsComplete does not certify complete reasoning-token reporting. Reasoning is a subset of output, not an extra amount to add to it. |
| tokens.* | Valid known fields are summed; cached input is included in input. [Conflicting usage](../../src/benchmark-report.mjs#L14-L16) marks the job and causes its usage to be excluded from totals. | Known partial amounts only unless all required dimensions and trace coverage are established. Missing/conflicting data is not zero and cannot support a complete savings ratio. |
| rework | [Every supplied matching repair/correction/repairing event](../../src/benchmark-report.mjs#L5-L6) increments the count, without event-cursor deduplication. | Count of those supplied event occurrences, not independently verified logical repairs or idempotent replay accounting. Identical repeated usage avoids double-summing job usage, but that does not make every metric replay-idempotent. |
| timeouts / outcome / model metadata | [Later supplied fields and job.finished](../../src/benchmark-report.mjs#L9-L18) determine retained values; the reducer does not reconcile conflicting terminal outcomes or authenticate provenance. | Describe the trusted source and ordering. Arbitrary reordered/replayed terminal records are not a new authoritative job history. |
| elapsedMs | [Caller-supplied finite ordered endpoints](../../src/benchmark-report.mjs#L21) are subtracted; otherwise null. | Elapsed time for the caller's declared interval, not measured inference time, summed worker effort or full campaign time without an interval contract. |

The reducer accepts the supplied array without checking project/pair identity, event cursor coverage, event schema or the reservation inventory. [Store.events](../../src/store.mjs#L218-L219) itself returns a bounded page (default 200). Passing one page to the reducer would not establish that all pages were included. This is a source-derived consumer responsibility, not a claim that an existing live benchmark caller made that error. Cursors are global across projects; gaps in a project's filtered sequence alone do not prove missing events.

## Consumer reporting gate

Before a future authorized comparison uses these metrics, the report preparer must retain:

1. Exact pair/arm identity and immutable candidate/capture stage; the event source, ordering, extraction window/high-water and digest of the retained input. Establish coverage against the applicable arm's authoritative job/reservation inventory; do not infer it from the reducer's flags. A direct arm may use a different authoritative source and must declare the unit explicitly.
2. Separate observed job IDs, committed reservations, provider-session/turn counts and unavailable quantities. Preserve missing terminals and usage. Do not label sessions as provider sessions merely because of the JSON field name.
3. All completeness flags and known token subsets. Report incomplete dimensions beside the totals. Do not add cached input or reasoning output again, fabricate zero values, or assert all-assignment cost/savings from a partial window.
4. Explicit timing endpoints and their measured scope, plus separately observed preparation, grading, owner intervention and cleanup where the frozen protocol requires them. Unknown amounts remain unknown; no person-hour estimate becomes agent elapsed time.
5. Independent candidate-bound acceptance evidence from the accepted grading route. [calibrationReport](../../src/benchmark-report.mjs#L51-L54) checks supplied process/new-behavior/preservation fields, retains `scored=false` and `modelPerformanceMeasured=false`, and does not execute or authenticate a grader. Its `accepted` field is limited to those supplied calibration checks; it cannot establish a passed game, Squire effectiveness or benchmark acceptance.

The accompanying [comparison trace report scaffold](../benchmarks/trace-report-scaffold.md) makes these unknowns visible without changing a machine schema, scorer or runner. It contains no real outcomes or grading material. This blank template does not authorize data acquisition, entry of actual results or distribution of a report; those activities require the applicable data, execution and destination approvals.

## Evidence, scope and closure

The [summary/conflict fixture definitions](../../test/benchmark-report.test.mjs#L7-L15) and [calibration definitions](../../test/benchmark-report.test.mjs#L17-L33) are existing source evidence, not new test results. This inventory did not establish dedicated coverage for every empty-window, reasoning-flag, duplicate-rework or reordered-terminal case. Any later validation needs separate scope; no synthetic run, mutant or fixture was added here.

These findings set a reporting interpretation contract without changing the reducer, schema, scorer or runner. Stronger automatic enforcement would require a separately scoped input/coverage contract and meaningful validation. The contract supports honest comparison preparation and establishes no benchmark outcome, current capacity, runtime readiness or measured resource benefit.
