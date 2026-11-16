# Private multi-file candidate review and decision

`buildProjectCandidateReviewPackage(spec, ports)` consumes exactly one original
`SQUIRE_PROJECT_REVIEW_CANDIDATE_V1` result from PR210. The closed
`SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1` has `result`,
`candidate_git_dir`, `candidate_git_identity: {dev, ino}`, `base_git_dir`,
`base_git_identity: {dev, ino}`, a fresh `output_dir`, and optional genuine
`signal`. The result is a supplied witness, not authenticated provenance.
Revision candidates are outside this API. The two selected protected Git
stores must remain available and quiescent throughout the build.

The fresh mode-`0700` output contains `review-manifest.json`, `diff.txt`, and
`changes/<path>.old` / `.new` for changed sides only. Files are mode `0400`.
The diff presents every old line with `-` and every new line with `+`.
Each line is JSON quoted, so control characters and trailing newline state
are unambiguous. Invalid UTF-8, NUL, DEL and non-text control characters are
conservatively classified as binary. Binary paths are
marked `BINARY_REVIEW_REQUIRED`; the exact bytes are in the side copies.
The manifest binds each side to mode, Git blob ID, byte count and SHA-256,
and binds the diff by length and hash. `verifyProjectCandidateReviewPackage(dir)`
checks every copy, the complete display, manifest, modes and directory closure
without Git access. This is package integrity, not current source-store state.

The review profile permits 2,048 base files, 2,098 candidate files, 50 changed
paths, 4 MiB per changed side, 8 MiB of copied changed bytes, an 8 MiB diff,
a 256 KiB manifest and 17 MiB total package. Additions and replacements of
regular files are supported; deletions, renames, new executable modes,
symlinks and gitlinks reject. The result remains pending human review and
unevaluated for task correctness.
The 17 MiB total guard is conservative: the three byte ceilings sum to at
most 16.25 MiB (8 MiB copies + 8 MiB diff + 256 KiB manifest), so a valid
package cannot reach that total ceiling.

`recordProjectCandidateDecision(reviewPackageDir, decision, freshDecisionDir,
ports)` first verifies the package offline. Its closed
`SQUIRE_PROJECT_CANDIDATE_DECISION_V1` contains a bounded `decision_id` and
`reviewer_label`, `review_package_sha256` (the verified manifest digest), exact
base/candidate commit and tree IDs, `choice: ACCEPT|REVISE|REJECT`, sorted
`attestations`, and optional note (at most 4,096 UTF-8 bytes). Each attestation
has `path`, `old_sha256` (nullable for additions), `new_sha256`, and
`binary_inspected`. `ACCEPT` requires one matching attestation per path and
explicit binary acknowledgement. The fresh decision directory contains one
mode-`0400` `decision.json`; prior decisions and the package are untouched.
Canonical decision bytes have a shared 96 KiB ceiling, checked before reserving
the fresh directory. This accommodates the existing 50-path and 4,096-byte
note profile even when JSON escaping expands the note; it does not reduce
those input limits. P1b consumes prior P1 decisions under the same ceiling.
Conflicting decisions can coexist. A consumer must select and reverify an
exact decision; presence or recency grants no authority. The label reports
what the caller supplied and does not authenticate human identity or attention.
No choice runs candidate code, grants functional PASS, merges Git or authorizes
disclosure.

These APIs return fixed status, object IDs, counts and digests without private
paths or content. A failure withholds success and retains any partial fresh
output. There is no automatic cleanup, retry, upload or candidate execution.

## Explicit original-candidate package CLI

Build or verify the existing private review package without a custom API caller:

```sh
node bin/squire-candidate-review.mjs --build /absolute/review-spec.json
node bin/squire-candidate-review.mjs --verify /absolute/review-package
node bin/squire-candidate-review.mjs --help
```

