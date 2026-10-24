# Offline project-result reporting contract

**Status: source API and explicit-input CLI implementation.** This offline metadata projection accepts the closed data-only `SQUIRE2_PROJECT_RESULT_V1` profile. Source validation passed 16 focused and 701 full-suite tests; independent source/privacy review and exact-head CI are delivery gates. These checks do not establish actual use with a durable producer, repair runtime behavior, or qualify native execution. Durable producer compatibility remains **UNKNOWN**.

`CANDIDATE_STAGED` always reports `task_correctness: NOT_EVALUATED` and `task_outcome_evaluated: false`. The contract makes no task-correctness, execution, authorization, artifact-verification, syntax, import, functional, gameplay, fixture, scoring, or performance claim.

The original implemented-source observations behind this contract are pinned to commit `2091c5ecaef039fa07c913e734eb50905dd75136` (tree `49afcd3daee3c1bb1b3bad1e377bee5a8049446d`). The checks below now define the source candidate's implemented profile; they do not describe native capability or producer compatibility.

## Intake and reuse

Reuse these existing intake primitives:

- `parseReceiptJson`: 262,144-byte input cap, fatal UTF-8, decoded-key duplicate rejection, prohibited prototype keys, depth 10, arrays of at most 64, and strings of at most 4,096 characters.
- `snapshotReceiptData`: descriptor-only capture with its existing budget, prototype, accessor, Proxy, cycle, and scalar restrictions.
- `validateLimitedJobRecord`: existing closed shapes, counters, and lifecycle invariants, followed by the proposed exact task-class requirement `PROJECT_CODEGEN_V1`.

