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
Canonical decision bytes have the shared 96 KiB ceiling before a new directory
is reserved and on offline readback. The bound includes the existing 100
two-view attestations and 4,096-byte note with JSON escaping; path, note and
attestation profiles remain unchanged. Oversized existing records reject.

These APIs return fixed statuses, digests, object IDs and counts without
private paths or source contents. A decision records only a supplied source
review choice. It does not grant execution, merge or disclosure authority,
authenticate a person, or establish native or benchmark acceptance. Focused
synthetic/disposable-Git tests run with
`npm run test:project-revision-review-package`.

## Explicit first-revision package commands

Use the same offline review executable with separate first-revision routes:

```sh
node bin/squire-candidate-review.mjs --build-revision /absolute/revision-spec.json
node bin/squire-candidate-review.mjs --verify-revision /absolute/revision-package
node bin/squire-candidate-review.mjs --help
```

These delegate only to `buildProjectRevisionReviewPackage` and
`verifyProjectRevisionReviewPackage`. Original `--build` / `--verify` retain
their successful bytes, 64 KiB spec frame and original-candidate contract;
help lists both families. No schema is relabeled, prior decision selected,
revision chain created or substantive choice inferred.

Build requires the existing closed `SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1`
with its thirteen required fields: `schema`, `original_result`,
`revised_result`, `base_git_dir`, `base_git_identity`, `original_git_dir`,
`original_git_identity`, `revised_git_dir`, `revised_git_identity`, `output_dir`,
`original_package`, `prior_decisions`, and `selected_decision_id`. All source,
original-package, prior-decision and fresh output paths are explicit normalized
absolute non-root paths, at most 4,096 characters, without controls or
backslashes. The optional genuine `AbortSignal` remains programmatic API only
and must be omitted from JSON; no serialized substitute is accepted.

The stable regular non-symlink request reader caps the **revision** file at
262,144 raw bytes. The existing strict UTF-8/JSON parser rejects malformed
input, duplicate decoded keys and arrays over 64 elements. This accommodates
the accepted 50-path lists, 50 revised-blob witnesses and eight prior references;
prior decision bodies are read separately by the unchanged API, never inlined
or translated by the CLI. For a conservative canonical encoding budget,
13 maximum path strings require at most 159,744 UTF-8 bytes, the two 50-path
lists 25,600, and 50 closed blob-witness rows 28,800. A further 32 KiB allowance
for fixed metadata remains below the 256 KiB frame (246,912 bytes total).
This is a finite serialization budget, not a runtime or measured-gain claim.
Raw whitespace and escape-heavy encodings still count toward the frame.
Cooperative stable-read checks do not provide a hostile-filesystem atomic snapshot.

The API retains all source/store identity checks, original/revised lineage,
selected prior REVISE and declared-set binding, disclosed conflict rejection,
two direct endpoint views, profile limits and private create-exclusive output.
The CLI does not generate bindings, filter a conflicting set, choose a winner
or claim that undisclosed decisions do not exist. Old candidates, packages and
decisions remain untouched. A restored-base path remains visible in the
original-to-revised view; this command does not substitute a merge-base view.

Success output contains only fixed
`PROJECT_REVISION_REVIEW_PACKAGE_CREATED` or
`PROJECT_REVISION_REVIEW_PACKAGE_VERIFIED`, manifest SHA-256, base/original/revised
commit IDs, the two view path counts and package byte count, followed by
`COPY_INTEGRITY_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY`. It contains no
private paths, caller labels, prior IDs, decision content, diffs or source.
The projection validates digest/ID formats and finite counts; build commit IDs
and view counts must match the supplied result witnesses. It invents no tree
IDs or acknowledgement. Handled input/API/result failure returns 2 with fixed
`PROJECT_REVISION_REVIEW_REJECTED` when usable output permits. Success is 0;
help is 0 and malformed/default invocation is usage/2 with no input/API reads.

Offline verification selects one package and reads no spec, original source
store or prior decision directory. It verifies retained copy integrity and
bindings, not current source state, original acknowledgement, producer or
reviewer authenticity, declared-set completeness, substantive review, task
correctness, functional PASS, execution, integration or disclosure authority.
The separate decision command below still needs an explicitly supplied fresh
choice and complete matching attestations.

