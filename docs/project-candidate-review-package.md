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

## Explicit record-only decision CLI

An owner can supply an explicit original-candidate decision without writing an
API caller:

```sh
node bin/squire-candidate-decision.mjs record /absolute/review-package /absolute/decision-request.json /absolute/fresh-decision-dir
node bin/squire-candidate-decision.mjs --help
```

The three paths must be normalized absolute non-root paths, at most 4,096
characters each, without controls or backslashes. There is no discovery,
stdin input, package-building mode, revision mode or automatic choice. The
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
`record` overrides for deterministic callers/tests, plus stdout/stderr sinks;
the executable uses the fixed reader/API defaults. Overrides are not a new
untrusted execution or admission boundary. The wrapper copies request bytes,
clears its copy after completion and validates the fixed result projection.

Source checks use fresh synthetic packages and explicit synthetic decisions:
`node --test test/candidate-decision-cli.test.mjs test/project-candidate-review-package.test.mjs`.
They do not make a real owner decision or run generated code.
