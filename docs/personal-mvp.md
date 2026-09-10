# Squire Personal MVP — One Ticket End to End

- **Status:** Approved
- **Owner:** Zachary Krausman
- **Implementation ticket:** [AIDEV-255](https://linear.app/geltagentictrading/issue/AIDEV-255/deliver-one-personal-ticket-end-to-end-with-squire-run)
- **Approved:** 2026-09-10
- **Supersedes for the first usable release:** the prior six-ticket hardening path through AIDEV-254, AIDEV-239, AIDEV-251, AIDEV-224, AIDEV-253, and AIDEV-225

## 1. Product goal

The first usable Squire is a single-user local tool that takes one explicitly selected Linear ticket through Plan → Implement → independent Review → Test → Retro and opens one pull request for the owner to merge.

The intended interface is:

```bash
squire run AIDEV-123
```

The command either prints the resulting pull-request URL or stops with a clear, locally persisted error. It never merges.

## 2. Scope rule

Work belongs in this MVP only when it is required for one reliable ticket-to-PR run. Hardening, abstraction, UI, recovery, or platform work that does not directly unblock that run is deferred until an observed end-to-end failure justifies it.

Squire is initially personal software:

- one human owner;
- one trusted local controller;
- one active controller per run;
- owner-controlled repositories;
- one Docker Sandbox per ticket;
- same-ticket phase processes share the sandbox trust boundary.

Docker Sandbox is the host-security boundary. Squire will not build another container/runtime security platform inside it.

## 3. Workflow

The trusted deterministic TypeScript controller performs this sequence:

1. Read local configuration and fetch one explicit Linear issue.
2. Create one Docker Sandbox and one deterministic feature branch.
3. Launch a separate top-level Plan Pi process.
4. Launch a separate top-level Implement Pi process.
5. Launch a separate top-level Review Pi process.
6. If Review requests remediation, return its findings to Implement, then rerun Review.
7. Launch a separate top-level Test Pi process.
8. If Test requests remediation, return its failures to Implement, then rerun Review and Test.
9. Require Review and Test to pass the exact current Git HEAD.
10. Launch a separate top-level, read-only Retro Pi process with a fresh session and all prior results.
11. Require Retro to pass without changing the clean, tested Git HEAD; Retro has no remediation loop.
12. Export and verify the candidate branch from the sandbox.
13. Use host-held GitHub credentials to push the deterministic branch and create or find one matching PR.
14. Publish Retro lessons and proposed follow-ups in the PR body, then persist and print the PR URL.

The first implementation supports at most one remediation cycle per Review or Test gate. Exhaustion, failed or malformed Retro output, or a dirty/stale Retro workspace stops for the owner without publication.

An AI Orchestrator is not required to sequence five known phases. Herdr may display or steer sessions, but it is optional and cannot block the first end-to-end run.

## 4. Minimal persisted state

An atomically replaced JSON document is sufficient initially:

```json
{
  "runId": "...",
  "ticketId": "AIDEV-123",
  "phase": "review",
  "status": "running",
  "sandbox": "squire-aidev-123-...",
  "repository": "owner/repository",
  "baseBranch": "main",
  "baseSha": "...",
  "branch": "squire/aidev-123-...",
  "head": "...",
  "sessions": {},
  "attempts": {},
  "prUrl": null,
  "lastError": null,
  "updatedAt": "..."
}
```

SQLite, migrations, leases, fencing tokens, operation settlement, and multi-controller coordination are deferred. On interruption, the run becomes `interrupted`; an explicit retry may resume a clearly identified phase or recreate the sandbox. Ambiguous state stops for owner intervention.

## 5. Phase contract

Each phase receives:

- run and ticket identity;
- repository/base/branch identity;
- current expected Git HEAD;
- its phase instructions;
- relevant output from the preceding phase;
- a fixed result path.

Each phase returns one small JSON result containing:

- run, phase, attempt, and session identity;
- input and output Git HEAD;
- `passed`, `remediation_required`, or `failed`;
- a summary;
- phase-specific plan, findings, test evidence, or Retro `lessons` and `followUps` string arrays.

Retro must return at least one lesson; proposed follow-ups may be empty. It receives only read-only repository tools and cannot create Linear issues, write a wiki, or change the workspace. The controller validates the result shape, identities, and Git HEAD. It does not need a recursive cryptographic artifact-authority graph for the personal MVP.

## 6. Sandbox and credentials

Protect now:

- host home and primary checkout;
- unrelated repositories and sibling sandboxes;
- host Docker and Herdr sockets;
- Linear and GitHub delivery credentials;
- the human-only merge boundary.

Controls:

- one Docker Sandbox per ticket run;
- only an empty ticket-specific host bridge;
- repository, sessions, and artifacts live inside `/ticket`;
- phase processes run non-root with explicit environment variables;
- Pi runtime/config lives outside the repository worktree and is ordinarily read-only;
- no host checkout, host home, host sockets, GitHub private key, or delivery token enters the sandbox;
- builds and tests have finite timeouts;
- corrupted runtime or ambiguous identity fails the run; the sandbox may be recreated.

Deferred threats include hostile same-ticket phases, malicious same-UID processes, PID-reuse forensics, mount/inode proofs, kernel append-only custody, cgroup journals, multiple controllers, and multi-tenant workloads.

## 7. GitHub publication

The controller:

1. copies the candidate Git bundle from the sandbox;
2. verifies the expected branch, base SHA, head SHA, and ancestry;
3. obtains a short-lived installation token from the already configured private GitHub App;
4. pushes only the deterministic feature branch;
5. finds or creates one PR for the expected head/base pair;
6. writes the phase summaries and a canonical `## Retro` section containing lesson bullets and proposed follow-ups as unchecked tasks;
7. reconciles that section without duplication when reusing an exact existing PR;
8. records the PR URL and discards the token.

Retro publication is limited to the PR body. Squire does not automatically create follow-up Linear issues or mutate a wiki.

The first MVP does not implement GitHub App onboarding, automatic approval, automatic drafting/closing compensation, or exactly-once distributed settlement. Unexpected remote state stops for the owner. No code path may call a merge endpoint.

## 8. Code disposition

Retain narrowly:

- workflow transitions and same-HEAD Review/Test/Retro gates;
- Pi RPC process/session primitives;
- essential phase result schemas;
- basic Git branch/bundle verification;
- host-side credential and human-merge boundaries.

Simplify or replace:

- `src/pi/pi-runner.ts`;
- `src/git/workspace-service.ts` and related path/identity machinery;
- `src/control/workflow-store.ts`;
- Plan input/result handling;
- transitive artifact validation.

Remove from the first runtime composition:

- `src/pi/pi-agent-directory.ts` quarantine/fencing implementation;
- `src/pi/wiki-footer.ts`;
- custom Plan filesystem tool implementations;
- `src/git/trusted-isolation.ts`;
- retained-allocation, terminal-fence, inode/mount, and authenticated-disposal machinery;
- native SQLite/VFS hardening;
- custom custody service/launcher/protocol/image work.

History is preserved. Simplification occurs on a new branch without rewriting `main`.

## 9. Implementation sequence

1. Add the executable CLI and minimal configuration/state model.
2. Add Linear issue lookup and Docker Sandbox lifecycle adapter.
3. Add five sequential Pi phase runners, with read-only Retro after Test, and one bounded remediation loop per Review/Test gate.
4. Add controller-side bundle verification, branch push, and create-or-find PR.
5. Add focused tests for the vertical slice.
6. Run one small real Linear ticket end to end.
7. Only then prioritize hardening based on observed failures.

A reasonable target is 1,500–3,000 production lines for the functional personal controller, excluding dependencies and generated lockfiles.

## 10. Acceptance

The MVP is accepted when a real invocation of `squire run <ticket>`:

- creates one isolated ticket workspace;
- completes Plan, Implement, independent Review, Test, and read-only Retro in separate Pi processes;
- handles one ordinary remediation path;
- proves Review, Test, and Retro passed the published Git HEAD;
- opens or reuses exactly one PR;
- prints its URL;
- leaves the PR unmerged for the owner;
- never exposes host delivery credentials to phase processes.

Expansion begins only after this path works reliably.