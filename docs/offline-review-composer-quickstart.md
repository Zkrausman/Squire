# Review the disposable fixture with the composers

Start from the repository root and follow **only step 1** of the [published fixture walkthrough](../examples/offline-review/README.md). Keep its private shell, fresh directory `$R`, store inventory and supplied test witnesses. The fixture contains fixed text, three-byte binary samples and a preconstructed revision. Its artificial receipt and stage tokens establish no producer provenance. Inspect candidate files as data.

## Build the original and inspect its worksheet

Create `$R/original-bindings.json` using the six-field [original bindings example](project-review-spec-composer.md#original-candidate). Use actual absolute paths in JSON. Select `original-result.json` under the fixture root, copy the original and base store paths and identities from `stores.json`, and designate the fresh `$R/original-package` destination.

```sh
node bin/squire-review-spec.mjs original "$R/original-bindings.json" "$R/original-spec.json"
node bin/squire-candidate-review.mjs --build "$R/original-spec.json" | tee "$R/original-build.txt"
D=$(awk '/^Manifest SHA256:/ {print $3}' "$R/original-build.txt")
node bin/squire-candidate-review.mjs --verify "$R/original-package" --expect-sha256 "$D"
node bin/squire-review-worksheet.mjs original "$R/original-package" "$D" "$R/original-worksheet.json"
cat "$R/original-package/diff.txt"
od -An -tx1 "$R/original-package/changes/assets/icon.bin.new"
jq . "$R/original-worksheet.json"
```

Inspect all five rows and the binary addition (`00 ff 01`). Stop here with choice and attestations blank until the reviewer supplies their own responses. Retain each successful build or record acknowledgment separately. On an uncertain write, preserve the output and stop.

## Prepare a request when the reviewer supplies responses

The reviewer edits only the response fields in the private worksheet according to the [request contract](project-review-decision-request.md#supply-your-own-responses). The composer checks the package against the retained digest and transfers the verified bindings into a fresh editable request.

```sh
node bin/squire-review-decision-request.mjs original "$R/original-package" "$D" "$R/original-worksheet.json" "$R/request.json"
jq . "$R/request.json"
```

Inspect the identity, choice, note and individual claimed rows. Only when the reviewer intends to submit this request, record and verify it separately.

```sh
node bin/squire-candidate-decision.mjs record "$R/original-package" "$R/request.json" "$R/prior" | tee "$R/prior-record.txt"
```

Set `P` to the decision digest in that successful record acknowledgment. Verify the record against it.

```sh
node bin/squire-candidate-decision.mjs verify-decision "$R/original-package" "$R/prior" "$P"
```

## Inspect the first revision after an explicitly selected REVISE

Create `$R/revision-bindings.json` from the [first-revision bindings example](project-review-spec-composer.md#first-owner-supplied-revision). Select `original-result.json` and `revised-result.json`, all three physical store paths and identities from `stores.json`, and the fresh `$R/revision-package`. Supply the original package with retained digest `$D`, the complete declared prior record set with independently retained digests, and the explicitly selected REVISE ID. For a single prior under `$R/prior`, its digest is `$P`.

```sh
node bin/squire-review-spec.mjs revision "$R/revision-bindings.json" "$R/revision-spec.json"
node bin/squire-candidate-review.mjs --build-revision "$R/revision-spec.json" | tee "$R/revision-build.txt"
V=$(awk '/^Manifest SHA256:/ {print $3}' "$R/revision-build.txt")
node bin/squire-candidate-review.mjs --verify-revision "$R/revision-package" --expect-sha256 "$V"
node bin/squire-review-worksheet.mjs revision "$R/revision-package" "$V" "$R/revision-worksheet.json"
cat "$R/revision-package/base-to-revised.diff.txt" "$R/revision-package/original-to-revised.diff.txt"
od -An -tx1 "$R/revision-package/changes/assets/icon.bin.original"
od -An -tx1 "$R/revision-package/changes/assets/icon.bin.revised"
jq . "$R/revision-package/revision-review-manifest.json" "$R/revision-worksheet.json"
```

Look for four base-to-revised rows and three original-to-revised rows. The restored blue value in `src/restore.mjs` appears only in the second view as `RESTORED_BASE`. Inspect the binary in both views. Leave the revision responses blank.

The two spec compositions and one request preparation replace hand assembly of three final documents. The request composer carries over the five original request bindings. The caller still prepares two bindings files, edits one worksheet and selects each store, saved result, digest and prior record. The three composition commands add steps to the published direct route.
