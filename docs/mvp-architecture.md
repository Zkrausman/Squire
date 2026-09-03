# Squire MVP Architecture

- **Status:** Accepted technical design candidate
- **Owner ticket:** AIDEV-214
- **Last updated:** 2026-09-01

## 1. Decision summary

Squire is a trusted TypeScript control plane that takes one Linear ticket through Plan → Implement → Review → Test and leaves an approved, merge-ready GitHub pull request for a human to merge.

The MVP uses:

- one trusted host controller with a durable SQLite workflow ledger;
- one persistent Docker Sandboxes microVM per ticket run;
- one ticket-private Git repository and linked worktree inside that microVM;
- five independent top-level Pi sessions: Orchestrator, Plan, Implement, Review, and Test, each with an explicit provider/model/thinking profile;
- one run-scoped Pi agent directory beneath `/ticket/runtime/<runId>/pi-agent`, shared by those processes but never by the target repository or host home;
- one Herdr workspace per ticket with one tab and exactly one root pane per Pi session;
- Pi RPC plus persisted Pi JSONL and explicit result envelopes as the authoritative session seam;
- a controller-mediated Git bundle export for trusted branch publication;
- separate Squire Delivery and Squire Reviewer GitHub App identities; and
- GitHub rules that deny both Squire identities merge, bypass, and protected-base update authority.

Docker Sandboxes was selected over ordinary containers because it provides a hypervisor-backed ticket boundary, a private persistent filesystem, and a private Docker daemon while still supporting normal developer tooling. The supporting POC is documented in [Docker Sandboxes viability spike](docker-sandboxes-viability-spike.md).

## 2. Fixed product boundary

Each workflow run accepts exactly one ticket. Success means:

1. a ticket-specific branch and workspace were created;
2. Plan, Implement, Review, and Test completed through independent Pi sessions;
3. review and test gates passed at the recorded head commit;
4. the branch was published and a pull request was opened;
5. the pull request received an eligible approval from the separate Reviewer identity; and
6. the pull request remains unmerged for a human decision.

Squire never performs the final merge.

## 3. System topology

```text
Trusted host
├── Squire controller (Node.js/TypeScript)
│   ├── SQLite workflow ledger
│   ├── Linear adapter
│   ├── Delivery GitHub App adapter
│   ├── Reviewer GitHub App adapter
│   ├── Docker Sandboxes adapter
│   ├── Pi RPC/session registry
│   └── Git bundle verifier/publisher
├── Herdr server
│   └── Ticket workspace
│       ├── Orchestrator tab ── squire-runner ─┐
│       ├── Plan tab ───────── squire-runner ─┤
│       ├── Implement tab ──── squire-runner ─┤ sbx exec/RPC
│       ├── Review tab ─────── squire-runner ─┤
│       └── Test tab ───────── squire-runner ─┘
└── Docker Sandboxes daemon
    └── Ticket microVM
        ├── private filesystem and Docker Engine
        └── /ticket
            ├── git/repo.git
            ├── workspace
            ├── sessions/{orchestrator,plan,implement,review,test}
            ├── artifacts
            └── evidence
```

The controller is trusted infrastructure, but it is not the Pi orchestrator. The Orchestrator is one of the five independent Pi sessions and decides requested workflow transitions. The controller performs validated mechanics, persistence, and privileged integrations.

## 4. Component responsibilities

### 4.1 Trusted controller

The controller is one Node.js/TypeScript process for the MVP. It owns:

- one-active-run locking for each ticket;
- immutable run identity and monotonic workflow state;
- Docker Sandbox creation, startup, stop, recovery, and removal;
- ticket-private Git initialization and trusted artifact export;
- Herdr workspace, tab, and runner lifecycle;
- Pi RPC routing and exact session-path registration;
- validation of result envelopes and requested transitions;
- retry budgets, cancellation, and timeout enforcement;
- Linear reconciliation;
- GitHub branch publication, PR creation, review, and rule preflight; and
- credentials that must not be exposed to phase sessions.

The controller does not make product-level pass/fail decisions in place of the Orchestrator, Review, or Test sessions. It rejects malformed or forbidden actions and executes valid decisions idempotently.

### 4.2 Pi Orchestrator session

The Orchestrator is an independent top-level Pi process. It:

- receives the normalized ticket and workflow configuration;
- requests the next allowed phase;
- reads validated phase results, artifacts, and relevant Pi session history;
- evaluates Review and Test feedback;
- directs remediation back to the existing Implement session;
- requests repeat Review/Test gates after remediation; and
- requests publication only after the required gates pass at the same head SHA.

