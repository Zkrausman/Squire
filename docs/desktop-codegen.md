# Explicit desktop source generation

## Explicit observation profile

The separate source preparation API
`prepareDesktopCodingObservationTask(root, source_commit, request, inputs, ports)`
and the exact five-argument preparation flag
`--prepare-desktop-coding-observation` select an additional desktop
`CODEGEN_ONLY_NO_DESKTOP_EXECUTION` profile. Existing preparation APIs, flags,
generic project routes and their 120-second generation / 140-second observation
formats remain unchanged.

The observation config schema is
`SQUIRE2_DESKTOP_CODING_OBSERVATION_OPERATION_V1`; its manifest schema is
`SQUIRE2_DESKTOP_CODING_OBSERVATION_PREPARED_MANIFEST_V1`. Both require this exact
closed descriptor:

```
{
  "id": "PROJECT_CODING_OBSERVE_V1",
  "generation_wall_ms": null,
  "outer_observation_ms": null,
  "post_generation_closeout_ms": 20000
}
```

The corresponding config generation and outer bounds, manifest generation wall
bound, and manifest outer observation bound are null. Null is accepted only
with the exact observation schema, desktop target, descriptor and explicit
desktop execution path. It is not a generic timeout override.

This profile imposes **NO SQUIRE ELAPSED GENERATION CUTOFF** while the child is
starting, running or waiting to complete. It schedules no generation or
whole-operation observation timer. Progress, inactivity and JSONL events neither
create nor renew a deadline. The historical external 170-second observation
convention does not apply to a future observation-mode caller. A separately
released caller must support non-expiring asynchronous observation and owned
cancellation, or disclose an unavoidable platform limit before dispatch.
No such caller or producer operation is released by this source change.

Actual AbortSignal cancellation remains available during asynchronous intake,
runner setup, generation and staging. Canceling a pending filesystem wait does
not prove that its underlying I/O stopped or settled. Synchronous blocking,
process death and platform limits cannot be preempted or bounded by this
JavaScript contract. Installed Codex, external provider duration limits and
cost remain UNKNOWN; this profile supplies no unlimited platform, allowance or
spending guarantee.

One child, shared job/scope nonreuse, exact source and prompt bindings, admission,
freshness, retention policy, permissions, forced ChatGPT authentication and the
six environment exclusions remain required. Denial, quota, provider errors,
parser errors, stream failures and output caps remain failures without fallback
or retry. After actual cancellation or error, existing finite shutdown remains:
3000 ms TERM grace, 2000 ms KILL grace and 1000 ms stream drain. Unobserved
termination retains uncertain custody and quarantine.

Once direct-child termination is observed, existing local drain and persistence
bounds remain finite. Rejected retention uses the existing 2000 ms persistence
bound in observation mode. These waits cannot terminate an otherwise running
generation. After foreground success returns, staging receives one fixed
20000 ms local closeout window. It never starts while generation is running and
cannot renew. Expiry reports `POST_GENERATION_CLOSEOUT_DEADLINE`, an incomplete
primary result and `post_generation_closeout.status: "DEADLINE_EXCEEDED"`.
It does not claim a generation timeout or successful staging. Pending I/O and
partial artifacts remain preserved; no cleanup, replay or late promotion occurs.

Observation results use `SQUIRE2_PROJECT_CODING_OBSERVATION_RESULT_V1`, the exact
execution descriptor, `outer_observation_target_ms: null`, and a closed
`post_generation_closeout: {status, limit_ms: 20000}`. Its statuses are
`NOT_STARTED`, `COMPLETE`, `CANCELED`, `DEADLINE_EXCEEDED` and
`FAILED_OR_UNCERTAIN`. Generation runtime evidence retains a null deadline,
false generation-timeout latch and actual monotonic process wall time.
Primary correctness and native application qualification remain unevaluated.

The explicit native receipt APIs are
`createNativeProjectCodingObservationResultReceipt(liveResult)` and
`writeNativeProjectCodingObservationResultReceipt(liveResult, destination, ports)`.
They share existing exclusive 0600 creation, ownership, identity, bounded
readback and successful-close checks. They emit
`SQUIRE3_NATIVE_PROJECT_CODING_OBSERVATION_RESULT_RECEIPT_V1`.
Legacy APIs reject this format, and observation APIs reject legacy or mixed
formats before writing.

