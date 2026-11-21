---
name: squire-offline-review
description: Build or verify explicit Squire original-candidate or first-revision review packages, and record or verify a caller-selected decision. Use for the offline candidate-review flow, not generation, native admission, candidate execution or Git integration.
---

# Squire offline candidate review

Use the existing commands below from the repository root. This skill routes an
already scoped request; it grants no new permission to read private artifacts,
create a package, supply an owner decision or disclose source. For native task
preparation/outcome classification, use the separate
[squire-scoped-delivery skill](../squire-scoped-delivery/SKILL.md).

## Choose the operation and candidate family

Read the applicable contract before constructing requests:
[original candidate](../../../docs/project-candidate-review-package.md) or
[first owner-supplied revision](../../../docs/project-revision-review-package.md).
They own the schemas, finite profiles and source-identity requirements; do not
translate one family into the other or extend a first revision into a chain.

| Intent | Original candidate | First revision |
| --- | --- | --- |
| Create package from explicit spec | `node bin/squire-candidate-review.mjs --build SPEC` | `node bin/squire-candidate-review.mjs --build-revision SPEC` |
| Read-only package verification | `node bin/squire-candidate-review.mjs --verify PACKAGE` | `node bin/squire-candidate-review.mjs --verify-revision PACKAGE` |
| Record supplied choice | `node bin/squire-candidate-decision.mjs record PACKAGE REQUEST FRESH_DECISION_DIR` | `node bin/squire-candidate-decision.mjs record-revision PACKAGE REQUEST FRESH_DECISION_DIR` |
| Read-only selected-record verification | `node bin/squire-candidate-decision.mjs verify-decision PACKAGE DECISION_DIR EXPECTED_SHA256` | `node bin/squire-candidate-decision.mjs verify-revision-decision PACKAGE DECISION_DIR EXPECTED_SHA256` |

Uppercase tokens are placeholders. Supply explicit normalized absolute non-root
paths; `SPEC` and `REQUEST` name bounded strict JSON files. `EXPECTED_SHA256` is
the caller's retained exact lowercase 64-hex decision digest, never a digest
computed from an untrusted record to manufacture the expected value. Exact
`--help` on either executable reads no input and invokes no operation.

If the caller retained an expected **package manifest** digest, append
`--expect-sha256 EXPECTED_MANIFEST_SHA256` after `PACKAGE` in either package
verification command. Supply that exact lowercase 64-hex value; do not derive
it from the package to manufacture a match. This opt-in read-only comparison
rejects a mismatch before success output. Legacy verification without the option
still checks copy integrity and prints the observed manifest digest; it does not
claim comparison to a caller-retained expectation. The option is not a build or
decision-recording argument. See the linked family contract for exact grammar.

When only an original portable snapshot remains, build its review package with:

```sh
node bin/squire-candidate-review.mjs --build-from-snapshot /absolute/snapshot-review-spec.json
```

See the [retained-source contract](../../../docs/project-candidate-review-package.md#build-an-original-review-package-from-a-retained-snapshot).
Supply the caller-retained snapshot manifest digest and a fresh output root.
That root contains a V1 `package/` plus a bound private `provenance.json`; use
**the package child** with the normal package/decision commands. A valid portable
snapshot can exceed the smaller review limits. No Git stores or full original
result are reconstructed. Preserve the receipt and its digest/limitations;
normal package verification does not consume it or recover original ACK.
For a copied handoff, use `node bin/squire-candidate-review.mjs
--verify-snapshot-handoff HANDOFF_DIR EXPECTED_PROVENANCE_SHA256` with the
caller-retained receipt digest. This read-only operation checks the receipt and
V1 package pairing, without reopening the snapshot/stores or authenticating a
producer. See the [selected-handoff contract](../../../docs/project-candidate-review-package.md#verify-an-explicitly-selected-copied-snapshot-review-handoff).
This route is original-format only and does not infer an owner choice or release
a held artifact/job. No source is executed.

## Preserve the supplied bindings and choice

Package builds and decision recording create new private artifacts. Verification
is read-only. Use the supplied result witness, source-store paths/identities,
package bindings and fresh output destination exactly as the contract requires;
do not invent missing digests, object IDs or source witnesses. Do not serialize
an API AbortSignal into JSON. Keep source, packages and decision bodies private;
command status output deliberately omits their contents and private paths.

For a first-revision build, retain the explicitly selected prior REVISE and
complete caller-declared prior-decision set with exact digests. Do not select
latest, filter conflicts or claim undisclosed records do not exist. Inspect both
direct views (base-to-revised and original-to-revised), including restored-base
paths, before supplying the requested review outcome.

Recording requires an explicit owner-supplied ACCEPT, REVISE or REJECT request.
If choice or required attestations/binary acknowledgements are missing, stop
recording and identify the missing input; do not infer them from verified bytes
or fill them in automatically. ACCEPT binds all required paths (both views for
a revision); it is not task correctness or runtime acceptance. The original
recording request permits an omitted note or a string, but rejects explicit
null. Its stored omitted note becomes null. Revision requests also allow null.
A stored decision.json includes boundaries and is not a recording request; use
the selected-record verification route rather than copying it into recording.

## Preserve failures and report the narrow result

Use only the selected package/record. Do not scan a root, choose a winner, repair
or recreate outputs, overwrite old artifacts, retry a mutation or clean up a
partial/complete artifact after failure. Missing output or exit 2 does not prove
no mutation. If original acknowledgement is unknown, preserve that uncertainty
and stop replay; later verification may establish retained copy/record integrity
but cannot recover the original ACK. Existing output-error handling offers no
flush or consumer-receipt guarantee.

Exit 0 means the selected operation's documented result, including verification
of REVISE or REJECT; exit 2 is handled rejection or failed output, not proof that
an artifact is absent. Report package integrity, selected-record integrity and
supplied choice separately. None authenticates a reviewer/producer, proves human
attention or functional success, settles an old job, or grants execution, merge,
integration, disclosure or retry authority. No generated code is run here.

## Retained first-revision source

If the owner needs first-revision packaging after Git stores disappear, retain
review witnesses **while all three stores and explicit original package/prior
REVISE set are available**:

```sh
node bin/squire-candidate-review.mjs --retain-revision-source /absolute/retain-spec.json
```

Later, verify the retained source or build the revision review package using the
caller-retained source manifest digest:

```sh
node bin/squire-candidate-review.mjs --verify-retained-revision-source /absolute/retained-source EXPECTED_MANIFEST_SHA256
node bin/squire-candidate-review.mjs --build-revision-from-retained /absolute/build-spec.json
```

See the [retained first-revision contract](../../../docs/project-revision-review-package.md#retain-first-revision-review-source-before-stores-disappear)
for exact schemas and finite limits; no JSON signal. The build creates a fresh
root with V1 revision `package/` plus bound private `provenance.json`; existing
package/decision commands use the package child. This artifact carries complete
three-tree metadata and only needed blob payloads, not runnable source closure.
An original-only snapshot cannot replace missing revision evidence. Supplied
candidate record validation does not validate underlying generation receipt or
stage bodies, authenticate an owner/producer, recover an ACK or grant authority.
If an existing revision package was retained, verify it directly; do not create
another wrapper or infer a fresh decision. Retain failed/partial output without
retry/cleanup. The native scoped-delivery workflow and held jobs are separate.
