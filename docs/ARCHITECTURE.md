# Squire architecture

Status: architecture approved; implemented as the Squire 0.3 rewrite. The approved canvas is saved alongside this document. The user will select the first live acceptance project after readiness checks.

## Product contract

Give Squire a project brief, authorized repository scope and shipping policy. It
turns the brief into bounded tickets, executes their dependency graph, verifies
and reviews each change, ships changes that satisfy policy, and checks the
integrated project. It requests owner input when the authorized scope or budget
cannot resolve a blocker. Status and evidence remain available through restart.

Initial shipping means a verified merge plus configured postmerge checks.
Deployment can be a separate provider and gate when a project requires it.

**Required authentication path:** the initial Codex runtime uses the owner's
existing Codex subscription through the officially authenticated local CLI.
No Platform API key is required. Planning, implementation, review and repair
use this runtime and share the account's Codex usage limits. The adapter checks
the active authentication mode before dispatch and must not silently switch to
API-key billing. On usage exhaustion it preserves the checkpoint and schedules
an appropriate retry when capacity is available, rather than consuming repeated
failed attempts. Authentication failures retain a visible blocker until sign-in
is restored. API-backed runtimes are optional future adapters with explicit
credentials and billing configuration.

## Three layers

1. **Clients and integrations.** CLI, dashboard, a harness plugin or any HTTP API
   client starts projects, supplies tickets, reads status, pauses/resumes and
   supplies authorized decisions. Each uses the same control API and policy.
2. **Durable controller.** Owns the ticket graph, execution leases, budgets,
   state transitions, evidence, repair decisions and shipping authority. Agent
   sessions contribute plans, code and review findings. Their statements cannot
   establish that tests passed, a commit merged or a ticket shipped.
3. **Provider adapters.** Translate the core's typed jobs and events into a
   particular agent runtime, workspace, test runner, delivery system, ticket
   system or notification transport. Provider-specific state stays in adapters.

The controller is deterministic at its evidence and shipping boundaries. Agent
reasoning is used to interpret briefs, implement requirements, review changes
and propose repairs within the project's authorized scope.

Status comes from persisted facts and runtime events. Idle queues and unchanged
CI state do not invoke an LLM. Completion, blockers and decisions are meaningful
notifications; a periodic model-generated progress estimate is unnecessary.

## Persistence and ownership

Use SQLite for the initial single-host controller. Store projects, ticket
dependencies, attempts, leases, immutable config/ticket snapshots, candidate
base/head/tree identities, test and review receipts, delivery identities and an
outbox of pending external updates. Keep transcripts and larger artifacts on
disk with hashes and references in the store. A storage interface leaves a
server database possible without requiring it initially.

Claim work and advance states transactionally. A writer lease belongs to a
**repository and target branch**, rather than just a service name. Services in
one monorepo share that conflict key; independent repositories can run
concurrently. Recovery reconciles active provider runs and external side effects
before starting replacement work. Unknown outcomes never become success.

## Delivery loop

Brief → bounded ticket plan → dependency-ready ticket → isolated implementation
→ controller-created candidate commit → executable verification → fresh review
of that commit → publication → required CI → merge under repository policy
→ merge-tree/postmerge verification → shipped → unlock dependencies.

Failed checks and actionable review findings feed a bounded repair attempt.
Every changed candidate invalidates prior verification and review. A moved base
also invalidates their applicability to the refreshed candidate. Attempts stop
at configured time, retry and usage limits and retain a precise blocker.

GitHub expected-head merging prevents a changed PR head from being merged under
old evidence. Base freshness must also be enforced at the delivery boundary,
using strict up-to-date branch protection or a merge queue; a client-side base
check alone cannot eliminate the race. Enqueueing is an intermediate state;
the provider must confirm the actual merged commit. Required check names and
their source are configured explicitly, and skipped work is not silently counted
as executed verification. Postmerge failure halts the affected repository lane
and retains recovery work.

Project acceptance checks the integrated result against the brief after all
required tickets ship. Individual merged tickets do not imply the project goal
is complete. Ticket-system and notification updates use the outbox; failed
status synchronization is visible and retried without repeating a merge.

## Adapter contracts

| Port | Responsibility | Initial implementation | Later examples |
| --- | --- | --- | --- |
| AgentRuntime | Start, observe, inspect and cancel a bounded job; optional resume | Codex CLI | Pi, other harnesses, remote agent API |
| WorkspaceProvider | Materialize a base, isolate changes, collect/apply artifacts, create candidate | Local Git clone | Container, remote workspace |
| VerificationRunner | Run trusted project checks and emit process receipts | Local process supervisor | CI/sandbox executor |
| DeliveryProvider | Reconcile publication, check CI, merge and establish delivery identity | GitHub; local Git for trials | GitLab, other Git hosts |
| TicketSource | Import briefs/tickets and synchronize status | Local brief and queue | Linear, GitHub Issues |
| EventSink | Publish normalized durable status events | JSONL and status API | Webhook, dashboard, chat connector |

