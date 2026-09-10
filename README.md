# Squire

Squire is a personal AI delivery tool intended to take one software ticket through **Plan → Implement → Review → Test → Retro**, open a pull request, and leave the merge to its human owner.

## Current MVP

The approved first milestone is deliberately small:

```bash
squire run AIDEV-123
```

One trusted local controller will fetch the ticket, create one Docker Sandbox, run five independent Pi phase processes, require Review, Test, and Retro to pass the current Git HEAD, and create or reuse one pull request. Retro runs read-only after Test with a fresh session, records lessons and proposed follow-ups, and publishes them in the PR body. Squire does not turn those follow-ups into Linear issues or mutate a wiki. Docker Sandbox is the host isolation boundary; same-ticket phases share that trust boundary. Ambiguous failures stop for the owner rather than invoking production-scale recovery or compensation.

See the authoritative [Personal MVP plan](docs/personal-mvp.md) and [scope audit](docs/audits/2026-09-personal-mvp-scope-audit.md). The older [requirements](docs/mvp-requirements.md), [architecture](docs/mvp-architecture.md), and [ticket path](docs/mvp-ticket-path.md) are retained as historical design context where they conflict with the approved personal MVP.

## Developer preview

For a complete first-run walkthrough, see [`docs/first-run.md`](docs/first-run.md).

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build
# Copy squire.config.example.json to your per-user Squire directory and edit
# the repository checkout, sandbox, and token settings.
npm run squire -- run AIDEV-123
```

Squire does not search the checkout for configuration. The implicit config is
`%USERPROFILE%\.squire\config.json` on Windows and
`$XDG_CONFIG_HOME/squire/config.json` (or `~/.config/squire/config.json`) on
Linux. `--config <file>` takes precedence over `SQUIRE_CONFIG`, which takes
precedence over that per-user default. Relative `state`, `bridges`, `staging`,
and `piAuthFile` paths are relative to the selected config file; the repository
path should be an explicit checkout path.

The configured Docker Sandbox template must provide Git, Node.js, and Pi at `sandbox.piExecutable`. `sandbox.piAuthFile` is an explicitly provisioned, ticket-usable model credential copied into the sandbox; it must not be a GitHub or Linear delivery credential. Keep this dedicated Pi OAuth file under the per-user Squire directory and never commit it. `github.tokenCommand` names a trusted host helper that prints one short-lived GitHub App installation token. Squire supplies that token only to host-side Git/`gh` publication commands and never passes it into the sandbox. Plan selection is a stable 50/50 choice between the two profiles in the example; the selected profile and all phase profiles are persisted in run state.

> Squire is under active development. The controller-level flow is automated, but a real sandbox/template end-to-end acceptance run is still required.
