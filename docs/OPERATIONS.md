# Operations and integrations

## State and recovery

Use one absolute state root for the host. SQLite (`squire.sqlite`) stores immutable project configuration, ticket checkpoints, leases and ordered events. Project directories store isolated clones, prompts, model outputs, command logs and receipts. Logs may contain proprietary source; retain them privately. Never commit the state root.

Processes run beneath a supervisor with a parent lifeline. Before spawning that supervisor, the existing SQLite store records a unique operation under a durable producer scope. One-use supervisor and target launch grants require the same controller lease owner. These random tokens establish protocol ownership, not OS process identity. Existing process-tree termination remains best effort; this protocol does not establish descendant settlement.

An operation's immutable canonical terminal record binds the existing receipt by digest, including nonzero exits and affirmative launch failures. A terminal process is not a recorded caller outcome. A producer scope closes only after its caller persists the outcome and all registered operations have canonical terminal records. Interrupted or failed outcome persistence holds the scope even when the command finished. Planning, ticket phases, acceptance, explicit recovery, doctor and runtime configuration use this boundary; Git, GitHub, checks, auth and catalog launches inherit it. Agent-call reservations share the existing debit transaction and are referenced by their process registrations.

`producer_unresolved` means retain the state root and inspect the referenced scope/operation and private evidence. Retry, recovery admission and runtime/budget changes cannot clear held scopes. No receipt import, replay with another ID, TTL takeover, dead-PID completion inference or automatic scope clearing is available. Project-wide scopes fence dependent work. Scopes also retain the existing canonical repository/branch resource keys, so another project in the same SQLite store cannot bypass an unresolved producer after lease turnover. Independent repository lanes can proceed. Separate state roots do not coordinate these fences. Old active records without matching registration remain unknown. Existing project states without `processProtocol: 1` refuse new producer execution as `producer_legacy`; there is no automatic migration claiming that historical launches settled. Do not recreate an ambiguous operation in a fresh project to evade its fence.

Known, durably projected outcomes still use the existing verification, review, candidate and delivery gates. This prerequisite does not complete recovery, prove exactly-once remote effects, or demonstrate a performance improvement.

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
