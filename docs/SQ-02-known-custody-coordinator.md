# Known-custody coordinator and rebuild readiness

`createKnownCustodyCoordinator({session, source, clock, read_timeout_ms})` composes the existing observation bridge and original-deadline driver for an already acknowledged manager session. It never creates a session, calls start, adopts a startup operation, opens a bus or supplies a native clock/producer. The existing conditional custody assertions remain trusted preconditions, not proof that this host is qualified.

The frozen API exposes `result`, `snapshot()`, `readNext()`, `abort()` and `reconcile()`. Creation arms the existing injected deadline driver without reading a source. Each explicit `readNext()` starts at most one bridge read; no polling or autonomous read loop is added. After each observed event, the coordinator reconciles the existing driver. External session changes such as explicit workspace release require `reconcile()`. Concurrent reads and reads after coordinator response are rejected.

The result is `{status, state, runtime_qualification}` with the existing local response decisions RELEASED, FENCED, DEADLINE or CANCELED. These are not JobRecord outcomes. Raw exit and empty-proof validation remain in the existing session/bridge. Cleanup does not imply artifact verification or task success, and the coordinator does not release a workspace automatically. Explicit abort or the original task deadline uses the existing known-custody stop path; the module adds no manager dispatch implementation or new stop semantics.

`bridge.close()` is an additive passive observation hook. It closes a pending read with status CLOSED, cancels its timer and cooperatively aborts the injected read signal. It never calls session.abort. The session's existing tick still evaluates elapsed task time; close cannot suppress an actual deadline. Later reads on that closed bridge are ineligible. Existing `bridge.abort()` remains a task cancellation API and is not used for disposal.

Coordinator response closes only observation. It does not cancel a pending StopUnit transaction, establish descendant settlement or discharge host custody. A qualified external manager would retain responsibility under the existing contract; no qualification is supplied here. Read-cancellation effects are reflected in the final coordinator snapshot, including uncertainty or cancellation discovered during closure. Delivered snapshots are immutable, and late read outcomes cannot revive the closed reader or rewrite a response.

The original task deadline is unchanged. Clock and source ports must remain bounded, trusted and in one monotonic time domain. The source must honor cancellation to close its resources; AbortSignal is a cooperative request, not resource-closure evidence. There is no durable owner, daemon, retry, admission after process loss or native acceptance.

## Rebuild readiness at this source checkpoint

| Stage | Verified source outcome | Remaining boundary |
| --- | --- | --- |
| SQ-01 core | Validators and deterministic lifecycle are implemented, reviewed and tested. Existing UNKNOWN representation and cancellation remain unchanged. | No integration that observes a real execution and emits its JobRecord is supplied; pure finalization from caller assertions is implemented. |
| SQ-02 execution | Startup uncertainty, private capability-checked adoption, known-custody coordinator, observation/deadline control and async stop ACK/codec are composed under fakes. | No live startup/transport, qualified host custody or native acceptance. Unsafe startup remains disabled. |
| SQ-03 subscriptions | No subscription adapter shipped in this rebuild. | SQ-02 dependency plus exact supported provider/usage and subscription-only admission contract; no model calls or authentication work performed. |
| SQ-04 artifacts | Physical local verifier has owned temporary-file tests for bytes, counts, hashes and failure cases. | Trusted publication/custody and integration into a final task remain unestablished. |
| SQ-05 environment | No new environmental acceptance executed. | Historical child-output incident and no-rerun/denial holds remain. A separately scoped operation and qualification are needed before native work. |
| SQ-06 task integration | This coordinator covers a coherent fake acknowledged-execution segment, including exit/cleanup/release and failure/abort/deadline paths. | Full task entrypoint, provider, startup handoff, artifact/final-record orchestration and environmental acceptance remain incomplete. |

The [reviewed source adoption path](SQ-02-startup-adoption.md) now implements handoff without a second start request or synthetic process allocation, preserving exclusivity, identity, original deadline and cancellation. The next provider boundary is the accepted pure metadata-decoder contract and a selected supported invocation profile before any encoder/launcher. No CLI/schema/profile/version has yet been adopted for launch, and actual transport and host qualification remain separate prerequisites.

The conservative startup API remains source-only behind its compatibility facade and the shared private adoption core. Its caller response is not operation terminality, and its local reservations do not survive process loss. The weaker unacknowledged-discharge and rejected launch-gate candidates remain unimplemented. Original preservation snapshots, historical checkout and private benchmarks are outside this source slice.

## Concrete MVP and conditional benchmark gates

A completed MVP requires a bounded task entrypoint connecting validated specification/admission, safe startup and ownership handoff, subscription-only provider execution, honest native exit/usage metadata, actual nonempty declared artifact witnesses, full owned-descendant settlement and final-only JobRecord emission. The approved SQ-05 environmental acceptance must be established under a separately supported operation; historical failed/denied diagnostics are not reusable acceptance authority.

Outstanding host prerequisites include qualified transport/message identity; cgroup-before-exec and full descendant coverage; stable manager lifetime and failed/nonempty retention; exclusive unit epoch authority/no reuse; supported observation and bounded control behavior; and retained ownership through the accepted failure paths. No flag or pure test qualifies these properties. Config/service/security changes, held native/probe operations and denied retries remain outside current authority.

The owner has conditionally authorized benchmarking after actual MVP completion. A bounded prospective protocol is being coordinated with Lore, preserving historical private benchmarks. There is no current benchmark run or new accepted task protocol. Execution remains gated on MVP acceptance and applicable operation/host permissions; paid fallback, spending, old denied workloads and optimization/hill-climbing are not authorized by that condition.
