# First run

Install Node 24, Git and the native Docker Sandbox CLI (`sbx`). Build Squire with `npm ci` and `npm run build`. Windows also requires Python, MSVC/Windows SDK and the built native addon; missing security support fails closed.

Use an approved sandbox template containing Node 24, Git, Pi, `sh` and util-linux `setpriv`. The phase role is an unprivileged numeric uid:gid (example `1000:1000`). It must not have an ambient privilege bypass. Tests may create ignored outputs, not mutate tracked source. Verify's Git metadata stays sealed after completion.

Copy `squire.config.example.json` to the per-user config location or select an explicit file with `--config`. Fill in the target repository, exact source ref/base, private data directory outside the checkout, App token helper, sandbox template/auth and target-specific `testCommands`. Model profiles are exactly implement and verify. Retired policy keys are rejected, not migrated silently.

Config selection: explicit `--config`, then `SQUIRE_CONFIG`, then per-user default. POSIX defaults use XDG config/state locations; Windows uses the user profile for config and LOCALAPPDATA/Squire for data. `SQUIRE_DATA_DIR` overrides dataDirectory. Resolve symlinks and effective state/staging/bridge/log paths outside source before launch. Never put credentials in Git or logs.

Provision a pinned declared ticket runtime with `npm ci --ignore-scripts --no-audit --no-fund` under `/ticket/runtime`; Squire's runtime manifest and validator are in `.github/runtime` and `.github/validate-ticket-runtime.mjs`. Repository-controlled package scripts never run in privileged setup. Pi auth is copied privately to the sandbox, not the host GitHub App token. The Linear credential remains a host-side fetch capability.

Before a paid launch prove owner approval, exact GitHub App installation scope, template/toolchain, private paths and configured tests. Preserve dirty owner checkouts. Reserve one ticket, fetch the immutable contract, prepare an isolated exact-base checkout, then Implement and Verify. For details see [workflow](personal-mvp.md) and the operator skill. A failure is not resumable: preserve evidence and ask the owner whether a new run is justified.
