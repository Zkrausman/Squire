# Node runtime and required-check policy

Squire is an internal/personal tool supported on **Node.js 24 only**, with the
explicit package range `>=24 <25`. Every Node 24 release is supported. Node 20,
22, other earlier majors, prereleases, and Node 25+ are unsupported. This applies
to the host CLI/controller and repository-controlled Node commands in the ticket
sandbox, not to unrelated target applications' own runtime contracts.

## Migration and preflight

1. Install/use Node 24 on the host and update the configured sandbox template.
   Check `node --version` in both environments; do not merely update npm.
2. From the trusted Squire checkout, run:

   ```sh
   node scripts/check-node-runtime.mjs
   npm ci --engine-strict
   npm run build
   npm run validate:contracts
   npm test
   ```

   Rebuild native outputs rather than reusing an older installation. Windows
   still requires Python, Visual Studio C++ build tools/Windows SDK and local
   NTFS for the native security boundary. Linux tests require the C++ toolchain.
3. Start a new run normally. No runtime override or fallback to older majors is
   supported. An unsupported-runtime diagnostic reports the detected version,
   required range and Node 24 remediation instruction. Check the selected PATH
   if it persists after installation.

`src/node-runtime-policy.mjs` is the shared dependency-free policy. CLI public
and reserved-child dispatch checks before argument/config/state handling;
install and native/build scripts check before repository-controlled build work.
`--ignore-scripts` intentionally disables npm lifecycle hooks: use
`--engine-strict` and run the build afterward. npm may resolve/install dependency
packages before the root lifecycle hook, so engines plus engine-strict are the
install boundary, not a claim that a root hook precedes npm's own work.

The sandbox executes a controller-owned copy of the same preflight as the role
user, independently of the target checkout, before optional ticket-runtime
installation/validation and before copying model credentials or launching Pi.
A template with an unsupported Node fails preparation; update the template,
not the check. `.github/runtime` metadata and clean CI installs use the same
engine-strict contract. Package dependency versions/engines remain their owners'
contracts; a broader dependency engine range does not expand Squire support.

Historical state, telemetry and run artifacts remain readable on Node 24 through
existing compatibility readers. They are not rewritten, recovered, promoted or
made successful by migration, and do not establish current runtime support.

## Required gates and cohort boundary

`.github/required-checks.json` schema version 1 identifies gate policy
`squire-node24-v1`. Its exact GitHub check contexts are:

- `clean-install-build-test`
- `filesystem-event-integration (ubuntu-latest)`
- `filesystem-event-integration (windows-latest)`
- `windows-launch-capture (24)`
- `CodeQL`

CI validates both the workflow and manifest, with independent negative probes.
Linux clean-install/build/contracts/full-test and both filesystem platforms
remain unconditional. The singleton Windows Node 24 job preserves engine-strict
install, native build, the entire ACL/state/launch/retry/Plan/correction/evidence/
telemetry regression command, fail-fast setting and existing 15-minute job,
5-minute test and 120000-ms per-test bounds. CodeQL is unconditional and bounded
with upload permissions confined to its job (`security-events: write`,
`contents: read`, and `actions: read` for private-repository run metadata). Its JavaScript/TypeScript analysis
uses `build-mode: none` (interpreted-language extraction), while the explicit
repository install/build commands still run on Node 24.

The manifest is a reviewable required-check contract, **not an API that changes
GitHub branch protection**. The owner must require these contexts in repository
rules/branch protection and retain CodeQL code-scanning enforcement where
configured. Exact-head hosted Linux, Windows filesystem/native and CodeQL
results must pass through normal Review/Test/CI before merge. Local Linux tests
cannot attest to Windows or hosted CodeQL success.

This change is prospective: merge the policy through normal exact-head gates
first. Only subsequent candidates from that merged baseline may use this
Node-24-only gate set. Never reinterpret a failed existing candidate under the
new policy, drop security tests or loosen timeouts to obtain green checks.

Cohort comparisons must disclose each candidate/base SHA and its manifest
policy ID/context set. Pre-manifest commits are a legacy unversioned policy;
old Node 20/22/24 matrix runs cannot satisfy `squire-node24-v1`. Do not silently
pool their timings or success rates with this cohort. No historical telemetry
schema mutation is needed to record this repository-policy distinction.

## Build/release and GitHub Actions audit

The repository has no separate release workflow; `package.json` install/build,
`scripts/build-windows-launch.mjs`, CLI startup, sandbox preparation and ticket
runtime validation are the controlled runtime paths. TypeScript copies the
shared `.mjs` policy into the compiled CLI tree. All `setup-node` selections in
CI use 24, including CodeQL's repository commands.

`actions/checkout@v4` and `actions/setup-node@v4` implement their actions using
an embedded Node 20 runtime; they are not running Squire under Node 20.
CodeQL init/analyze are pinned to v4.38.1 commit
`1c5b675653bb5c22dbe9b12b556ec555138e09fd` (embedded Node 24). Action-maintainer
runtime changes and runner compatibility are a separate dependency maintenance
concern, not evidence of broader Squire application support.
