# MVP architecture and boundaries

## One invocation

`mvp/run.mjs` accepts `sourceRepo`, `baseSha`, `ticketFile`, `resultRoot`, optional owner-policy model fields, and optional `progressIntervalMinutes`, and optional Windows-only `window` display identity. Paths must be absolute; unknown config keys and alternate model IDs fail closed. Plan defaults to `openai-codex/gpt-6-sol` at medium thinking; implementation defaults to `openai-codex/gpt-6-luna` at max thinking. The progress interval defaults to 15 minutes and must be an integer from 1 to 120; it is validated before any Pi process starts.

The runner confirms the source worktree is clean and pinned, snapshots the ticket, and makes a no-hardlinks local clone outside the source. It removes the clone's `origin` remote and checks out the pinned SHA. Git runs with optional source locks disabled and hooks directed to a private empty directory.

Each primary phase launches the installed host Pi JavaScript CLI as a child process with piped stdio, its own session directory, a time limit, and bounded stdout/stderr. On timeout the runner closes the pipe readers and terminates the child process tree (POSIX process group or Windows `taskkill /T`), without waiting indefinitely for pipe drain; partial JSONL/stderr files remain available. Plan uses only read-only builtin tools; Implement uses only native read/bash/edit/write tools. Extensions, skills, prompt templates, and themes are disabled, and `--no-approve` keeps trust-gated project resources off. `--no-context-files` is deliberately omitted for these primary sessions: Pi's normal AGENTS/CLAUDE discovery is separate from project trust, and both prompts explicitly ask the model to read applicable `AGENTS.md` instructions. Plan is passed explicitly with the ticket; the captured plan and ticket are passed explicitly to Implement. JSONL—not model formatting—is checked for both a zero process exit and a final assistant stop plus `agent_settled`.

Before Implement, Squire writes `evidence-manifest.json`, hashing the retained pre-implementation evidence inventory (including the ticket, plan, Plan JSONL/stderr/session files, and existing command logs). Progress files are stored in a separate `progress/` subtree and excluded from that inventory. After Implement returns or throws—including a nonzero exit—it checks the manifest and evidence inventory plus the ticket/plan against in-memory snapshots. It restores the ticket and plan where possible and fails closed on persistent changes. The manifest is a tamper detector, not a security boundary. After successful verification, Squire checks that `HEAD` is still the pinned base, includes untracked files in a bounded binary-capable Git patch, and retains the worktree. It does not commit. A non-empty candidate is labeled `UNVERIFIED`; an empty diff is `no-candidate`. `state.json` journals phase transitions. Session JSONL, Pi session files, stderr, command logs, prompt inputs, and artifacts remain in the run directory on failure.

## Opt-in bounded implementation budget

Existing configs keep the 60-minute Implement deadline. An operator may opt into
`implementationBudget: { minutes: 120, reserveMinutes: 10, commands: [
  { command: "npm --prefix v2 test", maxSeconds: 1200 }
] }`. Minutes are bounded 20..240, reserve 1..30 (strictly less than half
of the phase); at most 50 exact shell command strings are allowed, each capped at
1..3600 seconds. Declare target-specific commands after a preflight of CI/toolchain. Never put
secrets in command strings: the trusted budget is passed to Pi through its
process environment. This example is not a default test command. Unknown bash commands are blocked in
strict mode. Pi's built-in read/edit/write tools remain available. No alias, shell
wrapper or alternate executable may be used to bypass the list.

The trusted Squire build explicitly loads only its phase-budget Pi extension for
Implement even though resource extension discovery remains disabled. The host
requires a per-run nonce acknowledgement written after the extension registers its
hook; a missing acknowledgement fails Implement even if Pi emits a settled response.
This is a load check, not OS isolation or proof that the model obeyed the policy.
The extension checks monotonic remaining time against each declared maximum plus
handoff headroom *before* the builtin bash tool runs, sets the builtin tool timeout
to the declared maximum, and writes bounded `not_run` receipts under `progress/`.
A blocked check is never a pass. The reserve is **bash-admission headroom only**:
non-bash tools and model turns may consume it, so it cannot guarantee a complete
handoff. The outer Implement process hard deadline remains independent and
terminates the Pi tree. A successful unverified candidate includes
`state.json.deferredCommands`; the external operator must run all required full
verification, independent review and exact-head hosted CI before publication.