Existing synchronous output suppression and executable-only persistent stdio
error observers apply; imports remain inert and `write(false)` retains
backpressure meaning. A partial or complete package can remain after failure,
interruption or lost acknowledgement. No retry, fallback, cleanup, rollback,
flush or consumer-receipt guarantee is added. Exit 2 or missing output does not
prove no mutation; later verification cannot recover the original ACK or
authorize a repeat build. Trusted `buildRevision` / `verifyRevision` injections
are separate from the original CLI ports and are for deterministic callers/tests;
executable defaults use the accepted APIs. The wrapper clears only its own
request-byte copy. No real private candidates or runtime jobs are used by tests.

## Explicit first-revision decision command

Use the existing offline decision executable with an explicit revision route:

```sh
node bin/squire-candidate-decision.mjs record-revision /absolute/revision-package /absolute/decision-request.json /absolute/fresh-decision-dir
node bin/squire-candidate-decision.mjs --help
```

The `record` original-candidate route is unchanged; it does not translate or
accept revision requests. `record-revision` delegates only to
`recordProjectRevisionDecision`. Supply its existing closed
`SQUIRE_PROJECT_REVISION_DECISION_V1` request: explicit choice and supplied
attestations, revision/original package and selected prior REVISE digests,
base/original/revised commit and tree IDs, decision ID and reviewer label, and
optional note. No fields, prior linkage, attestations, decisions or winner are
inferred. `ACCEPT` retains the API's all-path/two-view and binary-inspection
requirements. The command adds no alternate verifier, revision-chain support
or change to the P1b schema or first profile.

The three paths follow the [original command's normalized absolute non-root
path grammar](project-candidate-review-package.md#explicit-record-only-decision-cli).
The shared stable regular non-symlink reader and strict UTF-8/JSON parser bound
the request to 96 KiB, rejecting malformed or duplicate-key input. The
revision route selects a finite 100-element parser profile; the original route
and offline receipt parser retain their 64-element profile. The API's limits of
100 sorted two-view attestations, a 4,096-UTF-8-byte optional note and a 96 KiB
canonical record remain unchanged. The revision API permits an omitted
or null note as well as a string; the original route's note validation is
unchanged. A stored record's added `boundaries` field is rejected as a request,
not stripped. Cooperative file checks do not guarantee a hostile-filesystem
atomic snapshot.

Exit 0 acknowledges recording the explicitly supplied choice, including
`REVISE` or `REJECT`; it is not software acceptance. Stdout contains only
`PROJECT_REVISION_DECISION_RECORDED`, revision-package and decision SHA-256s,
and `SOURCE_DECISION_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY`. It omits paths,
caller IDs, labels, choice text, notes, attestations and source bytes. Handled
input, API or result rejection returns 2 and the fixed
`PROJECT_REVISION_DECISION_REJECTED` diagnostic when the channel is usable.
Malformed/default invocation returns 2 with fixed usage; exact `--help`
returns 0 with usage for both routes. Neither reads a bundle/request nor
records a decision. Plain import remains inert.

The existing synchronous output-failure guard and executable-only stdio error
observers apply to this route, with no output retry, fallback, cleanup or
rollback. Partial output or a complete decision may remain after an I/O or
acknowledgement failure. Exit 2 and missing acknowledgement do not prove no
mutation or authorize retry; file presence or later integrity verification
does not settle original acknowledgement. No drain/flush or consumer-receipt
guarantee is added. Preserve old packages, decisions and partial outputs.

The API still binds the prior REVISE and both direct views, without choosing
among later conflicting decisions or proving the declared set complete.
Recording a choice authenticates neither human identity nor attention, grants
no execution/merge/disclosure permission, and establishes no task correctness,
original job completion, native acceptance or benchmark result. This command
launches no provider, candidate code or Git integration.

The exported CLI's trusted `recordRevision` injection is separate from its
original `record` injection; executable defaults use the existing APIs. Tests
use newly constructed synthetic packages and explicit synthetic choices only:
`node --test test/candidate-decision-cli.test.mjs test/project-revision-review-package.test.mjs`.
