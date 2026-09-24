# Reset rationale and boundaries

## Research

The previous installed Squire (merged SHA `b130b26b9a466498bca748c6486c43b1084f1dfa`) failed the Pith value trial: its AIDEV-330 Verify phase ended normally from Pi, but the 1,897-byte final report omitted the outer JSON closing brace. Controller parsing rejected it before deterministic tests; no PR. AIDEV-331 stopped by the arm's prior rule. Direct Pi delivered two independently reviewed and hosted-CI-passing, unmerged PRs (#215 and #216). Other historical malformed Implement reports had the same failure shape. This established a report-format delivery bottleneck, not a proven defect in the rejected candidate code.

The old runtime mixed phase-result schemas, platform-specific custody, sandbox runtime installation and parity, correction/queue state, telemetry, notification, publishing, and native Windows launch surfaces. The new runtime eliminates most of that: no model report schema, no queue, no autonomous correction, no sandbox Pi installation, no Linear API adapter, no automatic merge. We retain the important boundaries: isolated candidate, independent reviewer, deterministic host gates, host-only publication credentials, exact-head PR checks, preserved failures.

Pi's current CLI documents `--no-builtin-tools`, explicit `--extension`, `--no-extensions`, `--no-skills`, `--no-context-files`, JSONL `message_end` and terminal `agent_settled`. The runner uses those public switches instead of pinning a second Pi runtime. The bridge extension exposes only `sandbox_exec` to the implementer. The fresh reviewer uses `--no-tools` and receives bounded material from the frozen commit. Docker Sandbox `sbx create shell` provides a cloned workspace without mounting the host source repo or the host's Pi/GitHub credentials. Local integration fixture demonstrated actual implement → freeze → Windows test → fresh independent review to `validated-local`; it did **not** prove hosted publication.

## Limits

- `sbx` needs Docker Desktop. The sandbox may have network and a sandbox-scoped Docker daemon; a compromised runtime/daemon or malicious trusted extension is outside the asserted protection. No credentials are intentionally installed in the sandbox. All reviewed source/test code should still be treated as untrusted content.
- The target repository and host test commands must be explicitly approved; host tests execute target code as the user, so use a VM for adversarial repositories. A clean checkout and source bundle avoid writing to the owner checkout but do not make target code harmless.
- No automatic correction: a review finding, validation failure, provider error, CI failure, or changed head ends the run and preserves evidence. This lowers complex recovery risk at the cost of possible non-delivery.
- A model PASS is necessary but not sufficient; local tests, exact-head hosted checks and PR state are independently checked. The reviewer sees a bounded patch and instructions, not unlimited repository context. This can miss logic defects. No result is a human security approval.
- The simple process/state journal is not a crash-resumable queue. A process crash leaves run artifacts for manual assessment, never implicit promotion. `dryRun` is never counted as ticket-to-PR delivery.
- This branch is a product experiment, not installed Squire. A controlled crossed trial must measure accepted PRs first, supervision/reliability second, and full cost/time including failures; a premium is acceptable only for clear value. The two previous direct-Pi PRs are baseline evidence, not a substitute for a new trial.
