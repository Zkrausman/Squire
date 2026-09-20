# Squire Personal MVP — One Ticket End to End

- **Status:** Approved
- **Owner:** Zachary Krausman
- **Implementation ticket:** [AIDEV-255](https://linear.app/geltagentictrading/issue/AIDEV-255/deliver-one-personal-ticket-end-to-end-with-squire-run)
- **Approved:** 2026-09-10
- **Supersedes for the first usable release:** the prior six-ticket hardening path through AIDEV-254, AIDEV-239, AIDEV-251, AIDEV-224, AIDEV-253, and AIDEV-225

## Architecture diagrams

- [Current workflow model](diagrams/squire-current-workflow-model.tldraw) is the locked authoritative as-is flow delivered with AIDEV-259.
- [Confirmed white-glove Plan architecture](diagrams/squire-confirmed-whiteglove-plan-architecture.tldraw) is the locked agreed next-state design tracked by AIDEV-261 and its implementation tickets.

The current-state diagram remains distinct from the confirmed next-state plan so future architecture discussion cannot silently rewrite evidence of the shipped workflow.

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
3. Launch one deterministic Plan supervisor for the configured Requirements → Implementation Design sequence (or one legacy Plan Pi process when the selection is empty).
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
14. Publish exactly one canonical `## Knowledge` section showing the Implement disposition, summary and changed wiki paths or the no-update rationale, alongside the Retro section; then persist and print the PR URL.

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

Pi returns one reduced JSON payload containing only:

- the output Git HEAD;
- `passed`, `remediation_required`, or `failed`;
- a summary;
- phase-specific plan, changes, findings, test evidence, or Retro `lessons` and `followUps` string arrays.

The adapter treats those fields as untrusted and validates their exact shape and phase semantics. It constructs the complete persisted `PhaseResult` by adding run, phase, attempt, session, and input-HEAD identity from the trusted phase launch plus the exact validated model profile used in Pi's argv. Older full-envelope responses are accepted only as compatibility echoes: every present trusted field must exactly match the adapter-owned value, and unknown fields are rejected. The controller independently reconciles the model-supplied output HEAD with the observed Git HEAD. Pi's raw JSONL session remains unchanged as audit evidence; the adapter-attested full result is the canonical workflow state.

Retro must return at least one lesson; proposed follow-ups may be empty. Implement must also persist a closed project-wiki disposition in its details: `updated` contains unique canonical `.llm-wiki/...` paths and a concise summary, while `not_required` contains a concrete reason. The controller compares that evidence with the cumulative committed diff from the run base SHA to the Implement HEAD before allowing Review. Implement evaluates durable architecture, workflow, operational, and constraint knowledge in the target worktree only; personal/host vaults, secrets, transcripts, routine status, and unrelated material are excluded. Implement commits required wiki edits before the exact-head Review/Test/Retro gates. Any pre-existing uncommitted control-worktree wiki backlog is handled by a separate reviewed reconciliation and is never bundled into a feature PR. Retro receives only read-only repository tools and cannot create Linear issues, write a wiki, or change the workspace; selected Retro lessons can be incorporated by a later gated run. Supervised Plan adds the aggregate contract described below; other phase contracts retain these fields. It does not need a recursive cryptographic artifact-authority graph for the personal MVP.

## 6. Personal operations

`phaseTimeoutMs` is optional configuration for the Plan, Implement, Review, Test, and Retro phase processes. It must be an integer from 60,000 through 14,400,000 milliseconds (60 seconds through four hours); when omitted, each phase uses the runner default of 3,600,000 milliseconds (one hour). For legacy and non-Plan phases a timeout bounds the process command only, not sandbox quiescence. Supervised Plan uses one deadline across its children and explicit remote-exit observation, with a bounded cleanup reserve described below. Operators should inspect persisted state and workspace diagnostics before retrying.

### Deterministic supervised Plan

The Run Controller owns one private supervisor subprocess and never directly manages its Pi children. The supervisor has no model session, state port, ticket client, or publication credentials. Its host environment is a transport-only allowlist: PATH/HOME, plus the normalized Windows OS location variables LOCALAPPDATA, SYSTEMROOT, WINDIR, USERPROFILE, TEMP, and TMP required by native sbx/settingskit. Windows/libuv can additionally supply OS defaults HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, USERDOMAIN and USERNAME during spawn; those are not additions to the application allowlist. It never forwards the inherited environment, credentials, NODE_OPTIONS, or state-specific overrides; the sandbox Pi environment is separately cleared and remains unchanged. A root-owned deterministic remote guard launches each non-root Pi process, handles cancellation, and certifies observed child close. This guard is the sandbox half of the supervisor transport, not another agent.

Requirements and Implementation Design run sequentially with fresh sessions and attempt/subphase-specific inputs, homes and temporary directories. Both use the exact persisted Plan profile and the same expected HEAD. Tools are only `read,grep,find,ls`; extensions, skills, templates, themes and context-file discovery remain disabled. The supervisor independently checks clean Git state and exact HEAD before and after each child, including failure exits. Children cannot access controller IPC/state or the root-only guard control directory.

Requirements returns a closed version-1 artifact containing `inputHead`, `problem`, `acceptanceCriteria`, `nonGoals`, `assumptions`, `dependencies`, `openQuestions`, and `readiness: ready|needs_clarification`. Clarification requires nonempty questions, skips Design, and persists a failed Plan aggregate with a visible blocker before Implement.

Design consumes only the validated Requirements content/digest and returns a closed version-1 artifact containing `inputHead`, `requirementsDigest`, ordered `steps`, `affectedComponents`, `tests`, `risks`, `exactHeadEvidence` (`head`, `observations`), and a prospective `projectWiki` disposition. That disposition is `planned` with paths/summary or `not_required` with reason, never Implement's verified `updated` claim. Strings/lists and transport output are bounded; markdown, extra JSON, unknown fields and mismatched binding fail closed.

Validated artifacts are hashed with canonical SHA-256 and stored in a root-owned `/run/squire-plan-<supervisorId>/artifacts` directory, with host copies under staging `<runId>/plan/<attempt>/<supervisorId>`. The single Plan result retains `details.steps` and adds versioned `details.supervision`: supervisor identity/outcome/launch digest plus ordered child session, profile, input HEAD, effective prompt digest, artifact path/content/digest and execution outcome. Failed children have diagnostics and no fabricated artifact; a failed aggregate may contain partial evidence. The top-level session identity represents the deterministic supervisor, not a model session; its compatibility session file is an aggregate journal on success. Host validated artifacts/result survive failure, but are **not resumable checkpoints**.

Only the controller writes global state. It serializes acknowledged nested progress, rejects stale/late attempts and persists `step: plan` with `planProgress`. Status displays `Plan / Requirements` or `Plan / Implementation Design` and clarification questions. New supervised runs carry immutable `planExecution: supervised-v1`; historical records without this marker remain readable, while new supervised runs cannot substitute legacy flat results.

One `phaseTimeoutMs` deadline covers both children. Cancellation goes to the supervisor; its remote guard sends TERM and, after two seconds, KILL to its active Pi process group. Cleanup separately requests cancellation and polls for a root-owned close marker (up to ten seconds); a stopped local `sbx` client is not exit proof. Transport/check operations are bounded to thirty seconds, and the controller allows at most ninety seconds for supervisor cleanup before failing it as unobserved. This is fail-closed observation, not a universal sandbox-quiescence guarantee after crashes or forced supervisor death. Never launch Design after interruption. Plan remains one lifecycle/attempt/retry boundary, with no recovery, independently resumable children, model escalation, or generic graphs.

### Immutable prompt policy

The user-global configuration may select a closed, versioned `promptPolicy`. Omission means the host-installed built-in set `{ "version": 1, "id": "default", "plan": [] }`. Prompt selection is independent of deterministic Plan A/B model selection. Only `requirements` and `implementation-design` are recognized Plan subphase IDs. Executable selections are exactly `[]` (legacy single Pi Plan) or `["requirements", "implementation-design"]` (supervised Plan). Partial/reversed selections fail before launching a process; they are never silently reordered. The default remains empty: this change does not activate a live configuration. Live provider/host acceptance remains AIDEV-264. No executable workflow graphs are supported.

For an operator-owned external set, use an absolute host path outside the target repository:

```json
"promptPolicy": {
  "version": 1,
  "id": "white-glove",
  "root": "/home/operator/.config/squire/prompt-sets/white-glove",
  "plan": ["requirements", "implementation-design"]
}
```

That directory must contain `manifest.json`, whose ID matches the selection:

```json
{
  "version": 1,
  "id": "white-glove",
  "phases": {
    "plan": "plan.md",
    "implement": "implement.md",
    "review": "review.md",
    "test": "test.md",
    "retro": "retro.md"
  },
  "subphases": {
    "requirements": "requirements.md",
    "implementation-design": "implementation-design.md"
  }
}
```

Every phase and each selected subphase must exist. Unselected subphases may be omitted. Unknown keys, IDs, malformed manifests, traversal, symlink components, repository-owned roots/aliases, hardlinked or nonregular prompt files, and unsafe ownership or writable prompt roots/files fail closed. On POSIX, group/other write permissions are rejected. Ancestors must be host-owned (current UID or root on POSIX); shared sticky ancestors such as `/tmp` are permitted. Files are bounded to 256 KiB and must be nonempty UTF-8 without NUL. POSIX external capture uses retained directory descriptors and descriptor-relative opens (`/proc/self/fd` on Linux, `/dev/fd` where supported); unsupported external-capture filesystems fail closed rather than falling back to unpinned path reads. Built-in selection and configuration/status parsing do not impose a blanket Windows rejection. Windows custom roots use the native source-integrity boundary described below; POSIX mode bits never stand in for Windows ACL validation.

On POSIX, the initial ancestor/root identities must match the retained opened descriptors. Each file is opened relative to the pinned root, its opened identity is checked against its pre-open metadata, and its size/high-resolution modification metadata and pathname identities are checked around descriptor reads. Tests exercise pre-pin and pre-file-open replacement (including replacement-and-restore), and in-place write/truncation between partial reads. These are snapshot/byte-substitution protections, not a claim to detect all filesystem history: a transient root rename restored before verification that leaves pinned bytes unaffected is not substitution. Privileged metadata forgery and hostile same-UID controller processes remain outside the personal-host trust model.

The final policy is trusted core/output contract → captured phase text → optional selected subphase text. Core invariants have no configuration replacement slot. The runner uses Pi's `--system-prompt` and ignores project resources with `--no-approve`, `--no-context-files`, and the existing resource-disable flags; it omits the append-system-prompt option so no empty argv element is sent to the sandbox transport. Ticket text, feedback, and configured validation commands remain JSON input data, not system policy. Tools, result validation, transitions, retry budgets, timeout, credentials, and exact-head gates remain controller code, not prompt-granted authority.

Both launch modes capture raw configuration bytes and normalize environment-dependent paths once, then capture the selected manifest/prompts once per file. Immutable base64 strings and defensive deep copies avoid mutable Buffer aliases. The domain-separated combined SHA-256 covers exact captured bytes, normalized configuration, ordered selection, and the trusted core digest. New state records carry controller-authored `launchEvidence`; phase input evidence includes the combined and effective system-prompt digests without adding model-authored result fields.

Before detached spawn, the parent atomically writes `state/launch-material/<runId>.json` (mode 0600 on POSIX; a protected native DACL on Windows), bound separately to the reservation, ticket, repository/source identity, selected config pathname/digest, state directory, and launch evidence. The child must validate that material **before claiming the reservation or invoking adapters**, including direct `runReserved` calls. There is no raw-config fallback or child-environment renormalization. Original config/prompt files can change or disappear after capture without affecting either mode. Legacy states remain readable, but do not bypass mandatory detached material. The integration harness exercises real foreground CLI and detached bootstrap through both supervised Plan children and the remaining phase launch argument sets with external services stubbed; it is not live provider/host-rollout evidence. Independent normal Review, Test, and Retro gates remain required before publication.

### Windows capture boundary

Windows builds require Python and Visual Studio C++ build tools/Windows SDK already installed, with Node `^20.17.0 || >=22.9.0` (the supported package range on every platform). Windows capture CI tests exact minima 20.17.0 and 22.9.0 plus Node 24 with engine-strict installation. `npm ci` and `npm run build` build the local N-API addon at `build/Release/windows_launch.node`. An `--ignore-scripts` install still needs `npm run build`. Missing native support fails closed with an actionable error; POSIX neither builds nor loads the addon. Do not copy a compiled addon between unreviewed installations. The Windows build also emits `windows_plan_sbx.exe`, a test-only executable shim for the real supervisor-fork harness; production never references it. Its adjacent fixture-owned node-path file and script are removed with each fixture, and argv/std-handle/exit forwarding has a bounded regression.

Windows custom prompt sources support local NTFS only, checked with opened-volume filesystem information; other filesystems, remote/device paths, drive aliases and reparse components fail closed. The repository must exist so a retained canonical repository handle can anchor exclusion (including repository junction aliases). Manifest filenames remain direct ASCII root members; ADS, DOS device names, trailing dots and traversal are rejected, including unselected subphase entries. Native source capture is read-only and never repairs ACLs.

Source integrity is **not source confidentiality**: reader-only ACEs for outsiders, including inherited sandbox identities, are accepted. Do not put secrets in custom prompt sources. Owners/authors must be the current token user, SYSTEM or Administrators; TrustedInstaller is permitted only on ancestors, not the selected root or files. Outsider write/append/add-child, delete/delete-child, attributes/EA, ACL and owner-changing rights on root/files are rejected. Ancestors permit reader/traverse/child-creation rights but reject substitution authority. These permissions do not confer authorship on readers or access to private persisted capture/log/staging.

The first successful handle-relative native open establishes each Windows source identity; owner/DACL, regular-file, reparse and link-count validation apply to that same handle before consuming bytes. No separate pathname precheck becomes a trust anchor. All directory handles and captured file handles remain retained across manifest parsing and selected-file reads. Source root/files deny write/delete sharing, ancestors deny delete sharing; ACL and file identity/size/high-resolution metadata checks run through final lease close. Files remain bounded to 256 KiB, with UTF-8/NUL/empty checks and filename deduplication in TypeScript. Errors release the lease and all handles. Tests cover unsafe pre-open substitutions, blocked pinned replacement/restore and write/truncation, ACL mutation between reads, and an actual writable mapping retained after its originating file handle closes: capture rejects before bytes, and the mapping remains writable afterward. This is concrete NTFS mapping coverage, not a universal filesystem-history/revocation guarantee. Trusted-author edits before first open are not historical tampering detection; hostile same-user/privileged processes remain outside the trust model.

Windows material, detached logs, and new phase-input byte containers are created with a protected DACL from inception: current token user, SYSTEM, and Administrators only, with validated ownership. An extra read principal—including inherited `CodexSandboxUsers`—is not implicitly trusted. Unsafe existing objects are rejected, never silently repaired. The operator must choose a fresh dedicated destination beneath safe ancestors; changing modes or broad root ACLs is not a remedy. Existing configuration, credentials, state-store semantics, and sandbox bridge destinations are not migrated by this boundary.

The native helper uses retained directory handles, `NtCreateFile` handle-relative opens with reparse rejection, native owner/DACL inspection, regular-file/link-count checks, and file handles denying write/delete sharing. Full ancestor ownership and mutation permissions are checked, not just the final pathname. Ancestor read/traverse or child-creation rights alone do not grant access to protected child bytes; untrusted delete/delete-child, write-attributes/EA, ACL and owner-changing rights fail closed. The exact Windows TrustedInstaller service SID is permitted **only for ancestor owner/write authority**, never as a protected-child reader/owner. No-delete-sharing is supplemental, not the sole reparse/identity proof. Local fixed-drive paths are supported; UNC/device/reparse paths and unrecognized ACL forms fail closed. Hostile same-user and privileged processes remain outside the personal-host threat model.

Material publication flushes a protected temporary file then renames by retained parent handle, without overwriting an existing envelope. Reads validate the same opened handle throughout, then retain all envelope binding, digest, repository-exclusion and pre-claim checks. Log descriptors are transferred through Node's libuv descriptor table rather than reopened by path. Legacy phase inputs and supervised Plan input/guard files use the same protected creation and are removed on success/failure; rejected pre-existing files are not deleted. Supervised Plan validated artifacts and aggregate journals are also natively protected, retaining the existing non-resumable evidence lifecycle. This is not a claim of confidentiality for all pre-existing state/config/auth/bridge files, nor of sandbox quiescence after a host process exits.

`windows-launch-capture` CI builds the addon and runs bounded real Windows ACL/reparse/hardlink/replacement tests plus actual foreground/detached CLI bootstrap with controlled service/model stubs. Its version matrix does not fail fast, so one failure cannot cancel evidence for the other supported versions. Test ACL probes invoke Windows PowerShell by its explicit SystemRoot system path and import only its system Utility/Security modules, not inherited executable/module search paths: a parent `pwsh` can otherwise make Windows PowerShell 5 load incompatible PowerShell 7 modules. This test-harness isolation does not change production transport environment policy. It checks all six captured calls (Requirements, Design, Implement, Review, Test, Retro), prompts/digests, protected logs/staging, cleanup and fail-closed pre-claim behavior. These tests do not fund model calls or activate a live sandbox. Linux full CI retains the POSIX prompt race/launch checks; repository CI and independent review remain required before publication.

## 7. Sandbox and credentials

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

## 8. GitHub publication

The controller:

1. copies the candidate Git bundle from the sandbox;
2. verifies the expected branch, base SHA, head SHA, and ancestry;
3. obtains a short-lived installation token from the already configured private GitHub App;
4. pushes only the deterministic feature branch;
5. finds or creates one PR for the expected head/base pair;
6. writes the phase summaries, exactly one canonical `## Knowledge` section containing the Implement wiki disposition and changed paths or no-update rationale, and a canonical `## Retro` section containing lesson bullets and proposed follow-ups as unchecked tasks;
7. reconciles that section without duplication when reusing an exact existing PR;
8. records the PR URL and discards the token.

Retro publication is limited to the PR body. Squire does not automatically create follow-up Linear issues or mutate a wiki during Retro; this does not prohibit an Implement change to the committed project wiki.

The first MVP does not implement GitHub App onboarding, automatic approval, automatic drafting/closing compensation, or exactly-once distributed settlement. Unexpected remote state stops for the owner. No code path may call a merge endpoint.

## 9. Code disposition

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

## 10. Implementation sequence

1. Add the executable CLI and minimal configuration/state model.
2. Add Linear issue lookup and Docker Sandbox lifecycle adapter.
3. Add five sequential Pi phase runners, with read-only Retro after Test, and one bounded remediation loop per Review/Test gate.
4. Add controller-side bundle verification, branch push, and create-or-find PR.
5. Add focused tests for the vertical slice.
6. Run one small real Linear ticket end to end.
7. Only then prioritize hardening based on observed failures.

A reasonable target is 1,500–3,000 production lines for the functional personal controller, excluding dependencies and generated lockfiles.

## 11. Acceptance

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
## Report-only handoff correction

The existing personal JSON config accepts this dedicated policy (omission uses the shown default):

```json
"reportCorrectionPolicy": {
  "maxAttempts": 1,
  "allowedErrorClasses": ["implement-unexpected-details-fields"]
}
```

Both fields are required when the policy is supplied. `maxAttempts` is an integer 0–2; 0 disables calls. An empty class list also disables correction. Unknown fields/classes and nonfinite/fractional bounds are rejected before model work. Raw and effective policy are captured and compared at detached launch and bound to immutable run state. AIDEV-294 will migrate this policy into repo-owned configuration separately; this feature does not implement that system.

Only Implement reports containing valid required facts plus unexpected `details` fields are initially eligible. For example, `details.verification` is rejected by strict validation, preserved verbatim, and can be removed **by a report-only model response**, never silently by the controller. The correction must preserve HEAD, status, summary, changes, wiki disposition and any supplied trusted identity echoes. All original facts and the net original-ticket-base-to-candidate wiki diff must validate first. Failed status, missing/contradictory wiki, forged run/phase/attempt/profile/session/head, dirty/changed candidates, invalid Git identity, execution/auth/security/ownership errors and other phases fail closed. Malformed original JSON has no independent structured-facts protocol yet and is not eligible; malformed correction output may consume only the remaining allowance after original facts were preserved.

Each actual Implement attempt (including staged or remediation attempts) gets a distinct allowance. A correction launch is durably charged **before** dispatch; charges are never refunded, borrowed, or reset by model escalation or Review/Test. All preparation, execution and correction share the original monotonic phase deadline and cancellation signal. There is no extra elapsed-time grant or authoritative per-call token/cost ceiling in this runtime. No token/cost claim in a report creates such a ceiling or independent acceptance evidence.

Correction uses a fresh no-tools, no-session Pi context, with extensions, skills, templates and project context disabled. It runs outside `/ticket/workspace` with only a separate auth copy, exact schema/diagnostics and controller-bound report context. It never invokes implementation again. Before/after independent HEAD and cleanliness checks, including after a failed/cancelled correction, guard candidate identity. A corrected report only rejoins the normal independent Review, Test, Retro and exact-head publication gates.

Evidence is stored under the host staging root's `report-evidence/`, not model-writable workspace artifacts. Original response, each correction response and controller observations have distinct exclusive-create references. The append-only state ledger binds timestamps, original/correction producer, attempt, candidate, validation diagnostics, byte length, SHA-256 and filesystem identity. The controller independently exact-reads **every** artifact, checks content against the actual captured response or its own observation, and repeats verification before continuation/acceptance. Metadata-only evidence is rejected. Initial file evidence support uses Linux `/proc/self/fd` pinned directories, no-follow bounded regular-file reads and before/after identity checks. On non-Linux hosts safe report correction is unavailable and invalid reports fail closed; valid ordinary reports remain supported. Do not substitute POSIX modes for Windows ACL/reparse guarantees. Hostile privileged/same-UID controller processes are outside the personal-host trust model.

`squire status` shows correction maximum/used/remaining and lifecycle independently of remediation/escalation. The ledger remains authoritative if bounded events are pruned. Exhaustion, unavailable safe evidence, mismatches or cancellation produce one terminal human escalation with primary schema failure and evidence references. Inspect the preserved artifacts and candidate independently; do not promote the candidate or reset the run. Secondary Git inspection failures retain sanitized operation/source diagnostics separately; this feature does not establish a root cause for the owner-reported `invalid Git SHA`. Exact-owner cleanup remains unchanged, including a separate cleanup-failure field and no retained-lock takeover. Historical failed runs are immutable.

`test/personal-report-correction.test.ts` uses synthetic reports and offline fake ports; it does not recover or authenticate the owner-reported incident artifacts. No original incident run ID/candidate SHA was supplied. The separately described failed delivery finding motivates independent content reads, not adoption or repair of its candidate. Live model acceptance requires separate scoped approval.

## Read-only live-owner status

`status <run-id>` and `status <ticket-id>` do not acquire or wait on the
`ticket-operations` mutation mutex. They open existing local evidence with
read/query rights only: no directory creation, lock-byte changes, release,
recovery, state writes, model calls, Git, Linear, Docker, or App access. A
successful running result includes `Reservation: verified live owner
(read-only observation)`. This is a point-in-time observation, not a lease or
permission to mutate the run.

The authoritative combination is:

* exactly one readable running state for the ticket (even with an exact-run
  selector), matching the reservation's exact run ID;
* a versioned `owner-observations/<ticket>.owner` record bound to ticket/run,
  a random fencing generation, the reservation's file identity and the owner
  record's own file identity;
* an exact live process creation identity, **not** PID existence. Windows uses
  volume/file index/creation identity on local fixed NTFS and a retained
  `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)` reference,
  creation time and nonblocking exit checks. Linux retains the `/proc/<pid>`
  directory and checks boot ID, process start ticks and non-zombie state;
* when present, a ticket-operation marker with matching file identity,
  process identity, ticket and owner fencing evidence. The marker's original
  handle remains owned by the mutator; observation never closes or duplicates
  it. Observer-owned file/process references are closed after revalidation.

The owner publishes evidence inside the existing reserve/claim boundaries.
Before detached handoff the live parent is a `reserver`; the child publishes a
fresh `controller` generation while claiming the started state. Evidence role
and persisted launch state must agree. Incomplete publication, an interrupted
handoff, a legacy live reservation lacking this evidence, or an unsupported
observation platform is ambiguity, never a PID-only fallback. These diagnostic
records **do not authorize** reservation acquisition, release, or stranded-lock
recovery; the original mutation ownership and serialization checks remain in
force. The reservation pathname lasts for the run; the separate operation
handle lasts only for its serialized operation, not the controller lifetime.

Reads retain file references, verify exact process liveness, and re-open paths
to check identity and bytes before returning. Ownership observations also
bracket state selection. Same-content replacement, missing/empty/malformed or
unreadable evidence, contradictory operation markers, competing running states,
process exit/PID reuse, and release/handoff races fail closed. Diagnostics use
bounded reasons (`unreadable`, `inconsistent`, `owner-not-live`) and recommend
retrying observation or inspecting controller diagnostics, **not** stealing,
releasing, or repairing the reservation. A PID or readable state alone is not
sufficient evidence for recovery.

Terminal history needs no live process when ownership is absent. An exact
historical record can also be read beside a verified active replacement for
that same ticket; ticket status selects that replacement. An orphan reservation
or a terminal run retaining its own reservation is still ambiguous. Lightweight
embedded state ports without the optional observation API retain state-only
lookup; status never substitutes their mutation-authorizing `reservationOwner`
method for observation.

### Native validation boundary

`personal-windows-status.test` starts a separate fixture-owned controller using
production reserve/claim, holds its original ticket-operation handle at a
lifecycle barrier, pins the exact reservation file, and runs both installed CLI
selectors in separate processes. Fresh IPC challenges prove the owner stays
responsive after each query; snapshots prove unchanged state/evidence and a
competing reserve remains excluded. Normal shutdown is awaited through actual
child-process close before fixture removal. The fixture also covers background
handoff and stranded evidence after exact owner exit. Deterministic observation
tests cover replacement and inconsistent evidence; an incompatible Windows
reader proves unreadable evidence cannot be bypassed.

These fixtures are included explicitly in the existing `windows-launch-capture`
Node 20.17.0, 22.9.0 and 24 matrix. Linux executes the portable multiprocess and
negative checks but cannot establish native Windows handle behavior. The
App-authored PR's **exact-head** Windows jobs and existing
`filesystem-event-integration` gates must complete successfully before merge;
no native gate may be skipped, weakened, or declared passing from Linux-only
results. This feature does not authorize intervention in any unrelated live or
stranded run.
