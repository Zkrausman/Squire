# Operations and integrations

## State and recovery

Use one absolute state root for the host. SQLite (`squire.sqlite`) stores immutable project configuration, ticket checkpoints, leases and ordered events. Project directories store isolated clones, prompts, model outputs, command logs and receipts. Logs may contain proprietary source; retain them privately. Never commit the state root.

Processes run beneath a supervisor. Its parent lifeline closes on controller death, terminating the job tree. Restart reconciles active receipts before recovering work. Interrupted implementation preserves partial work for controller checkpointing; review restarts with checks and a fresh session. Lost publication/merge receipts reconcile the stable branch/PR before sending another request. Unknown outcomes cannot establish success.

`pause` takes effect at the next boundary; Ctrl+C cancels local jobs and records pause. `resume --retry` can re-enter verification or postmerge checks after the owner resolves a blocker. Budget ceilings remain durable; changing config for an existing project ID is rejected. Use a new explicitly authorized project when changing scope or budget, preserving the old evidence. Quota waits are automatic and charge neither repair nor rebase counters, but dispatched model calls count against the total call ceiling.

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
