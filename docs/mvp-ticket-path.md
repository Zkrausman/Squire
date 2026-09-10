# Squire MVP Ticket Path

> **Superseded on 2026-09-10:** The first-run path is now the single vertical-slice ticket [AIDEV-255](https://linear.app/geltagentictrading/issue/AIDEV-255/deliver-one-personal-ticket-end-to-end-with-squire-run). The graph below is retained as historical context and is not the current execution order.

_Last updated: 2026-09-10_

## Linear scope

- Project: [Squire MVP — Automated AI Delivery](https://linear.app/geltagentictrading/project/squire-mvp-automated-ai-delivery-fb9e333ec073)
- MVP epic: [AIDEV-213 — Deliver one ticket to an approved, merge-ready PR](https://linear.app/geltagentictrading/issue/AIDEV-213/mvp-deliver-one-ticket-to-an-approved-merge-ready-pr)
- Team: AIDEV

The dependency graph is the source of truth for when a ticket is eligible to start. The path below recommends an implementation order within that graph. It deliberately establishes isolation early so it is part of the architecture rather than a late retrofit.

## Recommended serial path

Use this order when working one ticket at a time:

1. **[AIDEV-214 — Research and finalize the MVP technical design](https://linear.app/geltagentictrading/issue/AIDEV-214/research-and-finalize-the-mvp-technical-design)**
   Validate the architecture and refine the remaining ticket scopes.
2. **[AIDEV-215 — Define configurable workflow and stage handoff contracts](https://linear.app/geltagentictrading/issue/AIDEV-215/define-configurable-workflow-and-stage-handoff-contracts)**
   Establish the [versioned configuration, immutable handoff, and workflow contracts](aidev-215-workflow-contracts.md) every later component will implement.
3. **[AIDEV-222 — Provision an isolated Git worktree for each ticket](https://linear.app/geltagentictrading/issue/AIDEV-222/provision-an-isolated-git-worktree-for-each-ticket)**
   Make workspace isolation a foundational invariant.
4. **[AIDEV-223 — Run agent sessions in a restricted sandbox](https://linear.app/geltagentictrading/issue/AIDEV-223/run-agent-sessions-in-a-restricted-sandbox)**
   Enforce the runtime boundary around the ticket worktree.
5. **[AIDEV-216 — Build the Pi-based orchestration control plane](https://linear.app/geltagentictrading/issue/AIDEV-216/build-the-pi-based-orchestration-control-plane)**
   Implement the session responsible for workflow control.
6. **[AIDEV-224 — Integrate single-ticket intake and workflow state tracking](https://linear.app/geltagentictrading/issue/AIDEV-224/integrate-single-ticket-intake-and-workflow-state-tracking)**
   Give the orchestrator a single unit of work and durable stage state.
7. **[AIDEV-217 — Integrate Herdr sessions using one tab per Pi session](https://linear.app/geltagentictrading/issue/AIDEV-217)**
   Surface all five isolated Pi sessions in separate tabs with exactly one root pane each, no splits, authoritative RPC/session tracking, and manual steering.
8. **[AIDEV-218 — Build the Plan phase Pi session](https://linear.app/geltagentictrading/issue/AIDEV-218)**
   Produce the implementation plan consumed by delivery.
9. **[AIDEV-219 — Build the Implement phase Pi session](https://linear.app/geltagentictrading/issue/AIDEV-219)**
   Apply the plan inside the isolated ticket workspace.
10. **[AIDEV-220 — Build the Review phase Pi session and feedback loop](https://linear.app/geltagentictrading/issue/AIDEV-220)**
    Add an independent quality gate and remediation path.
11. **[AIDEV-221 — Build the Test phase Pi session and feedback loop](https://linear.app/geltagentictrading/issue/AIDEV-221)**
    Add executable validation and remediation behavior.
12. **[AIDEV-225 — Automate branch, commit, push, and pull-request creation](https://linear.app/geltagentictrading/issue/AIDEV-225/automate-branch-commit-push-and-pull-request-creation)**
    Turn a successful workflow into a reviewable delivery artifact.
13. **[AIDEV-226 — Automate PR approval while enforcing human-only merge](https://linear.app/geltagentictrading/issue/AIDEV-226/automate-pr-approval-while-enforcing-human-only-merge)**
    Complete automation at the explicit human merge boundary.
14. **[AIDEV-227 — Validate the end-to-end MVP workflow](https://linear.app/geltagentictrading/issue/AIDEV-227/validate-the-end-to-end-mvp-workflow)**
    Demonstrate the complete ticket-to-approved-PR outcome.
15. **Close [AIDEV-213](https://linear.app/geltagentictrading/issue/AIDEV-213/mvp-deliver-one-ticket-to-an-approved-merge-ready-pr)** after end-to-end validation succeeds.

## Parallel execution waves

If capacity permits parallel work, the same blocker graph supports these waves:

| Wave | Tickets | Exit condition |
|---|---|---|
| 1 | AIDEV-214 | Architecture research is complete. |
| 2 | AIDEV-215 | Workflow and handoff contracts are defined. |
| 3 | AIDEV-216, AIDEV-218, AIDEV-219, AIDEV-222 | Orchestration, initial phase sessions, and worktree foundations exist. |
| 4 | AIDEV-220, AIDEV-221, AIDEV-223, AIDEV-224 | Feedback stages, sandboxing, and workflow state are implemented. |
| 5 | AIDEV-217, AIDEV-225 | Worker-session launch and PR creation are integrated. |
| 6 | AIDEV-226 | Automated approval and the human-only merge boundary are enforced. |
| 7 | AIDEV-227 | The end-to-end MVP is validated. |
| Close | AIDEV-213 | The MVP epic is complete. |

Parallel work must still use separate worktrees and sandboxes. A ticket starts only after all of its blockers are complete. A lifecycle phase is always a top-level Pi session; it may use subagents internally, but a subagent never substitutes for the phase session.

## Blocker map

| Ticket | Blocked by |
|---|---|
| AIDEV-214 | — |
| AIDEV-215 | AIDEV-214 |
| AIDEV-216 | AIDEV-215 |
| AIDEV-217 | AIDEV-216, AIDEV-223 |
| AIDEV-218 | AIDEV-215 |
| AIDEV-219 | AIDEV-215 |
| AIDEV-220 | AIDEV-216, AIDEV-219 |
| AIDEV-221 | AIDEV-216, AIDEV-219 |
| AIDEV-222 | AIDEV-215 |
| AIDEV-223 | AIDEV-222 |
| AIDEV-224 | AIDEV-216 |
| AIDEV-225 | AIDEV-222, AIDEV-223, AIDEV-224 |
| AIDEV-226 | AIDEV-220, AIDEV-221, AIDEV-225 |
| AIDEV-227 | AIDEV-217, AIDEV-218, AIDEV-226 |
| AIDEV-213 | AIDEV-227 |

## Working rule

Research may refine titles, descriptions, acceptance criteria, and dependencies. Any change to the Linear blocker graph should be reflected in this document in the same change.
