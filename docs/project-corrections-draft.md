# Prepare an owner-supplied corrections draft

For a **verified original** project review package, select the changed paths
and replacement files yourself. Neither a review worksheet nor a decision is
an input to this operation. The command does not create a revision, record a
choice, or read a Git store.

```sh
node bin/squire-corrections-draft.mjs standard /absolute/original-package EXPECTED_MANIFEST_SHA256 /absolute/private/corrections.json docs/added.md /absolute/private/edited-added.md src/app.js /absolute/private/edited-app.js
```

Use `standard` for `--revise-standard` and `large` for `--revise`. Supply the
separately retained lowercase manifest SHA-256, not a value inferred from an
untrusted package. Supply 1–50 explicit path/file pairs; paths are exact
original package changed paths, not discovered from a directory. All local
paths must be normalized, absolute and non-root. Replacement files must be
owner-owned, single-link, mode `0400` regular files under protected ancestors,
as required by the revision CLI. Keep the selected package and replacement
files quiescent while preparing and consuming the draft. The draft and the
replacement files must be outside the selected package.

The destination must be a fresh private file under protected ancestors. The
command verifies the complete selected package against the expected digest,
uses each selected **candidate/new** side (including original additions), and
rejects duplicate/unknown paths or replacement bytes unchanged from that side.
It checks the revision CLI's 512 KiB per-file and 1 MiB standard / 4 MiB large
aggregate correction-payload limits. The output is a mode `0600` JSON array
in package path order, with entries of the existing CLI shape:

```json
[{"path":"docs/added.md","original":{"blob":"<candidate blob ID>","bytes":12,"sha256":"<candidate SHA-256>"},"content_path":"/absolute/private/edited-added.md"}]
```

Use the array as `corrections` in the appropriate existing [first-revision
specification](project-review-candidate.md#first-owner-supplied-revision).
Supply the other original-spec, prior-candidate and store bindings separately.
The array itself is bounded to 64 KiB but the entire assembled specification
must fit the existing 64 KiB limit. The package has no complete classification,
stage, or unchanged-path inventory; preparation does not establish eligibility
of any path absent from it or the complete revised project limits. The revision
consumer still validates the supplied prior candidate, original receipt/stage,
old witnesses, replacement files, class/profile/complete-project limits and
changed-tree constraints. The draft contains paths, not replacement bytes or
replacement hashes; later edits to a selected file are read by the consumer,
not bound to the bytes examined during preparation. Review the final supplied
files before revision intake. The draft is not a decision or attestation.

Success is exit 0 and `PROJECT_CORRECTIONS_DRAFT_PREPARED`; rejection or output
failure is exit 2 without successful acknowledgement. No private input fields
are printed. No existing file is overwritten; retain a partial fresh output
if writing fails. Keep the draft, package, and replacement files private.
