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
below remains separate. There is no revision-package mode, discovery, automatic
source selection, decision recording, source execution or Git integration.

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
the executable uses the fixed reader/API defaults. Overrides are not a new
untrusted execution or admission boundary. The wrapper copies request bytes,
clears its copy after completion and validates the fixed result projection.

Source checks use fresh synthetic packages and explicit synthetic decisions:
`node --test test/candidate-decision-cli.test.mjs test/project-candidate-review-package.test.mjs`.
They do not make a real owner decision or run generated code.