Offline projection uses
`projectNativeProjectCodingObservationRunSummary(savedEnvelope)` and
`formatNativeProjectCodingObservationSummaryTerminal(summary)`, with summary
schema `squire3.native_project_coding_observation_summary.v1`.
`bin/squire-report.mjs` recognizes the exact saved receipt schema and reads only
the supplied saved bytes. Valid recorded native claims exit 1; invalid receipts
exit 2. Operator admission is the recorded boolean, with authority
`NOT_ESTABLISHED`; missing evidence stays unknown and zero stays zero.
No private command, path, operator receipt or payload becomes terminal text.

The existing explicitly admitted desktop CLI also accepts a hash-bound
observation config. A staged result emits only the distinct
`SQUIRE2_DESKTOP_CODING_OBSERVATION_ACK_V1` nonqualification ACK and exits 1.
The original desktop ACK remains byte-for-byte unchanged.

Both explicit phase and failure observation APIs compose with this profile
through the same admitted child. Their schemas, privacy limits, error behavior
and sidecar separation remain unchanged. Diagnostic writes remain separate,
explicitly awaited host operations after the primary result.

Source acceptance uses fake children, clocks, injected preparation and receipt
filesystems, and owned disposable fixture files. No actual long wall wait,
provider, generated program, GJS or product task is required. Focused synthetic
checks and independent complete-callchain/privacy review are required before
publication or any separately authorized installation or run. This feature
does not alter S1, release a retry, establish a timeout cause or prove a native
benefit.

This additive adapter permits one separately admitted real Codex generation for
`desktop-gjs-gtk4`. It uses the existing JSONL collector, envelope parser,
exclusive envelope persistence and physical multifile staging. It never launches
GJS, generated files, syntax checks, tests, a desktop application or a grader.

The existing Node route and desktop `SOURCE_SIMULATION` route retain their
schemas and behavior. Original project admission, receipt-destination validation
and `--run-admitted` continue to reject desktop activation. The original desktop
profile document describes that older source simulation route. This document
defines the separate production code-generation seam.

Preparation uses exactly five arguments:

```
node acceptance/prepare-project-task.mjs --prepare-desktop-codegen <fresh-prepared-dir> <published-source-commit> <request.json> <private-inputs.json>
```

The existing closed request must explicitly select `desktop-gjs-gtk4`.
Private inputs explicitly supply job, fresh scope, Codex executable pin and
version, requested model, effort, tuple authorization, permissions and prospective
desktop identity. There are no model, effort, executable or permission defaults.

The prospective identity retains the existing closed representation:

```
{
  status: "NOT_QUALIFIED",
  executable: {path, bytes, sha256},
  typelibs: [{namespace, version, typelib, bytes, sha256}],
  libraries: [{name, path, bytes, sha256}]
}
```

Preparation validates this supplied data without observing, reading, probing or
executing its paths. Node, Codex and prospective GJS executable paths must be
distinct. Only the separately pinned Codex executable is a generation launcher.
This representation establishes no GJS ABI, library resolution or native app
qualification.

The new closed config has schema `SQUIRE2_DESKTOP_CODEGEN_OPERATION_V1`, mandatory
`operation_intent: "CODEGEN_ONLY_NO_DESKTOP_EXECUTION"`, explicit desktop target,
the exact desktop prefix identity and the prospective identity. Other policy
fields retain the existing source, Node, Codex, prompt, retention, shutdown,
environment, 120-second generation, 140-second observation and one-child bounds.

Only `DESKTOP_CODEGEN_ONLY` prepends the fixed global arguments
`-c 'forced_login_method="chatgpt"'` before the existing Codex argv and `exec`
command. Preparation, config validation and generation use the same pure
ChatGPT-only profile helper. The original Node, default, receipt,
`SOURCE_SIMULATION` and other Codex profiles keep their existing argv.
Operation inputs cannot select another auth method, provider or extra arguments.
This per-process restriction writes no persistent config and authorizes no
manual login, logout or credential changes. The existing six scoped API key
and endpoint environment deletions remain unchanged.

The override restricts allowed authentication; it does not establish the active
account, current included allowance or credit state, and supplies no hard
billing guarantee. ChatGPT authentication alone does not disable purchased
ChatGPT or Work credits. Real admission still requires fresh evidence for the
same account using ChatGPT authentication, the official default provider,
available included capacity, `hasCredits: false` and balance zero, bound to the
exact accepted source, config, cwd and argv. No proof boolean is inferred from
the flag. The helper remains `PREPARED_NOT_EXECUTABLE` with
`runtime_admitted: false`; it creates no admission or preflight proof.

