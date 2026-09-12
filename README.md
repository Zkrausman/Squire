# Squire

Squire is a personal AI delivery tool intended to take one software ticket through **Plan → Implement → Review → Test → Retro**, open a pull request, and leave the merge to its human owner.

## Current MVP

The approved first milestone is deliberately small:

```bash
squire run AIDEV-123
# Return immediately and follow the persisted run:
squire run AIDEV-123 --background
squire status AIDEV-123
squire status aidev-123-0123456789
```

One trusted local controller will fetch the ticket, create one Docker Sandbox, run five independent Pi phase processes, require Review, Test, and Retro to pass the current Git HEAD, and create or reuse one pull request. Implement may update the committed project wiki when the ticket requires it. Retro runs read-only after Test with a fresh session, records lessons and proposed follow-ups, and publishes them in the PR body; Squire does not automatically turn those follow-ups into Linear issues or mutate the wiki during Retro. Docker Sandbox is the host isolation boundary; same-ticket phases share that trust boundary. Ambiguous failures stop for the owner rather than invoking production-scale recovery or compensation.

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
precedence over that per-user default. `dataDirectory` is the one JSON setting
for mutable data and logs; `SQUIRE_DATA_DIR` is its only Squire environment
override and takes precedence over the JSON value. It defaults to
`%LOCALAPPDATA%\Squire` on Windows and
`$XDG_STATE_HOME/squire` (or `~/.local/state/squire`) on Linux. The pre-existing
`paths.state`, `paths.bridges`, and `paths.staging` settings remain supported
and resolve relative to the selected config file. All data destinations are
checked after resolving symlinks and must remain
outside the repository. The repository path should be an explicit checkout
path. Configuration objects are closed: unknown fields and legacy root aliases
are rejected rather than silently ignored, and `repository.sourceRef` must be a
non-whitespace, non-control Git revision.

The configured Docker Sandbox template must provide Git, Node.js, and Pi at `sandbox.piExecutable`. `sandbox.piAuthFile` is an explicitly provisioned, ticket-usable model credential copied into the sandbox; it must not be a GitHub or Linear delivery credential. Keep this dedicated Pi OAuth file under the per-user Squire directory and never commit it. `github.tokenCommand` names a trusted host helper that prints one short-lived GitHub App installation token. Squire supplies that token only to host-side Git/`gh` publication commands and never passes it into the sandbox.

The canonical JSON policy key is `modelPolicy`; the approved personal policy is fixed in the example: Plan bucket A is
`openai-codex/gpt-6-astra` at `medium`, bucket B is
`openai-codex/gpt-5.6-sol` at `high`, Implement is
`openai-codex/gpt-5.6-luna` at `max`, Review and Retro are
`openai-codex/gpt-5.6-sol` at `medium`, and Test is
`openai-codex/gpt-5.6-terra` at `high`. Plan chooses one bucket from the
canonical repository/ticket identity exactly once; the selection digest and
all five resolved phase profiles are persisted with the run and each phase
result records the profile that actually launched Pi.

Background runs write `<run-id>.stdout.log` and `<run-id>.stderr.log` in the
`logs` directory beneath `dataDirectory`. The detached child is bound to the
exact selected config bytes and its absolute config pathname, so relative
configuration paths cannot silently resolve against another copy. Before
handoff, the production Docker workspace resolves `repository.sourceRef` to one
commit and persists that source SHA; child preparation verifies the ref still
names the bound commit before creating bridge, staging, or sandbox resources.
`status` reads only persisted JSON records and reservation ownership; it does
not contact Linear, Git, Docker, Pi, or GitHub. State writes
are versioned and serialized per run, while reservation reserve/release
operations use a short-lived per-ticket boundary; malformed or orphan
reservations are reported as ambiguous rather than reclaimed. A detached child
is intentionally not a crash-perfect supervisor: a forced kill or power loss
can leave an ambiguous reservation, and ticket status reports it even when an
older terminal run exists. Exact run-ID status remains available for a
historical record beside a readable active replacement, but reports a
reservation whose owner is missing or inactive as ambiguous. Do not delete or
reuse that run's sandbox; inspect the log and state, and remove the exact
reservation only after confirming no controller remains.

> Squire is under active development. The controller-level flow is automated, but a real sandbox/template end-to-end acceptance run is still required.
