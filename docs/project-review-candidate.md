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

## First owner-supplied revision

After inspecting an original stage-derived candidate, an owner may supply exact
replacement bytes with `buildProjectRevisionCandidate(spec, ports)` or
`buildProjectRevisionCandidateNative(spec)`. This creates a **fresh** review
candidate; it neither changes the original candidate nor claims another producer
completion. This first slice supports one revision of the original staged
candidate, not a chain of revisions, arbitrary Git commits, merging, deletions or
renames. Ordinary manual Git editing remains an alternative outside this API.

The closed revision schema is `SQUIRE_PROJECT_REVIEW_REVISION_V1`, with:

- `original`: the complete `SQUIRE_PROJECT_REVIEW_IMPORT_V1` specification,
  including the saved receipt, stage, allowed paths and original base witnesses.
  Use a new `operation_id` and fresh `snapshot_dir` / `candidate_dir`. The
  receipt and original stage bytes remain unchanged.
- `prior_candidate`: `{git_dir, identity: {dev, ino}, operation_id, commit, tree}`.
  This is the exact original bare candidate repository, its physical identity,
  original import operation ID and commit/tree, not moving branch selection.
- `corrections`: one to 50 unique `{path, original: {blob, bytes, sha256},
  bytes_data}` records. Each `bytes_data` is a plain `Uint8Array` captured before
  asynchronous IO. Each old witness describes that file in the prior candidate,
  not the file in the original base. Bytes are supplied by the owner and are not
  evaluated as code.

Only existing declared project paths may be replaced, including paths originally
added by staging. Their classifications come from the pinned original manifest;
corrections cannot add an unrelated path or relabel evidence. Existing profile
limits apply to the **complete revised project**: SOURCE files are nonempty,
25 files / 512 KiB each / 2 MiB total; LOCAL_ASSET has 20 files / 512 KiB each /
2 MiB total; DOC has five files / 64 KiB each / 128 KiB total. The whole project
remains at most 50 files and 4 MiB. Each listed correction must change bytes, and
the resulting candidate must still differ from the original base.

The bridge revalidates the final producer receipt and original stage. It derives
the original candidate tree from those verified files and the pinned original
base without writing to either input repository. The prior commit must have
exactly that tree and the single original base parent; its original candidate ref
must still select that commit. Every original project blob is read and checked,
including files without corrections. Missing receipt or staging acknowledgement
cannot be recovered from existing Git objects or refs. A prior output that has
already been revised is rejected rather than silently inheriting its history.

The prior candidate must satisfy the owner, physical identity, ancestor,
nonsymlink and quiescent-custody checks. Redirecting `gitdir`/`commondir` metadata
rejects. Its only permitted alternate is exactly the independently validated
original base object store; nested or substituted alternate chains reject. All
input roots and fresh output roots must be disjoint. Nothing repairs permissions
or grants authority to use an input merely because its identity matches.

The new commit has the **same original base parent**, not the prior candidate as
parent. All original non-base project blobs are copied into the new output,
including uncorrected additions, so it never depends on the prior candidate's
object store. The new output still depends on the original base's protected
alternate store. Corrected files are nonexecutable; restoring exact original base
bytes preserves the original base mode. Old candidate, stage, export, base refs
and working files remain unchanged. Prior identities, objects and ref selection
are checked again before the new create-only ref is published. Failure or
cancellation retains partial fresh output without successful acknowledgement;
there is no automatic replay or rollback.

Success returns `SQUIRE_PROJECT_REVISION_CANDIDATE_V1` /
`SOURCE_REVISION_CANDIDATE_CREATED`, plus the usual base/new object IDs,
`revision_of: {commit, tree}`, `correction_origin: OPERATOR_SUPPLIED` and private
`revised_blobs` old/new blob, byte-count and SHA-256 bindings. Human review starts
at `PENDING`; task correctness remains `NOT_EVALUATED`, origin remains
`SUPPLIED_NOT_AUTHENTICATED`, and native/benchmark acceptance stays
`NOT_ESTABLISHED`. A supplied correction does not resolve a review finding or
inherit an earlier verdict. A human must review the new exact diff.

For explicit CLI intake, use:

```text
node bin/squire-project-review.mjs --revise <revision-spec.json>
```

Its `original` object uses `receipt_path` instead of `receipt_bytes`. Each
correction uses `content_path` instead of `bytes_data`; these must be explicit
bounded local regular files. Correction files use a separate private stable,
no-follow reader requiring owner UID, one link and mode `0400`, with protected
ancestors; the existing receipt reader and its 256 KiB cap are unchanged.
The JSON specification remains limited to 65,536 bytes. Receipt bytes are at
most 262,144; each captured correction is at most 524,288 bytes and all captured
corrections together are at most 4 MiB. Each read is additionally capped by the
remaining aggregate allowance, with at most one sentinel byte to detect growth.
This is a correction-payload bound, not a total process-allocation guarantee:
validation also retains bounded copies and original stage/snapshot buffers. CLI output includes fixed status, base/new/prior object IDs
and a changed-path count, never relative filenames, source bytes, local paths,
operation labels or raw errors. Existing `--build` input/result behavior is
unchanged. The API's relative paths and source witnesses remain private review
material rather than a public receipt format.


## Standard native project intake

The separate `buildStandardProjectReviewCandidate(spec, ports)` and
`buildStandardProjectReviewCandidateNative(spec)` APIs accept the standard
native result and stage profile. Their closed specification uses
`SQUIRE_STANDARD_PROJECT_REVIEW_IMPORT_V1` with the same explicit input fields
as the large importer. Existing large, revision and CLI entry points retain
their existing profile; there is no profile autodetection or conversion.

