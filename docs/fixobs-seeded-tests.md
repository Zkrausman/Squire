# FIXOBS seeded source tests

## V5 R2-01 terminal status oracle precision, freeze before validation

Independent review-v2 resolved F1, F3, F4, and F5 but left F2 partial as
R2-01. The V4 checker could accept `COMPLETED` after a faulted Stop or
fault-coded settlement, and could accept `FAULT` with canonical PR180
success and nominal cleanup. This is a test oracle gap; no current
production defect was established.

For canonical model success, the V5 oracle requires `FAULT` exactly when
visible cleanup fault evidence exists, and `COMPLETED` when it does not.
The closed evidence is Stop status `FAULT` or `TIMEOUT`, a non-`NONE` Stop
error code, or a non-`NONE` settlement error code. A faulted Stop can
coexist with an independently valid clean settlement. Settlement status
alone, including `UNKNOWN` or `OBSERVED_NONEMPTY` without a fault code,
does not invent a cleanup fault or impose an all-clean prerequisite.
Direct controls reject contradictory `COMPLETED` and unsupported `FAULT`
claims and accept both kinds of independent settlement outcome.

V5 was frozen before pinned synthetic validation. Six focused tests and
685 full-suite tests passed. Each invocation reported 32 seeds, 356
commands, 32 distinct command streams, and one N7 check. The output-only
author did not execute tests. The 32 fixed seeds, command alphabet,
50-command inclusive limit, 16 drains, two snapshot reads per command,
one nested reentry, no retry, N7 clock behavior, and prior identity,
privacy, and deadline checks are unchanged. Fresh nonauthor review and
ordinary PR/CI/merge remain separate gates; source tests are not native
qualification or exhaustive coverage.

## V4 oracle precision amendment, frozen before validation

This V4 candidate addresses the independent `CHANGES_REQUIRED` F1–F5
adjudication. V1, V2, and V3 remain historical records. V4 changes oracle
precision and ordinary clock choice eligibility because V3 could miss
undispatched launch, Stop, and settlement success claims; accept a false
`COMPLETED` claim; serialize unchecked observations on failure; select an
ordinary backward `SET_TIME`; and classify an out-of-bounds first Launch ACK
as valid for the duplicate-PID precondition.

The eight fixed operation IDs use the test-owned port invocation ledger.
`NOT_RUN` requires zero calls and unobserved row fields. A dispatched row
cannot remain `NOT_RUN`; an undispatched row cannot claim ACK, CAPTURED, or
an observed settlement. A genuine predispatch fault row remains valid.
Terminal `PENDING`, correlation, error-code, clean-scope, and independent
Stop versus settlement checks remain in force.

`COMPLETED` requires PR180 `BUFFER_SEQUENCE_MATCH`, reason
`THREE_BUFFER_PREDICATES_MATCH`, three `MATCH` frames, the canonical
reservations, actual invocation of all six active operations, and the
matching harness stop reason. `STOPPED` cannot claim that canonical
success; `FAULT` may retain a valid model match when cleanup faults.
Fault, abort, and unknown outcomes are not required to succeed.

The driver's failure writer and its direct negative controls share one
oracle-to-trace function. It reads only own data descriptors, projects
closed enums and bounded numbers, emits null for invalid fields, and
reconstructs at most 50 commands from fixed fields. Synthetic getter,
proxy, and buffer observations must produce the exact `PUBLIC_RAW_DATA`
code without invoking getters or proxy traps or copying sentinel data.
The tests do not inject these invalid objects into production.

Ordinary `SET_TIME` choices below the current synthetic time are
ineligible before PRNG selection, including `CLEANUP_CAP`. The existing
explicit invalid port-event timestamps, actual acquisition timestamps,
PR180 N7 `INVALID_CLOCK` behavior, and synchronous `poll()` are unchanged.
The valid-first-Launch-ACK predicate now uses the actual dispatch and
completion bounds. Possible own PID retention remains independent of
successful ACK validation, as does the abandoned-launch late-identity
rule.

The V4 alphabet, seeds 1–32, max 50 commands inclusive of nested and
finalization work, 16 drains, two snapshot reads per command, one nested
reentry, and no retry are frozen. V4 validation passed: six focused tests,
then 685 full-suite tests. Each invocation reported 32 seeds, 356 commands,
32 distinct command streams, and one N7 check. Fresh nonauthor source and
privacy review and ordinary CI/publication are separate gates. These
finite source tests do not establish exhaustive coverage or native
qualification.

## V3 oracle precision amendment

