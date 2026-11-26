# Prepare an editable decision request from a completed worksheet

Start with a [private review worksheet](project-review-worksheet.md) and its
selected original or first-revision package. Inspect the required sides and
views yourself and supply your responses. Keep the independently retained
manifest SHA-256, package, and worksheet quiescent during preparation.

```sh
node bin/squire-review-decision-request.mjs original /absolute/original-package EXPECTED_MANIFEST_SHA256 /absolute/private/completed-worksheet.json /absolute/private/request.json
node bin/squire-review-decision-request.mjs revision /absolute/revision-package EXPECTED_MANIFEST_SHA256 /absolute/private/completed-worksheet.json /absolute/private/request.json
```

Use the same family and retained lowercase 64-hex digest that you used to
prepare the worksheet. All paths must be normalized absolute non-root paths;
the worksheet and output must be outside the package and distinct from each
other. Use a private mode-0600 worksheet owned by you, with a single link,
and protected, symlink-free ancestors. The output must be fresh.

## Supply your own responses

- Fill `decision_id` and `reviewer_label` with your own nonempty 1–64-character
  tokens (ASCII letters, digits, underscores or hyphens).
- Explicitly choose `ACCEPT`, `REVISE` or `REJECT` in `choice`.
- For every row you wish to attest, set `attested` to `true` and explicitly
  set `binary_inspected` to `true` or `false`. A text row with no binary
  inspection can be marked `false`. A required binary inspection must be
  acknowledged with `true` to ACCEPT. Do not claim inspection you did not do.
- ACCEPT requires an affirmative attestation for every row, including both
  independent revision views. REVISE and REJECT permit partial or empty
  attestations: leave unclaimed rows' `attested` null or false and their
  `binary_inspected` null or false. A `true` binary response without a `true`
  attestation is contradictory and rejected. No blank is filled with a value.
- Optionally add a top-level `note` string of at most 4,096 UTF-8 bytes. Omit
  it when unused; explicit null is allowed only for the revision family, as in
  its existing recording request contract. The command preserves a supplied
  note exactly, without interpreting it as a choice or inspection.

Do not edit the worksheet schema, family, bindings, display paths, row order,
path inventory, copy filenames, side digests or binary requirements. This
command independently verifies the selected package against the retained digest
and compares all these fields to the corresponding verified manifest. A valid
but different package cannot be substituted. Strict JSON with no duplicate
keys is required; worksheets are limited to 256 KiB, allowing full two-view
worksheets, and the editable request to the existing 96 KiB request ceiling.

## Review the resulting request separately

The fresh mode-0600 JSON file contains the family's recording request: matched
immutable bindings, the explicitly supplied identity, choice and optional note,
and only affirmatively attested rows with their verified side hashes and
explicit binary responses, sorted by path or `(view, path)` as applicable.
There is no `boundaries` field or decision record. The worksheet and package
are not altered. Exit 0 prints `PROJECT_REVIEW_DECISION_REQUEST_PREPARED`;
exit 2 reports invalid syntax or rejected preparation. Terminal output omits
private content. Preserve any partial output after a write or terminal failure.

Preparation is not recording. Inspect the editable request and use the
appropriate existing record operation only when you intend to submit that
explicit choice:

```sh
node bin/squire-candidate-decision.mjs record /absolute/original-package /absolute/private/request.json /absolute/fresh-decision-dir
node bin/squire-candidate-decision.mjs record-revision /absolute/revision-package /absolute/private/request.json /absolute/fresh-decision-dir
```

The [original recorder](project-candidate-review-package.md#explicit-record-only-decision-cli)
and [revision recorder](project-revision-review-package.md#explicit-first-revision-decision-command)
retain their existing authority and validation, rechecking the package and
submitted request. They do not infer which request to use. This preparation
command does not call them, choose a decision, attest inspection, authenticate
reviewer attention, evaluate task correctness, execute candidate bytes, or
grant integration or merge authority. The command only prepares a local,
editable request; its success is not a recorded review decision.
