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
- `sandbox.template`, `sandbox.roleUser`, and sandbox executable settings
- `github.tokenCommand`

The example contains the approved model policy. Plan has two equal deterministic
buckets: `gpt-6-astra` at medium thinking and `gpt-5.6-sol` at high thinking.
Implement, Review, Test, and Retro use their fixed approved profiles. The
controller chooses Plan once from the canonical repository/ticket identity and
persists the selected and resolved profiles; retries do not reroll it.

`state`, `bridges`, and `staging` are simple relative paths and resolve beside
the selected config file. `sandbox.piExecutable` and
`sandbox.piAgentDirectory` are paths inside the sandbox and are not host
resolved.

## 3) Provision dedicated Pi OAuth

Put a model-only Pi OAuth file in the same per-user Squire directory:

```bash
cp <your-pi-oauth-file> "$HOME/.config/squire/pi-auth.json"
```

Set `sandbox.piAuthFile` to `pi-auth.json`. On Windows, use the corresponding
file under `%USERPROFILE%\.squire`. This file may contain only credentials for
Pi model access. Do not put GitHub or Linear delivery credentials in it, and do
not commit it.

## 4) Configure the host GitHub helper

Set `github.tokenCommand` to a trusted helper that prints a fresh installation
token, for example:

```json
"github": {
  "tokenCommand": ["/path/to/squire-github-token"]
}
```

The token is used only for host-side publication commands and is never passed
to sandboxed Pi processes.

## 5) Run a ticket

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
