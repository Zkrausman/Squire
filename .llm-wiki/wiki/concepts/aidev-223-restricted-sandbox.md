---
type: concept
title: AIDEV-223 restricted sandbox
created: 2026-09-06
updated: 2026-09-06
---

# AIDEV-223 restricted sandbox

A bounded trusted host controller for one digest-pinned Docker Sandboxes v0.39.0 microVM per run.

## Definition

The controller owns immutable template/release identities, CAS/lease lifecycle state, exact sandbox/boot/process bindings, private staging transfers, attestations, and the terminal teardown fence. The guest image separates root `squirectl` control from the unprivileged `squireagent` role principal and exposes only measured, bounded operations. `/ticket/bridge` is empty, ticket-specific, untrusted passthrough; repository import and artifact export never use it. Transfer calls require a persisted `SandboxLifecycleService.withTransfer()` reservation.

Pi roles are separate top-level RPC processes. A reverse workflow-store mediator exposes only bound `read` and `assertRunStartAllowed` requests; it does not expose generic store access, CAS, SQL, filesystem, or lease authority. AIDEV-222 owns descriptor-backed Git isolation and AIDEV-228 owns Pi materialization. Host-only resource, network, credential, topology, quota, and exact-removal facts require independently produced, identity-bound conformance evidence; guest output and manually bootstrapped sandboxes are not acceptance proof. Pi 0.84.4 and pi-llm-wiki 0.11.8 are resolved immutably per run rather than pinned in the repository.

## Links

- [trusted-controller-boundary](/concepts/trusted-controller-boundary.md)
- [run-scoped-pi-profiles-and-trusted-footer](/concepts/run-scoped-pi-profiles-and-trusted-footer.md)
- [immutable-handoff-validation](/concepts/immutable-handoff-validation.md)