Incompatible credentials, unknown fresh state, unavailable quota or unexpected
credit state require stopping. Never repair credentials, switch providers or
retry. Existing prepared artifacts remain preserved and unadmitted; they cannot
silently rebind to changed source. Newly accepted source requires fresh
preparation and separately supported admission.

The desktop inventory includes the existing project inventory plus the receipt
modules already imported by the entrypoint. The dedicated source test traverses
relative runtime imports and checks membership. Preparation hashes current
source bytes; historical preparations cannot be rebound to changed source.

The fresh manifest records actual source pins, prompt bytes and digest, config
digest, selected explicit profile, Codex executable pin and exact argv. It labels
the operation `CODEGEN_ONLY_NO_DESKTOP_EXECUTION` and the native application
`NOT_QUALIFIED`. Creation uses the existing fresh directory and exclusive file
writes with readback; existing files are never overwritten or deleted. A partial
preparation remains partial and supplies no authorization to retry in place.

The separate admission has exactly:

```
{
  provider_id: "native_codex",
  operator_receipt,
  config_sha256,
  job_id,
  scope,
  desktop_codegen_admitted: true,
  preflight: {evidence_receipt}
}
```

`validateDesktopCodegenAdmission` checks binding without consuming authority.
`requireDesktopCodegenAdmission` additionally consumes the job and scope in the
same in-memory sets used by original project admission. Exact config bytes are
bound, including whitespace. Neither function admits a native application.
Consumption supplies no durable crash recovery, reset or retry mechanism.

The explicit operation shape is:

```
node acceptance/project-entrypoint.mjs --run-admitted-desktop-codegen <config.json> <admission.json>
```

This is an interface description, not a benchmark command or authorization to
run an operation. A future operation requires fresh admission and effective
preflight bound after source freeze. The adapter invokes the existing
`validateCodexPreflight` unchanged, verifies source/Node/Codex/prompt pins, checks
retention READY and binds exact prompt bytes before generation. Environment
key deletion and argv intent do not establish effective authentication,
subscription routing, fallback exclusion or permission enforcement.

The native wrapper uses fixed native filesystem, clock, retention and spawn
capabilities. The pure invocation builder and explicitly injected acceptance
helper permit source tests without a native child. Operation JSON cannot supply
a shell, loader, evaluator, executable override or provider callback.

The real runner port mode is `DESKTOP_CODEGEN_ONLY`, with the mandatory codegen
intent. It forwards exact target, prefix and prospective identity. It is
separate from `SOURCE_SIMULATION`. The only child is the pinned Codex launcher
using the existing read-only CLI profile and controlled foreground launch.

The private API may return the existing raw `SQUIRE2_PROJECT_RESULT_V1` with
`operator_admitted: true` for code generation only. No new fields are inserted
into that closed result. The CLI does not serialize the raw result or use the
old receipt writer. A physically staged candidate emits only:

```
{"schema":"SQUIRE2_DESKTOP_CODEGEN_ACK_V1","status":"CANDIDATE_STAGED","task_correctness":"NOT_EVALUATED","native_app_status":"NOT_QUALIFIED"}
```

It exits 1. Admission, setup, generation, persistence, staging and other operation
failures emit the fixed error
`DESKTOP_CODEGEN_ADMISSION_OR_OPERATION_FAILED` and exit 2. This mode has no exit
0 outcome. Default and unrelated CLI invocations retain their old inert behavior.

Envelope custody and the stage ACK remain separate observations. Existing
destination, partial I/O, cancellation and deadline failures retain honest
quarantine without overwrite, deletion, replay or late promotion. Cooperative
filesystem I/O can outlast a returned failure; owned buffers remain retained
until that I/O settles. Direct-child settlement does not prove descendant
custody or hard host lifetime control.

Source acceptance uses injected event-emitting producers, clocks and owned
temporary files. The focused workflow runs only the new test file. Existing CI
and the full regression remain separate required checks. These tests establish
source behavior, not provider readiness or benchmark results.

This is the first real producer component, not the full Blackjack controller,
desktop bridge, evaluator or benchmark. The frozen brief, autonomous
interpretation and host ACK, original 2400-second budget, ten model reservations,
three native jobs, eight owned-process ceiling and per-call bounds remain
unchanged. Actual native input, app-only capture, custody, settlement, evaluator
isolation, runtime qualification and fresh operation proof remain pending.
No score is computed; the manual score remains UNKNOWN until supplied by the
owner.