The controller transports and validates information. The Orchestrator owns workflow reasoning.

### 4.3 Pi profiles and run-scoped agent configuration

The workflow configuration keeps five independently overridable profiles plus a separate `pi.wiki` background profile. Defaults are Orchestrator/Plan `openai-codex` + `gpt-5.6-sol` + `high`, Implement `openai-codex` + `gpt-5.6-luna` + `max`, Review `openai-codex` + `gpt-5.6-sol` + `medium`, Test `openai-codex` + `gpt-5.6-terra` + `high`, and wiki background `openai-codex` + `gpt-5.6-luna` + `high`. The closed Pi thinking enum is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; every launch passes `--provider`, `--model`, and `--thinking`, and the RPC `get_state` handshake must echo all three effective values.

Runtime selection resolves the Pi executable and pi-llm-wiki once, persists their exact identities (and trusted local roots), and never performs an in-run install/update/latest lookup. Published runtime-resolution v1 observations may omit additive model-capability records for legacy compatibility; preparation requires authoritative exact provider/model reasoning-capability evidence at its boundary and never infers it from a model name. Preparation consumes that persisted observation and the normalized wiki profile to atomically materialize `/ticket/runtime/<runId>/pi-agent/settings.json`, a binding manifest, and the controller-owned footer extension. The manifest also binds the exact resolved wiki entrypoint/package tree digests. Independent controllers serialize the materialization with a private bounded lock, atomic staging, stale dead-owner recovery, and winner verification; identical requests converge while conflicts fail closed. Cleanup atomically captures lock, reclaim-marker, staging, and failed-creation directories, revalidates their identity/token, and records authenticated run/source/type/identity metadata for verified captures under the runtime root's private `.pi-agent-quarantine-retained/<runId>` namespace because Node cannot bind recursive deletion to an inode. The ledger is strictly bounded to 32 captures per run and 256 globally; a process-independent retained-allocation mutex makes both checks atomic across concurrent controllers. Stale fences carry authenticated metadata and are reconciled with bounded owner/identity checks. Every materialize/verify operation first acquires a durable preparation lease in persisted workflow state and holds it through final no-fence verification; terminal-fence acquisition atomically rejects active preparation leases. Teardown first acquires a durable workflow terminal fence, publishes a matching authenticated filesystem fence outside the removable sandbox, independently re-proves absence of every process allocation/live or termination-failed role and preparation lease immediately before and immediately after each destructive disposal boundary, and moves identity-checked retained objects into a private disposal namespace before recursive removal. A noncooperative same-UID role makes quiescence false and teardown refuses; the permanent fence then rejects new role/controller work, including after restart. Interrupted authenticated publications are resumed or safely discarded only by fenced teardown. Active replacements remain untouched and fail closed. The settings point to the exact local wiki root, set `llm-wiki.taskModel` to Luna/high, and record `modelThinkingLevels`; an explicitly supplied ticket-scoped auth file is the only credential that may be copied. Restart preparation is idempotent only for matching digests; partial, symlinked, cross-run, or tampered directories fail closed. Pi's private `auth.json` and `models-store.json` runtime files are allowed only at their fixed names, with empty unprovisioned auth and private parseable cache validation.

Every role launch exports `PI_CODING_AGENT_DIR`, run-scoped `HOME` and `WIKI_HOME`, and `PI_SKIP_VERSION_CHECK=1`, keeps `/ticket/workspace` as cwd, disables repository resource discovery, and explicitly loads pi-llm-wiki followed by the same trusted footer bytes. In sandboxed Herdr TUI tabs, that trusted extension installs `ctx.ui.setFooter` and reads `footerData.getExtensionStatuses()`; routine `llm-wiki`/`llm-wiki-model` entries render as `🧠 <count-or-dash> · <provider>/<model>` without replacing the normal model/thinking/state/token/context/cost layout. The footer replaces only the pinned healthy `<wiki_status>` block with the same compact marker. Evolved or warning/error/blocked/diagnostic blocks are retained in full, and extension warnings, RPC `extension_error`/warning/error records, stderr, and protocol failures are not intercepted or abbreviated. A conflicting target-repository wiki model setting is rejected rather than written over. Integrity and project-override checks run again in the fenced pre-spawn stage for every role, rather than trusting a completed first-role preparation.

### 4.4 Phase sessions

Plan, Implement, Review, and Test are separate Pi processes with separate JSONL histories and result artifacts.

- **Plan** converts the ticket and repository context into an actionable plan.
- **Implement** changes only the ticket workspace and records the resulting head SHA.
- **Review** independently returns pass or actionable findings for that head SHA.
- **Test** executes configured checks and returns pass or failures with evidence for that head SHA.

