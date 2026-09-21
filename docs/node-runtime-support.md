# Node.js runtime and required-check policy

## Supported application runtime

Squire supports **Node.js 24 only**, range `>=24 <25`, on Linux and Windows.
Node 20 and 22 are retired; Node 25 and later are not supported. This is the
owner's personal/internal deployment policy, not a promise to follow every LTS.
Use a released Node 24 build, not a prerelease.

`src/runtime-policy.mjs` is the shared, dependency-free policy. It is directly
executable before compilation and copied by TypeScript into `dist/src`.
The CLI checks it before public/reserved-child argument handling, configuration,
state access, process launch or paid model work. Unsupported startup exits 1 with
the detected version, supported range and installation/build instructions, even
for status/watch/telemetry or invalid arguments. There is no environment bypass.
The version parameter is an offline test seam, not a CLI option.

`preinstall` runs `scripts/check-runtime.mjs`; the install/build native wrapper
imports that same preflight before invoking node-gyp. `npm run build` cannot
reach TypeScript after a failed preflight. npm can process dependencies before a
root lifecycle hook, so use `--engine-strict` for package-manager rejection.
`--ignore-scripts` disables hooks, not engine-strict metadata enforcement; it
still requires a subsequent guarded build before running Squire.

## Migration

1. Finish or explicitly stop active work under its existing operational policy;
   changing PATH does not upgrade already-running controllers or children.
2. Install Node 24 and verify `node --version` reports `v24.x.y` and npm resolves
   to that installation. Do not change global installations without approval.
3. In the trusted checkout run `npm ci --engine-strict`, `npm run build`,
   `npm run validate:contracts` and `npm test`. Rebuild native artifacts locally;
   do not carry compiled addons from another installation.
4. Restart Squire using the verified build/Node 24 executable. Ensure any sandbox
   template executing Squire builds/tests also supplies Node 24. Target projects
   retain their own toolchain requirements; this is not a policy for all targets.

Python/C++ prerequisites remain necessary on Linux for the test exit observer;
Windows still requires Python, MSVC and Windows SDK and supported local NTFS.
Runtime migration does not relax ACL, ownership, filesystem or native gates.
Historical runs/artifacts created under earlier Node versions remain readable
on Node 24 under the existing schema/integrity rules. They are not rewritten,
recovered or promoted, and do not establish current runtime support.

## Selecting the test runtime

The committed `.nvmrc` selects major 24 for nvm users: run `nvm install` and
`nvm use` in the checkout before installation or tests. It does not automatically
change a noninteractive shell, a sandbox image, or an already-running process.
Sandbox owners must provision Node 24 in the environment that actually runs
`npm test`; selecting it in a different shell is insufficient.

On a POSIX development shell with npm available, an explicit temporary selection
can also run the local checks without replacing the global Node installation:

```sh
npm exec --yes --package=node@24 -- sh -c 'node --version && npm ci --engine-strict && npm test'
```

This downloads/runs the Node 24 npm distribution; use it only where dependency
installation is permitted. The selected PATH applies to npm lifecycle commands
and their children, not subsequent unrelated shells. Verify the printed version
is `v24.x.y`. Windows operators should select their approved Node 24 installation
and run the same install/test commands there.

A test invocation rejected on Node 22 is a failed invocation, not a passing test
suite or a reason to relax the preflight. Rerun on Node 24 and retain both results;
local reruns do not waive hosted Windows, CodeQL, or exact-head acceptance gates.

## Prospective evidence cohort boundary

`.github/required-check-policy.json` records schema version 1, policy version 2,
cohort `squire-node24-v2`, and predecessor `squire-node20-node22-node24-v1` (a name
for the formerly unversioned gate set). It binds the AIDEV-312 baseline and makes
activation **descendants of the merged policy only**. It is an evidence manifest,
not authority to change controller checks, branch protection, or acceptance.

This policy change itself must pass the pre-existing exact-head Review/Test/CI
requirements through the normal owner-controlled process. A new workflow or
manifest cannot reinterpret failed checks on an existing PR head, waive old
requirements, or retroactively relabel results. Any transition conflict must be
resolved by that process, not by suppressing failures. Only subsequent candidates
based on the merged policy can use the new cohort. Comparisons must record the
cohort ID, policy version and exact head/base, and explicitly disclose a cross-
cohort boundary; do not pool old multi-runtime and new Node-24-only results as
identical gate evidence.

Required gates remain:

- Clean engine-strict install, native/TypeScript build, contracts and full tests.
- Filesystem event integration on **both Linux and Windows**.
- Windows launch/native security, ACL, state replacement, launch material, owner
  observation, background lifecycle, controller, supervision, correction, retry
  and telemetry regressions. Only the Node matrix changes to `[24]`; fail-fast
  stays false, job bounds stay 15 minutes, test bounds stay 5 minutes, and the
  Windows per-test bound stays 120 seconds. No substantive regression is removed.
- **External CodeQL**, still required on the exact head. This checkout has no
  CodeQL workflow; repository/default-setup and branch-protection configuration
  own its actual check identity. The manifest's `CodeQL` ID identifies that gate,
  not a replacement status or proof it passed. Verify the external result before
  merge; a local manifest validator cannot prove GitHub settings or scan success.

## Build/release and Actions audit

The package is private and has no publish/release workflow in this checkout.
The supported source-install path and native/TypeScript build entry points are
listed above; CLI and detached children use the selected application runtime.
All three first-party CI jobs select Node 24 via `actions/setup-node@v4`; install,
build, tests, validators and the pinned ticket-tool provisioning commands execute
on that selected runtime. The executable workflow validator and negative probes
lock the cohort declaration and the existing unconditional/failure-propagating
security and filesystem commands together.

`actions/checkout@v4` and `actions/setup-node@v4` are third-party actions whose own
implementation runtime is defined upstream (these v4 JavaScript actions declare
Node 20). That runner-managed runtime is **not** the Node executable installed
for Squire and is not application Node 20 support. Audit action upgrades and
runner compatibility separately; do not rewrite action internals to express this
application policy. Similarly, transitive engine fields in the root lockfile and
`.github/runtime` describe upstream dependencies. Only the root application
package/lock engine record declares Squire support; upstream metadata and the
separate pinned phase-tool bundle are intentionally unchanged.