Agent jobs carry a role, task snapshot, workspace reference, base identity,
instructions, capability requirements, idempotency key and limits. The runtime
returns its run/session reference, normalized events, outcome, artifact
references and available usage. Review results identify the exact candidate
head and findings. A provider needs a fresh review session capability to fill
that role; it cannot reuse the implementation conversation as independent review.

Contracts are versioned and capabilities are negotiated before dispatch. A
remote provider may return a patch or artifact instead of sharing a filesystem;
the workspace adapter materializes it before Squire creates the candidate.
Resume is optional. Without it, recovery starts a new bounded attempt from a
known checkpoint after reconciling the old run. Provider auth/configuration stays
outside ticket text and is referenced through trusted project configuration.

There are **two independent directions of integration**:

- Another harness calls Squire's control API to delegate a delivery project.
- Squire calls that harness or an API through AgentRuntime to execute jobs.

Neither requires changing the delivery state machine. An external protocol such
as A2A can later map onto these contracts; it is not a dependency for the first
working loop.

A raw model API also needs an adapter-owned tool loop and executor to read/edit
the workspace and return artifacts. A hosted agent API may already supply that
harness. Squire consumes the same job contract in either case; it does not assume
that receiving a text completion means code was implemented.

## Scope and policy

Project policy identifies allowed repositories/branches, check commands,
required CI, merge authority, protected paths, execution limits and actions
that require owner input. Agent-generated ticket plans cannot expand that
authority or rewrite their own gate definitions. Policies and ticket snapshots
are recorded with each attempt so later configuration edits are explicit.

An isolated clone prevents normal candidate edits from changing the owner's
checkout. It does not isolate same-user processes or credentials. The initial
local implementation targets trusted owner repositories; stronger OS isolation
belongs in the workspace/execution providers before untrusted workloads.

## First acceptance project

Use a small dependency-free service with three dependent tickets. Run real
authenticated Codex implementation and fresh review sessions, executable checks,
actual candidate commits and automatic delivery through PRs, CI and merges in a
private scratch GitHub repository. Local Git fixtures separately exercise fault
injection without risking production repositories. Separately demonstrate repair
after a failing check, recovery after interruption, moved-base invalidation,
idempotent publication and a bounded terminal blocker. Confirm the integrated
service works, and that no ticket advanced through a missing gate.

Suggested trial: a tiny Node HTTP task service. Ticket 1 establishes the health
endpoint and executable baseline tests; ticket 2 adds create/list/complete with
input validation; ticket 3 persists tasks and proves restart behavior. An
operator-defined end-to-end acceptance check creates, completes and reloads a
task against the delivered service. The controller's recovery tests cover a
crash after PR creation but before its receipt is saved, stale evidence after
an edit, a base update before merge and exhausted repair attempts.

The initial build includes the controller, local Git and process supervision,
Codex adapter, local brief/queue, GitHub/local delivery, durable evidence and
CLI/control API status/pause/resume. New dashboards, mandatory planning rituals,
model-generated progress polling, distributed infrastructure and extra harness
adapters are deferred until the loop succeeds on that project.

## Agreed decisions

- Squire owns durable delivery; every agent harness is replaceable through a
  runtime adapter, and can independently be a control API client.
- Start as a single-host process with SQLite and explicit ports; add distributed
  execution only when a real workload requires it.
- Let project policy authorize automatic merges after checks and fresh review,
  with a separate deployment policy and visible bounded blockers.
- Validate one real three-ticket service before connecting production services
  or adding a second harness.

## Research informing the proposal

- [Temporal durable execution](https://docs.temporal.io/temporal) and
  [retry policies](https://docs.temporal.io/encyclopedia/retry-policies): durable
  recovery and bounded external activities. The recommendation is to apply these
  principles to a small local controller; adopting Temporal is not required.
- [GitHub PR merge API](https://docs.github.com/en/rest/pulls/pulls),
  [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
  and [merge queues](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue):
  expected PR head, server-enforced base freshness and confirmed delivery.
- [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode):
  bounded process integration, JSONL events and structured job results can sit
  behind the initial runtime adapter.
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents):
  simple workflows, objective environment feedback and bounded evaluator/repair
  loops inform the implementation and review roles.
