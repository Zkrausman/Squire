# Offline run summary

Read one explicit, previously saved Q218 JSON receipt:

```
node bin/squire-report.mjs <receipt-path>
```

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
