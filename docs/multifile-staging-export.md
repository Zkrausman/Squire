# Bounded local multifile staging and export

This additive library accepts explicit caller-owned bytes. It does not generate,
import, evaluate, launch, grade or publish a project. PR175's fixed four-file
single-source package and its CLI are unchanged. No new CLI or runtime route is
provided. All evidence and frames remain local-only and potentially sensitive.

```js
import {planStaging, writeStage, verifyStage} from '../src/multifile-staging.mjs';
import {planExport, writeExport, buildExport, verifyExport} from '../src/multifile-export.mjs';
```

`planStaging({stage_operation_id, caller_label, files})` is pure. Each file has
exactly `{path, classification, content}` with a plain Uint8Array. Project
classifications are SOURCE, LOCAL_ASSET and DOC. Tokens contain 1–64 ASCII
letters, digits, underscores or hyphens. Plans own defensive byte copies;
plain metadata is frozen, while typed arrays remain mutable and are validated
and copied again at each write boundary. Forged or changed plans reject.

| Class | Files | Per-file bytes | Aggregate bytes |
| --- | ---: | ---: | ---: |
| SOURCE | 25 | 65,536 | 524,288 |
| LOCAL_ASSET | 20 | 524,288 | 2,097,152 |
| DOC | 5 | 65,536 | 131,072 |
| EVIDENCE_LOG | 10 | 262,144 | 1,048,576 |
| FRAME_CAPTURE | 10 | 1,048,576 | 5,242,880 |

Paths preserve original ASCII bytes/casing. Only letters, digits, `.`, `_`, `-`
and segment separators are accepted: at most 256 bytes, seven segments and
64 bytes per segment. Absolute paths, empty segments, traversal, backslashes,
controls, reserved manifest/bucket names and DOS device names reject. Duplicate,
casefold and file/directory-prefix collisions reject rather than rename.

`writeStage(plan, output_dir, {fs, uid, signal?})` exclusively creates a fresh
directory and its declared subdirectories at mode 0700. It writes exact data
bytes through exclusive mode-0600 handles, closes, performs bounded readback and
checks hashes, then changes only the newly created file to 0400 and confirms it.
It writes `stage-manifest.json` last. Existing destinations stop; failures retain
partial output without rollback, deletion, overwrite or automatic retry.

`planExport({export_operation_id, caller_label, stage_binding, staged_files,
evidence_files?})` is pure. The binding is exactly `{stage_operation_id,
stage_manifest_sha256}`. Staged descriptors have `{path, classification, bytes,
sha256}`; optional evidence descriptors have `{path, classification, content}`.
The plan partitions project files under `project/`, logs under `evidence/`,
and frames under `frames/`. Classification is not redaction or a public-safety
certificate. Contents are never sent to a provider or emitted in receipts.

`writeExport(plan, stage_dir, output_dir, ports)` reserves a fresh destination,
verifies the full exact stage and binding, copies project bytes into distinct
files, writes evidence, then writes `export-manifest.json` last. It verifies the
export and rechecks the original stage before acknowledgement. A subset cannot
masquerade as the bound complete stage. `buildExport(spec, ports)` provides the
same operation with explicit private `stage_dir`, `export_dir`, expected
`stage_manifest_sha256`, operation token, caller label and optional evidence.
It captures caller data before I/O and rejects EEXIST before reading stage data.

Manifests use the versioned `squire4.stage_manifest.v1` and
`squire4.export_manifest.v1` schemas: ASCII key/path ordering, compact UTF-8 JSON,
no trailing whitespace and no self entry/hash. `file_count`/`total_files` and
`total_bytes` count declared content only. The separate manifest digest is in
the returned receipt. Stage/export manifests are capped at 65,536/131,072 bytes;
the on-disk content plus manifest is additionally capped at 20 MiB.

Ancestor checks include the filesystem root and stop at the immediate parent
before creation. Above the boundary, root-owned or caller-owned directories must
have no group/other write bits, with an exception for root-owned sticky shared
directories. The immediate parent must be caller-owned protected or root-owned
sticky. A root caller may use a protected root-owned parent under the same caller
rule. Foreign owners, caller-owned writable parents and non-sticky writable
ancestors reject. Stat uid/mode must be safe non-negative integers before any
bitwise checks. There is no configurable trusted-root uid or permission repair.
After exactly one exclusive mkdir, the target is checked for caller ownership
and mode 0700. Existing-target verification performs no mkdir.

Receipts (`squire4.stage_receipt.v1`, `squire4.export_receipt.v1`) acknowledge
copy integrity only after close, readback, mode, exact inventory and final abort
checks. They omit host paths and never claim task PASS or runtime progress.
`verifyStage` / `verifyExport` return their corresponding versioned verification
schema with VERIFIED or CORRUPT_OR_INCOMPLETE. Verification leaves original
operation acknowledgement UNKNOWN, provenance authenticity NOT_ESTABLISHED and
crash durability NOT_ESTABLISHED. A valid manifest can remain after a failed
operation; verification cannot reconstruct its original acknowledgement.

All I/O requires explicit ports with `open`, `mkdir`, `lstat`, `chmod` and
`readdir`, a non-negative safe-integer uid and optional AbortSignal. Reads use
no-follow/nonblocking leaf opens, stable identity/mode/length checks, max+1
bounded buffers and at most 4-KiB reads. Symlinks, special files, hardlinks,
executable bits and undeclared inventory reject. Only manifest-declared
directories are listed; undeclared directories are never traversed. Fixed safe
error codes omit native messages, stacks, paths and causes. Abort/close failures
withhold acknowledgement; a stalled filesystem call has no hard time bound.

The filesystem must be cooperative and quiescent. These checks do not establish
hostile-code containment, same-user tamper resistance, race-free custody,
descendant shutdown, durable storage, private-grader isolation or GUI readiness.
The Blackjack baseline still needs its separately admitted execution route.
