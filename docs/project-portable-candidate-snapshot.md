# Portable review snapshot for one PR210 candidate

`src/project-portable-candidate-snapshot.mjs` builds a private, self-contained
two-tree snapshot for one original `SQUIRE_PROJECT_REVIEW_CANDIDATE_V1` result
from PR210. It copies the selected base and candidate commit objects, both
reachable tree closures, every candidate-tree blob, and only the base blobs for
changed paths that existed in the base. It does not copy Git history, other
refs, repository configuration, or the candidate's alternate dependency.

The result is a review artifact, not a cloneable repository or a Git
provenance certificate. It proves copied-byte integrity for the supplied
objects. It does not authenticate the producer, reconstruct the original
acknowledgement, establish functional correctness, apply a change, or execute
candidate bytes. Human review remains `PENDING`; correctness remains
`NOT_EVALUATED`.

## Explicit inputs

The additive API is `buildProjectPortableCandidateSnapshot(spec)` in
`src/project-portable-candidate-snapshot.mjs`. It accepts one closed
`SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1` specification containing:

- the complete immutable PR210 `SQUIRE_PROJECT_REVIEW_CANDIDATE_V1` result;
- the selected candidate bare Git directory and its device/inode identity;
- the selected base Git directory and its device/inode identity;
- a distinct, fresh output directory; and
- an optional genuine `AbortSignal`.

For deterministic synthetic fault tests, the JavaScript API has a second
options argument that can supply the complete filesystem port. The CLI always
uses the native filesystem implementation and does not accept a filesystem
port.

The candidate ref must directly select the supplied candidate commit. That
commit must select the supplied candidate tree and have exactly the pinned base
commit as its one parent. The base commit must select the supplied base tree.
The candidate's sole alternate must be the selected base object's directory;
the base may not have an alternate of its own. Replacements, grafts, symlinks,
gitlinks, and executable additions or replacements reject. An executable file
already in the base may remain executable when its candidate path and object
are unchanged.

The API is explicit and native. Imports are inert. It uses fixed local Git
plumbing with replacements, hooks, filters, protocol access, lazy fetch, and
network access disabled. The request and result paths can be private. They are
not written to the snapshot manifest or public CLI output. The manifest records
the SHA-256 of the canonical captured result JSON, not the original PR210
receipt bytes; that receipt is not part of the candidate result.

## Snapshot contents and limits

The fresh output root is mode `0700`. It contains only:

- `manifest.json`, canonical UTF-8 JSON, mode `0400`, with the exact schema,
  candidate/base identities, changed paths, object and file inventories,
  finite limits, byte totals, and the four fixed limitations;
- `objects/<two-hex>/<38-hex>`, mode `0400`, containing raw, uncompressed Git
  object payloads verified by Git SHA-1 and SHA-256; and
- `candidate-files/<path>` plus `base-preimages/<path>`, mode `0400`, containing
  byte-exact inspection copies. Binary files remain bytes.

Directories inside the snapshot are mode `0700`. All output files are created
exclusively, checked after close, and read back before success. Output is never
reused or automatically cleaned up after a failure.

The verifier's directory-walk work bound follows the approved profile: at most
`max_tree_records` entries under `candidate-files`, seven entries for each of
the at most 50 changed preimages, 8,192 object files, 256 two-hex SHA-1
fanout directories, and four fixed root entries. This derived ceiling permits
valid deep trees with heavily shared Git objects.

The first profile is fixed:

- SHA-1 only; at most 2,048 base files, 2,098 candidate files, and 50 changed
  project paths;
- at most 8,192 distinct included objects and 4 MiB per blob;
- at most 32 MiB of distinct raw object payloads and 8 MiB for the manifest;
- at most 64 MiB total output bytes, including candidate and base inspection
  copies; and
- PR210's existing 4 MiB base tree-metadata cap and 4,219,904-byte candidate
  tree-metadata cap.

Oversize input fails closed. The implementation does not partially export a
tree or enlarge the profile automatically. These limits describe this first
profile; they do not establish that any real owner project fits it.

The 8 MiB manifest limit is defensive. A valid manifest cannot approach it
under the other closed limits: candidate paths together fit within the
4,219,904-byte tree-metadata budget; 2,098 candidate-file rows add at most 256
bytes each beyond those path bytes; at most 8,192 object rows add at most 256
bytes each; and the 50 changed paths plus 50 base preimages add under 39 KiB
including row overhead. The remaining fixed schema, limits, and JSON syntax
fit within a conservative 64 KiB allowance. This bounds a valid manifest
below 7 MiB. The verifier still rejects a malformed manifest larger than 8
MiB before reading it into memory.

## Offline verification and commands

`verifyProjectPortableCandidateSnapshot(snapshotDir)` needs only the snapshot
directory. It checks the closed manifest and exact filesystem inventory, modes,
identities, hard-link count, all object hashes, commit-to-tree links, recursive
tree modes and paths, changed-path comparison, object closure, and inspection
copies. It does not accept a base repository or alternate path. Missing older
base ancestors are expected because this snapshot contains only the two
selected review commits and tree closures.

The explicit CLI lives at `bin/squire-portable-candidate.mjs`:

```text
node bin/squire-portable-candidate.mjs --build <private-spec.json>
node bin/squire-portable-candidate.mjs --verify <snapshot-directory>
```

The build spec is a private local JSON file owned by the caller, mode `0400`,
and no larger than 65,536 bytes. CLI output contains fixed status, object IDs,
digests, counts, and byte totals. It never prints source paths, candidate file
names or contents, local roots, operation labels, or raw errors. The snapshot
itself contains private source-relative paths and must remain private; sharing
or uploading it requires separate destination-specific approval.

If a write, close, cancellation, source check, or readback fails, the API
withholds success and retains partial task-owned output for inspection. It does
not delete, repair, overwrite, retry, or infer success from a manifest. If a
caller loses the response after output publication, the result is `UNKNOWN`
until the original invocation is reconciled; verification proves copy
integrity only and cannot promote that unknown operation into an acknowledged
one.

## Synthetic validation

`test/project-portable-candidate-snapshot.test.mjs` uses disposable Git stores
and synthetic bytes only. It covers an addition, replacement, unchanged
regular file, documentation file, binary local asset, inherited executable
mode, older base ancestry, unrelated refs, exact source/ref/tree/parent binding,
object exclusion, offline verification after both source stores are unavailable,
private CLI projection, exact file-count and per-blob boundaries, one-over file,
exact 8,192-object and 64 MiB total-output limits, one-over object, file, and
total-output limits, a 47,104-directory highly deduplicated tree, wrong
identities and alternate, unsafe modes, unknown and
duplicate manifest keys, oversize manifest rejection, output corruption, hard
links, source-ref drift, close-failure and readback fault injection, partial
output retention, and cancellation at final builder/verifier checks. The
injected filesystem port is used only by these synthetic fault tests; normal
API and CLI operation use native filesystem methods. Run the suite with:

```text
npm run test:portable-candidate-snapshot
```

The ordinary CI workflow runs this suite alongside the PR210 review-candidate
tests. These fixtures do not run or grade candidate code and do not authorize
exporting a real private candidate, uploading a snapshot, merging the change,
native admission, or any model or benchmark run.
