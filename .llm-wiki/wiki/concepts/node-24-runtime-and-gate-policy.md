---
type: concept
title: Node 24 runtime and required-check policy
---

# Node 24 runtime and required-check policy

Squire's application contract is Node.js 24 only, `>=24 <25`, on host and ticket
sandbox. Node 20/22 are retired and 25+ is unsupported. Root and ticket-runtime
package/lockfile metadata agree; dependency-owned engines are not rewritten.
`src/node-runtime-policy.mjs` supplies bounded actionable diagnostics, CLI
public/reserved preflight before config/state work, native install/build checks,
and a controller-owned sandbox preflight before runtime installation and model
credential copy. It is copied by TypeScript into the compiled tree. Injection is
a test seam, not a user-configurable runtime bypass.

Migrate host and sandbox template to Node 24, use `npm ci --engine-strict`, then
rebuild native artifacts. Ignore-scripts installs still need the build and
engine-strict. Existing historical state/telemetry/artifact readers stay intact
on Node 24; readability neither establishes older-major support nor recovers a
failed run.

`.nvmrc` selects major 24 for developer version managers; npm does not apply it
automatically. Noninteractive Review/Test environments must select Node 24 on
PATH for npm, lifecycle scripts and children, not merely invoke npm with a Node
24 executable. Unsupported-major refusal during `npm test` is a runner
prerequisite failure, not suite success or grounds to relax the runtime policy.
The runner owner must provision/select the supported runtime, then rerun the
unchanged exact-head checks. See `docs/node-runtime.md` for selection examples.

`.github/required-checks.json` version 1 / `squire-node24-v1` declares exact
contexts for Linux clean-install/build/test, Ubuntu and Windows filesystem
integration, Windows native launch-capture (24), and CodeQL. Executable workflow
validation and independent negative probes protect the manifest, singleton
matrix, complete security/ACL/launch/retry/correction/telemetry test command,
unconditional execution and unchanged bounds. CodeQL actions are pinned; their
implementation runtimes (like checkout/setup-node's embedded Node 20) are
separate from the Node 24 runtime executing Squire commands.

The manifest does not mutate branch protection: repository rules must require
its contexts. Merge this policy only through normal independent Review/Test and
exact-head hosted gates; subsequent candidates from the merged baseline may use
it. No past failed candidate is promoted or reinterpreted. Cohort comparisons
must disclose candidate/base SHA and gate-policy identity/context set; absent
manifests mean legacy unversioned policy, never implicit Node-24 evidence.
Local Linux validation does not replace native Windows or hosted CodeQL proof.

Authority: `docs/node-runtime.md`, `.github/workflows/ci.yml`,
`.github/validate-ci-workflow.mjs`, `.github/required-checks.json`,
`src/node-runtime-policy.mjs`.

Related: [Windows launch capture](/concepts/windows-launch-capture.md),
[Background state/status](/concepts/background-run-state-and-status.md),
[Transient phase retry](/concepts/transient-phase-launch-retry.md),
[Report correction](/concepts/report-only-format-correction.md).
