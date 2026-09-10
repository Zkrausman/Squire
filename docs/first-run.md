# First personal Squire run

This page documents a minimal first run. Configuration and credentials belong
to the user's Squire directory, not to a repository checkout.

## Prerequisites

- Node.js (`npm`)
- Docker
- `pi` CLI (`pi --version`)
- GitHub App token helper available to your shell
- `LINEAR_API_KEY` in your environment

## 1) Install and verify the checkout

From the repository root:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

When the checkout declares `.github/runtime/package.json` and
`.github/runtime/package-lock.json`, Squire provisions that pinned runtime
inside the ticket sandbox before phases run and validates it with
`.github/validate-ticket-runtime.mjs`. This keeps the repository-wide test
command from confusing missing Pi/wiki/TUI prerequisites with product
failures.

## 2) Create the per-user configuration

The default locations are:

- Windows: `%USERPROFILE%\.squire\config.json`
- Linux: `$XDG_CONFIG_HOME/squire/config.json` when `XDG_CONFIG_HOME` is set,
  otherwise `~/.config/squire/config.json`

Create the directory and copy the example there. For example, on Linux:

```bash
mkdir -p "$HOME/.config/squire"
cp squire.config.example.json "$HOME/.config/squire/config.json"
```

On Windows, create `%USERPROFILE%\.squire` and copy the file to
`%USERPROFILE%\.squire\config.json`.

Edit at least:

- `repository.slug` (for example, `zkrausman/personal-mvp-single-ticket`)
- `repository.path` with the explicit path to that checkout
- `repository.sourceRef` and `repository.baseBranch`
- `dataDirectory` with an absolute per-user mutable-data location
- `sandbox.template`, `sandbox.roleUser`, and sandbox executable settings
- `github.tokenCommand`

The example contains the approved model policy. Every profile uses the
`openai-codex` provider. Plan has two equal deterministic buckets:
`gpt-6-astra` at medium thinking and `gpt-5.6-sol` at high thinking.
Implement is `gpt-5.6-luna` at max, Review and Retro are `gpt-5.6-sol` at
medium, and Test is `gpt-5.6-terra` at high. The controller chooses Plan once
from the canonical repository/ticket identity and persists the selected and
resolved profiles; retries do not reroll it.

`dataDirectory` is the only JSON spelling for mutable data and logs, and
`SQUIRE_DATA_DIR` is its only Squire environment override. If omitted, it
defaults to `%LOCALAPPDATA%\\Squire` on Windows and `$XDG_STATE_HOME/squire`
(or `~/.local/state/squire`) on Linux. The pre-existing `paths.state`,
`paths.bridges`, and `paths.staging` settings remain compatible and resolve
relative to the selected config file. Squire rejects data destinations inside
the repository, including destinations reached through symlinks.
`sandbox.piExecutable` and `sandbox.piAgentDirectory` are paths inside the
sandbox and are not host resolved.

## 3) Run in the foreground or background

A foreground run waits for the workflow and prints its pull-request URL:

```bash
npm run squire -- run <ticket>
```

A background run reserves the ticket, binds the child to the selected config
content and repository source identity, starts a detached controller, and
prints only its run ID. The launcher requests hidden-window operation on
Windows; a provisioned acceptance run must still record the manual observation
that no second console appeared:

```bash
npm run squire -- run <ticket> --background
squire status <ticket>
squire status <run-id>
```

Status is persisted and remains useful when the controller has failed during
credential lookup, ticket fetch, preparation, or publication. It shows the
current phase/attempt, selected provider/model/thinking, elapsed time, HEAD,
terminal error, pull-request URL, and log paths. A completed or stopped run's
elapsed time is frozen from its persisted end timestamp; old v1 records without
start-time/model evidence display `unavailable` rather than invented values.

A detached run is deliberately not a daemon or crash-perfect supervisor. A
forced kill or power loss can leave an ambiguous active reservation. `status`
reports that reservation even when an older terminal run exists. Preserve the
state/logs and sandbox, confirm that no controller is still running, then
perform conservative owner cleanup of the exact reservation rather than
starting a second run for the same ticket. Normal SIGINT/SIGTERM received
before child handoff is persisted as an interrupted launch and releases the
reservation.

## 4) Provision dedicated Pi OAuth

Put a model-only Pi OAuth file in the same per-user Squire directory:

```bash
cp <your-pi-oauth-file> "$HOME/.config/squire/pi-auth.json"
```

Set `sandbox.piAuthFile` to `pi-auth.json`. On Windows, use the corresponding
file under `%USERPROFILE%\.squire`. This file may contain only credentials for
Pi model access. Do not put GitHub or Linear delivery credentials in it, and do
not commit it.

## 5) Configure the host GitHub helper

Set `github.tokenCommand` to a trusted helper that prints a fresh installation
token, for example:

```json
"github": {
  "tokenCommand": ["/path/to/squire-github-token"]
}
```

The token is used only for host-side publication commands and is never passed
to sandboxed Pi processes.

## 6) Run a ticket

```bash
npm run squire -- run <ticket>
```

Use `SQUIRE_CONFIG=/path/to/config.json` or `--config /path/to/config.json`
when an explicit config is needed. `--config` wins over `SQUIRE_CONFIG`.

Expected behavior:

- Plan, Implement, Review, Test, and Retro run as separate Pi processes.
- A single PR URL is printed on success.
- The PR remains open for the owner; Squire never merges it.
- Retro lessons and proposed follow-ups appear in one `## Retro` PR section.
