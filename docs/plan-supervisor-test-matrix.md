# Deterministic Plan acceptance matrix

The executable selection is either legacy `[]` or exactly `requirements, implementation-design`. Tests use fake command boundaries and local subprocesses, never a live provider.

| Boundary | Required evidence / negative case |
| --- | --- |
| Selection | Empty legacy path; reject partial, reversed, duplicate, unknown before launch |
| Transport | Protected controller/supervisor artifact reference; same stdin guard as normal phases/correction; oversized task and effective policy absent from actual argv/environment; wrong digest/binding/reference rejects before Pi |
| Ownership | Controller starts one supervisor; only supervisor launches children; no state/publication ports or credential environment |
| Order | Requirements completes and validates before Design; distinct sessions; same profile and HEAD |
| Contracts | Closed bounded artifacts, unknown fields/extra JSON rejected; validated Requirements digest passed to Design |
| Clarification | Questions retained, Design skipped, failed aggregate blocks Implement |
| Git | Clean and exact HEAD before/after each child, including failed exits; drift blocks next child |
| Evidence | Aggregate binds supervisor, child sessions, model, captured prompt/launch digests and artifact hashes |
| Interruption | One phase deadline; cancellation delivered to supervisor; remote exit observed before completion; no Design after cancel |
| State | Only controller persists nested progress; stale/late attempt updates rejected; step stays plan |
| Compatibility | Legacy Plan records readable; supervised launch cannot return legacy result; immutable captured prompt regressions |

Focused tests are followed by `npm run validate:contracts` and `npm test`. Wiki verification is cumulative from the run base, including any remediation commits. No live rollout, recovery checkpoints, generic graph, or escalation is introduced.

Windows capture CI additionally covers protected supervisor input manifests/chunks and artifact/journal staging, six-call foreground/detached parity, and the test-only executable transport shim. See [the transport protocol and AIDEV-308/AIDEV-304 deferrals](phase-input-transport.md). Direct remote-guard process-group/uid/gid tests require a Linux root fixture (root or passwordless sudo): Windows host transport tests are not Linux sandbox-close or live-provider acceptance evidence.
