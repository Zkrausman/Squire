# Node.js runtime and required-check policy

Squire supports **Node.js 24 only**, explicitly `>=24 <25`, on both Linux and
Windows and in ticket sandbox templates. Node 20 and 22 are retired; Node 25
and future majors are not implicitly supported. This is the application policy,
not a restatement of a dependency's engines.

## Migration and preflight

Select a maintained Node 24 release in the host and sandbox PATH (`node --version`
must report `v24.x.x`). Stop existing controllers before changing their runtime;
do not try to resume an in-flight phase under a different runtime. From the
trusted checkout:

```sh
node scripts/runtime-preflight.mjs
npm ci --engine-strict
npm run build
npm test
```

Rebuild locally rather than copying native binaries from an earlier installation.
Windows still requires Python, MSVC and the Windows SDK; Linux native test builds
still require the existing compiler/Python toolchain. There is no global install
or automatic runtime upgrade. `--ignore-scripts` skips npm lifecycle checks and
native compilation: run the explicit preflight before such an install, and always
build afterward. Package engines are advisory unless npm engine-strict is used.

`src/runtime-policy.mjs` is the shared, side-effect-free version policy. The CLI
checks it before parsing arguments or reading configuration, including reserved
background children, status, watch and telemetry. The install lifecycle and direct
native/TypeScript build path check the same policy before compilation. Unsupported
versions exit nonzero with the detected version, required range and migration
commands, before sandbox/adapters/model work. Test-only argument/process injection
covers refusal without installing alternate runtimes; no environment bypass exists.

Historical run state, reports, telemetry and other artifacts produced under older
Node versions remain readable under Node 24 subject to their existing integrity
and schema checks. Their original runtime provenance is not rewritten. Old green
runs are not evidence of current runtime support, and this policy does not repair,
resume or promote failed candidates.

## Selecting the runtime for local and phase tests

`npm test` builds first and deliberately rejects Node 20/22 before running tests.
An unsupported-version diagnostic is a test-environment prerequisite failure,
not permission to relax the engines, skip the build, or bypass the preflight.
Select Node 24 in the **same shell/environment that launches the test command**;
a Node 24 installation elsewhere on the machine does not change PATH. npm
lifecycle scripts and subprocesses must also resolve `node` to that installation.
Invoking only npm's entry point with an absolute Node 24 executable is insufficient
if its child scripts still find Node 22 on PATH.

For example, with an already installed, trusted Node 24 on POSIX:

```sh
export PATH="/absolute/path/to/node24/bin:$PATH"
node --version # must print v24.x.x
node scripts/runtime-preflight.mjs
npm ci --engine-strict
npm test
```

On Windows, select the Node 24 installation in the test shell's PATH as well.
For automated phase tests, the controller/sandbox owner must provision Node 24
and select it for each phase's command environment; a PATH export in one agent's
shell is not a persistent change to later phase environments. Rerun the actual
checks under Node 24 and retain their exact-head evidence; an earlier Node 22
refusal is not a passing test result.

## CI and comparison boundary

[`.github/required-check-policy.json`](../.github/required-check-policy.json) records
policy version **`node24-only-v1`**, replacing the unversioned Node 20.17/22.9/24
cohort. Report that policy version and exact commit alongside check results in
cohort comparisons; absence of the manifest means the older, unversioned policy,
not equivalent coverage. Do not compare timing/pass rates across this boundary
without disclosing the removed older-runtime executions.

All setup-node selections run Node 24. Required gates remain clean install/build/
contracts/full tests, filesystem events on **both Linux and Windows**, the full
Windows native launch/security/ACL/state/material/retry/background/controller/
Plan/correction/report/telemetry suite, and **CodeQL**. Windows retains the single
Node 24 matrix entry, engine-strict install, unconditional execution, 15-minute
job/5-minute step bounds and 120-second per-test bound. Executable workflow and
negative-fixture validators enforce policy metadata and substantive gate inventory.
CodeQL is externally provided by repository/default setup or branch protection;
the manifest records that requirement, it does not configure or replace it. Owners
must retain its required exact-head result in repository settings.

This policy change itself must pass normal Review, Test and exact-head CI before
merge. Only subsequent candidates from the merged baseline may use the new gate
cohort; do not reinterpret or bypass failed checks on an existing PR head.

## Build/release and GitHub Actions audit

The root package is private; there is no repository release/publish workflow. Its
install/build scripts share the runtime preflight and rebuild via node-gyp before
TypeScript compilation. The first-party ticket-runtime package and both lockfile
root records use the same range; transitive engine declarations remain untouched.

The version-pinned `actions/checkout@v4` and `actions/setup-node@v4` actions execute
using publisher-defined internal runtimes (these v4 actions use Node 20). That
implementation runtime belongs to GitHub/the action publisher, not Squire's
supported application runtime. setup-node's `node-version: 24` selects the runtime
for repository commands. External CodeQL actions likewise own their implementation
runtimes. Updating action releases for runner compatibility is separate maintenance,
not a reason to reintroduce application-runtime matrix entries.
