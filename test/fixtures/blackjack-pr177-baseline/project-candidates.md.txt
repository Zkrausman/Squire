# Bounded Codex project candidates

This additive source path connects one explicitly admitted Codex generation to
PR176 multifile staging. It never executes candidate files, checks syntax,
installs dependencies, grades a project or starts a benchmark. PR175, PR176 and
the single-JavaScript interfaces remain unchanged. Source tests use fake child
events and owned temporary files; they establish no actual provider readiness.

The closed request `SQUIRE2_PROJECT_REQUEST_V1` contains exactly `schema`,
`task_id`, `task_prompt`, `runtime_target: "node24-esm"` and
`stage_target: "multifile-candidate"`. Task IDs use 1–64 lowercase ASCII letters,
digits, hyphens or underscores, starting with a letter/digit. Instructions are
1–31,738 UTF-8 bytes. The exact reviewed 1,030-byte channel prefix plus those
unchanged instructions stays within the existing 32,768-byte prompt cap.

The restricted Codex JSONL profile still requires one started turn, exactly one
completed agent message, one successful terminal, clean stream EOF and observed
raw exit 0. The final message must be one JSON object:

```json
{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[{"path":"src/index.mjs","classification":"SOURCE","encoding":"utf-8","content":"export const example = 1;\n"}]}
```

Only SOURCE, LOCAL_ASSET and DOC classifications are accepted. Generated logs
or frames cannot be labeled observed evidence. Each closed file has exactly
`path`, `classification`, `encoding` and `content`. UTF-8 strings and canonical
padded base64 are supported; binary content is preserved exactly. SOURCE files
need at least one byte, without the single-JS profile's 100-byte minimum.
Markdown fences, encoding errors, duplicate decoded JSON keys, unknown fields,
unsafe paths/collisions, invalid base64 and excessive content/counts reject.
No syntax, dependency-freedom or code-safety claim follows from these checks.

PR176's unchanged class quotas and portable path rules apply. The envelope is
additionally bounded by 1 MiB of stdout and 1 MiB of decoded file bytes; the
actual JSONL transport needs space for its wrapper/escaping. Stderr is counted
and discarded at 65,536 bytes. No cap is silently increased to accommodate a
larger project.

`runProjectCodexTask(spec, options, ports)` uses explicit clock, fake/native
spawn, filesystem, uid, executable, tuple authorization and optional private
retention ports. It first persists the **exact final-message UTF-8 envelope**
at `output/run-<job>/candidate-envelope.json`, using exclusive creation and
bounded handle readback. The foreground record's output path and byte count
describe that envelope only. Its LimitedJobRecord task class is PROJECT_CODEGEN_V1.

Only after foreground success does the runner pass independently decoded file
buffers to PR176 `planStaging` / `writeStage` at `output/run-<job>/stage`.
The returned `squire4.stage_receipt.v1` is a separate physical copy-integrity ACK,
with the manifest digest and decoded-file totals. Those identities never replace
the envelope's custody identity. Staging failure leaves `staging: null`, retains
honest partial files and quarantines logical reuse; there is no rollback/retry.
A genuine completed stage ACK may remain as history if final cleanup observes
cancellation or deadline expiry. It cannot turn that INCOMPLETE result into a
candidate success or authorize reuse.

The versioned result `SQUIRE2_PROJECT_RESULT_V1` distinguishes CANDIDATE_STAGED,
GENERATION_REJECTED, STAGING_REJECTED, INCOMPLETE and FAILED. Every result keeps
`task_correctness: "NOT_EVALUATED"`, `task_outcome_evaluated: false`,
`runtime_admitted: false` and `descendant_guarantee: "NONE"`. CANDIDATE_STAGED
does not prove gameplay, functional correctness, trusted provenance, durability,
isolation, complete cleanup or benchmark acceptance. No old summary CLI is
repurposed to invent project PASS.

Source/config preparation is explicit:

```
node acceptance/prepare-project-task.mjs --prepare-codex <fresh-prepared-dir> <published-source-commit> <request.json> <private-inputs.json>
```

This creates only fresh prompt/config/manifest files after exact source/runtime
pin checks and private retention READY. The source inventory includes every new
collector/preparation module and the transitive single-JS summary dependency
loaded by the bounded receipt reader. Private inputs require explicit executable
identity, supported model/effort tuple, operator receipt and existing permission
mode; there is no production model, provider or effort default. Removing API key
environment variables does not prove effective subscription routing.

Imports and default invocation of `acceptance/project-entrypoint.mjs` are inert.
The only activation shape is `--run-admitted <config.json> <admission.json>`.
It needs separately scoped project admission, exact config/job/scope bindings,
fresh verified Codex subscription/allowance/permissions/output evidence and
retention READY. Admission tokens are consumed in memory; no reset/reuse/retry
or durable recovery is supplied. This source approval grants no actual launch.

The path attempts at most one 120-second generation, no syntax child, with a
140-second outer observation target. Timer/abort logic requires a responsive
parent event loop. Signal attempts differ from observed direct-child exit;
descendants remain untracked. A pending staging I/O may outlast the returned
failure; it retains its owned buffers until settlement, with no late promoted
ACK or workspace reuse. Filesystem calls are cooperative and cannot be forcibly
interrupted. There is no hard I/O completion, cleanup or host-lifetime guarantee.

Diagnostics expose finite stage/reason codes and validated usage metadata only.
Bodies, file contents, native error messages, stacks and raw streams do not enter
generic metadata/errors. Eligible rejected size/markdown responses use the
existing bounded **local-human-only** retention policy; noneligible failures do
not fabricate capture errors. Existing PUBLISHED/UNKNOWN retention semantics and
pending-copy ownership remain intact; no remote AI raw-body reads are enabled.

The existing major briefs still need separate orchestration, desktop/input/GUI
observation, full-owned custody/lifetime, grader isolation and exact runtime
admission. Job Queue service/workers and Windows Log Explorer platform/data
storage are not implemented by this candidate intake path.