`--build` delegates only to `buildProjectCandidateReviewPackage`; `--verify`
delegates only to `verifyProjectCandidateReviewPackage`. The decision command
below remains separate. Explicit first-revision package routes are documented
in [first-revision review](project-revision-review-package.md#explicit-first-revision-package-commands);
the original routes never translate revision inputs. There is no discovery,
automatic source selection, decision recording, source execution or Git integration.

Both command arguments must be normalized absolute non-root Unix paths, at most
4,096 characters, without controls or backslashes. Build reads one stable regular
non-symlink JSON file, capped at 65,536 raw bytes. The existing strict UTF-8/JSON
parser rejects malformed input, duplicate decoded keys and arrays over 64
items; the original-candidate profile needs at most 50 changed paths. The raw
frame limit also applies to whitespace and escape-heavy representations. The
wrapper copies input bytes and clears its own copy after completion. Cooperative
read-stability checks do not provide a hostile-filesystem atomic snapshot.

Supply the existing closed `SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1`: `schema`,
`result`, `candidate_git_dir`, `candidate_git_identity`, `base_git_dir`,
`base_git_identity`, and fresh `output_dir`. The source/output paths must be
explicit and normalized; exact source identities, result/object/ref bindings,
protected stores, original profile and create-exclusive private output remain
validated by the existing API. The optional genuine `AbortSignal` is available
only to programmatic API callers and must be omitted from the JSON spec. No
bindings, paths or source receipts are derived or relabeled by this command.

Verification selects exactly the package argument and reads no spec or Git
stores; it remains useful after the original stores are unavailable. It checks
copy integrity, not current source state, producer authenticity, substantive
review, task correctness, original acknowledgement or functional acceptance.
Neither operation reads decisions or infers a review verdict.

Exit 0 acknowledges the selected API result. Stdout contains its fixed
`PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED` or
`PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED` status, manifest SHA-256,
base/candidate commit and tree IDs, changed-path count and package byte count,
and `COPY_INTEGRITY_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY`. It contains no
private paths, operation labels, filenames, diff/source text or caller IDs.
Projected digests, object IDs and counts are validated before output; build
object IDs and path count must match the supplied result witness. This does
not authenticate that witness. Handled input/API/result failures return 2 with
fixed `PROJECT_CANDIDATE_REVIEW_REJECTED` when the output channel is usable.
Default/malformed invocation prints usage and returns 2; exact `--help` prints
usage and returns 0. Neither reads a spec/package or invokes an operation.

PR240-style synchronous sink capture/write containment suppresses later output
after a failed write. The executable alone installs persistent stdio error
observers that latch 2 for early or late observed errors; imports are inert.
`write(false)` retains backpressure meaning. There is no output retry, fallback,
cleanup, rollback, flush or consumer-receipt guarantee, and unobserved errors
before termination cannot be certified. A partial or complete package may
remain after interruption, API I/O failure or lost acknowledgement. Exit 2 or
missing output does not establish no mutation or authorize a repeat build;
file presence or later verification cannot recover original acknowledgement.
The command does not modify old source stores, packages or decisions.

The exported `runCandidateReviewCli(argv, ports)` has trusted `readBytes`,
`build`, `verify`, stdout and stderr overrides for deterministic callers/tests;
the executable uses fixed native defaults. This is not a new untrusted runtime
or admission boundary. Tests use fresh synthetic/disposable packages only:
`node --test test/candidate-review-cli.test.mjs test/project-candidate-review-package.test.mjs`.
They perform no real private-candidate use, owner decision or generated-code execution.

## Explicit record-only decision CLI

An owner can supply an explicit original-candidate decision without writing an
API caller:

```sh
node bin/squire-candidate-decision.mjs record /absolute/review-package /absolute/decision-request.json /absolute/fresh-decision-dir
node bin/squire-candidate-decision.mjs --help
```

The three paths must be normalized absolute non-root paths, at most 4,096
characters each, without controls or backslashes. There is no discovery,
stdin input, package-building mode or automatic choice in this decision command.
The [package command above](#explicit-original-candidate-package-cli) is separate. The original `record`
route does not accept revision packages; the explicit `record-revision` route
is documented in [first-revision review](project-revision-review-package.md). The
request file must be a stable regular non-symlink leaf, at most 96 KiB. The
existing bounded reader and strict UTF-8/JSON parser reject special files,
concurrent read changes, duplicate keys and malformed input. These cooperative
checks do not provide a hostile-filesystem atomic snapshot guarantee.

Supply exactly the existing `SQUIRE_PROJECT_CANDIDATE_DECISION_V1` API request
above: explicit choice, package digest, base/candidate object IDs and sorted
attestations. Preserve the 50-path and 4,096-UTF-8-byte note profile; `note` must
be omitted or a string. The shared 96 KiB canonical-output ceiling remains.
A previously stored `decision.json` is not a request: its added `boundaries`
and possible `note: null` are rejected rather than stripped or translated.
The command never generates attestations or chooses a decision from package
status, existing records or recency.

The command delegates package verification, exact bindings, complete/binary
ACCEPT requirements and fresh private create-exclusive output to
`recordProjectCandidateDecision`. It does not add a second verifier or change
that API. Package integrity does not authenticate the producer, the supplied
reviewer label or human attention. Recording even `ACCEPT` grants no execution,
merge, GitHub approval, task PASS or disclosure authority. No Git stores,
provider, candidate execution, upload or real-job recovery are invoked.

Exit 0 acknowledges recording the supplied choice, including `REVISE` or
`REJECT`; it is not software acceptance. Stdout contains only
`PROJECT_CANDIDATE_DECISION_RECORDED`, package/decision digests and
`SOURCE_DECISION_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY`. Paths, caller decision IDs, reviewer labels,
choice text, notes, attestations and source bytes are omitted. Handled input,
operation or result rejection returns 2 with the fixed
`PROJECT_CANDIDATE_DECISION_REJECTED` diagnostic when the output channel is
usable. Default/malformed invocation prints fixed usage and returns 2; exact
`--help` prints usage and returns 0. Neither reads a request nor records a decision.

Synchronous sink failures return 2 and suppress further writes. The executable
also installs process-lifetime stdio error observers that latch 2 without
logging the error or retrying output; plain imports install none. A `write()`
return of `false` keeps its backpressure meaning. These boundaries do not
certify drain/flush, consumer receipt or errors unobserved before termination.
A partial or complete record may remain after I/O failure, interruption or
failed acknowledgement. Missing output and exit 2 do not prove no mutation;
file presence or later integrity checking does not recover original ACK.
The command never retries, overwrites, removes output or advances a latest
pointer. External termination is not a successful acknowledgement. Preserve
partial outputs and existing nonreuse rules.

The exported `runCandidateDecisionCli(argv, ports)` has trusted `readBytes` and
`record` overrides for original-candidate deterministic callers/tests, plus a
separate `recordRevision` override for the explicit revision route and stdout/stderr sinks;
the executable uses the fixed reader/API defaults. A separate explicit
[first-revision decision verification route](project-revision-review-package.md#explicit-selected-revision-decision-verification)
uses its own trusted `verifyRevisionDecision` callback and creates no record.
Overrides are not a new
untrusted execution or admission boundary. The wrapper copies request bytes,
clears its copy after completion and validates the fixed result projection.

Source checks use fresh synthetic packages and explicit synthetic decisions:
`node --test test/candidate-decision-cli.test.mjs test/project-candidate-review-package.test.mjs`.
They do not make a real owner decision or run generated code.


## Explicit selected original-decision verification

Verify one caller-selected original decision without recording another choice:

```sh
node bin/squire-candidate-decision.mjs verify-decision /absolute/review-package /absolute/decision-dir <expected-decision-sha256>
```

Both paths follow the normalized absolute path rules above. The expected digest
is required, lowercase and exactly 64 hexadecimal characters. Malformed/default
invocation returns 2; exact help returns 0. Neither invokes the verifier or reads
a request. This route accepts no request file, discovers no decisions, selects
no winner and never infers ACCEPT or missing attestations.

`verifyProjectCandidateDecision(reviewPackageDir, decisionDir, expectedSha256,
ports)` verifies the existing original package and one private mode-0700 directory
containing only a regular, single-link mode-0400 `decision.json`. It reuses the
bounded no-follow reader, 96 KiB ceiling, canonical encoding and writer binding
checks: exact package digest and base/candidate object IDs, unique sorted path
attestations, old/new byte hashes, complete ACCEPT coverage and required binary
acknowledgements. Stored boundaries must match exactly. An omitted writer input
note is deliberately accepted as its canonical stored `note: null`; explicit
null remains invalid as a recording request. Missing stored note, unknown fields,
noncanonical bytes and wrong digests reject. Package and decision identities are
rechecked; these cooperative checks are not a hostile-filesystem atomic snapshot.
Offline verification needs no original source stores.

The frozen API result contains only `status`, `review_package_sha256`,
`decision_sha256` and `attested_path_count`. Exit 0 prints fixed
`PROJECT_CANDIDATE_DECISION_VERIFIED`, those digests/count and
`SELECTED_RECORD_INTEGRITY_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY`. Handled rejection
returns 2 with fixed `PROJECT_CANDIDATE_DECISION_REJECTED` when the channel is
usable. Choice, paths, reviewer labels, IDs, notes and attestations are omitted.
The trusted CLI `verifyDecision` override is separate from recording and revision
verification callbacks. Existing synchronous/asynchronous output-failure handling
above applies without retry or fallback. Verification creates no output artifact
and does not recover original acknowledgement, authenticate a reviewer, establish
substantive acceptance or grant execution, integration, disclosure or retry authority.

Tests use fresh disposable packages and explicit synthetic records only, including
all three choices, omitted notes, maximum profiles, corruption, private closure,
wrong bindings, source stores unavailable and failed acknowledgements. They do not
use real private decisions or execute candidate code.


## Compare a caller-retained expected package digest

```sh
node bin/squire-candidate-review.mjs --verify /absolute/review-package --expect-sha256 EXPECTED_MANIFEST_SHA256
```

Supply the caller's independently retained exact lowercase 64-hex manifest
digest; do not derive it from the selected package to manufacture a match.
The option follows the package path exactly and is valid only for verification.
Malformed, missing or extra arguments return usage/2 before any input/API call.
The command invokes the same complete package verifier once, validates the full
existing result projection and compares the captured manifest digest before any
success output. Mismatch or invalid metadata returns 2 with fixed
`PROJECT_CANDIDATE_REVIEW_REJECTED` when the channel is usable. No spec is read,
no build runs and no package is changed or retried.

A match preserves the exact healthy bytes/exit of the existing two-argument
verification, which remains unchanged. This compares selected copy identity,
not producer authenticity, current source state, substantive acceptance or
original acknowledgement; no execution, merge, disclosure or retry authority
is granted. Existing bounds, inert help/imports, synchronous/asynchronous
output-error containment and partial-output limitations apply unchanged.
See [first-revision comparison](project-revision-review-package.md#compare-a-caller-retained-expected-revision-package-digest)
for the separate revision family.


## Build an original review package from a retained snapshot

`buildProjectCandidateReviewPackageFromSnapshot(spec, ports)` consumes one
explicitly selected portable-original snapshot after its original Git stores
are unavailable. It never reconstructs a store or invokes Git. The closed
`SQUIRE_PROJECT_CANDIDATE_REVIEW_FROM_SNAPSHOT_SPEC_V1` contains `snapshot_dir`,
`expected_manifest_sha256` and fresh `output_dir`, plus the `schema` field and
an optional genuine API-only `signal`. Paths must be normalized absolute,
non-root and nonoverlapping. The expected hash is the caller's retained exact
lowercase 64-hex manifest SHA-256, never derived to manufacture a match.

```sh
node bin/squire-candidate-review.mjs --build-from-snapshot /absolute/snapshot-review-spec.json
node bin/squire-candidate-review.mjs --verify /absolute/handoff/package --expect-sha256 EXPECTED_PACKAGE_MANIFEST_SHA256
```

The first command uses the existing strict stable non-symlink JSON reader with
a 64 KiB raw frame; no serialized signal or extra fields are accepted. It
creates one fresh private mode-0700 **handoff container**, not a V1 package at
the container root. Its exact children are:

- `package/`: unchanged `SQUIRE_PROJECT_CANDIDATE_REVIEW_PACKAGE_V1`, consumable
  by the existing original package and decision APIs/commands;
- `provenance.json`: canonical UTF-8 JSON, a regular single-link mode-0400 file,
  at most 16 KiB. The V1 package manifest and directory closure gain no fields
  or extra receipt file.

The receipt's closed `SQUIRE_SNAPSHOT_REVIEW_PROVENANCE_V1` fields are `schema`,
`source_snapshot_manifest_sha256`, `review_package_manifest_sha256`,
`input_result_sha256`, the four `base_commit`/`base_tree`/`candidate_commit`/
`candidate_tree` IDs, `changed_path_count`, `package_bytes` and `boundaries`.
It links the selected snapshot and exact review package; it includes no paths,
job labels or source content. Its six ordered boundary statements are
`RETAINED_SNAPSHOT_SOURCE_ONLY`, `LIVE_GIT_CUSTODY_NOT_ESTABLISHED`,
`ORIGINAL_RESULT_BODY_NOT_VALIDATED`, `ORIGINAL_ACKNOWLEDGEMENT_NOT_RECOVERED`,
`ORIGIN_NOT_AUTHENTICATED`, and
`NO_DECISION_EXECUTION_MERGE_DISCLOSURE_OR_RETRY_AUTHORITY`.

The builder reuses complete snapshot object/tree/copy verification, reads exact
changed old/new inspection sides with bounded stable no-follow checks, and
reuses the existing complete diff/manifest/private writer and package verifier.
It rechecks the full source and its physical root identity after writing,
compares the resulting review binding, checks receipt readback and package
binding, and checks the container's identity, private modes and two-child
closure before success. These cooperative checks are not an atomic snapshot
or a hostile-writer/no-interference guarantee.

All portable limits still apply. The smaller review limits also apply: 50
changed paths, 4 MiB per side, 8 MiB copied sides, 8 MiB diff, 256 KiB manifest
and 17 MiB package. A valid snapshot can exceed these review limits and reject
before destination creation. The container adds only the bounded receipt to
package bytes; no profile is raised or text truncated. Binary review and
complete explicit ACCEPT attestations remain unchanged. No decision is recorded
or inferred by this builder. First-revision snapshots/chains are outside this
original-format route.

Snapshot bytes do not contain the full original result/receipt body or current
store/ref custody. The inherited result hash is retained, not revalidated from
an invented body; historical original-vs-revision producer behavior is not
proved by an opaque hash. Neither the V1 package nor the receipt authenticates
a producer or human review, recovers original ACK, or grants task PASS,
execution, integration, merge, disclosure or retry authority. Existing package
and decision verifiers check `package/` only; they do **not** consume or
authenticate `provenance.json`. The builder's readback binds the receipt when
created, and its returned digest lets a caller retain that exact receipt
identity. After copying, use the explicitly selected handoff verification route below to
check the retained receipt/package pairing; it still does not authenticate a
producer or recover original ACK.

The frozen API result contains `PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED_FROM_SNAPSHOT`,
source snapshot/package/provenance/inherited-result hashes, four object IDs,
path count and package bytes. CLI exit 0 acknowledges that result; stdout is
fixed validated metadata, the fixed relative directory `package`, and
`RETAINED_SNAPSHOT_SOURCE_ONLY; NO_LIVE_CUSTODY_OR_ORIGINAL_RESULT_VALIDATION`.
No private paths/content/labels are printed. Handled failure uses fixed
`PROJECT_CANDIDATE_REVIEW_REJECTED` and exit 2 when output is usable. Trusted
`buildFromSnapshot` CLI injection is for deterministic callers/tests, not new
execution authority. Old routes and their successful output remain unchanged;
help adds the new route. Existing sync/async output-error containment applies.

Failure, cancellation or lost acknowledgement may leave a partial or complete
container/package/receipt. Preserve it; do not retry, remove, overwrite or infer
no mutation from exit 2/missing stdout. Later integrity cannot recover original
ACK. This feature does not reopen any held artifact/job. Tests use newly made
synthetic/disposable stores, snapshots, packages and decisions only; trusted
fixture setup is distinct from the new route, which executes no candidate,
Git or provider workload.


## Verify an explicitly selected copied snapshot-review handoff

```sh
node bin/squire-candidate-review.mjs --verify-snapshot-handoff /absolute/copied-handoff EXPECTED_PROVENANCE_SHA256
```

`verifyProjectCandidateReviewSnapshotHandoff(handoffDir,
expectedProvenanceSha256, ports)` and this exact three-argument CLI form are
read-only. Supply a normalized absolute non-root root and the caller's retained
primitive lowercase 64-hex SHA-256 of `provenance.json`. Never derive an expected
value from the selected receipt merely to manufacture a match. Malformed,
missing or extra arguments reject before any reader/verifier call; no JSON
request file is read. Imports/default/help remain inert as documented.

The shared private verifier checks the mode-0700 root's exact `package/` and
`provenance.json` closure, reads the regular single-link mode-0400 receipt with
a bounded stable no-follow reader, and compares its bytes to the expected hash.
It validates the existing closed 11-field canonical receipt, all digest/ID/count
bounds and the six exact ordered limitation statements. It invokes the complete
V1 package verifier and checks the receipt's package manifest hash, inherited
input-result hash, four object IDs, changed-path count and byte count. Receipt,
package-directory and root identities/metadata and closure are rechecked. The
builder uses this same validation; its prepared-source digest and original
container identity gates remain. These are cooperative read-stability checks,
not a hostile-filesystem atomic snapshot guarantee.

Only the selected handoff and required ancestry metadata are read. No source
snapshot, Git store, request, decision or original result body is needed or
opened. No build, recording, discovery, latest selection, repair, write,
cleanup or retry occurs. Existing V1 package/decision verification still checks
only the package; it is distinct from this selected receipt/package operation.
The 16 KiB receipt frame, V1 17 MiB profile and all smaller per-side/copy/diff/
manifest/path limits remain unchanged. Fixed closed metadata cannot fill a valid
16 KiB receipt; padding and over-limit fixtures reject rather than representing
an invented maximum valid record.

The frozen API status is `PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED`;
its remaining fields are the same fixed source/package/provenance/inherited
result digests, four object IDs, path count and package bytes as the builder.
Success exits 0 with fixed validated metadata and
`SELECTED_HANDOFF_INTEGRITY_ONLY; NO_AUTHENTICITY_OR_ACKNOWLEDGEMENT_RECOVERY`.
The returned provenance digest must match the caller expectation before stdout.
No paths, labels, decision choice/content, receipt body or source text are
printed. Handled rejection returns 2 with fixed
`PROJECT_CANDIDATE_REVIEW_REJECTED` when output is usable. Trusted
`verifySnapshotHandoff` injection is separate from reader/build/revision ports;
it creates no new untrusted execution boundary. Existing synchronous sink
suppression, executable asynchronous error latches, backpressure meaning and
no output retry/fallback/flush/consumer-receipt guarantee apply unchanged.

This verifies a retained byte-bound pair, not the truth of a producer's source
claim, current source validity, live custody, missing original result body,
human review, task correctness or original acknowledgement. Even a caller-pinned
well-formed receipt only carries a declared snapshot hash; it cannot supply
source authenticity or execution, integration, merge, disclosure or retry
authority. Failure/lost output leaves the packet untouched and does not settle
any earlier unknown operation. Tests use fresh synthetic/copied packets only.
