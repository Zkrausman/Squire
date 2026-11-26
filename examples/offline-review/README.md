# Synthetic original → REVISE → first-revision review

A disposable offline example for inspecting *source review*, not for
producing or importing a candidate from a real job. It uses the review
commands present at Squire commit
`1f1dc90fb2053340628cde476ef8271e246407ea`. The companion fixture creates
three bare local Git stores from fixed harmless strings and three-byte
binary samples. They have no remote, workflow, working tree or executed
candidate source. The two candidate result JSON files are **supplied test
witnesses**; their artificial receipt/stage digest tokens do not refer to
any real producer receipt or stage. The revision store is preconstructed
as part of this fixture, not created from an actual owner's correction.
No real reviewer identity, attestation, acceptance, job outcome or
benchmark is established.

## 1. Prepare a fresh fixture

Run from the Squire root with verified Node 24, /usr/bin/git, jq and
ordinary Unix utilities. The fixture returns one private temporary directory.
Keep the selected stores quiescent and do not substitute real jobs or data.
Use each fresh output only once; retain any partial output and stop on a
failed or uncertain mutation.

```sh
set -euo pipefail
umask 077
R=$(node examples/offline-review/fixture.mjs)
printf 'Synthetic fixture: %s\n' "$R"
# Capture a before inventory for later comparison.
(cd "$R"
 find base.git original.git revised.git -type f -print0 | sort -z | xargs -0 sha256sum
) > "$R/stores-before.sha256"
(cd "$R"
 find base.git original.git revised.git -printf '%m %y %p\n' | sort
) > "$R/stores-before.inventory"
```

Git may print three `templates not found in /dev/null` warnings because
the synthetic stores use an empty template. The fixture contains:

| Path | Base | Original | First revision |
| --- | --- | --- | --- |
| `assets/icon.bin` | absent | `00 ff 01` | `00 ff 02` |
| `docs/added.md` | absent | synthetic note | same note |
| `src/app.mjs` | label = base | label = draft | label = revised |
| `src/restore.mjs` | color = blue | color = red | color = blue |
| `src/unchanged.mjs` | count = 1 | count = 2 | count = 2 |

## 2. Build and inspect the original package

Read the supplied result and the exact store identities. Construct one
closed original review spec explicitly; this is the current manual
composition path, not a package discovery or import step.

```sh
jq -n --slurpfile result "$R/original-result.json" --slurpfile s "$R/stores.json" \
  --arg out "$R/original-package" '{
  schema:"SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1",
  result:$result[0],
  candidate_git_dir:$s[0].original.dir,
  candidate_git_identity:$s[0].original.identity,
  base_git_dir:$s[0].base.dir,
  base_git_identity:$s[0].base.identity,
  output_dir:$out
}' > "$R/original-spec.json"

node bin/squire-candidate-review.mjs --build "$R/original-spec.json" | tee "$R/original-build.txt"
# Retain the digest from the successful build acknowledgement, not by
# hashing the package being verified.
D=$(awk '/^Manifest SHA256:/ {print $3}' "$R/original-build.txt")
printf '%s\n' "$D" > "$R/original-expected.sha256"
node bin/squire-candidate-review.mjs --verify "$R/original-package" --expect-sha256 "$D"
node bin/squire-review-worksheet.mjs original "$R/original-package" "$D" "$R/original-worksheet.json"

cat "$R/original-package/diff.txt"
od -An -tx1 "$R/original-package/changes/assets/icon.bin.new"
jq . "$R/original-worksheet.json"
```

Expected: package creation and verification acknowledge five changed
paths, including two additions and three replacements. The binary addition
has no old side; inspect new bytes `00 ff 01`. The display includes all changed
text sides. The worksheet has five rows with null responses; it is not a
decision request.

## 3. Supply a *synthetic* REVISE choice

For this fixed exercise only, explicitly select REVISE and label it as
a synthetic test operator, with no attestations. The example does not
assert any human inspected or accepted a real candidate. Never copy this
choice or label to another task or supply missing attestations for someone.

```sh
jq --arg id 'synthetic-revise' --arg reviewer 'synthetic-test-operator' '{
  schema:"SQUIRE_PROJECT_CANDIDATE_DECISION_V1",
  decision_id:$id, reviewer_label:$reviewer,
  review_package_sha256:.bindings.review_package_sha256,
  base_commit:.bindings.base_commit, base_tree:.bindings.base_tree,
  candidate_commit:.bindings.candidate_commit, candidate_tree:.bindings.candidate_tree,
  choice:"REVISE", attestations:[],
  note:"Synthetic exercise only: revise label, restore blue, and change final binary byte to 02."
}' "$R/original-worksheet.json" > "$R/synthetic-revise-request.json"

node bin/squire-candidate-decision.mjs record "$R/original-package" \
  "$R/synthetic-revise-request.json" "$R/synthetic-prior" | tee "$R/prior-record.txt"
P=$(awk '/^Decision SHA256:/ {print $3}' "$R/prior-record.txt")
printf '%s\n' "$P" > "$R/prior-expected.sha256"
node bin/squire-candidate-decision.mjs verify-decision "$R/original-package" "$R/synthetic-prior" "$P"
jq '{choice,decision_id,reviewer_label,attestations}' "$R/synthetic-prior/decision.json"
```