A phase may use subagents internally. A subagent never represents a lifecycle phase.

### 4.5 Squire runner and Herdr

Each Herdr tab contains exactly one unavoidable root pane and one `squire-runner`. No pane splits or multi-pane layouts are created.

The runner:

- invokes the assigned Pi process inside the ticket microVM through `sbx exec`;
- owns that Pi process's RPC stdin/stdout;
- renders bounded status and output in the tab;
- forwards operator prompts to the same Pi session;
- reports lifecycle events to the controller; and
- restarts Pi from its exact JSONL path when instructed.

Herdr is the human observation and steering surface. Terminal scraping is never workflow truth. Pi RPC events, persisted JSONL, validated result envelopes, Git state, and the SQLite ledger are authoritative.

On Windows, runner commands carrying Linux paths must set:

```text
MSYS_NO_PATHCONV=1
MSYS2_ARG_CONV_EXCL=*
```

### 4.6 Docker Sandbox

The isolation unit is one Docker Sandboxes microVM per ticket, not one microVM per phase. All five sessions intentionally share the active ticket workspace and ticket-local artifacts.

The sandbox is created from a versioned, digest-pinned Squire template with configurable CPU, memory, and disk limits. Docker Sandboxes v0.39.0 requires its primary workspace mount to be read/write, so the sandbox receives only a dedicated, ticket-specific, read-write but otherwise empty controller-created host bridge. It contains no repository, credentials, home data, or unrelated host state. Repository content is never supplied through Docker Sandboxes direct workspace mode or stock clone mode.

Inside the microVM, trusted setup creates:

```text
/ticket/git/repo.git       ticket-private bare repository
/ticket/workspace          one linked worktree and feature branch
/ticket/sessions           separate Pi session directories
/ticket/artifacts          plans, results, findings, bundles
/ticket/evidence           validation evidence and audit summaries
```

The microVM has its own Docker Engine. Builds and tests therefore cannot control or pollute the host Docker daemon.

## 5. Git workspace and delivery boundary

### 5.1 Import and branch creation

A trusted setup operation:

1. resolves and records repository, base branch, and base SHA;
2. creates `/ticket/git/repo.git`;
3. creates exactly one linked worktree at `/ticket/workspace`;
4. creates deterministic branch `squire/<ticket-id>-<run-id>` from the recorded base SHA; and
5. verifies that Git common-dir and worktree paths canonicalize beneath `/ticket`.

Agents never receive the primary host checkout, its `.git` metadata, sibling worktrees, or a repository parent directory.

### 5.2 Export and publication

After Review and Test pass for the same head SHA:

1. the trusted controller requests an immutable Git bundle under `/ticket/artifacts`;
2. controller-side `sbx cp` exports the bundle to trusted staging storage;
3. the controller verifies bundle integrity, branch name, base SHA, head SHA, and expected commit ancestry;
4. the Delivery GitHub App obtains a short-lived installation token;
5. the controller publishes only the recorded feature branch and creates or updates one PR; and
6. the token is discarded.

The agent does not receive the host checkout or long-lived delivery credentials. The POC proved Git bundle creation, controller export, disposable clone, expected content, and strict `git fsck` verification.

## 6. Workflow and state model

The durable workflow is monotonic and idempotent. The minimum states are:

```text
accepted
→ preparing
→ planning
→ implementing
→ reviewing
→ testing
→ publishing
→ awaiting_approval
→ approved
```

Terminal alternatives are `failed`, `cancelled`, and `expired`.

Allowed remediation transitions are:

```text
reviewing --remediation_required--> implementing → reviewing → testing
testing   --remediation_required--> implementing → reviewing → testing
```

A failed Test always requires a fresh Review and Test because remediation changes the head SHA. Retry and timeout values are configuration, with finite fail-closed defaults. Exhaustion moves the run to `failed` and preserves the sandbox and evidence for operator inspection.

Before every side effect, the controller re-reads local and remote state. Unique constraints and deterministic names prevent duplicate active runs, branches, sessions, and PRs.

## 7. Explicit handoff contract

The complete v1 schemas and semantic rules are defined in [AIDEV-215 Workflow and Handoff Contracts](aidev-215-workflow-contracts.md). The production handoff is an authoritative immutable artifact plus a short trigger prompt:

