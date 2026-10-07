# Operations and integrations

## State and recovery

Use one absolute state root for the host. SQLite (`squire.sqlite`) stores immutable project configuration, ticket checkpoints, leases and ordered events. Project directories store isolated clones, prompts, model outputs, command logs and receipts. Logs may contain proprietary source; retain them privately. Never commit the state root.

Processes run beneath a supervisor with a parent lifeline. Before spawning that supervisor, the existing SQLite store records a unique operation under a durable producer scope. One-use supervisor and target launch grants require the same controller lease owner. These random tokens establish protocol ownership, not OS process identity. Existing process-tree termination remains best effort; this protocol does not establish descendant settlement.

An operation's immutable canonical terminal record binds the existing receipt by digest, including nonzero exits and affirmative launch failures. A terminal process is not a recorded caller outcome. A producer scope closes only after its caller persists the outcome and all registered operations have canonical terminal records. Interrupted or failed outcome persistence holds the scope even when the command finished. Planning, ticket phases, acceptance, explicit recovery, doctor and runtime configuration use this boundary; Git, GitHub, checks, auth and catalog launches inherit it. Agent-call reservations share the existing debit transaction and are referenced by their process registrations.

`producer_unresolved` means retain the state root and inspect the referenced scope/operation and private evidence. Retry, recovery admission and runtime/budget changes cannot clear held scopes. No receipt import, replay with another ID, TTL takeover, dead-PID completion inference or automatic scope clearing is available. Project-wide scopes fence dependent work. Scopes also retain the existing canonical repository/branch resource keys, so another project in the same SQLite store cannot bypass an unresolved producer after lease turnover. Independent repository lanes can proceed. Separate state roots do not coordinate these fences. Old active records without matching registration remain unknown. Existing project states without `processProtocol: 1` refuse new producer execution as `producer_legacy`; there is no automatic migration claiming that historical launches settled. Do not recreate an ambiguous operation in a fresh project to evade its fence.

Known, durably projected outcomes still use the existing verification, review, candidate and delivery gates. This prerequisite does not complete recovery, prove exactly-once remote effects, or demonstrate a performance improvement.

### Passive held-scope inspection

Run `node bin/squire.mjs inspect-producers project.json` for one bounded JSON diagnostic (`type: squire.producer-inspection`, `version: 1`). The command reads only `id` and absolute `stateDir` from the supplied config; it does not validate or execute its runtime/check settings. It accepts no options. Existing `status` and HTTP API output remain unchanged.

The selection includes open producer scopes belonging to the project plus scopes explicitly referenced by its retained ticket holds and `producer_unresolved` blocker details (including a referenced conflicting project). Closed historical scopes otherwise remain outside this small view. It joins scope, resource, operation and call-reservation records; `holds` preserves the link from ticket to scope. Resource IDs are the existing canonical repository/branch digests. Project/ticket names are bounded identifiers; malformed IDs become null with an issue code. This is a local diagnostic, not a public export.

| Evidence | Meaning in this view |
| --- | --- |
| `registered` | Operation registered; launch unconfirmed. |
| `supervisor` | Supervisor grant consumed; target launch unconfirmed. |
| `target` | Target grant consumed immediately before spawn; successful spawn and current liveness remain unconfirmed. |
| Recorded terminal | Canonical terminal record, including nonzero/null exit codes and receipt digest. `immutableGuard` reports recognition of the database update guard. The artifact itself is not verified. |
| `terminal_records_present_scope_outcome_unprojected` | All selected operation records have valid terminals, but no scope outcome was recorded. The scope fence remains; this does not establish whether individual ticket updates already happened. |
| `recorded_closed` | Scope closure and outcome state digest are recorded. This does not establish product acceptance or current liveness. |
| Reservation without an operation | Retained call identifier with no linked operation evidence; never a refund or retry entitlement. |

`artifacts` supplies an operation ID, a digest of the recorded directory and fixed protocol slots (`<operationId>.receipt.json`, `.request.json`, `.active.json`, `.stdout.log`, `.stderr.log`). These are handles to retained database metadata, not verified file links: presence is `not_checked`. No directory or artifact path from stored data is followed. Requests, logs, argv, prompt/config payloads, free-form blockers, owner/grant tokens and raw paths are omitted. Identifier names can still be private; do not publish this output automatically.

