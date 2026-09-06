# AIDEV-224 intake, ledger, and reconciliation

AIDEV-224 supplies the trusted single-ticket intake and durable controller projection. `SingleTicketIntakeService` accepts one Linear UUID, expected identifier, validated v1 workflow configuration, and mandatory idempotency key. It fetches the issue by UUID, validates team/state IDs, resolves one full base object ID, writes the canonical create-once artifact at `artifacts/intake/<runId>/normalized-ticket.json`, and commits the run plus `ticket_run_locks` and first workflow event in one SQLite transaction.

## Durable database

`SqliteDatabase` opens only an absolute controller-owned private path. It sets foreign keys, WAL, `synchronous=FULL`, bounded busy timeout/checkpoint, and the Squire application ID. Checked migrations record name/checksum/version in `schema_migrations`; startup rejects checksum drift and newer versions. The operator-only rollback path requires a private verified backup and refuses to destroy workflow rows.

`SqliteWorkflowStore` implements the complete AIDEV-216 `WorkflowStore` and quiescence surface. Snapshot JSON is lossless, while sessions, process allocations, attempts, gates, leases, fences, resource bindings, delivery identities, webhook receipts, errors, and reconciliation observations have relational uniqueness/foreign-key projections. CAS and fenced operations use `BEGIN IMMEDIATE`, shared snapshot invariants, and append-only state events. Lease tokens never decrease or repeat. Terminal teardown requires the exact permanent fence and durable quiescence; terminal rows and audit history are retained.

The normalized-ticket branch is the published v1 spelling `squire/<ticket-lower>/<runId>`. AIDEV-222 receives only the independently persisted physical spelling `squire/<ticket-lower>-<runId>`.

## Startup barrier and ports

`StartupReconciler` acquires a singleton fenced controller lease, persists a complete read-only observation from Linear, Sandbox, Herdr, process/Pi, Git, and GitHub, performs only exact recovery seams, then repeats the complete observation. Incomplete pagination, provider errors, duplicates, and identity conflicts block. `ReconciledSideEffectGate` starts closed and issues an opaque permit only for a ready generation; permits are invalid after takeover, database/generation change, or a blocked run.

`reconciliation/ports.ts` contains observation and permit-requiring mutation ports for the unmerged Sandbox, Herdr, delivery, and UI-owned work. No permissive no-op adapter, publisher, approver, merge operation, UI, or webhook server is included. The Linear lifecycle mapping uses configured state IDs only: `awaiting_approval` and `approved` map to `awaitingHuman`, never `completed`.

## Lifecycle and operator recovery

`RunLifecycleService` verifies the trusted Git head before cancellation/failure/expiry CAS, removes only the exact active ticket lock when using the SQLite ledger, uses the injected clock and persisted deadlines, and schedules distinct success/failure retention. Cleanup obtains the permanent terminal fence and re-proves quiescence at each destructive port. Operator errors are bounded, sanitized, fingerprinted, counted, and retained; resolution cannot reopen a run, clear uncertainty, force-adopt a resource, bypass retention, or authorize merge.

The implementation includes file-backed restart, migration, hostile-data, concurrency, webhook deduplication, startup-barrier, naming, lifecycle, and store conformance tests. Human-only merge remains an explicit boundary owned by later delivery/approval work.
