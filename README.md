# Squire — minimal delivery experiment

This branch **replaces** the former personal runtime with one ticket-to-unmerged-PR path. The original history, prior runs, and the tracked `.llm-wiki` are retained as historical evidence, not executable workflow components. The CLI is not a queue, repair engine, merge agent or production service.

## Hypothesis

A small, bounded wrapper around ordinary current Pi may deliver independently reviewed, CI-passing PRs unattended with less owner supervision than a direct Pi session. That is a hypothesis until a crossed trial proves it; automation alone is not a win. No speed or price-parity threshold is assumed.

## Single path

1. Require a trusted local configuration and ticket file, a clean repository at a pinned exact commit, and a fresh branch. Make a source bundle and create a new Docker Sandbox containing only a clone of that source and the ticket.
2. Run the **host's current Pi** with normal model authentication but no builtin tools, discovered extensions, project context, or skills. Its *only* explicitly loaded tool runs shell commands in the disposable sandbox. The sandbox receives **no model, GitHub, or Linear credentials**. Implementation output is the Git tree, not a fragile JSON final report.
3. Freeze a candidate commit and export its Git bundle to an isolated host clone. Run configured Windows tests. A fresh no-tools Pi session independently reviews the bounded patch and ticket. A non-PASS verdict fails closed; no automatic correction or retry.
4. Only after those gates, host Git/GitHub credentials push the exact commit and create an **unmerged** PR. Hosted checks must pass at the same PR head; a moved head, missing check, or failed check is not success. Preserve the sandbox (stopped), run state, session files, bundle, candidate, and logs even on failure.

Model text is not an authorization to publish, a substitute for tests, or a Git identity. Tests and the reviewer are necessary but cannot prove correctness. The approved target repository and configured host test commands are trusted inputs; the Docker Sandbox is an isolation boundary for **model tools**, not a claim that arbitrary target code is safe to execute on the Windows host. The sandbox may have network access and a sandbox-scoped Docker daemon; do not place credentials in its bridge. The host Pi process itself runs with host permissions, but the run disables every other tool and extension. Reviewers have no tools and only receive ticket, repository instructions, and patch text.

## Requirements and invocation

Node.js 24, the owner's current global Pi CLI, Git, GitHub CLI authentication, Docker Desktop + `sbx`, and an approved target repository. `npm test` runs pure unit tests; the fixture integration requires a running sandbox and live model authorization. The CLI does not install or pin Pi. Its default CLI location follows the current Node installation; `PI_CLI_PATH` may explicitly identify a trusted current CLI.

Create a config from `mvp/config.example.json` outside the repository. Keep `resultRoot` private and existing. Pin `baseSha`, set a never-before-used `squire/trial-*` branch, list exact expected CI check names, and configure trusted local Windows test commands. Run:

```sh
node mvp/run.mjs C:/private/run-config.json
```

`dryRun: true` exercises through independent review without pushing or publishing and records `validated-local`, **not** delivery. On any failure, inspect `resultRoot/mvp-*/state.json` and artifacts; do not rerun unchanged or promote its candidate. `passed` means open PR, unchanged exact head, independent review and configured local/hosted gates passed — never merge/release/install. Both arms of any value trial must start from the same pinned source on independent branches, remain blind to each other's candidate until frozen, and account for all attempts and supervision.

The old code and CI were removed rather than hidden behind a feature flag. Historical wiki records remain; old operating skills/configurations do **not** apply to this runtime. See `mvp/architecture.md` for limitations and research rationale.
