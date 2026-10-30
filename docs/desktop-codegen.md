# Explicit desktop source generation

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