## Opt-in private failure observations

`runProjectDesktopCodegenNativeWithFailureDiagnostics(configBytes, admission,
abortSignal)` is a separate explicit observation API. Its trusted synthetic
counterpart is
`runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(configBytes, admission,
abortSignal, ports)`. Both reuse the existing admitted runner and fixed launch
once. They return `{result, failure_diagnostics}`; `result` is the unchanged
primary runner result. Existing native, default, CLI, simulation and receipt
APIs retain their shapes. Never pass this envelope to the old native receipt
writer.

Only the explicit opt-in function loads the observer module, through a fixed
literal lazy import. Legacy entrypoint routes do not eagerly load it. Future
desktop preparations pin it through `DESKTOP_CODEGEN_SOURCE_FILES`. Existing
artifacts, historical pins and admissions are not rewritten.

The observer attaches its own stderr data, end and error listeners to the
returned child. It performs no read, pause, resume, pipe, retry, extra launch or
provider callback. It seals and detaches owned listeners when the runner returns
or throws. Late events cannot revise the frozen metadata. Throws remain throws.

The closed observation contains fixed marker keys with counts saturated at 255,
saturating byte counts, scanned byte count, truncation, EOF, stream availability,
completeness and a fixed observer error enum. Unknown, missing, empty at EOF,
partial, truncated and observer failure remain distinct. It scans at most 65536
bytes in total, using at most that prefix of any chunk. ASCII letters are case
folded; non-ASCII bytes, including invalid UTF-8, break matching. Chunk boundaries
preserve at most the longest fixed pattern minus one ASCII characters. Omitted
bytes break matching continuity. Sealing clears the carry.

The fixed literals are `stream disconnected`, `error sending request`,
`retrying`, `reconnecting`, `connection reset`, `timed out`, `401 unauthorized`,
`403 forbidden`, `429 too many requests`, `rate limit`, `quota` and
`clamping interrupt hook timeout`. These are literal sightings only. They
establish no authentication, quota, permission or failure cause verdict.
No raw log, exception message, command, private path, payload, account identifier,
credential or arbitrary-byte digest enters the evidence. This supplies no
regex-based credential redaction guarantee.

A `CANDIDATE_STAGED` primary result returns only
`failure_diagnostics: {status: "NOT_RETAINED_SUCCESS"}`. Other terminal results
return:

```
{
  status: "OBSERVED",
  evidence: {
    schema: "SQUIRE_PRIVATE_FAILURE_EVIDENCE_V1",
    binding: {job_id, outcome, lifecycle},
    observation
  },
  sidecar_status: "NOT_REQUESTED"
}
```

The binding selects the validated config's UUID job identifier and fixed enums
from the actual returned primary outcome and generation lifecycle. An unavailable
primary field stays `UNKNOWN`. It contains no scope, operator receipt, command,
raw reason or exception. This relationship is recorded data; it establishes no
provenance authenticity or causation.

The observation wrapper starts **zero diagnostic filesystem operations**.
There is no automatic sidecar, background write, persistence promise or late
filesystem work owned by that wrapper.

The separate explicit trusted API is
`writeProjectFailureDiagnostics(evidence, {scope, job_id}, {fs, uid})`.
The host caller must separately authorize and await it under an accepted
remaining external deadline and observer. The helper has no internal hard
filesystem deadline and cannot force pending filesystem I/O to settle. If the
host's external observation window expires first, custody remains uncertain;
the host must account for outstanding I/O and preserve partial artifacts.
This API creates no runtime authority, primary-job extension, process dispatch
or permission to retry. No actual host integration is activated here.

The writer requires the evidence binding's job UUID to match the supplied run
job UUID before any write. Its only destination is the fixed derived path
`<scope>/output/run-<job>/failure-diagnostics.json`. It rebuilds closed data and
limits encoded JSON to 4096 bytes. It opens exclusively with no-follow flags
and mode 0600, checks owner and single-link regular-file identity, and compares
exact readback bytes without hashing secret input.