1. the controller creates and validates a complete phase-input artifact;
2. it records the artifact path and exact-byte SHA-256 with run, phase, attempt, target session, and head bindings;
3. Pi RPC sends only a short trigger referencing that artifact;
4. the phase verifies and reads it, then writes immutable result and evidence artifacts; and
5. the controller validates all bindings, paths, digests, evidence, Git state, and semantics before the Orchestrator consumes the result.

Every phase result binds schema version, handoff and input artifact, run, phase, actual session, input/output head, status, artifacts, evidence, findings, failures, and requested transition. Unknown versions, wrong identities, stale SHAs, missing evidence, contradictory pass results, digest mismatches, and illegal transitions fail closed.

Pi JSONL is session persistence, not the handoff protocol. Herdr terminal text and manual prompts are presentation and audited steering, not workflow truth. Scope-changing intervention creates a new immutable handoff and incremented attempt; it never mutates the accepted input or advances state from chat text.

## 8. Persistence and recovery

SQLite is the MVP workflow ledger. AIDEV-216 owns the transition engine, session orchestration, and persistence interface; AIDEV-224 owns single-ticket intake plus the concrete SQLite schema, migrations, adapter, and startup reconciliation. This preserves the blocker order without duplicating component ownership.

The ledger uses transactional updates and records at least:

- run ID and Linear issue UUID/identifier;
- repository, base branch, base SHA, feature branch, and current head SHA;
- sandbox name and lifecycle state;
- Herdr workspace, tab, pane, and runner identifiers;
- all five Pi session IDs and exact JSONL paths;
- current workflow state and phase attempts;
- result-envelope and evidence paths;
- exported bundle digest;
- PR number, URL, and observed current-head approval state; and
- last error and timestamps.

If a runner or Pi process fails, the controller terminates the failed process and relaunches Pi from the exact recorded session path. It does not attempt to reconnect orphaned RPC pipes.

If the controller restarts, it reconciles SQLite, Docker Sandboxes, Herdr, Linear, Git, and GitHub before performing another side effect. Existing matching resources are adopted; conflicting resources fail closed for operator review.

## 9. Isolation and threat model

### 9.1 Required protection

The MVP protects:

- the host checkout and host home;
- sibling ticket sandboxes and worktrees;
- unrelated repositories and ambient host state;
- the host Docker daemon;
- trusted controller state and delivery credentials; and
- the protected base branch and human merge boundary.

### 9.2 Trust boundaries

- The host controller, Herdr server, and Squire runners are trusted infrastructure.
- Ticket code, phase sessions, subagents, build scripts, and nested containers are untrusted within the ticket microVM.
- Sessions within one ticket share a trust boundary and workspace intentionally.
- Docker Sandboxes supplies the hypervisor boundary between ticket workloads and the host.
- Nested Docker provides build/runtime separation inside the ticket but is not a second host-security boundary.

### 9.3 Required controls

- one uniquely named sandbox per run;
- no host checkout, home, Docker socket, Herdr socket, or sibling mount;
- no shared cross-sandbox skill store;
- no host-local MCP servers unless explicitly approved;
- a dedicated ticket-specific, read-write but otherwise empty host bridge containing no repository, credentials, home data, or unrelated host state;
- bridge contents treated as untrusted, never used for repository work or trusted artifact publication, and deleted during ticket cleanup;
- repository and all Git metadata, sessions, and artifacts beneath `/ticket`;
- resource limits and deterministic cleanup;
- only ticket-scoped model credentials when proxy-managed credentials are incompatible; and
- GitHub/Linear delivery credentials retained by the trusted controller.

Normal outbound TCP access is allowed in the MVP. A model gateway and deny-by-default network policy are optional hardening because the agreed MVP threat model focuses on ticket filesystem isolation. Network activity remains logged by Docker Sandboxes.

### 9.4 Explicitly deferred threats

The MVP does not claim protection from:

- a hypervisor escape;
- intentional exfiltration of ticket code through permitted model/network access;
- compromise of a trusted controller or human administrator;
- malicious changes to organization policy by authorized administrators; or
- multi-tenant hostile workloads requiring a separate physical trust domain.

## 10. GitHub identities and human-only merge

Two GitHub App identities are required:

| Identity | Purpose | Required capability | Prohibited capability |
|---|---|---|---|
| Squire Delivery | Publish feature branch and create/update PR | Contents write on allowed feature refs; Pull requests write | Merge, bypass, protected-base update, Administration, Workflows write |
| Squire Reviewer | Submit the automated review after Squire gates pass | Pull requests review write; repository read | Contents write, merge, bypass, protected-base update |

Separate identities are required because a PR author cannot satisfy its own required approval.

Server-side GitHub rules must:

