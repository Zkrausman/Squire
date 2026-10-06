# Squire execution-boundary preflight and capability contracts

Research snapshot: 6 October 2026. Proposed design, not an implemented feature or a live-readiness result.

## Recommendation

Add a small, zero-model admission gate that answers: **Can this exact execution boundary perform the operations this job requires, preserve its output, and stop its owned processes?** Bind the answer to the selected executor generation, role, effective policy, prepared workspace, tools and probe version. Refuse expensive dispatch when required evidence is missing, stale, denied or contradictory.

Keep four statements separate:

1. The adapter declares a capability.
2. A trusted probe observed a limited operation on a particular boundary.
3. A job actually started and remains live, or has a terminal receipt.
4. The delivered application satisfied its acceptance criteria.

Only the second is the new preflight's claim. A passing probe does not establish model effectiveness, subscription capacity, benchmark progress or application correctness.

This memo expands [R6's execution-boundary slice](factory-recovery.md#execution-boundary-preflight). The [recovery design](factory-recovery.md) owns durable operation reconciliation, candidate journaling and terminal artifact retention. The [acceptance design](factory-acceptance.md) owns criterion-to-evidence resolution and real application/browser acceptance. Reuse their operation IDs and manifests; do not build another scheduler, evidence store or acceptance framework.

## Source baseline and research limits

Runtime source references use [ec98a61](https://github.com/Zkrausman/Squire/commit/ec98a61bd6a0fec89246c0b160ca90d2ff363d68). Publication was prepared against [bea01f4](https://github.com/Zkrausman/Squire/commit/bea01f496281e1189972011aaa7e857b53cfe1dd), which adds the companion recovery/acceptance documents and roadmap changes; the [intervening diff](https://github.com/Zkrausman/Squire/compare/ec98a61bd6a0fec89246c0b160ca90d2ff363d68...bea01f496281e1189972011aaa7e857b53cfe1dd) changes no runtime code. Source inspection establishes implemented code paths, not that they passed in a particular user's runtime. No Codex tasks, model calls, benchmarks, application launches or capability probes were performed for this research. Ordinary documentation-PR CI is separate evidence for the unchanged controller suite.

Publishing this design does not authorize implementation, capability probes, model calls, live demonstrations, new budget admissions or benchmark runs. The [v0.1 closure record](../releases/0.1/baseline-closure.json), closed-incomplete original baseline, separately unscored manual harness completion and owner hold on benchmark/comparative execution remain unchanged. Any later live demonstration or comparison requires its own authorization and the [roadmap prerequisites](../roadmap/README.md).

The design covers failure classes including foreign host paths passed into a guest, an initialized repository without a commit, different host/guest Node versions, unavailable browser startup, denied GUI shutdown and executor replacement during recovery. These motivate negative tests. They are not proof that every container, sandbox or platform behaves that way, and an error such as EPERM does not identify its cause by itself.

Runtime documentation was read on the research date. Pin the installed CLI/browser versions when implementing: documentation and sandbox implementation can change independently of Squire. In particular, do not derive a universal syscall matrix from an OS name or a historical error.

## Existing checks versus missing proof

| Area | Implemented at the source pin | Missing or weaker evidence |
| --- | --- | --- |
| Adapter contract | Runtime version, roles, fresh sessions and subscription support are checked. The declared capability object includes workspace artifacts and no resumption. [Ports](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/ports.d.ts#L1-L23), [controller](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L81-L95) | These are static declarations. There is no per-job boundary identity or observed capability contract. |
| Doctor and authentication | Doctor calls runtime and delivery preflight. Runtime checks subscription login, reads the model catalog and resolves role model/reasoning selections. Catalog querying starts no model threads/turns. [Doctor](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/bin/squire.mjs#L92-L96), [runtime](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L44-L60), [catalog](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/codex-catalog.mjs) | Login/model availability does not prove worker paths, tool execution, remaining quota or GUI support. Doctor's ready result has this narrower meaning. Metadata calls may use network even though they use no model. |
| Git workspace | Delivery preflight validates a branch and local bare target; remoteHead requires one SHA. Preparation clones/fetches, switches from a base and confines the workspace under managed state. Identity reads HEAD, tree and dirtiness. [Workspace](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/workspace.mjs#L45-L84) | These observations occur on the controller route. They do not establish guest visibility or accessibility of linked Git metadata. Missing base already blocks; the new work should classify boundary failures earlier, not claim base checks are absent. |
| Toolchain | Squire declares Node >=24.14 and <25. Preparation records the controller's OS, architecture, Node executable/version and trusted commands. The process helper resolves node and, where found, npm/npx to the controller's Node installation. [Package](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/package.json), [preparation](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L24-L64), [argv resolution](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/process.mjs#L10-L18) | This is useful host evidence, not the Node executable a worker's shell finds. The package engines declaration is not a same-boundary compatibility check. Controller and application versions need separate requirements. |
| Worker policy and temp | Jobs use clean ephemeral Codex sessions, implementation workspace-write, plan/review read-only and approval_policy=never. Implementation gets a task-owned temp directory via add-dir and TEMP/TMP/TMPDIR. [Runtime](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L61-L99) | Constructing argv and creating temp on the host do not establish effective worker access. Fake-CLI tests check flags/environment, not the real OS sandbox. [Fixtures](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/test/runtime.test.mjs) |
| Checks and GUI route | Trusted setup/checks use the controller's process helper. Windows worker instructions explicitly prohibit Electron launches and leave actual visual validation to the trusted host, preserving application sandboxing. [Verification](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/verification.mjs), [Windows constraint](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/runtime-codex.mjs#L81-L89) | There is no generic GUI launch/IPC/render/shutdown receipt or guarantee the separate host observer exists. The README explicitly says trusted checks run under the owner's OS account; do not describe that as worker isolation. [Trust limit](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/README.md#L52-L58) |
| Supervision and evidence | Shell-free commands, parent lifeline, deadlines/output limits, process-tree termination attempts and disk receipts exist. [Process helper](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/process.mjs#L44-L113) | No admission proof of cleanup/export on the selected boundary. A termination request is not an independently verified all-descendants-stopped result. Reconciliation improvements belong to the recovery slice. |
| Optional real smoke | An isolated model session executes a command and writes a verified marker. It consumes subscription usage and is excluded from offline tests. [Smoke](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/scripts/smoke-codex.mjs) | It is not zero-model readiness. Its initialized repository has no initial commit; that is a limited smoke fixture, not a delivery-base proof. Printing Node is not an asserted version requirement. |

Top-level run already preflights authentication before scheduling. However, callAgent reserves an agent call before runtime.execute repeats preflight, so a later infrastructure failure can be recorded after reservation. Put deterministic job-boundary admission before that reservation and its attempt hook; preserve conservative accounting once launch may have occurred. Do not retroactively rewrite old counters. [Ordering](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L117-L135), [reservation](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/controller.mjs#L211-L245).

## The contract: requirements, boundary and observations

Introduce a versioned, opt-in contract. These are proposed fields, not JSON accepted by the current strict version-1 configuration validator. Keep existing projects visibly legacy; do not upgrade their historical evidence by inference.

### 1. Required capabilities

The trusted project/service configuration declares:

- Role and purpose: planning, implementation, trusted setup/check, browser/native observer or artifact receiver.
- Selected executor reference and execution mode; required workspace and input handles; permitted read/write/temp/artifact roots; configured network policy reference.
- Tool identities and supported ranges for that role. Squire's controller requirement remains separate from the application's Node, embedded Electron Node, Python or other toolchain.
- Required operations, such as spawn, cancel-and-settle, local TCP round-trip, Unix socket round-trip, named pipe round-trip, browser launch/render/close or native-host feature. Avoid one undifferentiated gui=true flag.
- Artifact route, maximum bytes and receiving boundary; probe time/output limits; which capabilities are unnecessary for this profile.

Requirements come from owner-approved outcomes/checks. A planner can flag a missing requirement; it cannot silently remove visual acceptance, invent another executor or grant permissions. Before a paid planning call, verify the planning profile and declared project-wide prerequisites. Before each later role, verify its concrete prepared workspace and full requirements. Unknown future task requirements do not justify a global all-capabilities-ready claim.

### 2. Boundary identity

Compute a canonical boundary fingerprint from the adapter build, actual executor instance/generation, runtime/CLI identity, role, OS/architecture, workspace generation, effective sandbox/approval policy, configured mount/path mappings, approved roots, allowlisted nonsecret environment configuration and probe-bundle digest. Keep declared values distinct from runtime-observed values. Never capture the whole environment, credentials or authentication-file contents for fingerprinting.

Prefer opaque executor generation/boot identity supplied by the runner. If unavailable, restrict reuse to the current controller/executor session and mark that identity limitation; do not invent a stable identity from a hostname, directory string or PID. On recovery, an unavailable or changed executor invalidates reuse. Reading old receipts is allowed; launching replacement work still requires the recovery gate to settle the old operation.

Use executor-scoped path handles, for example workspace:ticket-7 plus relative path src/main.mjs, rather than passing a bare absolute host path into another machine. The consumer resolves and verifies the handle locally. Record source and destination mapping as separate facts. Docker's bind mounts are resolved on the daemon host, and a mount can hide existing destination content, illustrating why path spelling and host existence are insufficient. This is relevant when that runtime is actually used; it is not a claim that Squire currently has a Docker adapter. [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

### 3. Bounded observations and admission

Each probe produces an immutable receipt with:

- Schema/probe version, receipt ID, operation ID, requirements digest, boundary fingerprint and role.
- Start/end times and monotonic duration; observed workspace/base/tree and applicable input/tool identities.
- Probe command identity, sanitized resolved executable/argv, exit code/signal, timeout/cancel/output-limit flags and bounded error classification.
- Per-capability result: passed, failed, denied, unsupported, unknown or not_required. Include declared versus observed evidence kind and the precise operation attempted.
- Cleanup result, artifact receiver/hash result and explicitly absent/truncated fields.
- Admission decision and blocker code, with the next permitted action. Store full sensitive paths privately and use symbolic aliases in public exports.

An overall pass requires all required capabilities to pass on their assigned boundary, successful cleanup, verified required artifact receipt and current identity. A static capability declaration cannot substitute for an observation. A receipt hash detects mismatched bytes; it does not by itself prove a trusted origin. The controller-owned runner must produce/store these records outside candidate-controlled source. This is operational provenance within Squire's existing trusted single-user model, not hardware attestation or a new isolation guarantee against same-user malicious code.

## Same-boundary execution, with no model turn

```text
trusted requirements + selected executor
                 |
     reconcile old owned processes
                 |
 controller/setup prerequisites and authorized preparation
                 |
 job workspace + final policy + role-specific environment
                 |
  same-boundary deterministic probe runner
      |           |              |
    paths       tools       lifecycle/export
      +-----------+--------------+
                 |
 immutable receipt + current fingerprint check
                 |
     call reservation and frozen launch intent
                 |
          model-backed job dispatch
                 |
   verification / acceptance remain separate
```

Reuse Squire's existing supervisor and the recovery design's proposed operation registry. The adapter exposes a deterministic probe entry point that uses the same executor, user, working directory, policy and environment-construction code as the actual role. Calling node directly on the controller proves only the controller route.

For Codex, official documentation provides sandbox command helpers that execute a supplied command under Codex policies. These are the candidate zero-model mechanism, not codex exec with a prompt. At implementation time, pin/inspect the installed helper's supported arguments and demonstrate parity with the job's resolved policy, including managed requirements, writable roots, temp and user-config behavior. Current documentation exposes version-sensitive profile/config options; do not assume the helper accepts every exec flag. If exact policy reproduction is unavailable, emit boundary_probe_unsupported and block the strong readiness claim rather than use a host or less-restricted substitute. [Codex sandbox command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [sandbox testing](https://learn.chatgpt.com/docs/agent-approvals-security).

Keep model authentication/catalog checks as a separate zero-model metadata stage. They do not guarantee future capacity or successful inference. No probe installs dependencies, downloads browsers, uses npx auto-install, opens an application account, invokes an LLM, calls an external service with synthetic data or changes security settings. A package/binary missing from the approved environment is a prerequisite blocker. Network-free local probes cannot certify arbitrary outbound access.

Serial order matters: complete authorized setup before measuring its resulting toolchain/dependencies; do not scan or launch while setup is mutating the same paths. Recheck the cheap fingerprint and workspace identity immediately before reservation/launch. If the runner cannot hold a stable boundary between check and use, report that gap; a preflight cannot eliminate every runtime failure.

## Minimal probe suite

Run only the profile's required probes, using controller-owned fixtures and inert data. Suggested initial bounds are design defaults for review: core local probes together <=15 seconds, lifecycle <=10 seconds, optional GUI <=30 seconds, and <=90 seconds overall including cancellation, settlement and export. Limit diagnostic output and JSON receipts to <=64 KiB each; a bounded screenshot can have a separate <=1 MiB ceiling. Squire's current supervisor uses a fixed 16 MiB output ceiling, so the tighter probe cap requires an explicit bounded override in the probe integration, preserving existing job defaults. Timeouts remain failures/unknowns; never raise limits indefinitely until something passes.

Enforce both output and aggregate wall-clock bounds in the supervisor/probe runner, not only by truncating the final receipt. Reserve cleanup/export time from one absolute monotonic deadline; current supervisor escalation can extend 15 seconds past a command timeout and must fit inside that envelope. Deadline exhaustion with unresolved cleanup returns a blocked/unknown cleanup result and prevents replacement work.

| Probe | Exact observation and pass condition | Important limit or stop |
| --- | --- | --- |
| Workspace and inputs | Resolve consumer-local cwd/root; read a predeclared nonce/input marker and verify its digest; compare expected workspace generation and source identity. Resolve symlinks/reparse points using the existing root policy. | Same path string on two machines is no proof of shared bytes. Missing mapping or wrong marker blocks without guessing another host path. |
| Git context/base | From that boundary, use read-only Git queries to discover worktree root, Git directory/common directory, resolve HEAD^{commit}, expected base^{commit} and HEAD^{tree}; compare exact expected identities and phase-appropriate status. | A .git directory/file or successful git init is insufficient. Unborn, missing object, inaccessible metadata and wrong repository are distinct outcomes. Never create an initial commit to make the probe pass. |
| Writable paths | In each already-authorized required scratch/workspace root, exclusively create a nonce file, write/read bounded bytes, rename within the root, then remove only that file; record each operation. Exercise controller state/artifact roots from their owning boundary. | Do not test by writing arbitrary denied paths. Read-only roles get precreated read fixtures and stdout capture, without adding a writable root. Probe cleanup must leave source unchanged. |
| Toolchain | Run the exact selected executables through the role's launch route. Record Node process.execPath, process.version, selected process.versions fields, platform/arch; Git/CLI/package-manager/browser versions as needed. Validate declared ranges. | Host Node and guest Node can differ legitimately if each satisfies its assigned requirement. Version output alone does not prove native-module ABI or required feature availability. Add only a trusted minimal feature fixture when needed. |
| Process lifecycle | Launch a trusted short child; verify an intentional exit code and captured stdout/stderr. Launch a bounded owned child/descendant fixture, cancel through the normal supervisor, wait for terminal identity/stdio settlement and confirm registered descendants ended. | Signal sent, killed=true or parent exit is insufficient. Unknown child identity, denied cleanup or unsettled descendants blocks new work on that lane. Do not kill by process name or reused PID. |
| Local IPC, if needed | For each required transport separately: bind an owned endpoint, connect from the actual peer boundary, exchange a nonce, close both ends and confirm resource cleanup. TCP binds loopback only; Unix sockets/named pipes use the declared task-owned namespace. | A TCP pass does not imply Unix-socket/named-pipe support. Same-process bind is weaker than a peer round-trip. No public port, forwarding tunnel, ACL change or transport substitution after denial. |
| Browser/native lifecycle, if needed | Use the declared installed browser/native runtime, fresh task-owned profile and required display mode. Launch, render a bundled local fixture, exercise a tiny interaction, capture required pixels, export, close contexts/application and verify owned process settlement. | Headless success does not imply headed/native support. Startup, renderer/IPC, artifact capture and shutdown are separate results. No user browser profile, login, real account data or disabled sandbox. |
| Artifact return | Produce a small deterministic marker with operation/boundary nonce and digest; return via the already-authorized artifact route; receiver verifies identity, bytes and hash. Check final receipt is readable after the producing process ends. | A producer-local filename is not an export. Wrong receiver/generation, truncation, hash mismatch or missing acknowledgment blocks. Do not introduce an upload destination as a preflight side effect. |

Git documents commit verification and linked-worktree metadata separately; a valid worktree may have an unborn branch, and .git need not be a directory. Verify reachability of the Git/common directories without widening mounts. Squire's current managed SHA-1 expectation remains in force; a new probe must not silently imply SHA-256 repository support. [Git rev-parse](https://git-scm.com/docs/git-rev-parse), [Git worktree](https://git-scm.com/docs/git-worktree).

The Git probe should use shell-free argv, validate the expected full commit ID, and resolve it with rev-parse --verify --end-of-options followed by the commit-peeling expression. Discovery uses --is-inside-work-tree, --show-toplevel, --absolute-git-dir and --git-common-dir; bounded status output uses porcelain/NUL delimiters. Set GIT_OPTIONAL_LOCKS=0 for observational commands so status does not perform optional index-refresh writes, especially on a read-only role. This suppresses optional locking, not every possible helper/config side effect. The declared local-only Git profile must also prevent lazy fetch of missing promisor objects and constrain permitted helpers; do not enable network to obtain a missing base. Preserve the approved Git environment/config policy and fail unsupported if the selected version cannot enforce it. [Git background refresh](https://git-scm.com/docs/git-status#_background_refresh), [Git optional locks and lazy fetch](https://git-scm.com/docs/git).

Node documents executable/version/ABI identity and distinguishes spawn, exit, stdio close and successful signal submission. These support explicit observations, not a portable proof that all descendants vanished. Use the supported supervisor/OS identity mechanism and report unknown where it cannot establish cleanup. [Node process](https://nodejs.org/download/release/v24.14.0/docs/api/process.html), [Node child_process](https://nodejs.org/api/child_process.html).

For IPC, node:net provides TCP, Windows named pipes and Unix-domain sockets; endpoint path limits and close behavior differ. Record the transport and both endpoints' boundary identities. A successful small exchange is only transport readiness, not application protocol acceptance. [Node net](https://nodejs.org/api/net.html).

### Browser and native capabilities must remain granular

| Capability | Sufficient preflight evidence | Does not establish |
| --- | --- | --- |
| Browser executable available | Selected installed binary/package identity | Successful launch |
| Headless render | Required headless runtime renders/acts on local fixture | Headed window, display capture or native OS integration |
| Headed/native window | Intended display/session creates and captures a test window | Application workflows or correct visual design |
| Local IPC | Intended peers complete the required transport exchange | Other transports or external network access |
| Graceful close | Context/app closes, artifacts flush, owned processes end | Forced cleanup safety in every crash scenario |
| Emergency cancellation | Registered fixture settles through approved supervisor | Permission to terminate unrelated applications |

Playwright's Chromium launch option currently documents chromiumSandbox=false as its default. The proposed Chromium profile must explicitly retain Chromium sandboxing, record the effective launch configuration and reject sandbox-disabling arguments. Missing supported sandboxed launch is an unsupported capability, not permission to weaken it. BrowserType.executablePath names where a browser is expected; it is not a successful launch receipt. [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype).

Close explicit browser contexts before the owned browser so artifacts can flush. A connected browser close can disconnect rather than terminate the server; record launched-and-owned versus attached mode, and do not claim global shutdown for an attached owner browser. The first profile should use a disposable owned instance. [Playwright Browser](https://playwright.dev/docs/api/class-browser).

Electron's app.quit is an attempted graceful lifecycle and can be prevented by a handler; observing a window close is not enough. A denied shutdown operation must retain its exact phase/error and cleanup outcome, even if rendering succeeded. It does not establish that seccomp caused the failure without corresponding runtime evidence. [Electron app lifecycle](https://www.electronjs.org/docs/latest/api/app#appquit), [Docker seccomp](https://docs.docker.com/engine/security/seccomp/).

Preserve the existing Windows worker GUI prohibition. An approved host observer is a separately declared role with its own boundary receipt and candidate identity, not an automatic fallback after worker denial. If no permitted observer exists, native/visual readiness stays unsupported and those acceptance gates stay pending. Do not swap executors, add privileges, change ACLs, disable sandboxing or relax network policy to turn failure into success.

## Receipt reuse, recovery and stop conditions

Reuse stable tool/policy observations only while the full dependency fingerprint remains unchanged. Always validate job-specific workspace/base/input identities, receipt integrity and cleanup before dispatch. A short expiry can limit staleness but does not replace identity checking. Do not reuse across executor restart/replacement, role change, worktree generation change, runtime executable change, setup/lockfile change, policy/root/mount change or probe-version change.

Preserve two kinds of receipt: a reusable environment observation and a per-job admission record that references it and adds workspace/input identity. This avoids launching a browser for every shell command while preventing a broad machine-level ready flag. A browser observation may be reused only for the same browser build, launch/display policy and executor session; actual application acceptance still runs on its candidate.

| Condition | Required disposition |
| --- | --- |
| Required capability unsupported or helper cannot reproduce policy | Stop before model reservation; name unsupported operation/boundary. |
| Explicit permission denial | Record denied and stop that branch. No retry with broader access, a different transport or another executor. |
| Probe timeout, output cap, malformed receipt or contradictory identity | Fail closed with bounded evidence; do not reinterpret a partial success as ready. |
| Wrong/missing Git base or foreign path | Preserve existing workspace; report precise mismatch. No init/commit/reset/remount as a probe repair. |
| Cleanup fails or prior writer identity is uncertain | Keep lane blocked; preserve operation/receipt; use the recovery reconciliation path. |
| Export not acknowledged or hash differs | Keep local evidence and report artifact_export_failed; do not advertise durable/portable output. |
| Boundary changes before dispatch or during recovery | Invalidate admission; reconcile prior work first. Reprobe only on the already-authorized selected boundary when available. |
| Transient operational failure with no denial | Permit at most one same-boundary deterministic recheck after confirmed cleanup and a specific observed transient cause; otherwise stop. No periodic paid smoke loop. |
| Optional capability absent | Mark not_required only if the frozen profile truly does not require it. Never waive an unmet task criterion. |

Preflight failure is infrastructure/readiness failure, not an application repair attempt or a failed model sample. Record its elapsed time and resource overhead separately. Once a model launch is possible or ambiguous, existing conservative call accounting and recovery rules apply. No receipt can promise the next provider call will avoid quota rejection.

## Task alive, benchmark alive and progress

A conversation/task wrapper can remain running while its benchmark subprocess is absent, already exited or blocked. A controller can be alive while waiting on capacity. A process can be alive without measurable progress. None is proof of completion.

Expose separate, correlated facts rather than one running boolean:

| Layer | Evidence to record | Truthful label when evidence is insufficient |
| --- | --- | --- |
| Task/controller | Observer timestamp, controller/executor identity and last durable event | Controller status unknown/stale |
| Benchmark invocation | Benchmark run/attempt ID, frozen configuration digest, registered launch operation and boundary fingerprint | Not launched, launch unknown or awaiting reconciliation |
| Benchmark process | Owned process identity, observed spawn/terminal receipt, last liveness observation | Alive as of time, stopped, or identity unknown |
| Progress | Last benchmark-owned sequence/phase and durable result/checkpoint, plus time since advancement | Alive, progress unconfirmed; no inference from unrelated log activity |
| Outcome | Terminal process result plus required result-manifest and independent acceptance/evaluation status | Process ended, evaluation pending; interrupted or outcome unknown |

Use the existing event stream/job IDs and future operation registry, not another heartbeat database. Where a benchmark supplies no trustworthy progress signal, say so. A stale heartbeat triggers bounded inspection and the configured stall policy, not a replacement process, a reset deadline or a success verdict. A shutdown failure can mean the benchmark workload ended while cleanup remains unsettled; retain both facts.

Current benchmark reporting already distinguishes pending sessions, terminal outcomes, timeouts and unknown/conflicting usage. Extend those facts with invocation/process correlation without modifying frozen benchmark evidence or relabeling old pending jobs as known-dead. [Reporting source](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/src/benchmark-report.mjs), [foundation limits](https://github.com/Zkrausman/Squire/blob/ec98a61bd6a0fec89246c0b160ca90d2ff363d68/docs/workflows/benchmark-foundations.md).

## Portable offline validation scenarios

Start with fake boundary adapters, synthetic receipts and small disposable filesystem/Git fixtures. These tests need no network or model and must never use a private grader/reference. Real process/sandbox/browser capability tests are a later authorized, zero-model integration tier on supported machines, with clean unsupported/skipped labels on other platforms. Nothing in this memo claims those tests were run.

| Scenario | Expected assertion |
| --- | --- |
| Host file exists, guest mapping absent | Consumer probe fails before dispatch; host stat cannot substitute. |
| Same-looking guest path holds wrong nonce/content | Identity mismatch; no permission change or path guessing. |
| git init but no commit | Repository discovered, commit unresolved; no model call and no automatic commit. |
| Valid linked worktree, .git file, inaccessible common directory | Report Git metadata boundary failure; do not reject solely because .git is a file. |
| Base ref names a tag/tree/nonexistent object or unexpected commit | Require expected commit identity; no readiness from a string-shaped SHA. |
| Controller Node satisfies Squire; worker Node violates app range | Distinct runtime evidence; worker profile blocked. Different but allowed versions pass their own ranges. |
| Tool version passes but required native ABI/feature fixture fails | Feature capability fails; version discovery remains a separate passed observation. |
| Read-only reviewer shares machine with writable implementer | Separate role/policy fingerprints; no implementation receipt reuse or write probe in review. |
| Probe temp root inaccessible, rename denied, or symlink escapes root | Operation-specific failure, no ACL repair; preserve source and receipt. |
| Setup changes executable/lockfile after a cached probe | Receipt invalidated; probe after setup settles. |
| Receipt copied to another executor generation | Fail admission even if paths and versions match. |
| Fingerprint changes between probe and launch | No reservation/dispatch under stale admission; retain drift event. |
| Child spawn succeeds but exits nonzero | Spawn capability observed; fixture outcome fails. |
| Parent exits but registered descendant lives; PID later reused | Cleanup uncertain/failed; no unrelated process kill and no overlapping worker. |
| Cancellation denied or hangs after GUI render | Render stays observed, lifecycle/readiness fails, lane remains blocked. |
| TCP round-trip passes, Unix socket or named pipe fails | Only exact successful transport is supported; no silent substitution. |
| Browser installed but launch unavailable; headless works but headed absent | Discovery/headless pass cannot fulfill launch/headed/native requirements. |
| Browser launch defaults would disable Chromium sandbox | Profile validation rejects configuration before launch. |
| Browser close only disconnects from an attached service | Do not mark owned-process cleanup complete from connection closure. |
| Marker exported to wrong receiver, corrupted, truncated or missing | Artifact capability fails despite producer-local success. |
| Malformed/oversized receipt, output flood or timeout | Bounded stop, explicit missing/truncated fields, zero model dispatch. |
| Task wrapper alive, benchmark never launched or terminal | Status layers differ correctly; no automatic benchmark restart. |
| Probe passes, later model hits quota | Readiness remains a historical observation; model outcome waits for capacity with honest accounting. |
| Reopen same failed admission twice | Stable references and reason; no implicit retries, counter debit, scope change or side effect. |

In the real sandbox integration tier, test one allowed operation on the selected route and validate policy/config parity through supported runtime evidence. Negative permission tests should use controlled fixture policies and owned paths in an authorized test environment, not opportunistic attempts against the owner's denied/private directories. Browser integration uses a bundled inert page and local artifacts, never a scored benchmark.

## Small dependency-ordered implementation plan

All work below is proposed for later authorization. P0-P5 decompose R6 rather than creating a parallel workstream. During the research-only period, finish schema/examples, source review, test specification and roadmap integration only; do not start execution to create evidence for the memo.

| Slice | Dependencies | Small implementation boundary | Closing evidence |
| --- | --- | --- | --- |
| P0 Define semantics | None | Versioned requirements, boundary/observation/admission envelopes; blocker vocabulary; current doctor scope documented. | Reviewer can distinguish declarations, host observations, boundary probes, running jobs and acceptance. No version-1 evidence relabeled. |
| P1 Build the pure resolver | P0 | Canonical fingerprint, required-capability evaluation, path-handle validation, receipt bounds/integrity and invalidation rules. | Offline table-driven cases reject stale, wrong-role, wrong-executor, denied and unknown required capabilities. |
| P2 Add one local probe route | P1; R1 registered process identity and R3 immutable receipts | Trusted probe bundle; exact-policy Codex helper adapter; core workspace/Git/tools/lifecycle/export probes and supervisor-enforced output/aggregate deadlines on one supported platform. | Offline fake-adapter tests plus separately authorized zero-model same-boundary tests. A parity gap stays unsupported; cleanup time cannot escape the advertised bound. |
| P3 Gate dispatch | P2 | Prepared-workspace admission before callAgent reservation/onStarted; recheck identity; read-only role handling and restart invalidation. | Infrastructure failure spends no new model call/repair; a post-reservation ambiguous launch still follows conservative recovery; no overlap or policy weakening. |
| P4 Add one GUI/IPC profile | P3; A2 immutable artifact references | Owned browser fixture, needed transport only, sandbox-preserving launch, artifact acknowledgment and shutdown result. | One supported route proves every lifecycle stage; headless/native/attached distinctions and denial cases remain truthful. A4 still owns real application acceptance. |
| P5 Correlate status | P3; recovery operation registry | Add benchmark invocation/process/progress references to existing reports/status. | Synthetic wrapper-alive/process-dead and silent-process cases cannot report false progress, completion or restart authority. |

P4 and P5 can proceed independently after their prerequisites. Defer remote adapters, cross-platform GUI coverage, hosted previews and broad environment repair. The first useful outcome is a precise refusal before a wasted call; the next is a small, reproducible proof that an authorized job can execute and return evidence on its chosen boundary.

## Decisions for roadmap review

1. Choose the first supported platform/CLI version and approve its exact-policy helper mapping. Without that, same-boundary readiness stays a design rather than a guarantee.
2. Decide whether new strong-contract projects require all future acceptance routes ready before any implementation spend. Recommended default: yes for unattended delivery; explicitly scoped non-GUI implementation-only work can proceed with its unmet GUI gate visible, without calling the project deliverable.
3. Approve bounded probe overhead and conservative session-scoped cache reuse. Do not make agent-backed smoke a recurring readiness dependency.
4. Require sandbox-preserving browser startup and verified cleanup/export. If those cannot be met on the selected route, stop with the smallest prerequisite rather than spending repair attempts on infrastructure.

Success means fewer avoidable paid starts, no weakened execution boundary, no false ready/running/completed claims, and retained evidence that explains exactly which operation failed where.
