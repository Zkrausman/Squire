# Offline run summary

Read one explicit JSON receipt with a supported schema.

```
node bin/squire-report.mjs <receipt-path>
```

Consumers can inspect the fixed report interface without supplying a receipt:

```
node bin/squire-report.mjs --capabilities --json
```

This exact two-argument form prints one minified UTF-8
`SQUIRE_OFFLINE_REPORT_CAPABILITIES_V1` object followed by one LF and exits 0.
It performs no receipt read, file check, report projection, process spawn, or
provider call. The inventory is generated from the same closed route descriptors
that select the live projectors and formatters. It lists the seven accepted
versioned input schemas, the three closed unversioned legacy shapes, route output
kinds, exits, and route-applicable fixed stderr labels. Its total size is limited to
16 KiB; a serialization or size failure returns the fixed
`CAPABILITIES_INTERNAL_ERROR` diagnostic without writing partial JSON.

The listed rejection codes describe labels the CLI writes to stderr. The legacy
campaign terminal can also show finite producer diagnostic reasons from its
separate projection allowlist. Those `diagnostic.reason` values are not all
stderr labels; only codes listed for a route are promised by the V1 inventory.

The capability document introduces a versioned promise for its listed fields,
route and code meanings. It does not assert that these labels or meanings were
stable across earlier releases. A new receipt route or a newly listed rejection
code requires a reviewed discovery schema version. Receipt paths, receipt data,
environment values, raw exceptions, source text, and host or provider state are
not included. Capability data describes report selection only; it grants no
execution, admission, authenticity, or artifact-verification authority.

The command reads a regular file up to 256 KiB, rejects a leaf symlink or special
file, and prints a plain-text projection. It does not discover receipts, read the
recorded artifact, launch a task, recover a run or write files. Paths and raw
provider/error content are excluded from output. It reports recorded claims;
it cannot authenticate a receipt or reverify its artifact or operator admission.
Changing files concurrently remains outside an atomic snapshot guarantee.

| Exit | Meaning |
|---|---|
| 0 | Successful discovery with exact `--help` or `--capabilities --json`, or a complete reported legacy Q218 campaign `PASS`. |
| 1 | Valid typed receipt projection, including `NOT_RUN` for a Single-JS dry run, or a legacy result of `FAIL` or `INCOMPLETE`. |
| 2 | Invalid arguments or receipt, a read error, or an observed output failure. |

Discovery reads no receipt. Exit 1 on a typed receipt reports its recorded
outcome, which may be unevaluated. Invalid argument shapes print fixed usage.
Rejection diagnostics use fixed codes and omit exception text.

`projectRunSummary(receipt)` is the synchronous pure API. It accepts parsed JSON
data, rejects accessor/Proxy/cyclic inputs, and returns a deeply frozen
`squire1.offline_summary.v1` projection. `parseReceiptJson(bytes)` supplies bounded
UTF-8 JSON parsing with duplicate decoded-key rejection, depth/array/string limits
and prohibited prototype keys. `formatSummaryTerminal(summary)` validates the
summary and emits safe deterministic text. The async `runOfflineReportCli(argv,
ports)` wrapper permits injected read/stat/output ports for tests.

This first version recognizes the fixed Q218 campaign, its native wrapper, and
the disabled dry-run wrapper. A campaign requires FIX-01 through FIX-17 exactly
once in order. Expected nonzero exits can pass their recorded fixture oracle.
Generation `LIMITED_SUCCESS` alone never becomes task PASS. Early abort and dry
run preserve missing observations instead of inventing a completed matrix.
Unsupported schemas and contradictory success claims fail closed.

Requested and reported model are separate; only the current public Luna label
is emitted, with other labels projected to UNKNOWN. Explicit zero counters are
preserved. Unknown/unavailable counters remain null, reasoning stays separate
from thinking, totals are never derived, and provider duration is not inference
time. Artifact hashes identify recorded bytes only. Static false markers and
claimed operator admission are shown separately from fixture conformance.

The command grants no descendant containment, hostile-code safety, crash
recovery, automatic workspace reuse or general software-quality guarantee.
Generic single-JavaScript task reporting is a separate versioned successor;
this format must not invent 17-fixture acceptance for such a task.

## Synchronous output failures

A missing/non-callable selected sink write method or a synchronous exception
while selecting a sink, accessing its write method, or writing output returns
exit 2 without exposing the thrown value. Ordinary report and usage failures
do not attempt another write or a diagnostic fallback. Capability serialization
or stdout failure retains its existing one best-effort
`CAPABILITIES_INTERNAL_ERROR` stderr write; failure of that write also returns 2.
No failed channel is retried and no new capability rejection label is added.

A sink may emit bytes before throwing, so exit 2 can accompany partial output
or an already emitted report. The CLI cannot retract those bytes or certify
complete delivery. The imported reporter API boundary covers synchronous failures only: it does not
handle later stream error events, await drain or flush, or prove consumer
receipt. A `write()` return value of `false` retains its existing backpressure
meaning and is not classified as a synchronous failure. Successful report text,
route exits and capability JSON remain unchanged.

## Executable stdio error observation

The `node bin/squire-report.mjs` entry point installs stdout/stderr error
listeners before invoking the reporter and retains them for that executable's
lifetime. An observed stream error sets and latches exit 2 without logging the
error, attempting a diagnostic fallback, or retrying output. The latch prevents
an error before CLI completion from being overwritten by its ordinary result;
a later error can also change the exit code before process termination. A
closed pipe therefore withholds success without an uncaught stream-error stack.

Importing the module installs no process listeners and leaves exit state and
output untouched. Callers of the exported API still own asynchronous errors on
their supplied streams. The executable does not end or destroy streams, await
drain/flush, or prove consumer receipt. Already emitted bytes may remain, and
errors not observed before process termination cannot be certified. Successful
report bytes, receipt/readiness semantics and capability schema are unchanged.

## Synthetic examples

From the repository root, run the offline reporter against the files in
[`examples/offline-report/`](../examples/offline-report/).

```sh
node bin/squire-report.mjs --capabilities --json
node bin/squire-report.mjs examples/offline-report/single-js-dry-run.json
node bin/squire-report.mjs examples/offline-report/project-canceled.json
node bin/squire-report.mjs examples/offline-report/project-schema-only.json
```

| Input | Exit | Stdout | Stderr |
|---|---:|---|---|
| Capability discovery | 0 | Capability JSON | Empty |
| Single-JS dry run | 1 | `NOT_RUN` and `NOT_EVALUATED` | Empty |
| Canceled project | 1 | `INCOMPLETE`, `CANCELED`, and `generation=0` | Empty |
| Project schema discriminator alone | 2 | `INVALID_RECEIPT` and `Diagnostic: SCHEMA_MISMATCH` | `SCHEMA_MISMATCH` |

The dry-run input records zero child invocations. The canceled project records
null generation and staging and zero generation invocations. The final file is
valid JSON with an intentionally incomplete receipt. Its projection contains
only the fixed invalid-receipt message and diagnostic. Discovery reads no
receipt. These examples contain synthetic data and establish no task result.
