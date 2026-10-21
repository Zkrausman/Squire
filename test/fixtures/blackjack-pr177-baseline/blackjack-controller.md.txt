# Blackjack source-only phase controller

This additive controller preserves the unchanged Scribble Blackjack Shooter v2
brief (selected-page SHA256
`bee5f85f411b9f087d4e3de08531c7c00247ce42f64e7afc4aad7bcaacf6aad7`).
It does not run that benchmark. Its source contract is
`662afc3971feea68a7c2d2d1fab17a1ca7841858567db95eb1827a59a7c116de`.
The baseline API inputs remain PR177 commit
`2e1bf2dbe4bc034982c0376e65d0b530ee9484bc`, tree
`100fd72548b6c2c288e8177bf8f23089214a2207`; these identify the
unchanged reused interfaces, not an assertion that this later controller was
present in that commit. Actual future activation needs a newly reviewed exact
source/prompt/runtime/config binding.

`validateBlackjackSpec` requires all budget/model/effort fields explicitly.
Ceilings are 2400 seconds including 30 seconds of cleanup reserve, 10 model
reservations, 3 native jobs and 8 live owned processes. Those numbers are
prospective limits, not execution authority or proof of cleanup. Every model
call remains limited to PR177's 120-second generation and 140-second observation
contract. Dispatch needs at least 170 seconds left in the one original deadline.
Counters are reserved before dispatch, never refunded or reset; one active
reservation excludes all concurrent or reentrant dispatch. Failure is permanent
for that run. Reuse fences are in-memory only, with no cross-process or crash
recovery guarantee. This controller never observes or attests live processes.

`parseBlackjackInterpretation` accepts a closed, duplicate-aware bounded JSON
wire. It checks field sizes, the frozen brief identity, portable planned paths,
and encoding; it cannot judge whether an interpretation is fun or complete.
It imposes no reference mechanics, engine or architecture. Its canonical wire
is sorted-key, two-space UTF-8 JSON with a trailing LF, 512–65536 bytes.
The digest binds those canonical bytes, not the original transport serialization.

`prepareBlackjackController(spec, ports)` consumes a run/workspace reservation,
starts the original injected clock, verifies the 13 published baseline source
pins through `readPublicSource(path,maxBytes)`, checks the existing Node identity
through `observeNodeIdentity()`, checks `retentionReady() === 'READY'`, and
validates the existing workspace/ancestors through explicit filesystem/uid ports.
These observation ports must provide bounded source bytes and the actual
observations for their intended use; synthetic values establish tests only.
Preparation creates no higher directory and changes no existing permissions.
No default filesystem, clock, executable or provider is selected. Scope contents
must be fresh: existing interpretation/stage/export targets are never reused.

The returned API is:

- `interpret()`: one injected interpretation call, then host validation and
  exclusive write/readback of wire and host receipt under `interpretations/`.
  Only new files receive 0600 creation and 0400 witness mode. The receipt binds
  run, phase, operation, interpretation, path, bytes and SHA256; both artifacts
  are read back again before implementation. Model self-report is insufficient.
- `implement()`: after that gate, one injected candidate call. It accepts the
  PR177 result shape wrapped with `stage_root`, validates the LimitedJobRecord,
  reads the exact persisted envelope through `readCandidateEnvelope(path,maxBytes)`
  and bounded nofollow readback, and verifies its decoded files against the
  physical stage inventory. Envelope and staging identities remain separate.
- `packageCandidate()`: a separate injected source review and PR176 owned-file
  export operation. This source-only slice accepts no observed-evidence input.
  Generated logs or frames cannot become observation receipts.
- `rejectNative('logic' | 'gui' | 'grading')`: consumes a native reservation,
  permanently rejects unqualified execution and invokes no supplied native
  callback. No qualification Boolean enables those ports.
- `snapshot()` / `poll()`: immutable fresh result snapshots; `poll` observes the
  injected clock. `finish()` seals the run and cancels the observation schedule.
  Intermediate ready snapshots are `INCOMPLETE/SOURCE_CONTROLLER_READY`.

The only callable model seams in this delivery require explicit
`ports.mode: 'SOURCE_SIMULATION'` with caller-injected public synthetic fakes
(`model_provider.interpret`, `dispatchCodexTask`, `review`). This mode is a test
convention, not authenticated runtime admission, containment or a security
boundary against a caller who supplies arbitrary functions. No actual provider
adapter is wired. With any other mode the model path rejects without calling it.
There is no default native, GUI or grading producer.

PR177's unmodified 1030-byte prefix requires dependency-free Node 24 APIs and
`node24-esm`. It is **incompatible with actual desktop generation** absent a
separately reviewed compatible target/runtime/prompt. A future GUI Boolean
cannot fix that mismatch. Existing validators check closed shapes, limits and
prefix identity; they do not prove dependency freedom by inspecting prose or
source imports. This delivery adds no static dependency parser, Electron,
browser substitution, package installation or launch command.

All result objects use `SQUIRE_BLACKJACK_CONTROLLER_RESULT_V1`, retain
`NOT_EVALUATED`, `task_outcome_evaluated: false`, `runtime_admitted: false`,
`operator_admitted: false` and `descendant_guarantee: 'NONE'`. CANDIDATE_STAGED
and EXPORT_PACKAGED mean only candidate custody/copy integrity. Direct-child
invocation counts remain zero for these injected controller tests, separately
from simulated reservation/completion counters. No generic summary CLI is
repurposed to invent a benchmark PASS. Host interpretation receipt paths are
private local data; this result is not a sanitized public report or stdout feed.
Errors use fixed enums without raw responses, native messages or stack traces.

`acceptance/blackjack-controller-entrypoint.mjs` has no native activation mode;
all argument shapes yield a content-free DRY_RUN_NATIVE_DISABLED summary.
Imported modules dispatch nothing. The source/synthetic/owned-temporary-file
tests execute no generated code, provider prompt, desktop program or native
qualification fixture. A completed fake reservation does not establish actual
provider use or cleanup.

Cancellation and timeouts bound caller observation under a responsive parent
event loop. Pending I/O may outlive the response and retains its owned buffers
until settlement; late completion cannot reopen a failed run. Timers, 0400
witnesses, hashes and logical quarantine do not establish atomic publication,
trusted provenance, crash durability, same-UID isolation, physical denial of
reads, or full-descendant termination. Desktop/display/input/capture, qualified
all-owned custody and private-grader read isolation remain unadmitted. All
historical attempts, Q219 and other unknown/access/no-rerun holds remain intact.
