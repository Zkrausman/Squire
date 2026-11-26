# Prepare a private review package and blank worksheet

Use this additive offline command when you already have the exact saved
original result, or the linked original and first-revision results, and all
explicit caller-selected bindings described in the
[spec composer contract](project-review-spec-composer.md).

```sh
node bin/squire-review-prepare.mjs original /private/original-bindings.json /private/fresh-original-spec.json /private/fresh-original-worksheet.json
node bin/squire-review-prepare.mjs revision /private/revision-bindings.json /private/fresh-revision-spec.json /private/fresh-revision-worksheet.json
```

These are alternative operations, each with its own new destinations. The
package directory is the explicit `output_dir` in its bindings file, not a
derived or selected name. Supply normalized absolute paths, physical Git-store
identities, and saved result filenames. For a revision you must also supply the
original package and its independently retained manifest digest, the complete
caller-declared prior-record references with their retained digests, and the
explicit selected prior REVISE ID. No discovery or choice is performed.

Keep the inputs and stores quiescent, with trusted, existing, symlink-free
parent directories. The spec, package and worksheet destinations must be fresh
and disjoint from one another and the selected inputs and protected stores
(including the base checkout when the base is its .git directory).
No prior artifacts are overwritten or edited. Keep the artifacts private.

## What one operator invocation does

The separate entrypoint invokes the existing fixed repository CLIs using the
same Node executable, one stage at a time:

1. Compose the exact existing builder spec (#316). Retain it.
2. Build the original or revision package using the unchanged builder.
   Retain the package and its acknowledged manifest SHA-256.
3. Run the existing **full** read-only package verifier with that exact
   acknowledged digest (not a digest recomputed from an untrusted package).
4. Use #309 to create the blank editable worksheet, including its own full
   digest-bound verification and the original family's bound manifest reread.

Thus one operator command contains **four underlying CLI stages**, not one
validation stage. The standalone build's validations, explicit verification,
and worksheet verification have not been removed. Additional wrapper preflight
checks protect the separate new worksheet destination. All standalone commands
remain available with unchanged interfaces.

On success the fixed stage acknowledgements and digest are printed, ending
with `PROJECT_REVIEW_WORKSHEET_PREPARED` and
`PREPARE_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY`.
Exit 0 acknowledges preparation only, not human review. The manifest digest
is the exact successful builder acknowledgement and is passed to both
verification stages.

## Inspect the prepared artifacts

For an original package read `review-manifest.json` and `diff.txt`.
For a first revision read **`revision-review-manifest.json`**, then
`base-to-revised.diff.txt` and `original-to-revised.diff.txt` in that order.
The [worksheet](project-review-worksheet.md) points to every required side
copy and its hash, in contract order. Inspect exact binary sides separately
where required. The worksheet remains blank: all response fields are null.
This operation ends before reviewer identity, choices, attestations, or
decision preparation/recording. Those operations are separately authorized
and remain separate.

## Partial results and limits

Exit 2 reports rejection, stage failure or output error, not proof of absence
of an artifact. The fixed diagnostic identifies the stopped stage and the
number of child stages acknowledged by the wrapper, not a guarantee that
the caller received those acknowledgements. Preserve even partial artifacts
and any acknowledgement that actually reached you. An unacknowledged stage
may have written output; external interruption may prevent any diagnostic at
all and does not establish whether the active child completed. No automatic
cleanup, overwrite, repair or retry takes place, and no missing digest or
acknowledgement is reconstructed. Do not replay onto the same destinations.
A later read-only integrity check can establish retained integrity but cannot
recover a lost original acknowledgement.

This is an offline source-review preparation operation only, not producer or
reviewer authentication, original acknowledgement recovery, crash-durability
proof, functional correctness, integration, native/benchmark qualification,
or permission to execute candidate bytes.

For the comparable workflow with original and first revision, the prospective
operator-command target is 5 rather than 11 before terminal rechecks (each
four-command preparation becomes one). The other three operator commands
are unchanged. The two four-stage preparations still perform eight
underlying CLI operations; with the remaining three, the underlying total
remains eleven, plus the two terminal rechecks in the comparable flow.
This is a design-level count, not an observed comparison, elapsed-time gain,
review quality result or genuine reviewer score. The
[historical synthetic walkthrough](../examples/offline-review/README.md)
remains unchanged.