The existing parent must be owned by the supplied uid and mode 0700. Every
ancestor must be a nonsymlink directory owned by root or that uid, with no group
or other write permission or special permission bits. Whole-ancestor identities
and policies are rechecked across the write and close. Unsafe or changed
ancestry, including a writable temporary-directory ancestor, rejects recording.
No directory is created, existing file overwritten or partial artifact cleaned up.

The separately awaited writer returns only a fixed status:

- `FAILED`: validation or ancestor checking rejected before any potentially
  creating open was invoked.
- `UNKNOWN`: open was invoked and complete custody could not be established.
  This includes an open exception, partial write, readback mismatch, mode or
  identity uncertainty, and close failure. An exclusive-open rejection also
  remains `UNKNOWN`; exception text is never used to infer artifact absence.
- `RECORDED`: exclusive creation, exact bounded readback, identity, ownership,
  mode, ancestry and successful close checks completed.

None of these statuses rewrites the primary result or the wrapper's frozen
`NOT_REQUESTED` status. They establish neither crash durability nor hostile-host
isolation. Partial and uncertain artifacts remain preserved without cleanup or
replay.

The focused synthetic command is
`node --test test/project-failure-diagnostics.test.mjs`; existing regression
checks remain required separately. Tests use fake children, clocks and writer
filesystem ports, plus owned fixture files for successful synthetic staging.
They execute no provider, model, generated module, GJS or real child process.
This feature neither recovers lost stderr nor fixes or reproduces an unknown
benchmark failure, qualifies a native runtime, changes a runtime budget, or
authorizes another operation.

## Opt-in private phase observations

`runProjectDesktopCodegenNativeWithPhaseDiagnostics(configBytes, admission,
abortSignal)` explicitly selects phase observation. The injected source-test
counterpart is
`runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts(configBytes, admission,
abortSignal, ports)`. They call the existing admitted native path once and return
`{result, phase_diagnostics}`. The primary `result` is unchanged. Default, CLI,
receipt and V1 failure-observation contracts retain their behavior.

Only this opt-in wrapper loads `project-phase-diagnostics.mjs`, using a fixed
literal lazy import. Future desktop preparations pin its complete dependency
closure. Existing preparations, source pins and admissions are not rewritten.
The wrapper samples the existing trusted monotonic clock before its first await;
elapsed times therefore include async intake and setup. Clock throws, unsafe
values and regressions produce fixed errors and nullable times. These are
elapsed observations, never wall-clock freshness evidence.

The observer marks the spawn attempt immediately before the existing spawn
port and observes only the returned child and its streams. It adds and removes
its own listeners. It never wraps stdin write/end callbacks, calls stream
read/pause/resume/pipe, starts another child, accesses diagnostic files, schedules
work, sends signals or changes a deadline. The 120-second generation,
140-second observation and separately accepted 170-second parent window remain
unchanged. JSONL activity and terminal usage cannot renew any deadline.

`spawn_returned` records local child allocation. `stdin_finish_event` records
only Node Writable `finish`; it does not attest the source write/end callbacks,
peer EOF, a peer read or provider prompt receipt. JSONL kinds are literal local
observations and supply no trusted provider attestation. Missing milestones
supply no cause verdict. The observer seals on primary return or throw and
detaches its listeners without waiting for child close or descendants. Child
close may occur after sealing; an unobserved close does not contradict primary
direct-child exit evidence.

An observed envelope contains:

```
{
  status: "OBSERVED",
  evidence: {
    schema: "SQUIRE_PRIVATE_PHASE_EVIDENCE_V1",
    binding: {job_id, outcome, lifecycle, declared_prompt_bytes},
    observation: {
      clock, observer_error, milestones, streams,
      stdout_event_counts, stdout_frame_quality, terminal_usage
    }
  },
  sidecar_status: "NOT_REQUESTED"
}
```

The binding's prompt size is the validated declared size, never an observed
delivered-byte claim. Stdin has stream availability and event milestones, with
no fabricated observed byte count. Stdout and stderr availability, EOF, close,
error and byte counters remain distinct. Their counters saturate at the current
project collector caps plus one: 1048577 and 65537 respectively. Stream error
payloads and child error payloads are never inspected.

Diagnostic JSONL work has separate limits: 1 MiB scanned stdout, a 65536-byte
line buffer and 256 parse attempts, including malformed frames. LF frames and
the final nonempty EOF frame are processed once. Oversized lines are discarded
through LF, allowing later bounded frames to be observed. Omitted scan bytes
break continuity. An unfinished line without EOF is not counted as a complete
frame. Complete-frame count is capped at 1048576; each event-kind count is capped
at 255 with an overflow flag. Reaching 256 parse attempts sets the parse-cap
flag even when no later frame arrives. After that cap, bounded LF and final
nonempty EOF frame accounting continues without buffering or parsing more line
bytes. Only occupied buffer regions are cleared; empty LF frames perform no
line-buffer erase.

