# Squire

Squire delivers one owner-approved ticket through **Contract → Implement → fresh independent Verify**, publishes the exact verified candidate with a GitHub App, and leaves required exact-head CI and merge to the owner.

```sh
squire run AIDEV-123
squire run AIDEV-123 --background
squire status AIDEV-123
squire watch AIDEV-123
squire telemetry aidev-123-0123456789
```

A clean run has two model sessions. Implement is the only writer. Verify combines security/correctness review and configured tests without source-write authority. Failure is terminal and immutable; there is no automatic model replay or report repair. Never merge on model attestation alone.

- [Workflow and authority](docs/personal-mvp.md)
- [First run and configuration](docs/first-run.md)
- [Status](docs/read-only-status.md), [events](docs/run-events.md), [telemetry](docs/telemetry.md)
- [Runtime and required gates](docs/runtime-and-gate-policy.md)
- [Operator skill](skills/squire-operator/SKILL.md)

## Development

Production requires Node 24. Run `npm ci`, `npm run build`, `npm run validate:contracts`, and `npm test`. Native Windows coverage runs on Windows CI; local Linux success is not Windows or CodeQL evidence. Configuration examples require exactly `modelPolicy.implement` and `modelPolicy.verify`; obsolete workflow controls are rejected with migration guidance.
