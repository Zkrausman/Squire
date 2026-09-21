---
type: concept
title: Node runtime support and required-check cohorts
---

# Node runtime support and required-check cohorts

Squire's personal/internal application runtime is Node.js 24 only, package range
`>=24 <25`, on every supported platform. Node 20/22 are retired and 25+ refused.
This is an explicit owner policy, not a rolling LTS or node-gyp engine claim.

`src/runtime-policy.mjs` is dependency-free JavaScript shared by the pre-build
`scripts/check-runtime.mjs` and compiled CLI. TypeScript copies it into `dist/src`.
`main` checks before reserved/public arguments, configuration, state, launch or
model work. Unsupported execution returns nonzero with the detected version,
supported range and Node 24/reinstall/rebuild remediation. Only the version is
injectable for offline tests; no environment or command-line bypass exists.
`preinstall` and the native install/build wrapper run the same preflight before
native or TypeScript compilation. Engine-strict installation is the earlier
package-manager boundary; ignore-scripts skips hooks and still requires build.

Migration requires an approved Node 24 installation, verifying both node/npm,
reinstalling dependencies and rebuilding native artifacts, and explicitly
restarting controllers after active work is handled. Runtime migration does not
change Windows local-NTFS/ACL/toolchain constraints. Older artifacts remain
readable under existing schema/integrity rules, without rewriting their history;
old successful runs do not establish current runtime support.

`.github/required-check-policy.json` schema 1 / policy 2 identifies
`squire-node24-v2` versus `squire-node20-node22-node24-v1` (the formerly unversioned
cohort). It binds AIDEV-312's original baseline and activates only for descendants
of the merged policy. This change itself still needs the pre-existing exact-head
Review/Test/CI acceptance; no failed PR head can be reinterpreted, promoted or
waived by the manifest. Cohort comparisons must disclose ID/version and exact
head/base and explicitly identify this boundary, not silently pool gate sets.
The manifest is evidence metadata, not controller or branch-protection authority.

All first-party CI commands select Node 24. Required clean install/build/tests,
Linux **and** Windows filesystem integration, the entire Windows native/ACL/
launch/state/owner/controller/supervision/correction/retry/telemetry command,
15-minute job and 5-minute step bounds, 120-second Windows per-test bound, and
unconditional failure propagation remain. External CodeQL is required separately;
the manifest's logical ID cannot prove GitHub settings or scan success. Linux
fixtures are not native Windows evidence. Workflow and manifest validators plus
negative probes lock this contract together.

No release/publish workflow exists here; the package is private. Third-party
checkout/setup-node v4 action implementation runtimes (upstream Node 20) are
runner-managed and distinct from the selected Squire application runtime. Root
transitive and `.github/runtime` dependency engines remain upstream metadata,
not support claims. Action/runner upgrades are audited separately.

Authorities: `docs/node-runtime-support.md`, `package.json`,
`.github/required-check-policy.json`, `.github/validate-ci-workflow.mjs`.
Related: [Windows launch capture](/concepts/windows-launch-capture.md),
[Background state and status](/concepts/background-run-state-and-status.md).
