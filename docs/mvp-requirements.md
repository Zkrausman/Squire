# Squire MVP Product and Technical Requirements

> **Historical requirements notice (2026-09-10):** The approved first release is the smaller [Squire Personal MVP](personal-mvp.md). This document remains design history; requirements for an AI Orchestrator, five mandatory Herdr tabs, automated approval, hardened custody, and broad recovery do not block AIDEV-255.

_Last updated: 2026-09-10_

## 1. Product intent

Squire will become a generic, configurable automated AI delivery platform. The MVP proves the smallest useful outcome: accept one software ticket, run an AI-operated software delivery lifecycle, and produce an approved, merge-ready pull request for a human to merge.

The MVP applies a conventional SDLC rather than inventing a new lifecycle. Independent Pi phase sessions perform distinct responsibilities while an orchestrator Pi session controls the overall process. A phase session may use subagents internally, but a subagent cannot represent or replace a lifecycle phase.

## 2. MVP boundary

### Input

- One software ticket per workflow run.
- The ticket is the unit of planning, implementation, review, testing, and delivery.

### Workflow

The required delivery stages are:

1. **Plan**
2. **Implement**
3. **Review**
4. **Test**

A fifth meta-layer, the **Orchestrator**, surrounds and coordinates the four delivery stages. It is not another sequential stage.

### Output

A successful workflow run must:

- create the delivery branch and commits;
- push the branch;
- open a pull request;
- satisfy the required review and test gates; and
- leave the pull request approved and ready for a human merge decision.

### Human control boundary

- Squire must not merge pull requests in the MVP.
- A human performs the final merge.
- Automated approval means the AI delivery gates passed; it does not authorize autonomous merge.

## 3. Functional requirements

### PR-1: Generic, configurable workflow

Squire must not hard-code itself to one repository or one ticket. The workflow, stage contracts, and repository-specific behavior must have a defined configuration boundary suitable for later extension.

The minimum v1 configuration and workflow contracts are defined in [AIDEV-215 Workflow and Handoff Contracts](aidev-215-workflow-contracts.md).

### PR-2: Single-ticket execution

Each run must accept exactly one ticket and maintain an identifiable workflow state for that ticket through completion or failure.

### PR-3: Independent phase sessions

Each lifecycle phase must run as its own top-level Pi session with a distinct responsibility and explicit inputs and outputs. A phase session may delegate bounded internal work to subagents, but the phase itself must never be implemented as a subagent.

#### Plan

- Interpret the ticket and relevant repository context.
- Produce an actionable implementation plan for the Implement stage.

#### Implement

- Consume the ticket and plan.
- Modify only the active ticket workspace.
- Produce implementation artifacts suitable for independent review and testing.

#### Review

- Independently evaluate correctness and quality.
- Either pass the review gate or return actionable findings.
- Failed review must be able to route work back for remediation.

#### Test

- Run the configured validation for the change.
- Record validation results.
- Failed tests must be able to route work back for remediation.

### PR-4: Orchestration

The orchestrator must:

- sequence stages and enforce gates;
- launch or connect to each independent phase session;
- provide each phase session with its explicit inputs;
- read and monitor the other Pi sessions as they work;
- collect phase outputs and workflow artifacts from those sessions;
- track current and terminal state;
- direct phase transitions, feedback, and remediation loops;
- handle stage failures and bounded retries; and
- determine when the pull request is ready for automated approval.

Detailed retry and failure policies are deferred to research.

### PR-5: Observable independent sessions

The human operator must be able to observe and manually steer the orchestrator and independent phase sessions through five Herdr tabs. Each tab contains exactly one unavoidable root pane; pane splits and multi-pane layouts are prohibited. The orchestrator must also be able to read the phase sessions and use their progress and outputs to coordinate the workflow.

### PR-6: Delivery automation

Squire must manage the ticket branch through commit, push, pull-request creation, and approval while preserving the human-only merge boundary.

## 4. Technical requirements

### TR-1: Pi orchestrator

- The orchestrator runs as a Pi session.
- It is the control plane for a single ticket workflow.

### TR-2: Independent Pi phase sessions

- Plan, Implement, Review, and Test each run as a separate top-level Pi session.
- A phase Pi session may use subagents for bounded internal work.
- A subagent cannot serve as Plan, Implement, Review, or Test itself.
- The orchestrator reads and coordinates the independent phase sessions; it does not collapse them into its own subagent tree.
- Herdr surfaces the five sessions in one ticket workspace with one tab per session.
- Every tab contains exactly one unavoidable root pane.
- Pane splits, multi-pane layouts, and using Herdr worktree groups as phase containers are prohibited.

### TR-3: Dedicated Git worktree

- Every ticket run receives a dedicated branch and Git worktree inside its ticket-private sandbox filesystem.
- The ticket-private bare repository lives at `/ticket/git/repo.git` and its sole linked worktree lives at `/ticket/workspace`.
- All ticket modifications occur in that worktree.
- Agents must not operate in or inspect the primary host checkout.
- Import, bundle export, worktree lifecycle, and cleanup are owned by the platform.

### TR-4: Sandboxed execution

- Agent work runs in one persistent Docker Sandboxes microVM per ticket run.
- All five Pi sessions intentionally share that ticket boundary and its private Docker Engine.
- Docker Sandboxes direct workspace mode and stock clone mode must not expose repository content from the host.
- Because Docker Sandboxes v0.39.0 requires the primary workspace to be writable, the sandbox receives only a dedicated, ticket-specific, read-write but otherwise empty host bridge.
- The bridge contains no repository, credentials, home data, or unrelated host state; agents must not use it for repository work or trusted artifact publication.
- Bridge contents are untrusted and deleted during ticket cleanup. The repository, Git metadata, sessions, and artifacts remain beneath `/ticket` inside the microVM, and controller-mediated `sbx cp` is the trusted export path.

