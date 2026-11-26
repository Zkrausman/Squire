# Compose a private review-package spec from saved results

The offline composer replaces manual result-object copying in the existing
original and first-revision review-package CLI specs. Start with the full
[explicitly saved local result](project-review-candidate.md#retain-the-result-for-local-human-review),
not terminal output. Provide all other bindings yourself, in a separate JSON
file. Neither Git stores nor an original package are discovered or inspected
by the composer; it does not create a candidate, review package or decision.

## Original candidate

Choose a normalized absolute path to a caller-selected saved original result,
two source stores and their explicit device/inode identities, plus a fresh
package destination. Supply a bindings file with exactly these fields (example
values are placeholders, not real identities):

```json
{
  "result_file": "/private/saved-original.json",
  "candidate_git_dir": "/private/original.git",
  "candidate_git_identity": {"dev": 1, "ino": 2},
  "base_git_dir": "/private/base.git",
  "base_git_identity": {"dev": 1, "ino": 3},
  "output_dir": "/private/new-original-package"
}
```

```sh
node bin/squire-review-spec.mjs original /private/original-bindings.json /private/new-original-spec.json
node bin/squire-candidate-review.mjs --build /private/new-original-spec.json
```

These are separate commands. The first writes the exact closed
`SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1`, embedding the selected result object
unchanged. It does not make the package. The second still independently
validates the result, Git-store identities, refs, trees, bytes and output
through the [original package contract](project-candidate-review-package.md).

## First owner-supplied revision

Supply both saved results from the linked original and first revision, all three
stores and their identities, the original package directory and independently
retained manifest digest, the **complete caller-declared prior-decision set**
and the explicitly selected prior REVISE decision ID. Example placeholders:

```json
{
  "original_result_file": "/private/saved-original.json",
  "revised_result_file": "/private/saved-revision.json",
  "base_git_dir": "/private/base.git",
  "base_git_identity": {"dev": 1, "ino": 3},
  "original_git_dir": "/private/original.git",
  "original_git_identity": {"dev": 1, "ino": 2},
  "revised_git_dir": "/private/revised.git",
  "revised_git_identity": {"dev": 1, "ino": 4},
  "output_dir": "/private/new-revision-package",
  "original_package": {
    "dir": "/private/original-package",
    "manifest_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "prior_decisions": [
    {
      "dir": "/private/owner-revise-record",
      "file_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ],
  "selected_decision_id": "owner-revise-id"
}
```

```sh
node bin/squire-review-spec.mjs revision /private/revision-bindings.json /private/new-revision-spec.json
node bin/squire-candidate-review.mjs --build-revision /private/new-revision-spec.json
```

The resulting exact `SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1` preserves both
complete result objects, prior references (including order) and selected ID.
The composer validates the supplied result family/shape/lineage and reads only
the one to eight declared `decision.json` files. It checks each independently
supplied digest, REVISE choice, original bindings and unique ID, including
presence of the selected ID. It never chooses a decision for you or filters
out a conflict. Completeness is your declaration; this is not a search or proof
that no undisclosed decision exists. The existing
[first-revision builder](project-revision-review-package.md#explicit-first-revision-package-commands)
still checks the original package, complete decision contents, attestations,
source stores, bytes and final revalidation. No second or later revision is
supported.

## Input, output and limits

- Bindings and saved-result files must be explicitly selected regular files
  under safe, non-symlink ancestors. Strict UTF-8/JSON parsing rejects duplicate
  decoded keys, unsupported shapes, and malformed or over-limit inputs.
- Each saved result is capped at 64 KiB (65,536 bytes); bindings and emitted spec
  are capped at 64 KiB for original and 256 KiB (262,144 bytes) for revision,
  matching the existing builders' spec limits. Prior decision reads retain the
  existing 96 KiB limit and private read-only leaf contract.
- All paths are normalized absolute non-root paths, no longer than 4,096
  characters. The selected metadata files, protected source roots, original
  package, declared decisions, spec and package destination must be disjoint.
  Use existing safe parents for both output paths. An already occupied
  destination is rejected; the future package destination remains absent.
- The spec is exclusively created with mode `0600` and verified for size and
  identity. No overwrite, mkdir, cleanup on partial failure, or repair is
  attempted. Keep the spec and inputs private. Do not retry over partial output.
- Exit 0 and `PROJECT_REVIEW_SPEC_COMPOSED` acknowledge only spec composition.
  Exit 2 denotes rejection or output failure, not proof no artifact exists.
  The fixed status contains no private path, identity, content or digests.
  Exact `--help` is inert.

The result is a draft for a separate builder invocation, not evidence that a
store, package, producer, owner or review choice is authentic. It does not
recover an acknowledgment, approve execution, imply task correctness, or
establish native or benchmark acceptance. Do not execute candidate content.
