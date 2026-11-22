# Local human-review packages

Build a package from one explicit saved run receipt and its declared staged
source, under a fresh destination with an existing caller-owned parent:

```
node bin/squire-package.mjs --build <receipt-path> <source-path> <new-output-dir>
node bin/squire-package.mjs --verify <output-dir>
```

The tool never discovers runs, reads captures or neighboring files, launches
children, evaluates/imports candidate code, installs dependencies, or applies,
commits or pushes changes. It accepts the actual PR174 generic result profile
and the historical Q218 campaign profile through their existing validators and
safe projections. A profile selector cannot make invalid input acceptable.
Preparation configs and false runtime markers are not run evidence.

`planReviewPackage(receipt, sourceBytes, options)` is pure. It checks a copy's
exact byte count and SHA-256 against the recorded witness, then prepares safe
summary/README/manifest data. Its returned object and metadata are frozen;
typed-array contents are owned copies and are checked again before writing.
`writeReviewPackage(plan, outputDir, ports)` and
`buildReviewPackage(spec, ports)` use explicit filesystem ports. The latter
reads only the selected receipt (up to 256 KiB) and declared source (100–65,536
bytes), checks the source path binding and physically hashes its bytes.

The fresh mode-0700 directory contains exactly four regular files at mode 0400:

- `artifact.mjs`: an exact byte copy, with its own inode rather than a hardlink
  to the staged source. No added format transformation or BOM removal.
- `summary.json`: the existing allowlisted offline projection, excluding paths,
  raw errors, prompts, operator receipts and provider bodies.
- `README.txt`: safe review instructions and separate generation, syntax,
  conformance and limitation statements. Source body appears only in the artifact.
- `package-manifest.json`: `squire3.package_manifest.v1`, written last, with
  digests and sizes of the three data files. Its own digest is returned separately.

Reads are bounded and leaf opens reject symlinks/special files; selected ancestor
components are checked without scanning directory contents. Every write uses
`wx`, closes its handle, checks bounded readback and then sets the new file to
0400. Existing destinations of any kind stop with `DESTINATION_ALREADY_EXISTS`;
there is no merge, overwrite, retry, rollback or deletion. Any failure retains
honest partial output. Abort checks stop further work after observed I/O returns.
This adds no hard I/O deadline or crash recovery.

Manifest presence alone cannot establish original completion: a later close,
readback, chmod, cancellation or final source-check failure can occur after its
bytes exist. `verifyReviewPackage(dir, ports)` checks the current exact inventory,
modes, bounded bytes, digests and safe summary/README/manifest consistency. It
returns `VERIFIED` or `CORRUPT_OR_INCOMPLETE`. When a cancellation check
observes an explicitly supplied AbortSignal, it returns `VERIFICATION_ABORTED`
with exit code 2 and no integrity verdict. An unrelated I/O failure retains its
existing classification even if the signal was also aborted. All statuses leave
original operation acknowledgement UNKNOWN. Verification proves neither
provenance authenticity nor crash durability and cannot repair an earlier failed
operation.

The CLI's default native filesystem adapter enumerates this exact inventory
incrementally with `opendir` using a one-entry internal buffer, retaining at
most five names and rejecting the
fifth; it closes the directory handle on success, failure, and cancellation.
The injected filesystem port keeps its existing `readdir` callback contract.
Its caller controls that callback, so this allocation bound does not apply to
arbitrary injected implementations.
When called with an AbortSignal, `runPackageCli` reports a verification abort
as `PACKAGE_ABORTED` on stderr with exit 2 and no stdout report. The executable
does not translate process signals into package cancellation. Cancellation
does not modify the package or establish repair or retry authority.

CLI exit 0 means a valid package whose recorded Q218 task conformance is PASS;
exit 1 means a valid package with failed/incomplete conformance or generic
`CANDIDATE_READY` / `NOT_EVALUATED`; exit 2 means packaging/verification or synchronous CLI output failed.
A verified generic package never becomes functional PASS. Output uses fixed
labels and package-relative names, without caller paths or native exception text.

Checks rely on a cooperative, quiescent local filesystem. Modes and hashes do
not provide hostile-code containment, same-user tamper resistance, race-free
custody, descendant tracking or power-loss durability. The artifact remains
untrusted and local-only until a human explicitly reviews execution or disclosure.
No provider run or generated-program execution is needed to build a package.

## Synchronous CLI acknowledgement failure

The CLI captures selected write methods with their receivers before work. A
synchronous sink lookup/call failure returns 2 without exposing its exception.
After a failed output attempt, both channels suppress further writes: there is
no diagnostic fallback, retry, overwrite or output-driven cleanup. Healthy
operation errors retain their existing fixed diagnostics and successful output
and exit meanings remain unchanged; `write(false)` remains backpressure.

A completed package can therefore remain after exit 2, and a sink can emit
partial bytes before throwing. Neither missing output nor exit 2 establishes
that no mutation occurred. Later byte verification cannot establish the failed
operation's acknowledgement; existing partial-output/nonreuse rules still
apply. Imports remain inert. This boundary covers synchronous failures only,
not later stream error events, drain/flush or consumer receipt.

## Executable stdio error observation

`node bin/squire-package.mjs` installs stdout/stderr error observers before calling the CLI and retains
them for the executable lifetime. An observed error latches exit 2 without
inspecting/logging the error or attempting output, retry, rollback or cleanup.
The latch survives the normal CLI-result assignment and covers later events
observed before process termination. Importing the module installs no process
observers; exported CLI callers still own asynchronous errors on their streams.

Healthy bytes and exits remain unchanged. Partial acknowledgement or a complete
artifact can remain after exit 2; missing output does not prove no mutation, and
no retry or reuse is authorized. The executable does not end/destroy streams,
await drain/flush or certify consumer delivery, original acknowledgement, or
errors not observed before termination. No generation or artifact execution is
added.