This is scheduling policy, not OS command isolation: same-user Pi can access host
resources and shell commands can spawn descendants or bypass naive command parsing.
Strict exact strings fail closed for tool invocations; they cannot constrain
other code paths, nested process trees or malicious shell content. Windows process
cancellation and actual Pi-extension loading must be validated on the candidate
before release. Never claim a deferred test passed, or install this draft before
independent review and hosted gates.

## Live progress reports

A non-model timer runs during each active Plan/Implement Pi process. On each configured interval, at most one fresh Luna observer is started; it runs from the OS temporary directory with `--no-tools`, no extensions/skills/templates/themes, `--no-approve`, and `--no-context-files`. Its fresh session and bounded JSONL output are removed after the assessment. The prompt includes only the active phase, elapsed/remaining deadline, runner-known milestones, time since last activity, and the last bounded set of safe activity categories/tool names/statuses extracted while streaming primary Pi JSONL. It never includes raw tool responses, commands, repository text, Pi context, or credential material. Luna's runtime is capped at 90 seconds and its JSONL output at 128 KiB. Timeout, process/provider/authentication failure, cancellation, or invalid output yields an explicit unavailable report and cannot fail or change the primary run.

Each report is atomically saved as `progress/reports/NNN.json` with its evidence digest, timing, sanitized snapshot, usage counters when available, and a failure receipt when unavailable. The `progress/` subtree is excluded from both the pre-implementation manifest and post-implementation evidence inventory. Squire emits each persisted report as one stdout JSON line with `type: "squire.progress"`; this is the supported live forwarding boundary. Squire has no built-in owner-chat transport: an external host must consume stdout and forward the event while the process is running. Reports are not verification, authority, or candidate-status input. Completion percentage and ETA are currently always `unknown` because this runner does not yet have defensible implementation-completion milestones.

## Windows-only active ticket window

The optional trusted `window` config supplies a bounded ticket ID/name; it does not parse ticket bodies or discover workspaces. Each runner publishes one atomic, bounded heartbeat/phase record under the fixed per-user `%LOCALAPPDATA%/Squire/active-window-v1/` directory. The optional Node `window-web.mjs` service binds `127.0.0.1:41827` and launches an Edge app view with a dedicated local profile; binding is the singleton gate. No service on another interface is used. The browser fetches only token-scoped static assets and a read-only JSON snapshot; it constructs text nodes rather than HTML from ticket/report strings. A random per-service URL token, exact Host check, no CORS, CSP, no-store and no-referrer headers limit incidental local access, not same-user or credential access. The independent `window-state.mjs` snapshot reader scans only the per-user presence directory, rejects malformed/oversized/symlinked records, checks heartbeat freshness and Windows OS process start identity (not just PID), and shows every live run as ID, phase and name. It filters stale entries before applying the 128-live-record cap, so accumulated crashed-run files cannot hide a live run. The same record may contain only a bounded allowlisted projection of the latest successfully persisted Luna report for the current phase: action, evidence, risks/stalls, confidence and time. Selecting a row renders that projection locally; a missing report is shown explicitly. A phase change discards the previous phase's report. No full report file, ticket body, raw log, or workspace is opened by the UI. Concurrent writers use separate per-run files. Terminal completion removes the record; crashes leave retained evidence but cease appearing after the heartbeat window. The UI has no effect on runner deadlines, candidate status, model calls or Git and closing Edge does not cancel work. The local service remains alive after the browser closes; `node mvp/window-web.mjs --open <absolute presence root>` reopens the view explicitly. A display failure is best-effort and never a reason to promote a candidate. Linux UI is deliberately deferred; existing Linux headless behavior continues.

## Deliberate non-features

No GitHub, Linear, Docker Sandbox, queue, PR, CI, review, test gate, commit, publication, repair, or merge integration exists. Squire runs Git for checkout and artifact collection, but does not run repository tests. A model may invoke commands via the allowed host bash tool; their output is not evidence of validation. The observer cannot commit, publish, merge, trade, approve, retry, or change deadlines.

## Limits

Pi runs as the current host user with ordinary filesystem, network, and credential access. Tool/resource flags constrain Pi configuration and its advertised tool set, but they are not OS isolation and do not provide credential isolation. Persistent snapshot/evidence changes are detected, but a malicious same-user model can bypass the checks by altering and restoring files or racing the verifier; the manifest is writable by the same user. Treat repository content and every retained transcript/log as untrusted or sensitive. The local clone protects the source worktree from Squire's own implementation edits, not the host from arbitrary actions by host Pi. No candidate is verified or safe merely because a model says so. Inspect and validate manually before applying or publishing it.