Supply a validated `SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1` containing a
standard `SQUIRE2_PROJECT_RESULT_V1`, final `CANDIDATE_STAGED` and its exact
complete `squire4.stage_receipt.v1` acknowledgement. Use the existing
`createNativeProjectResultReceipt` to capture a live result when needed;
do not strip or rewrite fields to pass validation. A recorded
`operator_admitted` boolean remains a supplied claim with admission authority
unestablished. It does not authorize a new import. Physical verification alone
cannot recover an original acknowledgement.

The standard adapter uses `verifyStage`, `buildExport` and `verifyExport`,
including the final source/snapshot recheck. It exports no evidence files.
Standard class limits remain SOURCE: 25 files, 65,536 bytes per file and
524,288 aggregate; LOCAL_ASSET: 20 files, 524,288 bytes per file and 2,097,152
aggregate; DOC: 5 files, 65,536 bytes per file and 131,072 aggregate. The native
receipt additionally limits the entire acknowledged project to **1,048,576
bytes**, so the adapter enforces the intersection of those limits. A larger
standalone standard stage is insufficient. Serialized receipt bytes remain
capped at 262,144, and stage/export manifests at 65,536/131,072 bytes.

The same pinned-base, original-byte, path, custody, fresh-output, inert Git,
cancellation and partial-output rules apply. The result retains
`SQUIRE_PROJECT_REVIEW_CANDIDATE_V1` and can enter the original-candidate
review-package and portable-snapshot APIs subject to their own checks. It is a
source candidate with human review pending and correctness unevaluated; an
external functional grade does not select an owner decision, authorize a
merge or establish native acceptance. First-owner revisions use the separate standard revision APIs below. No
generated source is executed.


## First owner revision of a standard candidate

`buildStandardProjectRevisionCandidate(spec, ports)` and
`buildStandardProjectRevisionCandidateNative(spec)` accept a closed
`SQUIRE_STANDARD_PROJECT_REVIEW_REVISION_V1` specification. Fields are
`original`, `prior_candidate` and `corrections`, matching the existing revision
API. The `original` specification must use
`SQUIRE_STANDARD_PROJECT_REVIEW_IMPORT_V1` and fresh output roots with a new
operation ID. The prior store, commit, tree, base parent and original standard
receipt/stage are reverified. Revision chains are excluded.

Each correction supplies an exact declared path, its previous blob/byte-count/
SHA-256 witness and caller-owned `bytes_data`. There are one to 50 corrections,
confined to the original project's declared paths. No-op, deletion, rename,
empty SOURCE, unsafe path or wrong witness rejects. Input capture permits at
most 524,288 bytes per correction and 1,048,576 bytes in total. After the stage
classifications are known, each corrected file and the complete revised project
must satisfy the standard class limits and the 1,048,576-byte project ceiling,
including unchanged files. A SOURCE correction therefore remains at most
65,536 bytes. These project limits do not lower the existing unrelated
base/preimage limits.

The result remains `SQUIRE_PROJECT_REVISION_CANDIDATE_V1`, with exact
`revision_of` and `revised_blobs` witnesses, the original base parent and
receipt/stage digests, and `correction_origin: OPERATOR_SUPPLIED`. It reports
human review pending and task correctness unevaluated. The old candidate,
source stage, packages and decisions are preserved; a fresh partial output is
retained on failure without acknowledgement or retry.

The [revision review package](project-revision-review-package.md) can consume
the standard original/revision pair under its own source and size checks. It
requires an explicitly selected prior `REVISE` decision and preserves both
base-to-revised and original-to-revised views. Its fresh decision is explicitly
supplied by the caller; creating a revision selects no decision and grants no
integration, execution or disclosure authority. This additive API does not
change the large-profile revision API or the existing CLI.

## Explicit standard-profile CLI

Owners of an acknowledged standard native project result can use the same
local CLI without writing an API caller:

```sh
node bin/squire-project-review.mjs --build-standard /absolute/path/to/spec.json
node bin/squire-project-review.mjs --revise-standard /absolute/path/to/revision-spec.json
node bin/squire-project-review.mjs --help
```

For `--build-standard`, use `SQUIRE_STANDARD_PROJECT_REVIEW_IMPORT_V1` and the
standard API fields described above, replacing `receipt_bytes` with an absolute
`receipt_path`. For `--revise-standard`, use
`SQUIRE_STANDARD_PROJECT_REVIEW_REVISION_V1`, the standard original import fields
with that same receipt substitution, and corrections whose `bytes_data` is
replaced by an absolute `content_path`. These are explicit selected files;
commands do not discover receipts or select a profile from their contents.

Spec JSON remains bounded to 64 KiB and receipt JSON to 256 KiB. Standard
correction inputs are bounded to 512 KiB each and 1 MiB combined; the existing
standard API also enforces its per-class and complete-project limits. A source
correction remains subject to the standard 64 KiB source-file limit, even
though a local asset can be larger. The existing `--build` and `--revise`
commands retain their large-profile behavior and limits.

Success exits 0 with fixed status, Git object IDs and a changed-path count;
input or operation rejection exits 2 with the fixed rejection diagnostic.
`--help` exits 0 and reads no input. Existing default invocation remains usage
only, with exit 2. Terminal output omits source, file paths and owner labels.
These commands create local review candidates only: they do not execute the
candidate, accept its content, integrate it into an existing checkout, or
establish task correctness or native/benchmark acceptance.
