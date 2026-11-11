# Private first-revision review and decision

`buildProjectRevisionReviewPackage(spec, ports)` packages one original PR210
candidate and its first PR211 owner-supplied revision. It does not change the
original-candidate API or infer that a revision should be accepted. The closed
`SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1` supplies both complete results, exact
base/original/revised bare Git directories and their `{dev, ino}` identities,
the original P1 review package directory and expected manifest SHA-256, one to
eight explicitly declared prior P1 decision directories and expected file
digests, a selected prior `decision_id`, a fresh `output_dir`, and an optional
genuine `AbortSignal`. The selected decision must be `REVISE`; disclosed
conflicting `ACCEPT` or `REJECT` decisions reject. The declared set cannot
prove that undisclosed decisions do not exist. Reviewer labels are supplied
text, not authenticated people.

The builder binds the original and revised results to the same base, receipt
and stage digests, checks `revision_of` and all `revised_blobs` witnesses, and
rechecks pinned refs, physical stores, commit parents, tree closure and source
identity before reporting success. It compares raw endpoint bytes twice:
base to revised and original to revised. A path restored to its base bytes is
present only in the latter view and marked `RESTORED_BASE`; an unchanged
original path can remain in the base-to-revised view. No three-dot Git diff or
candidate code execution is involved.

The fresh mode-`0700` private directory contains
`revision-review-manifest.json`, `base-to-revised.diff.txt`,
`original-to-revised.diff.txt`, and exact `changes/<path>.base`, `.original`,
or `.revised` copies for sides used by either changed view. A restored-base
path needs its original and revised copies; an unchanged-original path needs
its base and revised copies. Leaves are mode `0400`.
Displays cover every changed side with reversible quoted text or explicitly
mark binary content for inspection of the byte copies. The manifest binds
both views and each side's mode, Git blob ID, byte length and SHA-256.
`verifyProjectRevisionReviewPackage(dir)` checks the package offline, with
the original Git stores unavailable. It proves copy integrity, not producer
authenticity, source task correctness or original job completion.

The first profile permits 2,048 base files, 2,098 candidate files, 50 union
changed paths and seven path components; each retained side is at most 4 MiB,
all side copies total at most 12 MiB, each complete display at most 8 MiB,
the manifest at most 512 KiB and the package at most 29 MiB. Oversize,
unsupported paths or modes, source drift, cancellation and uncertain I/O
withhold success. Partial fresh output is retained for inspection; it is not
promoted from file presence or silently cleaned up.
The 29 MiB total is conservative: component ceilings sum to 28.5 MiB.
Closed 50-path rows cannot reach the 512 KiB manifest ceiling, and a valid
first PR211 correction changes at most 50 paths with at most 4 MiB of revised
content. A union over 50 paths is unreachable under valid linked results;
malformed over-limit records reject.

`recordProjectRevisionDecision(packageDir, decision, freshDecisionDir, ports)`
accepts a closed `SQUIRE_PROJECT_REVISION_DECISION_V1` with explicit
`ACCEPT`, `REVISE` or `REJECT`, exact package and prior-decision digests,
base/original/revised commit and tree IDs, bounded caller-supplied label and
ID, sorted `(view, path)` byte-hash attestations and an optional private
note. `ACCEPT` requires every path in **both** views and explicit binary
acknowledgement. The fresh decision directory is append-only relative to old
packages and decisions. `verifyProjectRevisionDecision(packageDir,
decisionDir, expectedSha256, ports)` verifies one explicitly selected record;
there is no implicit winner among later conflicting decisions.

These APIs return fixed statuses, digests, object IDs and counts without
private paths or source contents. A decision records only a supplied source
review choice. It does not grant execution, merge or disclosure authority,
authenticate a person, or establish native or benchmark acceptance. Focused
synthetic/disposable-Git tests run with
`npm run test:project-revision-review-package`.
