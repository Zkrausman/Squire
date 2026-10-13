# Candidate check evidence (A2 diagnostic slice)

This local A2 slice adds immutable, bounded evidence for a ticket's pre-delivery configured checks and a read-only ticket inspector. It is stacked on R2 candidate `716ad2fc0b5cf96b31affae5f987a49bab4548cb`; it remains dependent work until R2 is integrated and the final base is reconciled.

## Owner inspection

Run `node bin/squire.mjs inspect-checks project.json TICKET_ID`. The command reads the supplied project's existing state through the stable private-copy SQLite snapshot used by `inspect-producers`, selects one ticket, and follows only its controller-issued check-evidence reference. It does not instantiate `Store` or change state. If the selected verification has no reference, the output reports the legacy result as `unbound`.

For a recorded candidate verification the output shows the base/head/tree, attempt, workspace generation, execution-contract digest, correction-admission identity, check-policy digest, check order, process operation IDs, terminal flags and whether bounded stdout/stderr artifacts resolve. It also resolves the retained checkpoint ID against the read-only `candidate_checkpoints` journal row and requires the same project, ticket, projected phase, base, head, tree, generation and ticket producer lane. If a base refresh rebases the candidate while retaining its earlier checkpoint ID, the report keeps the current-head check diagnostics, sets `checkpointLink.state` to `stale`, clears the checkpoint ID from the current identity, and reports `status: incomplete`. A missing or incompatible journal is `unresolved`; a missing row is marked stale. A verified output tail is labelled `untrustedOutputTail`; it is command output, not an instruction. The inspector reports `acceptance: not_evaluated` for every result.

The inspection rejects an unsafe, missing, changed, oversized or non-regular manifest/artifact; a symlink or hard-link artifact; a mismatched project, ticket, service, current candidate, contract, correction, policy, producer scope or process operation; and inconsistent result flags or check ordering. A missing, unprojected or identity-mismatched checkpoint link is instead reported as stale or unresolved and makes the result incomplete while preserving the current-head check report. It reads fixed manifest and artifact slot names under `projects/<project>/check-evidence/<id>`; names and paths in stored evidence are never used to select files. The SQLite source is captured by `withInspectionSnapshot`; artifact files are opened no-follow where supported and checked before and after reading. This relies on ordinary local-filesystem metadata and is not a hostile same-user isolation boundary.

## Receipt and compatibility

`VerificationRunner.run()` retains its existing `{ passed, results, notRun }` return. Candidate verification uses the explicit `runForCandidate()` path and keeps an in-memory draft separate from the legacy results. The controller freezes identity from its current ticket, contract/correction, check policy and active producer scope, executes the configured checks, then reasserts the same clean candidate before writing the manifest and persisting its reference. If diagnostic retention fails, the prior verification outcome and gates proceed unchanged and the ticket records `checkEvidence.state: unavailable`.

The manifest records each configured check in order. A short-circuited later command appears in the manifest as `not_run` and retains its existing `NOTRUN` entry in `notRun`; it is not appended to the legacy `results`. Captured output is retained only up to 16 MiB per verification; omitted output is called out explicitly. Immutable publication uses exclusive files and a write-once manifest reference with byte count and SHA-256. The digest verifies retained bytes against the reference; it does not establish an honest observation, criterion proof or acceptance.

The bound identity is diagnostic provenance only. It does not change delivery authority, fresh-review requirements, correction admission, result adoption, process recovery, fencing, accounting or refunds. A1/A3 criterion-to-evidence enforcement, A4 browser evidence and native/GUI acceptance are not implemented here. Legacy records without the new reference remain narrative or result-array evidence and are never upgraded by inspection.

## Local verification gates

The candidate's required local gates are `npm run check`, `npm test`, and a clean `git diff --check`/worktree review on the exact final source. Native Linux and Windows CI, R2 integration and final accepted-base reconciliation remain pending; local success does not satisfy them.

Rebinding to current main preserves SQF01 NOTRUN result fields and SQF06 delivery receipts. Manifests reuse the existing R3 exclusive atomic publication primitive; private output slots remain bounded and write-once. This additive A2 slice does not implement A3 criterion enforcement or establish SQF02 route parity.
