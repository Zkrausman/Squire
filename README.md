# Squire

Experimental local **0.1** snapshot: [release notes and benchmark evidence](docs/releases/0.1/README.md). The [later closure record](docs/releases/0.1/baseline-closure.json) is authoritative: the original baseline is **closed-incomplete**, with **0/3 major benchmarks accepted** and separately unscored manual harness completion. Benchmark/comparative execution remains on owner hold. This version label does not imply benchmark acceptance.

A durable controller for an agentic software delivery loop. Give it an authorized project and trusted executable checks; it plans or accepts tickets, schedules dependencies, runs fresh Codex implementation/review sessions, repairs bounded failures, and delivers verified commits. SQLite checkpoints and process receipts survive controller restarts.

This is a clean rewrite from `origin/main`. The [architecture design](docs/ARCHITECTURE.md) and [tldraw canvas](docs/Squire%20Architecture.tldraw) preserve the approved direction and historical terminology; they are not a current feature or acceptance inventory. Git history retains the previous implementation.

## Current reading path

- [Roadmap](docs/roadmap/README.md) and [research evidence/dependency guide](docs/research/README.md): implemented foundations, proposed hardening and execution holds.
- This README, [operations](docs/OPERATIONS.md) and [source contracts](src/ports.d.ts): current executable surfaces and limits.
- [Owner/orchestrator boundary](docs/ORCHESTRATOR-BOUNDARY.md): the owner gives goals and scoped decisions in conversation; CLI inspection and routine authorized recovery are internal orchestrator work.
- [Later baseline closure](docs/releases/0.1/baseline-closure.json) takes precedence over earlier readiness/release progress snapshots. [Canvas status legend](docs/canvases/README.md) distinguishes historical designs and fixtures from current behavior. Neither old plans nor new documentation authorizes execution.

## Requirements

- Node 24.14 or newer in the Node 24 series, Git, and Codex CLI signed in with `codex login` using ChatGPT.
- GitHub delivery also needs `gh auth login` with repository write access and permission to inspect branch protection.
- On Windows, Codex must have a working native elevated sandbox. Squire explicitly selects this approved mode, retaining workspace boundaries. It does not bypass sandbox failures.

The runtime checks ChatGPT authentication and the account's model catalog. API key environment variables are removed; there is no paid API fallback. An unavailable inherited model preference uses the account default; an unavailable explicit project model blocks. Jobs share your subscription usage limits. Quota exhaustion checkpoints and waits.

## Run

```powershell
npm ci --ignore-scripts
npm run check
npm test
node bin/squire.mjs validate project.json
node bin/squire.mjs doctor project.json
node bin/squire.mjs run project.json
```

Copy [examples/project.github.json](examples/project.github.json), replace repository and absolute state path, and choose checks that prove your requirements. `doctor` checks authentication and delivery policy; the optional `npm run smoke:codex` additionally proves a real agent can execute a command and write an isolated file. It consumes subscription usage and makes no delivery commits.

Use `goal` to request planning, or supply `tickets` with explicit dependencies. Checks/setup/acceptance are trusted argv arrays with timeouts, never shell strings. For Windows npm commands the runner resolves npm's Node entrypoint. Source may be GitHub HTTPS or a local **bare** Git repository. State must live outside source. All controllers on a host should share one state root for repository leases.

## What shipping means

An agent's success message is insufficient. Each ticket requires a controller-owned candidate commit, clean exact tree, passing executable checks, a fresh review tied to that head, publication, required CI, an expected-head merge, and passing checks on the exact delivered tree. Only then do dependent tickets start. Moving the base invalidates checks and review. Independent repositories run concurrently; one repository/target branch has one writer. Project completion requires integrated service checks and configured acceptance commands.

GitHub requires classic strict up-to-date branch protection with administrators enforced, explicit check names and app IDs, and an enabled merge or squash method. Check runs may use head or a verified synthetic merge commit. Skipped/neutral checks do not pass. Ruleset-only protection and merge queues are currently unsupported and block. Deployment is a future separate delivery gate.

## Operate and extend

```powershell
node bin/squire.mjs status project.json
node bin/squire.mjs events project.json --after=0
node bin/squire.mjs pause project.json
node bin/squire.mjs resume project.json --retry
node bin/squire.mjs run project.json
node bin/squire.mjs serve C:\SquireState --port=41828
```

`run` waits through capacity and CI. `--once` advances available work and returns without waiting. Ctrl+C cancels active jobs and pauses; `resume` reactivates persisted work. `--retry` retries blockers with new evidence; it does not reset exhausted budgets. Preserve state for diagnosis, and explicitly start a new project for changed scope/budgets. A postmerge failure halts the repository lane and is never hidden by a rollback claim.

See [operator/API guide](docs/OPERATIONS.md) and [adapter contracts](src/ports.d.ts). Another harness can call the versioned control API; a future runtime adapter can supply agent execution independently. The initial executable installs only the Codex subscription adapter.

## Verification and limits

Offline tests exercise real local Git delivery with deterministic agent fixtures, repair/review failures, recovery, moved bases, lost merge receipts, quotas, protected paths, exact GitHub evidence, API authentication, and scheduling. They test controller behavior, not model effectiveness or accepted application delivery. Read the later baseline closure above for actual historical outcomes; a future acceptance claim needs separately authorized, candidate-bound evidence.

This is an owner-controlled single-host tool. Trusted setup/check commands execute repository code under the owner's OS account; same-user auth files are not a separate security boundary. Keep state, transcript logs, and the control token private. Do not expose the loopback API or use untrusted repositories as a multiuser execution service.
