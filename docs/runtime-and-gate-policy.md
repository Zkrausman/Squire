# Node 24 runtime and required-check policy

Squire's only production runtime is stable Node.js 24 (`>=24 <25`), on every
platform. Install Node 24 before `npm ci` / `npm run build` / `npm run squire`.
The CLI checks the actual runtime before parsing arguments, reserved-child
handling, configuration, credentials, providers, or model work. There is no
command-line or environment-variable bypass. Every public command is gated,
including read-only status/watch/telemetry.

The governed Node 22 phase sandbox may still install (with an engine warning),
build, import modules, validate workflows and run `npm test`. This is bootstrap
compatibility, **not production support**. No module-import/build-script runtime
guard or engine-strict requirement is added to that path. Test-only imported
launchers inject a supported version under Node 22; Node 24 integration tests
use the actual production executable. Eligibility tests inject 20/22/24/25
version strings, not alternate executables. Windows native build prerequisites
and security boundaries are unchanged.

## Prospective comparison boundary

[`.github/required-check-policy.json`](../.github/required-check-policy.json)
schema/version **1** is the repository-owned cohort-comparison gate-policy
boundary. There was no manifest at the trusted baseline. This version records
these application gates on Node 24 only:

- `clean-install-build-test`
- `filesystem-event-integration (ubuntu-latest)`
- `filesystem-event-integration (windows-latest)`
- `windows-launch-capture (24)`

Advanced [CodeQL](../.github/workflows/codeql.yml) runs on pull requests and
pushes to protected default branch `main`, analyzing both languages:

- `Analyze (javascript-typescript)`
- `Analyze (actions)`

GitHub CodeQL default setup is disabled; advanced setup is authoritative.
GitHub's aggregate `CodeQL` check is also expected **when emitted**, but is not
a repository-configured job. The artifact compares workflow-emitted identities;
it does not configure or claim branch-protection settings or an external manifest.

`node .github/validate-ci-workflow.mjs` cross-checks both workflows, action
versions, runtime metadata/lock, gate identities, ordering, commands, permissions,
and unchanged timeout bounds against the policy. Its negative-probe companion
rejects missing or disabled gates/languages, status masking, weakened bounds,
and policy mismatches. Native Windows, ACL, launch, telemetry, verification,
launch retry, filesystem, full build/test and clean-tree coverage remain mandatory.

Acceptance requires fresh exact-head Node 24 hosted Linux/Windows and advanced
CodeQL results. Local Node 22 checks prove bootstrap behavior only; they do not
replace native Windows or CodeQL evidence. Historical artifacts and prior failed
heads remain readable, are not rewritten, and are not current-runtime evidence.
