---
type: concept
domain: engineering
confidence: high
sources: []
---

# Node 24 runtime and gate policy

Production Squire accepts stable Node.js 24 only (`>=24 <25` in package metadata
and the root lock record). Except for the dependency-free `--version`/`-V` bootstrap,
the CLI checks before argument parsing, reserved child handling, configuration,
credentials, or provider/model work. Version dispatch reads only package metadata,
works before the runtime guard, and rejects version-flag combinations through the
bounded usage path. Imports, build, workflow validation, and `npm test` remain usable
in the governed Node 22 phase sandbox: bootstrap compatibility is not production
support. Version injection is an imported test seam, never an executable environment
override. Node 24
integration tests use the production CLI; pure predicate tests inject version
strings for 20/22/24/25 without installing other executables.

`.github/required-check-policy.json` schema/version 1 introduces the repository's
cohort-comparison gate-policy boundary (no manifest existed at the baseline).
Application CI is Node 24 only: clean install/build/test, filesystem integration
on Ubuntu and Windows, and the bounded Windows native launch/capture cohort.
Native/ACL/launch/telemetry/verification/launch-retry/filesystem/security coverage and
existing timeout bounds are not reduced by the runtime cohort change.

CodeQL default setup is disabled. Repository-managed advanced
`.github/workflows/codeql.yml` runs on pull requests and pushes to `main`, with
least-privilege analysis of `javascript-typescript` and `actions`. Required
analysis identities are `Analyze (javascript-typescript)` and `Analyze (actions)`;
GitHub's aggregate `CodeQL` is expected when emitted, not configured as a job.
The executable CI validator cross-checks workflows and policy and rejects gate,
language, action-version, runtime, permission, timeout and identity regressions.
Neither policy nor validator configures branch protection or an external manifest.

This is prospective: prior failed heads and historical runtime artifacts remain
readable but cannot serve as current-runtime acceptance evidence. Node 22 local
bootstrap tests cannot replace exact-head Node 24 hosted Linux/Windows and
advanced CodeQL results. See [runtime policy](../../../docs/runtime-and-gate-policy.md)
and the [Windows event-consumer boundary](background-run-state-and-status.md).
