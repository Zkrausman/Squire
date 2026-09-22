---
type: concept
title: Node 24 runtime and required-check policy
---

# Node 24 runtime and required-check policy

Squire supports Node.js 24 only (`>=24 <25`) on Linux, Windows and ticket sandbox
templates. Root and ticket-runtime package/lock root engines agree; transitive
engine declarations are dependency-owned. `src/runtime-policy.mjs` is the shared
injectable policy: CLI startup checks before argument/config handling (including
reserved children and read-only commands); npm install and direct build preflights
refuse unsupported versions before native/TypeScript compilation. Refusal names
the detected version and migration commands, before paid model work. Ignoring npm
scripts requires an explicit preflight and subsequent build.

Upgrade host/template PATH to Node 24, stop older controllers, then run `npm ci`,
rebuild native binaries locally and test. Historical artifacts remain readable
under existing integrity/schema rules; old Node 20/22 runs retain their provenance
but do not establish current support or permit recovery/promotion of failed runs.

Test execution requires Node 24 on the launching shell's PATH, including npm
lifecycle children; invoking npm through an absolute Node 24 binary alone does
not select Node 24 for child `node` commands. `npm test` rejecting Node 22 is an
environment prerequisite failure, not grounds to bypass the build/preflight.
Controller/sandbox owners must select Node 24 for each phase environment; one
agent shell's PATH export does not persist to later phases. Rerun the checks in
the supported environment rather than treating the refusal as a passing result.

`.github/required-check-policy.json` names `node24-only-v1`, replacing the older
unversioned Node 20.17/22.9/24 cohort. Comparisons must disclose the policy version
and exact head. Node 24-only CI retains clean install/build/full tests, both Linux
and Windows filesystem gates, all substantive Windows native/security/ACL/launch/
state/retry/Plan/correction/report/telemetry tests and their existing bounds, and
externally required CodeQL. The manifest records rather than configures CodeQL
branch protection. Workflow validators reject stale policy or missing coverage.

The policy itself needs normal Review/Test/exact-head CI and merge before later
candidates use its cohort; it cannot retroactively bypass failed PR-head checks.
GitHub action-internal Node versions (e.g. v4 checkout/setup-node's Node 20) are
publisher implementation details, not Squire application support. The private
package has no release workflow; native builds and TypeScript share the preflight.

See [operator/runtime policy](../../../docs/node-runtime-policy.md) and
[Windows capture](windows-launch-capture.md).
