# Squire trust and privacy boundaries

Research snapshot: 6 October 2026. Source baseline: main at [28b14ab7f346ec42304a2fa3076b584b1a18d07f](https://github.com/Zkrausman/Squire/commit/28b14ab7f346ec42304a2fa3076b584b1a18d07f), including merged PR #104. Proposed design, not an implemented security feature or a reproduced vulnerability report.

## Recommendation

Keep Squire a local-first factory for one owner's trusted repositories. Make four boundaries explicit and testable: which process receives which environment, which text can influence authority, which files become retained artifacts, and which fields may leave the machine. The first useful changes are small helpers around existing adapters and export paths, not a new security service.

The most consequential current limitation is already documented: isolated clones protect the owner's checkout from normal candidate edits, but do not isolate same-user processes or credentials. Configured checks run through the host process supervisor. Removing five credential variables is useful, but does not establish that tests cannot access other environment values, home-directory files or the controller's state. Keep arbitrary hostile repositories and candidate code outside the supported trust claim until a separately authorized execution boundary actually contains them. [Architecture trust limit](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/ARCHITECTURE.md#L128-L139), [verification runner](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/verification.mjs#L7-L21), [environment construction](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/process.mjs#L80-L87).

Research for this memo inspected public source and the existing recovery, acceptance, preflight, skill and operator designs. It launched no local Squire process, model/provider task, benchmark, capability probe or exploit case, and retrieved no credentials or private project contents. Existing tests below are source evidence, not fresh test results; ordinary hosted controller CI for this documentation change is separate. All identified risks are code-derived concerns or explicit architectural limits; none is claimed as a reproduced exploit. Publication of this design would not authorize implementation or lift the existing execution hold.

## Scope and trust assumptions

Protect the owner's source and private files, authentication material, local controller state, candidate identity, retained evidence and authorized publication destination. Cover accidental disclosure, misleading repository/tool text, candidate-authored code crossing into more privileged execution, and corrupt or misleading artifact references.

Assume the owner, admitted project policy, installed controller/adapters, configured tool binaries and OS administration are trusted. Treat repository contents, generated files, test output, agent prose and remote response text as data whose authority is bounded by that policy. Repository ownership alone does not make every comment, dependency or generated test trustworthy. A compromised administrator or arbitrary malicious process already running as the owner is outside this local design's containment guarantee.

The owner-facing orchestrator remains the decision interface. It must not turn a worker suggestion into a command, change a permission because a check failed, or bypass Squire's existing delivery gates. [Orchestrator boundary](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/ORCHESTRATOR-BOUNDARY.md).

## Dataflow and authority boundaries

```text
Owner / authorized orchestrator
        | approved project policy, destinations and bounded actions
        v
Local CLI (OS/file access) / token-authenticated loopback API
        |
        v
Trusted controller + SQLite + configured adapters
  |            |                  |                    |
  | job        | configured       | exact candidate    | private state/events
  | context    | setup/check argv | publication        | and artifact refs
  v            v                  v                    v
Runtime CLI    Host supervisor    Git / GitHub         Owner projection
  |            |                  delivery             [proposed safe export]
  |            v                  |                    |
  |         Candidate code        |                    v
  |         and dependencies      |                 Approved owner sink
  |            |                  v
  |            |               Admitted repository/branch + PR metadata
  v            |
Plan / implementation / fresh-review job
  ^            |
  |            v
Repository text + candidate diff + bounded diagnostic data
  |                              |
  +-- outputs / logs / files -----+--> Private local evidence
                                      |
                                      +--> diagnostic projection [proposed]
                                           back to a repair job

External boundary: runtime/provider receives admitted job context;
                   GitHub receives admitted source and publication metadata.
Local authority boundary: controller policy versus job-controlled data.
Local containment limit: host checks share the owner's OS account;
                         a directory or content hash is not isolation.
Target credential boundary [proposed]: auth stays in its trusted integration,
                                      never job text or general exports.
```

The diagram combines current routes with explicitly marked proposed controls. Today, bounded failed-check tails reach repair context without the proposed diagnostic projection, and five named environment variables are stripped rather than a complete credential-separation profile being enforced.

The current runtime requests ephemeral sessions, clean user configuration, workspace-write implementation and read-only planning/review. These are adapter launch settings; actual filesystem/network isolation needs the preflight design's same-boundary evidence. The diagram does not claim a separate OS identity for each box. [Runtime launch](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/runtime-codex.mjs#L61-L99).

## Existing defenses and their limits

| Surface | Implemented defense | Boundary it does not establish |
| --- | --- | --- |
| Admission | Strict config keys, repository/source matching, configured command arrays, default protected policy paths and guarded project-config identity. [Config](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/contracts.mjs#L90-L145), [store](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/store.mjs#L143-L151) | A syntactically valid owner-configured command can execute repository-controlled code. Protected paths are not a comprehensive secret-file policy. |
| Process launch | Direct argv spawning, resolved Node/npm entrypoints, deadlines, bounded output, supervisor lifeline and private-mode log/request creation. [Process helper](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/process.mjs#L10-L18), [supervision](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/process.mjs#L50-L113) | Shell-free spawning does not make npm scripts, an explicitly configured shell or other executable code harmless. File modes do not separate processes running as the same user or prove effective Windows ACLs. |
| Credentials and runtime | Runtime/checks clear five known API/GitHub credential variables. Runtime forces subscription login; jobs ignore unrelated user configuration. [Runtime](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/runtime-codex.mjs#L8-L9), [configuration](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/runtime-codex.mjs#L29-L42) | The supervisor inherits the rest of its environment. These controls neither inventory all possible secrets nor prove auth files are unreachable by child tools. |
| Candidates | Managed-root realpath check, pre-agent HEAD check, protected/owned-path gates, submodule-change rejection, exact head/tree/cleanliness checks and fresh review. [Workspace](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/workspace.mjs#L74-L103), [review](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/controller.mjs#L374-L405) | Root containment and lexical ownership do not resolve every candidate link. Exact source identity proves which bytes were checked, not that they contain no private data or that host execution is safe. |
| Public context | Only the explicitly approved inline goal can opt in to cross-role public-contract propagation, pinned by exact digest and byte bound. [Contract](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/contracts.mjs#L77-L88), [dispatch](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/controller.mjs#L211-L222) | This is not a classification of every ticket, prompt, source file, log or PR field as public. |
| Local control | Loopback binding, exact Host check, Origin rejection, bearer token comparison, bounded requests and no unrestricted command route. [API](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/api.mjs#L12-L78) | The token identifies an authorized local client, not distinct multiuser roles. `publicState` removes config but retains other state; it is not safe-publication sanitization. |
| Delivery | Stable publication identity, expected-head merge, required check name/app/head selection and merge tree/ancestry validation. [Delivery](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/delivery.mjs#L72-L148) | Correct remote identity does not determine whether every changed file or description field was appropriate to disclose there. |

Existing fixtures cover literal shell metacharacters, fake-runtime credential removal/role flags, protected directory replacement, source aliases and local API authentication. Preserve them, but do not relabel fake-CLI tests as real sandbox evidence. [Process fixtures](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/test/process.test.mjs), [runtime fixtures](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/test/runtime.test.mjs#L65-L107), [workspace fixtures](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/test/workspace.test.mjs#L9-L23), [API fixtures](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/test/api.test.mjs).

## Bounded threats worth addressing

1. **Candidate code inherits host reach.** `VerificationRunner` launches configured setup/checks through `runProcess`, which merges the inherited environment with five null overrides. A check can load candidate-controlled test/build code even when its argv was owner-approved. The concern is accidental disclosure or host/state mutation by that code; no such action was attempted here. An allowlisted environment reduces ambient exposure, but stronger protection against malicious code requires an actual isolated runner. Treat the existing local route as trusted-owner-code execution.

2. **Diagnostic text crosses back into job instructions.** Failed-check tails and review findings become `repairReason`; the implementation prompt serializes that object after a request to repair the failures. Fresh review is instructed to read applicable repository guidance and inspect the complete candidate diff, so it may encounter overlapping untrusted material. A fresh session avoids conversation reuse, but does not establish that the reviewed text is trustworthy. Preserve the useful observations while clearly separating their provenance from commands and authorization. Schema-valid text can still contain misleading instructions. [Failure tail](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/verification.mjs#L10-L15), [repair context](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/controller.mjs#L283-L290), [job prompts](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/controller.mjs#L353-L395).

3. **Retained bytes have further disclosure paths.** Raw stdout/stderr are written before any disclosure filter; bounded error tails flow into stored blockers and repair prompts. Runtime prompt/result files are retained locally. GitHub publication copies the ticket ID/title into the PR title and description/acceptance into its body. A file allowed by ownership can still accidentally contain private content; checkpoint uses `git add -A`. These are specific disclosure paths, not evidence that a secret was present. [Capture](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/process.mjs#L93-L109), [runtime retention](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/runtime-codex.mjs#L90-L119), [PR payload](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/delivery.mjs#L84-L87).

4. **Path or receipt integrity is mistaken for trust.** Workspace containment checks the workspace root; there is no general candidate-artifact collector with link-safe traversal in the current source. The process reader follows stdout/stderr paths from its local receipt. Corrupt/stale references or a future generic collector could read an unintended file. Under the trusted single-user assumption this primarily calls for defensive validation; it does not prove an externally exploitable path. Candidate-controlled files must not supply authoritative receipt locations. Hashes alone cannot authenticate a producer sharing the same writable state. [Receipt read](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/process.mjs#L75-L77).

5. **A local view is reused as an external payload.** API snapshots include ticket specs, blocker details and filesystem references after config is removed. Future notifications or dashboards could disclose them if they serialize the whole object. Use the operator memo's explicit export boundary before adding a sink; no live external sink is inferred from the API. [State projection](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/src/api.mjs#L8-L10), [operator disclosure design](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/research/factory-operator-workflow.md#security-and-disclosure-boundary).

## Allowed destinations

This is a proposed default disclosure policy, not evidence of an implemented network allowlist. Admission must identify the actual approved destinations; the table does not authorize a transfer.

| Data | Permitted destination within admitted work | Excluded by default |
| --- | --- | --- |
| Approved goal, ticket and necessary project source | Private managed workspace/evidence and the selected runtime/provider context for that task | Unrelated providers, repositories, web services or notification payloads |
| Explicitly pinned public contract | The admitted roles under the existing propagation contract | Additional attachments, private files, new permissions or changed goal bytes |
| Candidate code and declared generated artifacts | Private project evidence; the exact admitted delivery repository/branch when shipping is authorized | Home-directory harvests, unrelated workspaces, implicit cloud uploads |
| Raw process logs, prompts and results | Restricted local evidence under its retention policy | Automatic PR bodies, chat messages, dashboards or other agents' context |
| Approved check diagnostics | Bounded, destination-reviewed repair/review context; safe reason/reference in owner status | Unfiltered logs, private grader text, credentials and unrelated source |
| Runtime/provider authentication | The trusted runtime's existing authentication mechanism and corresponding provider | Test environment, model prompts, argv, receipts, candidate files or public exports |
| Git/GitHub authentication | Trusted delivery integration for the admitted repository | Worker/check environment or job text |
| Control token | Authorized local control client to loopback API | Agent prompts, command logs, remote URLs or external status |
| Owner status and decisions | Authenticated local view; optional explicitly approved owner destination using allowlisted fields | Whole `publicState`, raw events, absolute paths or arbitrary worker-supplied links |
| Unrelated owner data and private evaluator material | Outside ordinary job inputs; a separately authorized owner/evaluator boundary only | Repository context, worker/reviewer inputs, logs or skill feedback by implication |

“Private to the project” is different from “never leaves this machine”: the admitted runtime may send source/context to its provider. Conversely, authorizing that provider is not permission to publish the same material on GitHub. The existing public-contract opt-in does not replace either destination decision.

For the first publication guard, use explicit admitted export fields and excluded path classes, plus the exact changed-file inventory already produced at checkpoint. Known credential/config outputs and fixture-private paths can be rejected deterministically. Unclassified or suspicious content requires the scoped disclosure decision; do not add a classifier that automatically declares arbitrary source secret-free. Changing published metadata must preserve its approved meaning, rather than silently replacing it with a generated summary.

## Untrusted text must not become authority

Keep controller-authored policy and executable actions separate from repository instructions, command output, agent results and review explanations. Repository-local guidance can explain conventions within the admitted scope; it cannot grant broader ownership, change the configured checks, select a new remote, expose credentials or authorize shipping.

For repair/review context, use a bounded data section with producer/check ID, candidate identity, source class and the actual diagnostic. Mark the contents as observations rather than instructions. Preserve quoted source faithfully when needed for review; do not silently rewrite candidate code to remove suspicious text. Do not evaluate command strings, paths or URLs found in these sections. Controller actions continue to resolve fixed action types to trusted code and current policy. Text framing is an aid to interpretation, not an enforcement mechanism.

OWASP identifies repository comments and tool results as indirect prompt-injection channels and recommends enforcing permissions outside model reasoning. That pattern motivates these Squire-specific controls; it is not evidence of a Squire exploit or a reason to add another judging model. [OWASP prompt injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).

Retain direct argv spawning. Explicit shell commands and package scripts remain executable authority approved through configuration, never through a failing log's suggested fix. Node documents environment inheritance and shell behavior separately, matching the distinction in Squire's helper. [Node child-process documentation](https://nodejs.org/docs/latest-v24.x/api/child_process.html#child_processspawncommand-args-options).

## Artifact and path integrity

Extend the recovery work's collector/reader rather than add a second manifest:

- Resolve controller-issued artifact handles to an operation/job-owned root. Never accept an arbitrary worker absolute path or URL as an authoritative artifact.
- Bound file count, individual/aggregate bytes, traversal depth and time. Inspect each selected entry and its ancestors; for the first generic collector, reject symlinks, junctions/reparse points and special files rather than following them. Git source can retain an authorized link as a link; that does not authorize dereferencing its target during collection.
- Treat hard-link aliases and mutable shared files explicitly. Copy allowed bytes into new receiver-owned files, do not preserve incoming links, and record unsupported identity checks honestly. Path checks cannot prove provenance of data deliberately copied into an allowed file.
- Settle the registered writer before collection and use platform-appropriate no-follow/open-handle checks where available. Revalidate identity around copying; a single earlier realpath check is insufficient against concurrent replacement. Do not claim malicious same-user race resistance without a boundary that excludes that writer.
- Compute digests from the retained bytes and atomically publish the manifest proposed by R3. Bind candidate/job/producer/retention identity using R3/A2 fields. Verify the expected process receipt/log filenames under the registered operation directory instead of trusting stored absolute paths alone.
- Keep controller state, token and original evidence outside candidate writable roots. Validate effective state-root ownership/access through the P-series boundary contract; a requested mode on creation is not proof for an existing directory or another platform.

A hash detects changed bytes only relative to a trusted expected value. It does not prove an honest observation, safe contents or safe publication. Producer authority and allowed destination stay separate. Preserve unresolved/failed evidence under R3's retention policy; do not add automatic deletion as a security shortcut. [Recovery retention](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/research/factory-recovery.md#artifact-retention-and-cleanup), [acceptance reference rules](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/research/factory-acceptance.md#rules-enforced-by-the-resolver).

## Redaction and environment boundaries

1. **Prevent avoidable capture.** Do not put credentials in argv, prompts, configured check text or receipt payloads. The current request file stores supplied environment overrides, not a full environment dump; keep that distinction. A future environment helper should pass sensitive values only through the necessary trusted integration without serializing them into request records.
2. **Use explicit process profiles.** Separate runtime authentication, delivery authentication and setup/check environments. Begin with one supported verifier profile that permits the required nonsecret tool/platform variables and task-owned temp paths. Pin resolved tool identity and carefully handle executable-search and loader/config variables. Missing required variables become a configuration blocker, not a fallback to the entire parent environment. HOME/config isolation must be compatible with the selected toolchain and recorded honestly; an environment allowlist alone does not prevent filesystem credential access.
3. **Keep raw evidence private.** Logs may contain proprietary source or accidental secrets. Private storage is a containment measure, not sanitization. Do not bulk-scan owner credential stores or copy their contents into a redactor. Suspected sensitive output blocks the affected export/context transfer and records a safe reason plus private reference; remediation follows the owner's authorized incident path.
4. **Project before sharing.** Build repair diagnostics and owner exports from destination-specific allowlists. Safe owner fields are project/ticket alias, state, reason code, bounded safe summary, scoped action and verified authorized evidence reference. Exclude unknown nested fields, raw tails and local paths by default. Text length limits are not privacy filters. A string inside an otherwise approved field still requires its field-specific content rule; when uncertain, fall back to a fixed reason code rather than forward it.
5. **Preserve provenance.** A redacted derivative gets its own digest and a reference to its restricted source. Never overwrite the original receipt or imply that omitted bytes were verified. Redaction must not convert a failed/unknown check to success or drop a decisive diagnostic without reporting the omission. A detector can catch expected secret shapes; it cannot guarantee arbitrary text is safe.

OWASP's logging guidance supports excluding credentials and higher-sensitivity data, treating paths specially, limiting access and sanitizing at display/export boundaries. Here that supports small local projections rather than centralized log infrastructure. [OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude).

## Proposed regression scenarios

All scenarios below are unexecuted. Use inert synthetic markers, fake adapters and test-owned roots only. Never probe real credential files, contact a provider, publish a test secret or execute an exploit to validate this memo.

| Scenario | Required outcome |
| --- | --- |
| Candidate comment or test output asks to alter ownership, skip review or send data elsewhere | Preserved as untrusted data where relevant; controller policy, destination and action set unchanged. Deterministic tests establish containment of authority, not model immunity. |
| Check argv contains literal shell metacharacters | Existing no-shell behavior preserved. No log text becomes a newly launched command. |
| Parent environment contains a harmless sentinel outside the verifier allowlist | Sentinel absent from the constructed verifier environment; required allowed variables remain. Fixture inspects only its own synthetic environment. |
| Required profile input missing; caller requests broad inheritance as fallback | Explicit blocker; no automatic permission expansion. Runtime/delivery profiles do not leak into verification. |
| Secret-shaped marker in stdout, nested error detail, ticket title or review finding | Raw local evidence stays restricted; external projection omits marker. Repair context uses only its approved diagnostic policy; publication payload is blocked or uses a separately approved safe field. |
| Correct candidate SHA but a fixture-excluded private path is staged | Identity gates do not declare disclosure safe. The configured destination/path policy rejects it; no publication occurs. |
| Artifact path traverses outward, points to a symlink/junction, or names a special file | Collector rejects before dereferencing. The fixture target is owned test data, never an owner-private path. |
| Selected file changes between inspection and copy; a hard-link alias is supplied | Stable-copy validation fails or reports unsupported. No silent complete manifest; original work retained. |
| Receipt supplies an out-of-root log path, wrong job ID or altered digest | Reader blocks or marks corrupt/incomplete; no arbitrary read and no reclassification as successful evidence. |
| Read-only fresh reviewer sees the same malicious-looking diff as implementation | Session separation remains enforced; text cannot grant a different tool/profile or override deterministic acceptance gates. |
| Status contains absolute paths, raw errors, unknown nested fields or an unverified link | Local view remains private; owner export includes only safe fields and verified destination-appropriate references. |
| Redaction/export fails or removes needed diagnostic facts | Export blocked/incomplete is visible; original failure and evidence identity preserved; no broader scan, upload or automatic rerun. |
| Legacy project lacks the new privacy/profile declaration | Reports the legacy trusted-owner scope. No silent security upgrade or expanded data destination. |

An actual sandbox integration check is a later, separately authorized P2 activity. Fake subprocess/serialization fixtures can prove environment construction and export behavior; they cannot prove that a real runtime, candidate or OS account cannot reach secrets.

## Minimal implementation sequence

| Slice | Narrow change | Dependencies and exit condition |
| --- | --- | --- |
| T0 Document the boundary | Publish this dataflow, destination policy, evidence labels and trusted-owner limitation; identify actual existing egress in admission documentation. | Documentation only. Preserve current baseline history and execution hold. |
| T1 Separate process environments and diagnostic authority | One shared process-profile constructor, starting with verifier/setup; one bounded repair-diagnostic projection and explicit untrusted-data framing. Retain existing runtime/delivery auth behavior until their compatibility is reviewed. | Reuse P0/P1 profile/fingerprint fields. Synthetic environment/serialization fixtures prove no broad-inheritance fallback or command promotion. This does not create OS isolation. |
| T2 Constrain artifact readers and collectors | Validate operation-owned receipt/log handles and add link-aware bounded copying inside R3. | R1 registered writer identity, R3 retention, A2 references and P-series path boundary. Wrong-path/link/mutation fixtures produce explicit incomplete outcomes. No new evidence schema or store. |
| T3 Guard actual disclosure paths | Destination-specific owner and repair exports; validate GitHub PR metadata and candidate disclosure policy before publication. Reuse the same safe projection for O4 when a sink is authorized. | T0 policy; R3 derivative identity; O1/O2 status and existing delivery gates. Synthetic private markers cannot reach external payloads. Do not require a new sink to close the slice. |

T1 and the pure export portion of T3 can be independently reviewed before all recovery changes land; T2 follows the artifact owner. Keep each change small, version any new opt-in contract, and leave existing strict version-1 validation and historical evidence intact. Implement no generic scanner service, credential broker, SIEM, hosted dashboard, optimizer guard model or new agent role.

Ownership remains with the companion designs: [recovery](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/research/factory-recovery.md) owns lifecycle/retention; [acceptance](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/research/factory-acceptance.md) owns evidence admissibility; [preflight](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/research/factory-runtime-preflight.md) owns actual execution-boundary claims; [skill improvement](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/research/factory-skill-improvement.md) owns private-feedback/promotion policy; [operator workflow](https://github.com/Zkrausman/Squire/blob/28b14ab7f346ec42304a2fa3076b584b1a18d07f/docs/research/factory-operator-workflow.md) owns decisions and notification delivery. This memo supplies shared trust and disclosure constraints, not parallel versions of those systems.

## Decisions before implementation

- Choose one supported host/toolchain for the initial verifier environment profile, including the minimum nonsecret variables and any tool-specific HOME/config needs.
- Decide which admitted ticket fields are allowed in provider context and GitHub metadata. Keep project-private and public disclosure distinct.
- Choose the first collector's platform-specific no-follow/link policy and document unsupported cases; reuse P2 validation rather than promise universal behavior.
- Define the safe diagnostic fields needed for useful repairs, along with the exact blocked-export behavior when they cannot be safely produced.

Stop at reviewed design during the research window. Later fixture success should establish these named boundaries only. It cannot establish security against hostile same-user code, absence of every secret, immunity to prompt injection or effectiveness on a new benchmark.
