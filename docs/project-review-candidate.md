# Local multifile review candidates

The review-candidate bridge consumes an explicitly supplied, completed
large-project result and its staged project files. It creates a reviewable Git
candidate in a **fresh local bare repository**, against a pinned base commit.
It does not generate code, execute candidate files, modify the base checkout,
publish a branch, or establish functional acceptance.

## Explicit inputs

The additive API is `buildProjectReviewCandidate(spec, ports)` in
`src/project-review-candidate.mjs`. `buildProjectReviewCandidateNative(spec)`
supplies local filesystem operations and fixed `/usr/bin/git` plumbing on
Linux with Node 24. Imports are inert.
The injected API trusts its supplied filesystem and Git operations; its
observations are not independent host attestation.

The closed specification has schema `SQUIRE_PROJECT_REVIEW_IMPORT_V1` and:

- `operation_id`, `caller_label`: explicit bounded tokens.
- `receipt_bytes`, `receipt_sha256`: the saved large-observation receipt and
  its expected digest. Receipt bytes are limited to 262,144 bytes.
- `stage_dir`, `stage_manifest_sha256`: the explicitly selected stage and
  expected manifest digest.
- `snapshot_dir`, `candidate_dir`: distinct, fresh output directories.
- `base_git_dir`, `base_git_identity`: an explicit physical Git directory and
  its expected device/inode identity. A normal `.git` directory fences its
  parent checkout; an explicitly verified bare base fences its own root.
  There is no repository discovery.
- `base_commit`, `base_tree`: exact SHA-1 object IDs, not moving branch names.
- `signal`: an optional genuine AbortSignal for the native wrapper.
- `allowed_changes`: at most 50 exact project paths, each with `original: null`
  for an addition, or `{blob, bytes, sha256}` describing the original blob.

The source stage, base and output roots must not overlap. Filesystem ownership,
protected ancestors, symlink rejection and quiescent owner custody are required;
the bridge does not repair permissions. Inputs are local and potentially
sensitive. Supplying a descriptor is not authorization to import it.

## Receipt, stage and base checks

The saved receipt must validate as a final `CANDIDATE_STAGED` large-project
result with its completed staging acknowledgement. Its digest and stage binding
must match the explicit inputs. A physically valid stage left by an incomplete
or quarantined operation is insufficient. Neither file verification nor this
importer reconstructs an original operation's acknowledgement or provenance.

The bridge reuses the existing large-project stage verifier and fresh export
builder with **no evidence files**. The snapshot contains only declared project
files. Existing class, path, canonical-manifest and readback checks apply:
at most 50 files and 4 MiB of decoded project content. Stage/export manifest
limits remain 65,536/131,072 bytes. Snapshot reads are bounded, no-follow and
identity/hash checked; the snapshot is verified again before success.

The base tree is bounded to 2,048 files and 4 MiB of tree metadata. The initial
profile uses SHA-1 repositories, bounded commit bodies and regular blob entries;
unsupported empty subtrees, symlinks, gitlinks and redirected object stores reject
rather than being dropped. Each declared
original file is read within its expected size, at most 4 MiB, and checked
against both its Git blob ID and SHA-256. `original: null` means the path is
actually absent. Unsafe paths, `.git` components, path/casefold/prefix
collisions, symlink or gitlink entries, wrong identities and unlisted changes
reject. The initial consumer supports additions and replacements only, with no
deletions, renames or automatic merging. At least one actual change is required;
listed files with identical bytes remain unchanged.

## Git candidate and review boundary

The native adapter uses fixed Git plumbing, bounded command output and a clean
command environment. It supplies verified bytes through stdin rather than
asking Git to read generated working-tree paths. It does not run hooks,
filters, external diff/text conversion, package scripts, credential helpers or
network operations. New or replaced files are regular nonexecutable blobs. Unchanged
base entries, including their modes, remain identical.

New candidate Git metadata is initialized with `--shared=0600`, using
[Git's explicit permission mode](https://git-scm.com/docs/git-init#_options)
so creation does not depend on the host umask. This affects only the fresh
task-owned repository; existing repository permissions and the process umask
are unchanged.

All Git writes target the newly reserved bare repository. The candidate has
exactly one parent, the pinned base commit. Its tree, parent and changed paths
are checked before a create-only candidate ref is written. The existing base's
objects, refs, index and worktree are not modified.

The fresh repository uses a private, read-only **alternate object-store
reference** to the base. It is a local review artifact, not a self-contained or
portable bundle. Later review requires that base object store to remain
available and quiescent; removal, garbage collection or tampering can invalidate
that dependency. Its private absolute location must not be uploaded in a
public receipt or source patch.

The API result includes relative changed paths for private review; those names
are potentially sensitive and are not a public-safe projection. CLI output
uses a count instead of enumerating them.

Success means only `SOURCE_CANDIDATE_CREATED`. Correctness remains
`NOT_EVALUATED`, human review is pending, and native/benchmark acceptance is
not established. Supplied receipts are not authenticated provenance. A human
must inspect the exact base-to-candidate changes before any later integration.
For ordinary Git review, disable external diff and text conversion; no review
command is an instruction to execute the candidate.

## CLI and failure handling

`node bin/squire-project-review.mjs --build <spec.json>` is explicit local input.
Its closed JSON specification uses `receipt_path` in place of `receipt_bytes`.
The specification is bounded to 65,536 bytes and receipt input to 262,144 bytes.
Default invocation does not import a candidate. Public output contains fixed
status, object identities and a changed-file count, not source content, project
names, host paths or native errors.

Existing output directories reject. Failures, cancellation or uncertain Git/IO
outcomes withhold successful acknowledgement and retain partial task-owned
output. There is no automatic replay, overwrite, rollback, reset or cleanup.
Git and filesystem IO are cooperative; there is no hard host-completion or
all-descendant shutdown guarantee. This operation grants no authority to retry
an earlier job, use a quarantined namespace, run applications or providers,
install dependencies, publish source, or start a benchmark.

## Source validation

The focused `test/project-review-candidate.test.mjs` suite uses synthetic saved
results, owned temporary stages and disposable repositories. Its local Git
plumbing checks source objects and refs; it never imports or executes candidate
files. These checks establish the bridge's source behavior under those fixtures,
not an actual generation, application run or human acceptance result. The focused
suite is included in the ordinary CI command separately from `npm test`.
