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