The source API applies checks in this order: **safe capture → closed profile validation → correlated recorded-claim checks → safe projection**. Capture establishes safe data, not a valid project profile. Never repair malformed structural fields through generic fallback. [Intake primitives](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/offline-run-summary.mjs#L5-L72), [record validator](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/limited-job-record.mjs#L6-L40).

Existing campaign and `SINGLE_JS` projections remain for their existing consumers. The campaign requires its 17-fixture structure, and the existing generation projection requires a different wrapper. The existing CLI dispatches an explicit `SQUIRE2_PROJECT_RESULT_V1` receipt to the project API while preserving those routes. [Existing projection boundaries](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/offline-run-summary.mjs#L92-L169).

When `generation` is non-null, the raw foreground wrapper includes callable `late_observations`. Capture must reject that callable-bearing raw result; do not invoke it or silently serialize or drop it. A raw result with `generation: null` may pass capture but still requires every profile and consistency check below. Neither case establishes saved-result compatibility. [Foreground wrapper](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/limited-core.mjs#L82-L101), [nullable initialization and early returns](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/project-runner.mjs#L38-L54).

The saved profile permits only `record`, `runtime_evidence`, and `diagnostic_retention` inside non-null `generation`. Establishing a producer that deliberately constructs this profile requires separately scoped persistence work. Complete retention construction and durable producer compatibility remain **UNKNOWN**.

## Complete safe-field crosswalk

All fields are required unless expressly optional. Every unlisted member rejects. “Record validation” means the unchanged validator after capture; project-profile restrictions supplement it. Private input fields may be checked internally but are never emitted.

| Input fields | Validation and safe output |
|---|---|
| `schema` | Exactly `SQUIRE2_PROJECT_RESULT_V1`; emit the discriminator. |
| `status`, `reason` | Must match the exact matrix below. Emit validated finite labels. Reject an unknown final reason before normalization. |
| `generation` | Null or the exact three-member saved profile; emit only the projection below. Null means no returned record, not necessarily no invocation. |
| `staging` | Null or the exact completed ACK profile below; emit separately as recorded history. |
| `task_correctness`, `task_outcome_evaluated` | Exactly `NOT_EVALUATED` and `false`; preserve both. |
| `runtime_admitted`, `operator_admitted` | Exactly `false`; preserve as recorded static markers without inferring authorization. |
| `workspace_disposition` | `DEDICATED_NOT_REUSED` iff final status is `CANDIDATE_STAGED`; otherwise `QUARANTINED`. |
| `descendant_guarantee` | Exactly `NONE`; preserve. |
| `operator_receipt` | String subject to intake’s 4,096-character and budget limits; emit only a nonempty-presence boolean. |
| `direct_child_invocations` | Exact `{generation}` object; generation count is a safe integer 0 or 1, subject to the invocation constraints below. |
| `outer_observation_target_ms`, `event_loop_condition` | Exactly `140000` and `RESPONSIVE_PARENT_EVENT_LOOP`; emit the target and condition, never an observed duration or hard completion guarantee. |
| `generation.record.job_id`, `.task_class` | Validate the record UUID and require task class exactly `PROJECT_CODEGEN_V1`. Use the UUID privately for ACK binding; omit it. Emit the fixed class. |
| `.lifecycle_status` | Existing nine-value enum and success invariants; emit the recorded lifecycle. |
| `.requested_model`, `.reported_model` | Validate independently as record text. Emit exact public label `gpt-6-luna` or `UNKNOWN`, independently. |
| `.process_exit.{pid,exit_code,exit_signal,process_wall_ms,observed_termination}` | Apply record nullable, type, and termination rules. Omit PID and signal string; emit exit code, wall milliseconds, and termination flag. |
| `.io_state.{stdout_bytes_observed,stderr_bytes_observed,stdout_eof,stderr_eof,io_drained}` | Require nonnegative safe-integer counts, booleans, and drain consistency; emit counts and flags. |
| `.containment_evidence.{containment_level,settlement_status,descendant_guarantee}` | Apply record finite-label and termination-consistency rules; emit recorded direct-child limitations and settlement. |
| `.provider_metadata.provider_reported_status` | Record nullable text. Output null if absent; preserve recognized provider status, otherwise emit `UNKNOWN`. |
| `.provider_metadata.duration_seconds` | Null or finite nonnegative number; retain record `turn.*` restrictions. Emit provider duration separately; inference duration is `UNKNOWN`. |
| `.provider_metadata.usage_tokens.{input,output,cache_read,thinking,total}`, optional `.codex_reasoning_output_tokens` | Apply record safe nonnegative-integer or literal `UNKNOWN` rules and Codex restrictions. Emit explicit numbers, including zero; literal unknown or optional absence becomes null. Derive no totals. |
| `.output_custody.{persisted,path,byte_count,persistence_error}` | Apply record closed-shape, type, and success rules. Emit persistence flag and envelope byte count; omit path and error. Envelope digest is `UNKNOWN`. |
| `.task_outcome_evaluated`, `.task_payload_valid` | Outcome is exactly false; payload flag is boolean or null. Emit the recorded payload-validity claim, never fresh source validation. |
| `.error_details.{code,classification,message}` | Apply record nullable-text rules; omit raw fields and use only the output diagnostic handling below. |
| `generation.runtime_evidence.{deadline_ms,timeout_latched,abort_latched,signal_attempts,event_loop_condition,workspace_reuse,workspace_disposition,max_steps}` | Apply the exact nested closure below; emit validated finite labels, numbers, and flags only. |
| `generation.diagnostic_retention.{retention_status,rejection_stage,rejection_reason,exact_response_bytes,retained_bytes_count,retained_truncated,retention_error}` | Apply the exact nested closure below; emit metadata only. `PUBLISHED` conveys no public disclosure or authenticity. |
| `generation.late_observations` or any other member | Reject; never invoke or silently omit during capture. |
| `staging.schema_version`, `.completion_status`, `.operation_acknowledgement` | Exactly `squire4.stage_receipt.v1`, `COMPLETE`, and `ACKNOWLEDGED`; emit the recorded ACK. |
| `staging.stage_operation_id`, `.caller_label` | ID exactly `'stage-'+generation.record.job_id`; caller exactly `project_candidate_stager`. Omit ID; the fixed caller may be emitted. |
| `staging.manifest_sha256`, `.file_count`, `.total_bytes` | Require lowercase 64-hex digest, safe integer count 1–50, and decoded total safe integer **0–1,048,576**. Emit separately identified manifest digest, count, and bytes. |
| `staging.provenance_authenticity`, `.crash_durability` | Both exactly `NOT_ESTABLISHED`; preserve. |

[Top-level result construction and control flow](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/project-runner.mjs#L35-L63), [complete record contract](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/limited-job-record.mjs#L2-L40), [existing public-label precedent](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/offline-run-summary.mjs#L94-L114).

Decoded `files[].{path,classification,bytes,sha256,content}`, inventory, and class counts are absent from the result. Do not read or reconstruct them. Empty DOC and LOCAL_ASSET contents are source-permitted; SOURCE must be nonempty. Preserve explicit zero totals. [Envelope validation](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/project-task.mjs#L33-L45), [staging totals](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/multifile-core.mjs#L45-L66).

## Finite final-status matrix

Definitions:

- **S**: validated `LIMITED_SUCCESS` generation, count **1**.
- **T**: validated `LIMITED_TIMEOUT` or `LIMITED_USER_ABORT`, count **0 or 1**.
- **R**: validated non-success generation excluding T, count **0 or 1**, subject to invocation constraints below.
- **N**: null generation, count **0 or 1**.
- **A**: valid, privately bound completed staging ACK.

These are structural recorded-claim permissions, not proof that every permutation is reachable. No row outside this table is valid.

| Final status | Exact reason | Generation | Staging |
|---|---|---|---|
| `CANDIDATE_STAGED` | null | S | A |
| `GENERATION_REJECTED` | `GENERATION_REJECTED` | R | null |
| `STAGING_REJECTED` | `STAGING:` + one code listed below | S | null |
| `INCOMPLETE` | `GENERATION_REJECTED` | T | null |
| `INCOMPLETE` | `CANCELED` or `OBSERVATION_DEADLINE` | N, T, R, or S | null; A permitted only with S |
| `FAILED` | `OPERATION_FAILED_OR_UNCERTAIN` | N or S | null |
| `FAILED` | `CLEANUP_FAILED_OR_UNCERTAIN` | N, T, R, or S | null; A permitted only with S |
| `FAILED` | `CLOCK_UNAVAILABLE` | S | A |

The staging suffix set is exactly:

`DESTINATION_ALREADY_EXISTS`, `SOURCE_NOT_FOUND`, `SOURCE_INTEGRITY_MISMATCH`, `STAGE_INTEGRITY_MISMATCH`, `STAGE_BINDING_MISMATCH`, `INVALID_STAGE_SPEC`, `INVALID_EXPORT_SPEC`, `INVALID_MANIFEST`, `SPECIAL_FILE_REJECTED`, `PATH_TRAVERSAL_REJECTED`, `PATH_COLLISION_REJECTED`, `CAPACITY_EXCEEDED`, `PRIVACY_VIOLATION_REJECTED`, `PACKAGE_IO_ERROR`, `PACKAGE_ABORTED`.

This includes the source-defined safe error fallback, not arbitrary exception text. [Finite multifile codes](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/multifile-core.mjs#L10-L14).

The matrix follows generation rejection, staging rejection, outer cancellation or deadline, and final cleanup or clock overrides. Clock failure here is the candidate-finalization clock check; general caught operation failures use `OPERATION_FAILED_OR_UNCERTAIN`. Cleanup can replace a prior disposition; cancellation does not replace an already `FAILED` status. [Finalization and branches](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/project-runner.mjs#L41-L62).

**Invocation constraints:** Every S and every A requires count 1. A count of 0 forbids a claimed PID, observed termination, exit code or signal, or settled direct-child exit. The count describes the outer wrapper’s recorded increment for direct-child invocation; it is not an unconditional wrapper-call count.

The foreground attempted-spawn flag and outer-wrapper increment occur at different boundaries. The flag is set before the injected spawn call; the outer wrapper checks `controller.signal.aborted` before incrementing. An attempted foreground spawn therefore does not independently prove the recorded increment. [Foreground spawn-attempt boundary](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/limited-core.mjs#L285-L293), [outer-wrapper increment boundary](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/project-runner.mjs#L51-L53).

The prospective profile requires count 1 for `LIMITED_SPAWN_FAILED` as an intentionally stricter profile choice, not a demonstrated producer invariant. Compatibility of count-zero `LIMITED_SPAWN_FAILED` remains **UNKNOWN** within the supplied excerpts. Other non-success records are not assigned count 1 merely because they exist. Initialization, abort or deadline early returns, and catches can finalize before spawn. Exact reachability of the remaining non-success/count combinations is **UNKNOWN** within the supplied excerpts; accepting noncontradictory recorded claims does not assert reachability. Null generation likewise does not prove count 0. This establishes neither a production defect nor a runtime repair. [Initialization](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/limited-core.mjs#L11-L22), [early returns, spawn, and catch](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/limited-core.mjs#L272-L295).

Every non-null ACK requires successful generation and its bound identity, including retained ACKs after final failure or cancellation. ACK history cannot upgrade final status or functional evaluation. Incompatible status, reason, generation, or ACK claims yield `INVALID_INPUT`, never a functional failure verdict. Every unrecognized final reason also yields `INVALID_INPUT` before output normalization.

## Nested validation closure

All following checks are project-profile requirements; unchanged primitives supply only the explicitly reused predicates.

### Runtime evidence

Require exactly the eight crosswalk keys. `deadline_ms` is null or a safe integer from 0 to `Number.MAX_SAFE_INTEGER`; latch fields are booleans. Require:

- `event_loop_condition='RESPONSIVE_PARENT_EVENT_LOOP'`
- `workspace_reuse='NOT_AUTHORIZED'`
- `workspace_disposition` exactly `DEDICATED_NOT_REUSED` or `QUARANTINED`
- `max_steps='UNSUPPORTED'`

Require dedicated disposition iff nested lifecycle is `LIMITED_SUCCESS`; success also forbids either latch. Final quarantine may coexist with nested successful-generation dedication.

`signal_attempts` is a dense captured array of at most **64** entries. Each entry has exactly `signal`, `accepted`, and optionally `elapsed_ms`; signal is `SIGTERM` or `SIGKILL`, accepted is boolean, and elapsed is null or a nonnegative safe integer. The bound comes from reused intake, not an asserted runtime attempt limit. Signals prove no termination. [Producer fields](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/limited-core.mjs#L97-L101), [existing runtime predicates](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/offline-run-summary.mjs#L85-L105).

### Diagnostic retention

Require exactly the seven crosswalk keys.

- Status is exactly `NOT_REQUESTED`, `NOT_ELIGIBLE`, `REQUESTED`, `PUBLISHED`, `FAILED`, or literal `UNKNOWN`.
- Each byte count is null or a safe integer from 0 to `Number.MAX_SAFE_INTEGER`; truncation is boolean.
- Error is null or exactly `RETENTION_IO_FAILED`, `RETENTION_TIMEOUT_OR_ABORTED`, `RETENTION_CAPACITY_EXCEEDED`, `RETENTION_PRIVATE_ROOT_UNAVAILABLE`, or `RETENTION_INVALID_CAPTURE`.
- Stage and reason must both be null, or both non-null and an exact source-table pair. Half-null, mismatched known pairs, and unknown values reject.

The finite pair table is:

| Stage | Reasons |
|---|---|
| `COLLECTION` | `COLLECTION_FAILED` |
| `ENVELOPE` | `PAYLOAD_SIZE_EXCEEDED`, `MALFORMED_UTF8`, `MALFORMED_JSON`, `DUPLICATE_KEY_CONFLICT`, `INVALID_ROOT_SHAPE`, `ENVELOPE_PARSE_ERROR`, `MISSING_TERMINAL`, `REPEATED_TERMINAL_REJECTED`, `CONFLICTING_TERMINAL_EVENTS`, `TRAILING_DATA_AFTER_TERMINAL` |
| `PROVIDER_STATUS` | `PROVIDER_NON_SUCCESS`, `TURN_FAILED` |
| `RESPONSE` | `RESPONSE_STRING_REQUIRED`, `AMBIGUOUS_AGENT_MESSAGE` |
| `PAYLOAD` | `CODEGEN_MARKDOWN_REJECTED`, `CODEGEN_ENCODING_REJECTED`, `CODEGEN_PAYLOAD_TOO_SMALL`, `CODEGEN_PAYLOAD_TOO_LARGE`, `CODEGEN_SOURCE_STRING_REQUIRED`, `TASK_PAYLOAD_INVALID`, `PROJECT_PAYLOAD_TOO_SMALL`, `PROJECT_PAYLOAD_TOO_LARGE`, `PROJECT_MARKDOWN_REJECTED`, `PROJECT_ENCODING_REJECTED`, `PROJECT_SCHEMA_MISMATCH`, `PROJECT_DUPLICATE_KEY`, `PROJECT_PATH_INVALID`, `PROJECT_PATH_TRAVERSAL`, `PROJECT_PATH_COLLISION`, `PROJECT_CLASSIFICATION_INVALID`, `PROJECT_ENCODING_INVALID`, `PROJECT_BASE64_INVALID`, `PROJECT_FILE_SIZE_EXCEEDED`, `PROJECT_AGGREGATE_CAPACITY_EXCEEDED` |
| `UNCLASSIFIED` | `UNKNOWN_REJECTION` |

[Source pair table](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/limited-diagnostics.mjs#L4-L10), [existing retention predicates](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/offline-run-summary.mjs#L104-L105).

Pair correlation is an additional proposed check. Infer no unsupported relation between nullable byte counts and retention status. Unknown status, stage, reason, or error strings never normalize into accepted structure; literal permitted `UNKNOWN` status and `UNCLASSIFIED/UNKNOWN_REJECTION` pair remain valid.

Raw record error text is different: after record validation, emit an exact recognized `stage:reason` pair or output-only `UNCLASSIFIED/UNKNOWN_REJECTION`; all-null error fields convey no diagnostic. Never echo raw code, classification, or message. This fallback does not repair invalid retention or final-reason fields. [Source safe diagnostic fallback](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/limited-diagnostics.mjs#L36-L45).

## Implemented source interface

The package export `squire/project-summary` provides `projectProjectRunSummary(value)` and `formatProjectSummaryTerminal(summary)`. The first function returns a deeply frozen `squire2.project_summary.v1` projection; malformed input returns the fixed `INVALID_RECEIPT` profile. The formatter re-captures and validates the complete closed projection before producing printable ASCII.

Example API use:

```js
import {projectProjectRunSummary,formatProjectSummaryTerminal} from 'squire/project-summary';

const summary=projectProjectRunSummary(recordedProjectResult);
process.stdout.write(formatProjectSummaryTerminal(summary));
```

Example CLI use and output:

```text
node bin/squire-report.mjs ./recorded-project-result.json
Squire offline project result: CANDIDATE_STAGED
Task correctness: NOT_EVALUATED
Task outcome evaluated: false
Reason: NONE
Generation: LIMITED_SUCCESS
Requested model: gpt-6-luna; reported model: UNKNOWN
Process exit code: 0; wall ms: 120; observed termination: true
Provider status: turn.completed; provider duration seconds: UNKNOWN; inference duration seconds: UNKNOWN
Tokens: input=0, output=8, cache_read=0, thinking=UNKNOWN, total=UNKNOWN, codex_reasoning_output=UNKNOWN
Envelope custody: persisted=true; bytes=100; SHA-256=UNKNOWN
Staging ACK history: COMPLETE; operation=ACKNOWLEDGED; files=1; decoded bytes=0; manifest SHA-256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Operator receipt present: true; runtime admitted marker: false; operator admitted marker: false
Direct child invocations: generation=1; observation target ms=140000; event loop=RESPONSIVE_PARENT_EVENT_LOOP
Workspace: DEDICATED_NOT_REUSED; descendant guarantee: NONE
Diagnostic: NONE
Recorded claims only; no task outcome, artifact, authorization, or execution re-verification.
```

The CLI accepts one explicit receipt path and uses the existing bounded reader. A valid project report always exits `1`, including `CANDIDATE_STAGED`; an invalid report exits `2`. The project summary requires and emits the fixed `PROJECT_CODEGEN_V1` task class through this project-specific schema. No JSON report producer, persistence change, artifact read, or stage verification is added.

## Identity, authority, and remaining limits

Envelope custody concerns serialized envelope bytes: the private path and recorded count, with the envelope digest `UNKNOWN`. The staging digest identifies a canonical decoded-file manifest; its totals count decoded contents. Neither identity substitutes for the other. Per-file identities and current disk state remain **UNKNOWN**.

A completed ACK is historical. A verification result is a distinct schema and cannot replace it; verification records original acknowledgement as **UNKNOWN**. This proposal performs no verification. [Envelope persistence](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/project-runner.mjs#L17-L29), [manifest identity](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/multifile-core.mjs#L57-L66), [ACK versus verification](https://github.com/Zkrausman/Squire/blob/2091c5ecaef039fa07c913e734eb50905dd75136/src/internal/multifile-core.mjs#L133-L140).

Output contains no raw paths, private IDs, operator receipts, prompts, source bodies, raw errors, or arbitrary model strings. Preserve explicit zero distinctly from `UNKNOWN`. Requested and reported models remain separate. Wall time and provider duration are not inference time. Supply no inferred tokens, totals, ratios, cost, benefit, score, performance, or remaining-effort estimate.

This source API and CLI supply neither a durable producer nor native authority. Persistence remains separately scoped. Existing native, display, input, settlement, preventive inclusive eight-process ceiling, host-support, host-output, recovery, benchmark, no-rerun, and unknown-state limits remain unchanged.
