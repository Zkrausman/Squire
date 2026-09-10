# First personal Squire run

This page documents a minimal personal setup and run for the committed personal MVP.

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

## 2) Copy the example config into the ignored `.squire` directory

```bash
mkdir -p .squire
cp squire.config.example.json .squire/squire.config.json
```

Edit `.squire/squire.config.json` and set at least:

- `repository.slug` (for this MVP, `zkrausman/personal-mvp-single-ticket`)
- `repository.path`
- `repository.sourceRef`
- `repository.baseBranch`
- `paths.state`, `paths.bridges`, `paths.staging`
- `sandbox.template`
- `sandbox.roleUser`
- `github.tokenCommand`
- `sandbox.piAuthFile`

`.squire/` is in `.gitignore`, so credentials and generated runtime files are not tracked.

## 3) Add a dedicated Pi OAuth file

Create a model-only credential file, for example:

```bash
cp <your-pi-oauth-file> .squire/pi-auth.json
```

Then set `sandbox.piAuthFile` in `.squire/squire.config.json` to `.squire/pi-auth.json`.

- This file must only contain credentials for Pi model access.
- Do **not** put GitHub or Linear delivery credentials here.

## 4) Configure host-side GitHub App helper token command

Set `github.tokenCommand` to a command that prints a fresh installation token to stdout, e.g.:

```json
"github": {
  "tokenCommand": ["/path/to/squire-github-token"]
}
```

Squire only uses this token command for host-side publication steps (branch push and PR operations). The token is never passed into sandboxed Pi phase processes.

## 5) Run a ticket

```bash
npm run squire -- run <ticket> --config .squire/squire.config.json
```

Expected behavior:

- The command creates a single PR URL on success.
- The PR targets/uses repository `zkrausman/personal-mvp-single-ticket`.
- The PR remains open and is handed to the owner.
- Squire never merges the PR.
