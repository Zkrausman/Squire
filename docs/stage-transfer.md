# Profile-aware local stage transfer

For an explicitly selected, already-created standard or large local stage, use
its separately retained stage receipt digest, an export operation ID, a caller
label, and a fresh protected destination. Select the profile used by the stage;
no profile is inferred from content or retried under another policy.

```sh
node bin/squire-stage-export.mjs standard "$stage_dir" "$stage_sha256" "$operation_id" "$caller_label" "$export_dir"
node bin/squire-stage-export.mjs large "$large_stage_dir" "$large_stage_sha256" "$operation_id" "$caller_label" "$large_export_dir"
```

The legacy five-argument invocation still selects standard. Both forms print
one JSON line with `operation_acknowledgement`, `manifest_sha256` (the **export**
manifest digest), `total_files` and `total_bytes` on success. Neither accepts
additional evidence, logs or frame attachments. A rejection exits 2 with a safe
stderr diagnostic and no stdout receipt. Existing destinations are not changed;
a failed export may leave a newly reserved or partially filled directory for
inspection. No automatic retry or rollback occurs.

## Receive a selected copy

Retain the expected digest from the sender's corresponding stage or export
receipt independently of the transferred copy. Do not derive the expected
value from the manifest inside that copy. Select both its original profile and
its kind, and supply the copy's canonical absolute directory:

```sh
node bin/squire-stage-verify.mjs standard stage "$copied_stage_dir" "$stage_sha256"
node bin/squire-stage-verify.mjs large export "$copied_export_dir" "$large_export_sha256"
```

All four profile/kind combinations work. The verifier reads the complete
manifest and declared inventory using the existing matching library policy,
including byte counts and content SHA-256, and requires the independently
retained digest to match. A valid but different copy, wrong profile or kind,
tampered bytes or unexpected inventory is rejected with exit 2 and no stdout.
On success it prints one JSON line with `profile`, `kind`, `status: VERIFIED`,
`manifest_sha256`, `total_files`, `total_bytes`,
`original_operation_acknowledgement: UNKNOWN`,
`provenance_authenticity: NOT_ESTABLISHED` and
`crash_durability: NOT_ESTABLISHED`. It does not recreate an original sender
acknowledgement. The receiver is read-only; it does not create a stage, export,
or receipt file, execute source or grant task acceptance.

The existing [multifile staging/export contract](multifile-staging-export.md)
defines custody, exact inventory, bounded reads, file modes and failure
semantics. Both directories and transferred copies must satisfy that contract;
verification requires a cooperative, quiescent filesystem. Use synthetic
fixtures for this offline workflow; no actual private job export is needed.