Complete UTF-8 frames use the existing duplicate-aware project parser. Numeric
tokens are checked lexically before that parser. Canonical nonnegative integer
tokens through 9007199254740991 are accepted. Syntactically valid zero tokens
with an all-zero mantissa, including `-0`, `0.0` and `-0e-999`, become exact zero
without evaluating an exponent. Other valid numeric tokens become a transient
negative sentinel, so selected counters report INVALID/UNKNOWN. This deliberately
rejects nonzero decimal or exponent notation, including `1.0` and `1e0`, as well
as fractions, unsafe integers, negative nonzero values and values that floating
point conversion could round or underflow. No rounded numeric conversion,
BigInt or exponent-sized allocation establishes validity. Strings and malformed
whole numeric tokens remain unchanged; grammar, UTF-8, BOM and duplicate-key
rejection remain subject to the existing parser. Rejected frames produce fixed
counts. Unknown event types map to `OTHER`; they never become metadata keys.

The only selected CLI usage fields are `input_tokens`, `output_tokens`,
`cached_input_tokens` and `reasoning_output_tokens` from an observed
`turn.completed`. Missing counters stay `UNKNOWN`, zero stays zero, and invalid
counters remain `UNKNOWN` with INVALID availability. Cache and reasoning
counters are separate views; no total, billing, cost or inference-time estimate
is computed. Repeated or conflicting `turn.completed`/`turn.failed` terminals
make usage AMBIGUOUS and clear its counters. App-server notifications are not
interpreted as this CLI route's usage.

For example, a synthetic `turn.completed` observed at 80000 ms can coexist with
the unchanged primary `LIMITED_TIMEOUT` at the original deadline and an
unobserved child-close milestone. Its numeric usage is a separate diagnostic
view; it does not promote the operation to success or rewrite the primary record.

Evidence is rebuilt as a closed, deeply frozen projection. Only fixed keys,
enums, counts, elapsed times, numeric usage and UUID binding survive. No raw
stdin/stdout/stderr, prompt, message, reasoning, tool argument, error, private
path, account identifier, credential or secret-byte hash is retained. Temporary
line buffers are cleared at sealing; this makes no secure JavaScript-string
erasure claim. Accessors, proxies, unknown keys and serialization hooks are
rejected without invocation.

Unexpected observer or evidence-construction failures after a known result
return fixed
`{status: "UNAVAILABLE", reason: "OBSERVER_ERROR", sidecar_status: "NOT_REQUESTED"}`
diagnostics while preserving that result. Existing config and admission throws
remain throws. Clock degradation alone retains useful finite observations with
nullable timestamps.

Observation starts zero diagnostic filesystem operations. The separate explicit
writer is `writeProjectPhaseDiagnostics(evidence, {scope, job_id}, {fs, uid})`,
exported by the phase module. A host must separately await it within its
accepted remaining external window. Its only destination is
`<scope>/output/run-<job>/phase-diagnostics.json`. It shares the private V1 writer
mechanics with a fixed internal kind: closed job binding, at most 4096 encoded
bytes, exclusive 0600 creation, single-link ownership, whole-ancestor policy and
identity checks, exact readback and successful close. It creates no directories,
overwrites nothing and performs no cleanup or background I/O.

Writer statuses retain the V1 meaning: FAILED before a potentially creating
open, UNKNOWN after possible mutation without established custody, RECORDED
only after verification and close. Pending filesystem work supplies no bounded
RECORDED claim; an expired external observation window leaves custody UNKNOWN.
The writer cannot extend the primary job or rewrite its result.

The focused proposed source command is:

```
node --test --test-isolation=none test/project-phase-diagnostics.test.mjs test/project-failure-diagnostics.test.mjs test/desktop-codegen.test.mjs
```

Fixtures use fake children and clocks, memory writer ports, owned disposable
files for synthetic staging, and source inspection. They distinguish native
stream caps from diagnostic scan, line and frame caps. Independent execution,
source/privacy review and the existing full regression remain required. This
source feature authorizes no native run, producer release or budget change.
