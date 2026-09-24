# Squire — two-session local MVP

Squire runs exactly one ticket per invocation. It creates a separate local clone at a pinned commit, asks the current host Pi for a plan, then starts a fresh Pi session to implement that plan. A changed checkout is retained with a patch labeled **UNVERIFIED**. Squire does not publish or validate the candidate.

## What a run does

1. Validate a trusted local config, a clean Git checkout whose `HEAD` equals `baseSha`, and a bounded ticket. `resultRoot` must be outside the source checkout. The source checkout is not used as the worktree.
2. Clone the local repository into a unique run directory and check out the pinned commit. Save a ticket snapshot and a run journal.
3. Launch current host Pi headlessly in JSON mode for Plan, with only `read`, `grep`, `find`, and `ls`. Start a fresh session for Implement with the exact captured plan and ticket, allowing only Pi's native `read`, `bash`, `edit`, and `write` tools. Both sessions disable extensions, skills, templates, and themes and pass `--no-approve`; `--no-context-files` is intentionally omitted. Pi's normal AGENTS/CLAUDE context discovery remains enabled, and each prompt directly asks the model to read applicable `AGENTS.md` instructions.
4. Require each Pi process to exit successfully and emit an authoritative final assistant `stopReason: "stop"` followed by `agent_settled`. Retain JSONL, Pi session files, stderr, and run state. Before Implement, write `evidence-manifest.json` with hashes of retained pre-implementation evidence. After Implement—also when it exits nonzero or throws—verify the manifest, ticket/plan snapshots, and original evidence inventory; restore ticket and plan from in-memory copies where possible and fail closed on persistent changes. `plan.md` is captured once as bounded, non-empty Markdown; the model need not follow a response schema.
5. If the worktree differs from the pinned base, retain it and write `candidate.patch`, including untracked files. Do not commit. The outcome is **UNVERIFIED**, regardless of model claims. If there are no changes, the outcome is `no-candidate` (exit code 2), not success.

Squire itself runs no tests, reviewer, CI, GitHub/Linear action, PR workflow, queue, Docker Sandbox, or automatic repair. The implementation session has ordinary host-Pi permissions and may choose to run commands through its native bash tool; Squire does not treat those results as a gate.

## Requirements and invocation

Requires Node.js 24, Git, the current host Pi CLI, and working Pi authentication for the configured owner-approved models. No dependencies are installed by this project. The default Pi CLI entrypoint is the package adjacent to the running Node installation. Set `PI_CLI_PATH` only when that installation is elsewhere; it must name the trusted JavaScript CLI entrypoint. Tests use a fake CLI through this variable.

Copy `mvp/config.example.json` to a trusted private location and set absolute paths, a full pinned commit SHA, and a ticket file. `planModel` and `implementationModel` are optional and, if specified, must remain exactly `openai-codex/gpt-6-sol` and `openai-codex/gpt-6-luna`; thinking levels are fixed to `medium` and `max` respectively.

```sh
node mvp/run.mjs C:/private/squire-config.json
# or: npm run squire -- C:/private/squire-config.json
npm test
```

A candidate run exits 0 and reports its run directory; a no-candidate run exits 2; a failed Pi/preflight/artifact run exits 1. Inspect the reported directory: `state.json`, `evidence-manifest.json`, `ticket.md`, `plan.md`, `implementation-response.txt`, `plan.jsonl`, `implementation.jsonl`, the two session directories, process stderr, Git command logs, and (when present) `candidate.patch` and `candidate/`. Failures are retained for inspection and never trigger automatic retry or promotion. Output/session files can contain repository data and model/tool output; keep `resultRoot` private.

## Limitations

This is ordinary host Pi, not a sandbox or credential boundary. Pi inherits the current user's filesystem, network, and available credentials; `--no-extensions`, `--no-approve`, and the tool allowlists do not isolate its process. `--no-approve` disables trust-gated project-local configuration/resources; in the installed Pi implementation it does not disable AGENTS/CLAUDE context discovery, which is controlled separately by `--no-context-files`. The runner's hash/inventory checks detect persistent evidence changes but cannot defend against a malicious same-user model that changes and restores files or tampers with state between checks. Retained evidence remains sensitive. The candidate is not reviewed, tested by Squire, CI-checked, published, committed, or approved as safe. Review the patch and run appropriate validation manually before using it.
