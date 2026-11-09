# Offline run summary

Read one explicit, previously saved Q218 JSON receipt:

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

Exit codes are 0 for complete reported task PASS, 1 for FAIL or INCOMPLETE, and
2 for invalid input or a read error. Diagnostics use fixed codes without native
exception text. Empty/missing/extra arguments print fixed usage and return 2.

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
