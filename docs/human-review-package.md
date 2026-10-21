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
returns `VERIFIED` or `CORRUPT_OR_INCOMPLETE`, always leaving original operation
acknowledgement UNKNOWN. It proves neither provenance authenticity nor crash
durability. Verification cannot repair an earlier failed operation.

CLI exit 0 means a valid package whose recorded Q218 task conformance is PASS;
exit 1 means a valid package with failed/incomplete conformance or generic
`CANDIDATE_READY` / `NOT_EVALUATED`; exit 2 means packaging/verification failed.
A verified generic package never becomes functional PASS. Output uses fixed
labels and package-relative names, without caller paths or native exception text.

Checks rely on a cooperative, quiescent local filesystem. Modes and hashes do
not provide hostile-code containment, same-user tamper resistance, race-free
custody, descendant tracking or power-loss durability. The artifact remains
untrusted and local-only until a human explicitly reviews execution or disclosure.
No provider run or generated-program execution is needed to build a package.