Expected: selected-record verification exit 0, zero attested paths,
choice REVISE. There is only one declared prior record for this
disposable fixture; a real owner must declare the complete prior set and
explicitly select a REVISE. A later matching hash cannot establish an
original lost acknowledgement.

## 4. Build and inspect the first-revision package

Use the separately supplied synthetic revised result and the original
result, all three store identities, the retained original manifest digest,
the declared prior set, and the exact selected ID. The already-created
synthetic revision represents the fixed corrections in step 3. The review
CLI is not a revision importer, worker or model invocation.

```sh
jq -n --slurpfile original "$R/original-result.json" --slurpfile revised "$R/revised-result.json" \
  --slurpfile s "$R/stores.json" --arg out "$R/revision-package" \
  --arg pkg "$R/original-package" --arg manifest "$D" \
  --arg prior "$R/synthetic-prior" --arg decision "$P" '{
  schema:"SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1",
  original_result:$original[0], revised_result:$revised[0],
  base_git_dir:$s[0].base.dir, base_git_identity:$s[0].base.identity,
  original_git_dir:$s[0].original.dir, original_git_identity:$s[0].original.identity,
  revised_git_dir:$s[0].revised.dir, revised_git_identity:$s[0].revised.identity,
  output_dir:$out,
  original_package:{dir:$pkg,manifest_sha256:$manifest},
  prior_decisions:[{dir:$prior,file_sha256:$decision}],
  selected_decision_id:"synthetic-revise"
}' > "$R/revision-spec.json"

node bin/squire-candidate-review.mjs --build-revision "$R/revision-spec.json" | tee "$R/revision-build.txt"
V=$(awk '/^Manifest SHA256:/ {print $3}' "$R/revision-build.txt")
printf '%s\n' "$V" > "$R/revision-expected.sha256"
node bin/squire-candidate-review.mjs --verify-revision "$R/revision-package" --expect-sha256 "$V"
node bin/squire-review-worksheet.mjs revision "$R/revision-package" "$V" "$R/revision-worksheet.json"

cat "$R/revision-package/base-to-revised.diff.txt"
cat "$R/revision-package/original-to-revised.diff.txt"
od -An -tx1 "$R/revision-package/changes/assets/icon.bin.original"
od -An -tx1 "$R/revision-package/changes/assets/icon.bin.revised"
jq . "$R/revision-worksheet.json"
```

Expected four base-to-revised rows: binary and note additions, label and
count replacements. Expected three original-to-revised rows: binary,
label, and restored color. Verify the restored path appears only in the
second view, classified `RESTORED_BASE`. The unchanged-from-original
count change appears only in the first view; the note addition likewise
remains in the first view. Inspect the binary's original and revised
copies separately. The binary row is required in **both** revision views.

## 5. Stop at human decision preparation

The new worksheet contains seven ordered view/path rows, with two binary
inspection requirements. All response fields are null, as are the
reviewer's label, selected choice, and decision ID. This exercise intentionally
leaves the worksheet in that state and records **no revision decision**.
A real reviewer would inspect all required side copies and views, fill in
their own explicit choices and attestations, then construct a separate
family request from their actual responses using
[the first-revision decision contract](../../docs/project-revision-review-package.md#explicit-first-revision-decision-command).
ACCEPT requires every path in both views and explicit binary acknowledgement.
The worksheet cannot record a decision on its own.

To verify no source-store changes and confirm previous artifacts still match:

```sh
(cd "$R"
 find base.git original.git revised.git -type f -print0 | sort -z | xargs -0 sha256sum
) > "$R/stores-after.sha256"
(cd "$R"
 find base.git original.git revised.git -printf '%m %y %p\n' | sort
) > "$R/stores-after.inventory"
cmp "$R/stores-before.sha256" "$R/stores-after.sha256"
cmp "$R/stores-before.inventory" "$R/stores-after.inventory"
node bin/squire-candidate-review.mjs --verify "$R/original-package" --expect-sha256 "$D"
node bin/squire-candidate-decision.mjs verify-decision "$R/original-package" "$R/synthetic-prior" "$P"
```

A successful run establishes integrity of the selected copied evidence
and synthetic prior record. It establishes neither authentic provenance,
human review, task correctness, runtime behavior, native or benchmark
acceptance nor permission to execute, integrate or disclose. Keep this
synthetic observation separate from any later comparison or actual
reviewer evaluation. The operator's manual score remains pending.

See the repository's [original](../../docs/project-candidate-review-package.md),
[first-revision](../../docs/project-revision-review-package.md), and
[worksheet](../../docs/project-review-worksheet.md) contracts for exact
schemas and limits.