- require a PR for the protected base;
- require the configured review and checks;
- dismiss stale approvals or require approval after the latest reviewable push;
- exclude both Squire Apps from bypass;
- prevent both Squire Apps from updating the protected base; and
- reserve merge/base-update eligibility for the configured human users or team.

A deployment preflight must prove that feature publication and PR creation succeed while direct base update, merge, bypass, and rule modification fail under Squire credentials. Application code merely omitting a merge call is insufficient.

## 11. Configuration boundary

The versioned configuration schema is defined in [AIDEV-215 Workflow and Handoff Contracts](aidev-215-workflow-contracts.md). The architecture requires configuration for:

- Linear team, allowed states, and state mappings;
- GitHub repository, base branch, App installations, and required rules/checks;
- sandbox template digest, resources, retention, and network policy;
- Pi provider/model, role instructions, and phase timeouts; runtime installation versions are observed and recorded once per run rather than repository-wide exact pins;
- validation commands;
- remediation attempt limits;
- artifact/evidence retention; and
- human escalation targets.

Repository-specific instructions and commands belong in validated configuration, not hard-coded controller branches.

## 12. Technology and packaging

- **Controller:** TypeScript on supported Node.js LTS.
- **Persistence:** SQLite with migrations and WAL mode for the single-worker MVP.
- **Linear:** official TypeScript SDK.
- **GitHub:** Octokit App/REST clients.
- **Sandbox:** Docker Sandboxes `sbx`, pinned to a validated release and template digest.
- **Agent runtime:** selected installation resolved once per run; exact observed Pi and pi-llm-wiki versions/installation identities are recorded and reused by all five sessions without an in-run upgrade or repository-wide exact-version requirement.
- **Operator surface:** pinned compatible Herdr preview/stable release and protocol.

The controller is packaged as one service/CLI for the MVP. The sandbox template, controller, schema, and Pi/Herdr compatibility versions are released together.

## 13. Observability and operator control

The operator can:

- view all five sessions in separate Herdr tabs;
- focus a tab and prompt or interrupt that exact Pi session;
- distinguish working, idle, blocked, failed, and done states;
- inspect phase artifacts and evidence; and
- cancel or retry through controller commands.

Manual prompts become part of the same persisted Pi history. The controller records an audit event but does not discard or hide operator intervention.

## 14. POC evidence

AIDEV-214 demonstrated:

- Docker Sandboxes `v0.39.0` on Windows Hypervisor Platform;
- isolation from host checkout, host home, sibling paths, and host Docker;
- persistent `/ticket` storage and an internal Git clone;
- a private Docker Engine that built and ran a representative image;
- Pi `0.84.4` RPC model execution and exact-session resume;
- five concurrent independent Pi sessions;
- a Herdr tab attached to in-sandbox Pi with manual prompt and working/done observation; and
- a committed branch exported as a Git bundle, copied by the controller, cloned, and verified with strict `git fsck`.

See [Docker Sandboxes viability spike](docker-sandboxes-viability-spike.md) for commands, evidence identifiers, caveats, and retained artifact paths. An independent top-level Pi Review session returned PASS; see [AIDEV-214 Independent Architecture Review](aidev-214-architecture-review.md).

## 15. Downstream delivery plan

| Ticket | Architecture responsibility |
|---|---|
| AIDEV-215 | Versioned configuration and handoff/result schemas |
| AIDEV-216 | Transition engine, runner, Pi RPC registry, validation, persistence interface |
| AIDEV-217 | Five-tab Herdr lifecycle and manual steering |
| AIDEV-218 | Plan session contract and implementation |
| AIDEV-219 | Implement session contract and implementation |
| AIDEV-220 | Independent Review gate and remediation loop |
| AIDEV-221 | Test gate, evidence, and remediation loop |
| AIDEV-222 | Ticket-private bare repository, worktree, branch, and bundle |
| AIDEV-223 | Docker Sandboxes template, isolation checks, private Docker |
| AIDEV-224 | One-ticket intake, concrete SQLite ledger/migrations, reconciliation |
| AIDEV-225 | Bundle verification, Delivery App branch publication, PR creation |
| AIDEV-226 | Reviewer App approval and enforced human-only merge preflight |
| AIDEV-227 | End-to-end acceptance and adversarial boundary validation |

## 16. Exit decision

The architecture is ready to proceed to AIDEV-215. Docker Sandboxes is the selected MVP runtime. Remaining credential brokering, GitHub deployment policy, runner implementation, and operational hardening are assigned to downstream tickets and do not reopen the fixed topology unless implementation evidence disproves an assumption documented here.
