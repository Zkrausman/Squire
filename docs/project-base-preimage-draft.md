# Draft preimage facts from a pinned synthetic base

The standalone offline command prepares only an array of observed original-file
facts for explicitly selected project paths. It never establishes approval to
import them, creates a candidate, changes a ref, discovers a branch, runs a
hook or executes source. Use only a disposable, caller-selected synthetic base.

```sh
node bin/squire-base-preimage-draft.mjs standard BASE_GIT_DIR DEV INO COMMIT TREE FRESH_DRAFT_JSON src/main.js assets/new.bin
```

Choose `standard` or `large` to match the intended original importer. The base
Git directory and new draft filename must be normalized absolute paths. Supply
the expected physical device and inode as decimal integers, and the exact
lowercase 40-hex commit and tree object IDs, independently selected and retained
by the caller. Neither moving refs nor automatically derived expectations are
accepted. A normal `.git` directory fences its whole checkout; a bare store
fences its own root. The output must be outside that root.

Select 1–50 exact permitted project-path spellings (not a path pattern). The
command validates the protected base, pin, complete bounded tree inventory and
path collisions before reading selected original blobs. Both original-import
profiles have the same 4 MiB per-original-blob witness limit; this is not a
replacement payload allowance. Unavailable or oversized original bytes reject.
Absence means absence from the verified pinned tree, not the current worktree.

The mode-0600 fresh draft is a deterministic path-sorted JSON array:

```json
[
  {"path":"assets/new.bin","original":null},
  {"path":"src/main.js","original":{"blob":"<40 lowercase hex>","bytes":12,"sha256":"<64 lowercase hex>"}}
]
```

The values above illustrate the shape, not valid witnesses. The read-only API
`draftProjectBasePreimages({profile, base_git_dir, base_git_identity, base_commit,
base_tree, paths})` in `src/project-review-candidate.mjs` returns the same rows
without creating a draft file. `base_git_identity` has `dev` and `ino` integers.

Retain the array privately. A path list and observed hashes do **not** approve
changes. An owner must separately decide exactly which paths are permitted,
check the selected draft against those decisions and supply the independent
receipt, stage and fresh destinations. Both [original importers](project-review-candidate.md)
revalidate the base and preimages; they do not trust the draft operation as
proof of provenance, authorization, correctness, or acknowledgement.

Exit 0 reports `PROJECT_BASE_PREIMAGE_DRAFT_PREPARED` after private file
readback. Exit 2 reports a fixed rejection; an interrupted output may remain
and is not silently retried or overwritten. Command diagnostics omit paths,
object IDs, source bytes and native errors. `--help` reads no inputs.
