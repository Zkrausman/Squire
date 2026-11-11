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
Conflicting decisions can coexist. A consumer must select and reverify an
exact decision; presence or recency grants no authority. The label reports
what the caller supplied and does not authenticate human identity or attention.
No choice runs candidate code, grants functional PASS, merges Git or authorizes
disclosure.

These APIs return fixed status, object IDs, counts and digests without private
paths or content. A failure withholds success and retains any partial fresh
output. There is no automatic cleanup, retry, upload or candidate execution.