### TR-5: Context and filesystem isolation

Phase sessions and any subagents they launch must not be able to inspect:

- the primary checkout;
- sibling worktrees;
- unrelated repositories;
- the repository parent directory;
- the host user's home directory; or
- ambient host state not explicitly granted to the run.

The isolation design must account for Git metadata: exposing a linked worktree must not accidentally expose sibling worktrees or unrestricted host repository data.

### TR-6: Least-privilege capabilities

- Filesystem mounts, credentials, secrets, network access, and host integrations must be explicitly granted.
- A stage receives only the capabilities and context required for its role.
- The sandbox must prevent a worker from gaining unauthorized knowledge from other workspaces.
- Normal outbound network access is allowed for the MVP; a model gateway is not required.
- Model credentials may be ticket-scoped inside the microVM when proxy management is incompatible.
- Linear and GitHub delivery credentials remain in the trusted controller and are never granted to phase sessions.

### TR-7: Explicit handoff contracts

The platform must implement the versioned machine-readable contracts in [AIDEV-215 Workflow and Handoff Contracts](aidev-215-workflow-contracts.md) for:

- normalized ticket input;
- phase input, short RPC trigger, and phase result;
- plans, findings, and test evidence;
- orchestrator transition requests; and
- pull-request delivery state.

For each attempt, the controller creates and validates an immutable phase-input artifact, records its path and SHA-256 with run, phase, attempt, target session, and head bindings, then sends a short Pi RPC trigger that references the artifact instead of embedding the task. The phase verifies the artifact and writes result/evidence artifacts; the controller validates those outputs before Orchestrator consumption. Herdr/manual prompts are audited steering only. Scope-changing intervention requires a new immutable handoff and incremented attempt rather than mutation of prior input.

### TR-8: Workflow and artifact state

The orchestrator must retain enough state to identify:

- the active ticket, branch, worktree, and sandbox;
- current and completed phase sessions;
- phase-session outputs and gate decisions;
- remediation attempts; and
- the resulting pull request.

The persistence mechanism is deferred to research.

### TR-9: Feedback loops

- Review failure can direct the Implement phase session to remediate findings.
- Test failure can direct the Implement phase session to remediate validation failures.
- A remediated change must pass the applicable gates again before approval.
- Retry limits and escalation behavior must be configurable or explicitly defined.

### TR-10: Pull-request safety boundary

- PR creation and approval may be automated.
- Merge authority must not be available to the MVP workflow.
- Successful completion leaves an approved, merge-ready PR awaiting a human.

## 5. MVP acceptance scenario

The MVP is demonstrated when Squire can:

1. receive one software ticket;
2. create a dedicated branch and worktree;
3. expose only that ticket workspace inside a restricted sandbox;
4. run the orchestrator as a Pi session;
5. launch the Orchestrator, Plan, Implement, Review, and Test as independent Pi sessions through five Herdr tabs with one root pane each and no splits;
6. have the orchestrator read and coordinate those sessions through Plan → Implement → Review → Test with explicit handoffs;
7. handle at least the defined review and test feedback paths;
8. commit and push the resulting change;
9. open and approve the pull request; and
10. stop without merging, leaving the final decision to a human.

## 6. Explicit non-goals for the MVP

- Processing multiple tickets in one workflow run.
- Automatically merging pull requests.
- Running multiple phase sessions in one Herdr tab, splitting panes, or creating multi-pane layouts.
- Implementing a lifecycle phase as a subagent.
- Allowing phase sessions or their subagents to inspect sibling worktrees or unrelated host context.
- Finalizing production-scale scheduling, distributed execution, or multi-tenant architecture before research establishes a need.

## 7. Ticket traceability

| Requirement area | Linear tickets |
|---|---|
| Research and architecture refinement | AIDEV-214 |
| Configuration and handoff contracts | AIDEV-215 |
| Pi orchestration | AIDEV-216 |
| Herdr one-tab-per-session integration and independent phase sessions | AIDEV-217 |
| Plan phase session | AIDEV-218 |
| Implement phase session | AIDEV-219 |
| Review phase session and remediation | AIDEV-220 |
| Test phase session and remediation | AIDEV-221 |
| Worktree isolation | AIDEV-222 |
| Sandbox and least-privilege isolation | AIDEV-223 |
| Ticket intake and workflow state | AIDEV-224 |
| Branch, commit, push, and PR creation | AIDEV-225 |
| Automated approval and human-only merge | AIDEV-226 |
| End-to-end acceptance | AIDEV-227 |
| MVP epic | AIDEV-213 |

## 8. Research decisions

AIDEV-214 selected the following implementation boundaries:

- TypeScript on supported Node.js LTS, packaged as one trusted controller service/CLI;
- SQLite as the durable single-worker workflow ledger;
- Pi RPC, persisted JSONL, and explicit result envelopes as authoritative session interfaces;
- one Herdr ticket workspace with five tabs, one root pane per tab, and no splits;
- one persistent Docker Sandboxes microVM per ticket;
- ticket-private bare Git repository and linked worktree beneath `/ticket`;
- normal outbound network access for MVP model and dependency traffic;
- controller-mediated Git bundle export and trusted publication;
- separate Squire Delivery and Squire Reviewer GitHub Apps; and
- server-side GitHub rules that reserve merge for humans and deny Squire bypass/base-update authority.

AIDEV-215 defines the [configuration and handoff contracts](aidev-215-workflow-contracts.md). Later implementation tickets own credential brokering, GitHub deployment preflight, cleanup automation, and operational hardening. See [Squire MVP Architecture](mvp-architecture.md) and [Docker Sandboxes viability spike](docker-sandboxes-viability-spike.md).
