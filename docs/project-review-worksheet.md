# Prepare a private review worksheet

Choose one verified package family, supply the manifest SHA-256 you retained
independently, and name a fresh file outside the package.

```sh
node bin/squire-review-worksheet.mjs original /absolute/original-package EXPECTED_MANIFEST_SHA256 /absolute/private/original-worksheet.json
node bin/squire-review-worksheet.mjs revision /absolute/revision-package EXPECTED_MANIFEST_SHA256 /absolute/private/revision-worksheet.json
```

Use normalized absolute paths and an exact lowercase 64-hex digest. Keep the
selected package quiescent. The command compares the manifest digest and
verifies all package copies, displays and inventory before creating the editable
mode-0600 file. Select a destination under protected, symlink-free ancestors.
An existing file or link at the destination causes rejection. Exit 0 prints
`PROJECT_REVIEW_WORKSHEET_PREPARED`. Exit 2 reports a usage or preparation
failure. Preserve any partial output after a write or terminal failure.

Open the worksheet alongside the package. Each view names its diff and lists
the paths in contract order. Each row gives the package-relative side filenames
and their SHA-256 values. An addition has a null old side. For revisions, work
through base-to-revised and then original-to-revised. A path appearing in both
views has a separate row for each comparison. When `binary_review_required` is
true, inspect the exact side copies for that comparison.

The verified package supplies the endpoint and digest bindings. The reviewer
fills in `attested` and `binary_inspected` after inspection and supplies their
own identity and choice. All response fields start as JSON null. The worksheet
is a personal checklist with a separate schema. To record a choice, the reviewer
must separately construct and submit the family's decision request. See the
[original decision contract](project-candidate-review-package.md) and
[first-revision decision contract](project-revision-review-package.md).

## Complete a new worksheet with the keyboard

Use the [offline response form](project-review-response.md) to enter responses
beside the selected evidence without editing JSON. It leaves the original
blank worksheet available and creates a separate private worksheet only.
