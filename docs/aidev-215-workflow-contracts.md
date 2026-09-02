# AIDEV-215 Workflow and Handoff Contracts

- **Status:** Accepted contract design
- **Contract version:** 1
- **JSON Schema dialect:** 2020-12
- **Last updated:** 2026-09-01

## 1. Scope and authority

This contract set defines the generic boundary that downstream Squire components implement. It does not implement the controller, Pi lifecycle phases, persistence, or delivery integrations.

Workflow truth, in descending authority, is:

1. the trusted controller's ledger and independently observed Git/GitHub state;
2. immutable, digest-bound, schema- and semantic-validated contract artifacts;
3. Pi JSONL for session persistence and audit; and
4. Herdr output and prompts for presentation and audited steering only.

Terminal text and conversational claims never advance workflow state. Unknown contract versions are unsupported and fail closed; a consumer must select a schema by an explicit allowlist, never by accepting the nearest known version.

## 2. Version 1 schemas

Schemas live under [`contracts/v1/`](../contracts/v1/) and use closed objects unless an extension point is explicitly defined.

| Schema | Purpose |
|---|---|
| `workflow-config` | Ticket/repository/base, Linear IDs, sandbox template/resources/network/retention, per-role Pi provider/model/timeouts, validation commands, remediation limits, artifact retention, and GitHub identities/checks/rules |
| `normalized-ticket` | One immutable, normalized Linear issue and resolved repository/base/feature-branch identity |
| `phase-input` | Complete immutable input for one phase attempt, bound to run, phase, target session, attempt, and input head |
| `phase-trigger` | Small Pi RPC trigger containing identity bindings and a path/SHA-256/schema reference to the phase input |
| `phase-result` | Required result envelope for Plan, Implement, Review, or Test |
| `implementation-plan` | Ordered implementation steps, risks, assumptions, acceptance criteria, and configured validation IDs |
| `review-findings` | Independent review decision and actionable findings for one head |
| `test-evidence` | Per-command timestamps, exit status, timeout state, immutable stdout/stderr references, and failures |
| `transition-request` | Orchestrator request bound to run, orchestrator session, current state, current head, and validated phase result when applicable |
| `pull-request-delivery-state` | Current-head PR, checks, Reviewer approval, mergeability, and human-only merge state |
| `runtime-resolution` | Exact observed Pi and pi-llm-wiki versions, Pi executable, and installation identities resolved once for one run |
| `common` | IDs, SHAs, artifact references, evidence, findings, failures, phases, and states |

`schemaVersion` is an integer discriminator and is `1` in every v1 top-level artifact. Schema IDs are stable `urn:squire:contracts:v1:<name>` values. Schema changes that alter accepted meaning require `v2`; additive prose clarification or stricter implementation tests may remain v1 only when existing valid artifacts retain the same meaning.

## 3. Configuration boundary

The v1 workflow configuration is repository-independent. Repository commands are argument arrays with a `/ticket` working directory; controller implementations must execute the array directly rather than through an implicit shell. The schema requires:

- one Linear ticket UUID/identifier, repository owner/name/HTTPS clone URL, base branch, and Git object format;
- Linear team UUID and accepted, in-progress, awaiting-human, completed, failed, and cancelled state UUIDs;
- a digest-pinned sandbox template, CPU/memory/disk limits, explicit network mode, and success/failure sandbox retention;
- all five Pi roles with provider, model, instructions beneath `/ticket`, and finite timeout; the optional legacy Pi version field is advisory, while the controller resolves the selected Pi and pi-llm-wiki installations once per run and records their exact observed versions and installation identities;
- named validation commands with finite timeout and required/optional status;
- finite review, test, and total remediation budgets;
- trusted export, session, and evidence retention periods; and
- distinct Delivery and Reviewer Apps, required checks, and rules requiring PRs/current-head approval while denying Squire merge, bypass, protected-base update, and auto-merge authority.

The trusted controller additionally rejects duplicate validation IDs and identical Delivery/Reviewer identities. It resolves the configured base SHA and writes it into normalized ticket input; agents cannot select or change it.

## 4. Immutable handoff protocol

For every phase attempt, the controller performs this order:

1. Reconcile the ledger and Git head, allocate a new `handoffId` and monotonically increasing phase `attempt`, and select the already registered target Pi `sessionId`.
2. Create the complete `phase-input` as a new artifact beneath `/ticket/artifacts`; never overwrite a prior handoff.
3. Validate its JSON Schema and semantic bindings, serialize it deterministically for storage, compute SHA-256 over the exact stored bytes, and record path, digest, schema ID, run ID, phase, attempt, target session ID, and input head in the ledger.
4. Send only a short `phase-trigger` through Pi RPC. The trigger repeats the identity bindings and references the input artifact by path, SHA-256, and schema ID; it does not embed the task or mutable replacement instructions.
5. Require the phase to read the referenced bytes, verify their digest and bindings, perform work, and write new schema-valid result, domain artifact, and evidence files. The `phase-result` repeats the `handoffId` and exact input-artifact reference to attest which input it consumed.
6. Recompute every referenced digest, verify canonical paths and file existence, validate structure and semantics against trusted run/session/Git context, and record accepted outputs before making them visible to the Orchestrator.
7. Give the Orchestrator only validated artifacts. The controller executes a resulting `transition-request` only after another state/head reconciliation.