The source database is **never opened by SQLite**. A read-only SQLite connection can still create or update WAL shared memory, so inspection instead reads the fixed existing `squire.sqlite` and optional `squire.sqlite-wal` into a private temporary directory. File identity, size, modification and change times must agree before and after the entire capture. Any rollback journal, detected concurrent change, incompatible SQLite image or read failure returns a sanitized `squire.error` and exit 1 without source recovery. It does not retry. Ordinary local filesystem metadata and cooperative SQLite writers are assumed; this is not an adversarial filesystem snapshot protocol. Reads can update filesystem access times. The command does not mutate source bytes, namespace, mtime or ctime; all SQLite sidecar work is confined to the temporary copy, which is removed afterward.

The captured image is opened read-only with extension loading disabled and trusted schema off. One transaction reads the snapshot, selected records and global event high-water. `snapshot.sha256` identifies the captured DB/WAL bytes, not a persistent state-generation ID. The view does not replay event history or claim complete lifecycle coverage. WAL commits newer than the capture are not part of the result. No `immutable=true` live-database shortcut is used. If private-copy cleanup fails after bounded retries, the command withholds the result and reports `inspection_cleanup` without exposing paths; a private temporary copy may remain for local cleanup.

Limits: 1 MiB config, 64 MiB combined DB/WAL, 2-second cooperative capture budget, 1 MiB project state, 4 KiB per selected field, 200 scopes/hold references and 200 total child records (resources, reservations, operations), 256 KiB JSON output. Size or row exhaustion returns an error rather than an apparently complete truncated view. The time budget is checked between bounded reads; it cannot interrupt a stalled OS filesystem call. Oversized/malformed state or fields and missing/legacy tables are explicitly partial/unknown. An empty selection never means idle or settled.

Inspection creates no source database/schema, migrations, checkpoints, leases, events or reservations. It clears no fences and performs no import, recovery, retry, subprocess, provider query, process/PID probe or benchmark. Controller liveness is always unknown and useful progress is not assessed. Better explanation alone establishes neither improved recovery nor measured time savings. The deterministic fixtures use only disposable SQLite state and fake evidence.

`pause` takes effect at the next boundary; Ctrl+C cancels local jobs and records pause. `resume --retry`, when no producer scope is held, can re-enter verification or postmerge checks after the owner resolves a blocker. Budget ceilings remain durable; changing config for an existing project ID is rejected. Use a new explicitly authorized project when changing scope or budget, preserving the old evidence. Quota waits are automatic and charge neither repair nor rebase counters, but dispatched model calls count against the total call ceiling.

Shipping authorizes merges, not production deployment. Postmerge failure requires owner reconciliation because the branch already contains that commit.

## Control API version 1

`serve ABSOLUTE_STATE_ROOT` binds only to `127.0.0.1`. Read the private `control-token` file and send `Authorization: Bearer <token>`. Host must be the exact returned loopback host/port. Browser Origin requests are rejected. Keep the token out of agent prompts and logs.

| Method | Route | Body/result |
|---|---|---|
| GET | `/v1/projects` | Project snapshots |
| POST | `/v1/projects` | Validated project JSON; stateDir must equal server root |
| GET | `/v1/projects/:id` | Durable snapshot |
| GET | `/v1/projects/:id/events?after=CURSOR` | Ordered events; persist highest cursor |
| POST | `/v1/projects/:id/pause` | `{}` |
| POST | `/v1/projects/:id/resume` | `{"retry":true}` to retry blockers |

Submission requires authorized source/checks/shipping policy. This API intentionally has no unrestricted agent command route. It is not a remote authentication/multiuser service.

## Adapter development

`Controller(store, projectId, providers)` accepts trusted `runtime`, `workspace`, `verifier`, `delivery(service)` and `onPublication` injections. These are code dependencies owned by the operator, not fields accepted from untrusted HTTP config. The installed CLI validates `runtime.kind=codex`; adding another installed kind requires an explicit adapter registry/validation change.

The [versioned runtime contract](../src/ports.d.ts) uses `execute(job)` with fresh role sessions, bounded timeout, events and AbortSignal. The adapter owns provider start/stream/cancel and materializes artifacts in the workspace before completion. A raw model API response requires an adapter-owned tool executor. Providers never directly mutate the controller database or declare tickets shipped. Subscription policy is a project capability requirement rather than a dependency inside the core.

Workspace methods materialize Git identities; the verifier runs trusted commands and returns process receipts; delivery publishes stable identities, checks remote policy and returns exact merge identity. Ticket sources use project JSON through the API. Event sinks consume durable cursors and can notify on completion/blockers. No mandatory ticket vendor, dashboard, Temporal service, or second harness is needed for the initial loop.
