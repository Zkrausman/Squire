# Enter review bindings without editing JSON

The standalone keyboard guide creates the same original or first-revision
bindings document accepted by the [spec composer](project-review-spec-composer.md).
It creates a draft only. Run it from the repository root in a private local
terminal; the review screen intentionally displays the selected private
values. Do not share a terminal transcript or use a public logging surface.

```sh
node bin/squire-review-bindings.mjs original /private/new-original-bindings.json
node bin/squire-review-bindings.mjs revision /private/new-revision-bindings.json
```

Choose the family and fresh bindings filename explicitly. Enter each answer
on its own line: literal normalized absolute paths (no shell quotes or tilde
expansion), decimal device and inode numbers, exact retained lowercase SHA-256
strings and the selected decision ID. There are no defaults. The guide does
not look up files, inspect stores, calculate expected digests, read decisions,
or select a decision ID. It does not establish validity or permission for any
input. Enter `yes` only after checking the complete draft against your
independently retained selections. A blank, invalid answer, EOF before the
confirmation, or any other confirmation stops instead of writing a draft.

## Original

Supply your selected original saved result filename, base and candidate Git
directories, each one's exact device and inode, and the fresh package
directory. Review every field and the bindings destination before confirming.

## First revision

Choose `enter` to enter the original result filename and the base and original
store fields independently, or `reuse` to explicitly select one existing
original bindings file. In the latter mode the guide reads only that selected
file, displays exactly the seven shared scalar fields (result filename, two
store paths, and both devices and inodes), and asks you to confirm with
`yes` before using them. The original candidate fields become the revision's
original fields; the previous package destination is **not** reused.

In either mode, directly supply the revised result, revised store and its
identity, explicitly selected original package directory and independently
retained manifest digest. Declare the number (1–8) of prior records in your
complete supplied set; enter each selected directory and independently
retained file digest in the intended order, then explicitly enter the chosen
prior REVISE decision ID. Supply the new package destination and review the
final complete bindings draft. Reuse does not validate lineage, permissions,
the completeness of the set, any record or its choice; confirm the inputs
yourself and let existing checks reject invalid evidence.

## Validate separately

A successful guide exits 0 with `PROJECT_REVIEW_BINDINGS_WRITTEN` and
`DRAFT_ONLY; VALIDATE_SEPARATELY_WITH_REVIEW_PREPARE`. This acknowledges the
new binding document only. Run the existing [prepare-only command](project-review-prepare.md)
with that binding file and separate, explicit fresh destinations:

```sh
node bin/squire-review-prepare.mjs original /private/new-original-bindings.json /private/fresh-original-spec.json /private/fresh-original-worksheet.json
node bin/squire-review-prepare.mjs revision /private/new-revision-bindings.json /private/fresh-revision-spec.json /private/fresh-revision-worksheet.json
```

All existing composition, build, digest-bound verifier and worksheet checks
remain intact. The guide does not run those operations, produce candidate
or review-package source, inspect package contents or make review choices.
A syntactically valid but wrong identity, digest, record or result selection
can be written as a draft and is still rejected by the downstream validators.
No execution, integration or decision-recording authority is established.

Use existing trusted non-symlink parent directories and keep input paths and
stores quiescent. The guide checks both explicitly selected output destinations
(binding file and package directory) for freshness and separation from known
inputs; it writes only the binding file, exclusively with mode 0600. It does
not create parents or modify the original bindings. Additional checks belong
to the unchanged prepare-only path. Exit 2 is a rejected or failed operation;
do not infer absence of output after interruption or output errors. Preserve
partial artifacts and never retry onto the same path. Exact `--help` is inert.

## Entry accounting (design, not an observed workflow improvement)

Count scalar binding values by field role, not JSON punctuation, confirmation
prompts or coincidentally equal identity numbers. A two-part identity contains
two scalar numbers. For one prior record the original needs 8 values; a
revision needs 17. Direct entry does not remove any binding value entries.
Explicit reuse in revision copies 7 repeated fields, requiring 10 direct
values instead of 17; the original package directory (a repeated path) still
must be independently entered. Reuse additionally requires the explicit
original binding filename, the mode selection, the reuse confirmation, the
prior record count and final confirmation. Both operations require a fresh
bindings filename as a CLI argument. Each additional prior record adds two
values. The prior count and confirmations are inputs but are not serialized
binding values. No claims about fewer prompts or elapsed time follow from
this accounting. A separate comparison of the whole workflow is needed to
establish whether the target of three hand-edited JSON files to zero is met;
this guide addresses the two binding documents, not worksheet responses.