Sandbox configuration paths must be canonical absolute `/ticket` paths with no `.` or `..` segments; artifact references must be canonical relative paths rooted at `artifacts/` or `evidence/`. Textual schema containment is still not proof of filesystem safety. The controller must resolve paths without following an escape, reject symlinks and non-regular files, and reject digest changes, duplicate acceptance, or references outside the run's artifact roots.

Herdr and manual Pi prompts are audited steering events, not handoffs. A prompt that only asks for status does not alter inputs. If intervention changes scope, acceptance criteria, feedback, commands, or any other phase input, the controller stops or supersedes the attempt and creates a new immutable handoff with a new `handoffId`, exactly incremented `attempt`, later creation time, artifact path, and digest while preserving run, phase, target session, and input head. The controller supplies the independently recorded old and new artifact references when validating the revision. It never edits the old artifact or treats chat history as the revised contract.

## 5. Result and evidence invariants

Every `phase-result` requires:

- contract version, `handoffId`, and exact input-artifact reference;
- run ID, phase, and actual session ID;
- input and output Git head SHA;
- `pass`, `remediation_required`, or `failed` status;
- at least one immutable artifact and one immutable evidence reference;
- explicit findings and failures arrays, including when empty;
- a requested destination and reason; and
- completion timestamp.

Plan, Review, and Test are read-only with respect to Git, so their input and output heads must match. A pass cannot contain failures or unresolved blocking findings. Remediation requires a blocking finding or failure. Test pass requires successful, non-timed-out evidence for every configured required command at the current head. A phase transition must reference the exact path, digest, and schema identity of the controller-accepted phase result. PR readiness must bind repository, base branch, feature branch, PR number, PR URL, checks, and configured Reviewer App approval to trusted context at that same head; auto-merge must be disabled.

JSON Schema validates shape. [`src/semantic-validation.mjs`](../src/semantic-validation.mjs) validates trusted-context bindings and cross-document/state invariants that JSON Schema cannot establish.

## 6. Transition graph

The only normal transitions are:

```text
accepted --run_accepted--> preparing
preparing --preparation_complete--> planning
planning --phase_pass--> implementing
implementing --phase_pass--> reviewing
reviewing --phase_pass--> testing
reviewing --remediation_required--> implementing
testing --phase_pass--> publishing
testing --remediation_required--> implementing
publishing --publication_complete--> awaiting_approval
awaiting_approval --approval_observed--> approved
```

After either remediation edge, Implement must produce a new head and the run repeats Review before Test. For every nonterminal state, `system_failure → failed`, `operator_cancel → cancelled`, and `retention_expired → expired` are also legal. Terminal states have no outgoing transitions. The phase result requests the phase-specific destination; the independent Orchestrator issues the full transition request; the controller validates and executes it.

Publication is legal only after Review and Test pass artifacts bind the current head. This is a controller precondition in addition to the graph edge.

## 7. Fail-closed validation

The controller rejects before state change or artifact consumption:

- unknown schema IDs or versions;
- wrong run, handoff, phase, attempt, target/actual session, or Orchestrator session IDs;
- stale input, output, reviewed, tested, check, approval, PR, or transition SHAs;
- missing, escaped, non-canonical, changed, or digest-mismatched artifacts/evidence and sandbox paths;
- pass results contradicted by findings, failures, timeouts, exit codes, missing required commands/checks, or stale approval;
- illegal transitions, incorrect transition triggers, skipped gates, or phase transitions that substitute a result path/digest;
- delivery state for an unexpected repository, branch, PR number, or PR URL; and
- silently edited handoffs, identity-changing revisions, non-monotonic creation, or scope-changing steering without a newly allocated attempt artifact.

A validation error is terminal for that requested action. Implementations may create a separately recorded retry only within configured budgets; they must not coerce, repair, or partially accept an invalid artifact.

## 8. Examples and executable validation

Examples are under [`fixtures/contracts/`](../fixtures/contracts/):

- `valid/` contains one valid document for every top-level v1 schema;
- `invalid/structural/` covers unknown versions, missing evidence, and sandbox path traversal; and
- `invalid/semantic/` covers wrong run/session IDs, stale SHAs, contradictory pass, digest and accepted-result substitution, wrong delivery targets, non-monotonic identity-changing handoff revision, missing command evidence, stale approval, remediation without immutable feedback, and illegal transitions.

Run:

```sh
npm install
npm run validate:contracts
npm test
```

`validate:contracts` compiles all schemas in strict JSON Schema 2020-12 mode, checks every fixture's expected structural outcome, verifies a real phase-input file SHA-256 against its short trigger, and runs semantic acceptance/rejection cases. Node's test runner independently exercises identity/head failures, immutable handoff revision, the complete transition graph, required evidence, and current-head PR readiness.

## 9. Downstream controller obligations

AIDEV-216 and later controller tickets must add durable transaction/ledger integration, filesystem-safe immutable publication, actual Git/GitHub reconciliation, idempotency, timeout/cancellation enforcement, and artifact cleanup. They must call structural validation before semantic validation and semantic validation before Orchestrator consumption or side effects. Schema validation alone is intentionally insufficient.