The frozen V1 and V2 records remain unchanged. The prior V2 focused
32-seed invocation exited 1: seed 7 reported `PUBLIC_ENUM` for an F0
capture summary row. The supplied source creates that row as `NOT_RUN`
before `dispatchPromise` registers its scheduler callback. Registration
can synchronously reenter `abort()` before the capture port is invoked;
`finishPendingRow` changes only `PENDING` rows. The trace reported zero
actual capture calls. A port result status and a summary row for work
never dispatched have different preconditions.

V3 checks action and capture `NOT_RUN` against a test-owned invocation
ledger keyed by the eight fixed operation IDs. Such a row requires zero
invocations, null observation time and error code, and, for capture,
predicate `NOT_RUN`. An undispatched row cannot claim `ACK` or
`CAPTURED`. An invoked operation must have its row, which must retain
the closed terminal status, error-code, and correlation checks; `PENDING`
remains forbidden. A predispatch scheduler fault may still produce a
fault row without a port invocation.

The coverage count now uses serialized command content without seed or
grammar version. The minimum of eight distinct streams is supported by
the eight different scripted prefixes for seeds 17 through 24; the test
reports the observed count. Independent review still assesses coverage.
The 32 seeds, command alphabet, 50-command budget including nested
and finalization commands, 16 drains, two snapshots per command, and
one nested reentry are unchanged.

## V2 oracle amendment

The frozen `SQUIRE_SEEDED_TEST_GRAMMAR_ORACLE_V1` remains the original
record. V2 changes one late-identity assertion precondition; it does not
change the command alphabet, seed order, bounds, or trace schema.

For a completed duplicate launch callback carrying a conflicting PID, the
checker requires orphan retention and a `late-launch:` fence when the first
launch fulfillment was a full-shape, own-correlated valid ACK, or when the
launch was abandoned before its first fulfillment. An initial response with
`EXTRA_FIELD` is not a valid ACK. Its possible own PID is still required to
be retained and fenced when launch stops unacknowledged; the malformed
response cannot promote launch success. A later callback with another PID
after that completed, nonabandoned malformed first fulfillment has no
conflicting-late-PID retention requirement in the accepted contract.

The driver also reports invalid steps returned without a synchronous coded
rejection, and runs each of the 32 seeds once before reporting collected,
bounded failures. These changes do not convert faults into successful runs.

`test/fixobs-seeded.test.mjs` runs seeds 1 through 32 against a fresh
`SOURCE_SIMULATION` harness for each seed. The test-local xorshift32 generator
chooses from finite, state-aware commands. Seeds 17 through 24 pin boundary
motifs for delayed ACK, synchronous poll during capture, early and exact
deadline delivery, clock reentry, conflicting correlation, rejection, and
invalid step. Seeds 25 through 32 drive the full active sequence before
varying cleanup. Remaining commands are generated from eligible choices.

Each seed has a hard limit of 50 commands. Nested reentry, abort, deadline,
late response, and cleanup commands use that same counter and debit before
effect. Each command has two harness snapshot reads and at most 16 finite
microtask turns. Pending public promises and test-owned port thenables are
tracked explicitly. The driver never awaits an unsettled port or public
operation, uses no timer or wall clock, and never retries a failed seed.

The checker compares actual calls with an independent count taken at the
injected port boundary. It checks call and model reservation ceilings
separately, non-refunding counters, fixed deadlines and first stop, closed
public enums and correlations, frozen older snapshots, terminal projection
stability, terminal rows, raw-buffer exclusion, and false proof flags. Fresh
bounded orphan, fence, and audit evidence may change after completion without
changing the completed model or summary. A fixed negative control must return
`LEDGER_MISMATCH`.

The capture check keeps the PR180 distinction: the harness accepts an
acquisition timestamp from dispatch through completion, while an intervening
synchronous `poll()` can advance PR180's last time beyond acquisition and
produce canonical `INVALID_CLOCK`. It does not require that capture to match
or alter its timestamp. A fault-coded Stop ACK can coexist with an independently
clean settlement observation; a fault-coded clean settlement cannot become
clean.

A failure prints one `squire.fixobs.seeded_trace.v1` JSON record containing
the grammar version, seed, command index, at most 50 encoded commands, one
fixed invariant code, and a bounded public projection. It contains no frame
bytes, arbitrary error text, or private identifiers. Replay uses the same
grammar, seed, source version, and command order. The suite performs no
automatic retry, shrinking, exhaustive claim, native execution, confinement
claim, runtime admission, or benchmark qualification.

Validation of V3 passed: 2 focused tests, then 681 full-suite tests. Each
invocation reported 32 seeds, 356 commands, 32 distinct command streams, and
one N7 check. No optional author prototype was invoked. Earlier V1/V2
failures remain separate records. Independent source/privacy review and
ordinary CI/publication are separate gates; these finite source tests do
not establish exhaustive interleaving coverage or native qualification.
