# Bounded private evidence for one physical project job

An owner can verify the copy integrity of one selected attempt offline, without
writing an API caller:

```text
node bin/squire-physical-evidence.mjs verify <absolute-attempt-dir> <expected-manifest-sha256> [--json]
```

The expected lowercase SHA-256 must come from the caller's separate retained
evidence status; the command never discovers a root or derives an expected
digest from the selected directory. The selected path must identify exactly one
`attempts/<job-id>` directory. Exit 0 means its bounded files passed the shipped
custody and byte-integrity verifier. Text and JSON success output contain only
fixed copy-integrity and acknowledgement-UNKNOWN labels. Exit 1 reports a
fixed verifier rejection code; exit 2 is usage. `--help` exits 0 without reading
an attempt. Neither output includes private paths, job IDs, raw streams, result
contents or exception text. Verification cannot establish the producer's
identity, original acknowledgement, job success, descendant settlement, retry
authority or native acceptance.

The opt-in `runProjectCodexTaskWithPhysicalEvidence(spec, options, ports,
evidenceSpec)` route is for one legacy bounded `PROJECT_CODEGEN_V1` attempt.
When the original runner returns in time, its `result` is returned unchanged
alongside a separate fixed-status evidence projection. If the conservative
cutoff precedes that return, the wrapper reports `result: null` and evidence
`UNKNOWN`; it does not invent an underlying result. The ordinary `runProjectCodexTask` route
and its result schema remain unchanged. The closed evidence spec supplies a
caller-owned private root and an operation/config SHA-256; the implementation
recomputes that digest from the admitted task before accepting the opt-in.
Neither API grants permission to start a model job; the caller must already
hold that separate authorization.

Before any spawn, the opt-in route checks its protected mode-`0700` root,
claims one of 16 create-exclusive slots and reserves a fresh attempt directory
for the unique job ID. Slots are never reused, even after interrupted setup.
Each attempt is limited to 1.5 MiB, so the 16-slot root has a 24 MiB managed
payload ceiling. A duplicate ID, exhausted capacity or uncertain reservation
withholds the opted-in spawn. There is no eviction, overwrite or automatic
cleanup.

The collector copies raw bytes synchronously in stream order into bounded
private memory before its usual close; it performs no disk I/O in the stream
callback and preserves the existing parse and stop decisions. Stdout is capped
at 1 MiB and stderr at 64 KiB. Over-capacity capture retains a prefix marked
`PREFIX_OVERFLOW`, never a claim that the complete stream was saved. The
existing project runner retains its generation and outer deadlines, one-spawn
limit, direct-child exit/EOF evidence and `UNKNOWN` states.

Only after the original runner returns does evidence publication write
create-exclusive private leaves and a canonical manifest. An existing result
receipt or stage reference is recorded only after its acknowledgement and
job/operation binding are checked. In this first profile, a result-receipt
write failure retains partial output and reports `UNKNOWN` without starting
the final manifest; an acknowledged bundle always has a checked result
receipt. A conservative absolute cutoff begins
before evidence preflight; it never extends the runner's budget. If the
runner remains pending, or a non-abortable write or manifest acknowledgement
is unresolved at cutoff, the evidence outcome is `UNKNOWN`. In-flight I/O may
leave readable partial files, including a manifest, but file presence does
not prove that the caller received an acknowledgement. The original result
may itself report an unsettled child; evidence publication never upgrades
that claim.

`verifyProjectPhysicalJobEvidence(attemptDir, expectedManifestSha256)`
checks a selected private bundle's byte integrity read-only. It cannot
authenticate the producer, settle descendants, establish provider finality,
recover missing usage, prove task correctness, grant a retry or authorize
candidate acceptance. Public evidence status omits raw streams, prompts,
source, paths, private IDs, provider text and arbitrary exception messages.
Full raw bytes and the manifest remain private; this source delivery does
not authorize retaining a real job or uploading a bundle.

The focused synthetic test is `npm run test:project-physical-job-evidence`.
It uses disposable roots and injected child/clock ports, without a real
provider, native app, benchmark or old held request.
