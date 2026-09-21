---
type: concept
domain: engineering
confidence: high
---

# Transient phase-launch retry

The personal controller has a narrowly scoped infrastructure relaunch protocol,
separate from staged failed-result retries, remediation and report correction.
Captured `launchRetryPolicy` defaults to `{maxRetries: 1, backoffMs: 1000}`;
only zero/one retries and integer delays 0–30,000 ms are permitted. The same
logical attempt, original monotonic deadline, candidate HEAD, sandbox, profile,
feedback and prior results are retained. An optional trusted cost-authority
callback must return true; absent authority means no monetary ceiling is defined.

`provider-launch.ts` independently validates the pinned Pi first-turn provider
error envelope after successful command exit. Classifier v1 initially allows only
`codex-daybreak-verification-v1`, the exact Daybreak entitlement-verification
error with no assistant content, response identity, tool/streaming activity or
result. Header/session/profile, empty usage placeholders, complete ordering,
terminal copies, JSON/UTF-8/size bounds and closed fields are verified. Arbitrary
exception/stderr/model text cannot activate it. Other service errors, hard auth,
moderation, timeout, partial/malformed results and uncertain termination fail
closed. Clean workspace plus unchanged HEAD is an additional independent check,
not sufficient proof of no effects. Supervised Plan child errors are not retried.

Capable runs persist additive immutable policy and append-only `launches` records
under the existing JSON state CAS and ticket reservation. Records bind owner UUID,
logical-input/system-prompt digests, original HEAD/deadline, generation/session UUID,
canonical paths, requested/elapsed delay, transition, bounded error code and
sanitized classifier rule/version/digest. Deeply frozen detached logical input
prevents cross-generation adapter mutation. Generation 1 keeps historical paths;
generation 2 has `-g2` input/session names, preserving failed evidence. Dispatch is
persisted before invocation, retry reservation before backoff. Validation rejects
history rewriting, identity drift, duplicate dispatch, overlapping launches,
reused sessions, gaps and results from unauthorized generations.

`returned` in the ledger records the handoff boundary, not success. Existing
parsing, correction-fact, wiki and exact-HEAD gates decide acceptance; failed
Implement candidates are not promoted. Accepted Plan/Implement are never replayed
to recover Review/Test/Retro availability. Stage/remediation counters do not change
for the same-attempt infrastructure generation.

Crash behavior is deliberately conservative: started workflows are not resumed,
including a controller that died with an undispatched reserved retry. There is no
automatic owner transfer. Existing reserved-child claiming rejects started state;
restart/status can read the ledger but cannot dispatch it. A dispatch lacking
settled proof remains human-required ambiguity. Never infer termination from clean
Git state, reopen terminal state, or steal/delete another owner's reservation.

Status distinguishes retry backoff from model work. Watch emits bounded generation-
aware launch failure/retry transitions with semantic deduplication. Telemetry has
separate generation/session rows under the unchanged logical attempt; inventory
uses dispatched ledger identities. Zero provider-error placeholders do not prove
zero billing, so missing accounting stays incomplete. Recovery adds only gate
launch/retry rows, not another paid Plan/Implement.

Sources: [operator contract](../../../docs/transient-launch-retry.md),
`src/personal/{launch-retry,provider-launch,controller,json-run-state}.ts`, and
`test/personal-launch-retry.test.ts` (also in the unconditional Windows gate).
