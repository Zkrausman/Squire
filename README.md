Squire runtime is **Codex only**. See [the Codex limited adapter](docs/CODEX-limited-adapter.md). One separately admitted `ndjson-log-summarizer v5` operation completed with one generation, a successful syntax check and all 17 frozen fixtures passing. This establishes that task's conformance under the documented direct-child limits; each new native operation still requires its own admission and fresh readiness evidence. Earlier AGY trials and provider profiles below remain historical wrong-integration evidence.

# Squire replacement — core, execution candidate and artifact verifier

Use the [offline run summary](docs/offline-run-summary.md) to read an existing
Q218 receipt: `node bin/squire-report.mjs <receipt-path>`. It separates generation,
syntax and fixture conformance without launching a task or reading its artifact.

[Single-JavaScript task preparation](docs/single-js-tasks.md) accepts an explicit
public-text request without editing the Q218 recipe. Generation and syntax-only
readiness remain separate from functional correctness and native admission.

The current limited path uses the Codex adapter and bounded coding entrypoint. The earlier [limited foreground MVP](docs/LIMITED-MVP.md) records the historical AGY implementation and its acceptance checkpoint; its native AGY entrypoint is now disabled. Neither path establishes the older manager design's full descendant or recovery guarantees.

The previous Squire implementation is retired from the current working tree. Its Git history remains intact, and the source custodian verified a private snapshot and restoration of both canonical history and the divergent dirty checkout before this replacement. The private historical `squire-benchmarks` repository is unchanged.

This replacement implements the pure SQ-01 library from the owner-approved Lore plan and independently reviewed internal contract: JobSpec validation, final-only JobRecord validation, immutable lifecycle values, permanent cancellation and guarded settlement/final emission. SQ-02 adds a metadata-only execution wrapper and Linux Node launcher candidate, exercised here only through injected operations. It requires supplied owned-group controls; no native descendant observer or signalling implementation is supplied. That older supervision candidate is not a usable task runner. SQ-04 adds a physical local artifact verifier with real temporary-file tests. The older core has no runnable entrypoint; the limited path has a separate explicit acceptance command. No automatic publication is included.

With Node24, run `npm test`. No install or dependencies are needed. The selected tests run in one Node test process, with injected process operations and owned temporary file fixtures. They launch no child processes, models, authentication flows, apps or benchmark workloads.

```js
import {createLifecycle, advanceLifecycle} from './src/lifecycle.mjs';

// Caller supplies identities, budgets and observations; no phase executes here.
const submitted = createLifecycle(spec);
const canceled = advanceLifecycle(submitted, 'EVENT_USER_ABORT');
// canceled.lifecycle_status === 'TERMINAL_SETTLEMENT'
// canceled.terminal_intent === 'CANCELED'; canceled.record === null
```

See [the pure core contract](docs/SQ-01.md) and [SQ-02 source and acceptance boundary](docs/SQ-02.md), plus [SQ-04 physical verification](docs/SQ-04.md) before using these APIs. The pure core treats supplied observations and digests as assertions; SQ-04 reads actual bytes within its documented staging-tree limits. Neither supplies trusted custody. The approved amendment represents unobserved post-spawn settlement as UNKNOWN in fail-closed final records; pre-spawn settlement remains null. This grants no cleanup assurance or retry. The host child-output incident remains unresolved; all runtime and diagnostic holds remain. Benchmarking is conditional on a completed, qualified MVP; hill climbing remains deferred.

The owner-approved conditional [systemd manager custody source contract](docs/SQ-02-manager-custody.md) adds injected service interfaces and synthetic tests. It has no real manager transport or host qualification and is separate from the legacy process-group candidate.

The [asynchronous observation bridge](docs/SQ-02-observation-bridge.md) consumes one injected event at a time after custody acknowledgement. It supplies no bus transport, service creation or runtime qualification.

The injected [deadline driver](docs/SQ-02-deadline-driver.md) drives the original custody budget while observation reads are idle. This is fake-tested scheduling source, not host qualification or a runnable native task coordinator.

The [asynchronous StopUnit acknowledgement branch](docs/SQ-02-async-stop-acknowledgement.md) is source/fake-tested after known custody. Async start-deadline policy and all real transport/native qualification remain incomplete.

The [pure StopUnit message codec](docs/SQ-02-stop-unit-codec.md) validates supplied message correlation after known custody. It supplies no bus connection or independent InvocationID attestation.

The [conservative startup-operation model](docs/SQ-02-startup-operation.md) separates a retained unresolved operation from a bounded passive caller wait. It has no dispatch port, emits no JobRecord and does not enable unsafe/native startup.

The [known-custody coordinator and readiness map](docs/SQ-02-known-custody-coordinator.md) join the existing observation and deadline pieces after acknowledgement under injected operations. The full task path remains incomplete.

The [source-only startup adoption path](docs/SQ-02-startup-adoption.md) connects an acknowledged operation to the existing session/coordinator through one private lexical core. It preserves original deadline/identity and coordinates local reservations without a second start RPC.

SQ-03 now includes [pure provider metadata decoders](docs/SQ-03-provider-metadata.md) for bounded AGY JSON and Codex JSONL bytes. These seams preserve reported counter provenance and wrapper observations without invoking a provider or determining task outcome. AGY one-shot JSON is the first selected source-only profile; invocation encoding and all runtime qualification remain separate.

The first [AGY source profile](docs/SQ-03-agy-profile.md) prepares fixed-cap, version-matched argument data with original deadlines and `runtime_admitted=false`. It includes no launcher or output collector; native startup stays disabled.

An [injected output collector](docs/SQ-03-output-collector.md) now models bounded AGY chunks, EOF and raw exit with original-deadline and callback-reentrancy guards. It contains no native producer, async pump or custody action.

The [fake task integration path](docs/SQ-06-injected-task-path.md) exercises accepted AGY, ownership, output, artifact and lifecycle interfaces together with explicit synthetic observations. It adds no production runner or runtime qualification.

The [injected source task coordinator](docs/SQ-06-injected-task-coordinator.md) now composes the accepted provider, custody, output, artifact and lifecycle interfaces under one original deadline. It requires explicit admission and quiescence evidence, withholds unrepresentable records and adds no real dispatch or runtime admission.

The additive [Q218 public coding preparation](docs/Q218-source-only-coding.md) supplies source-format collection, injected staging/execution seams and 17 frozen public fixture scenarios. Its initial source-only checkpoint preceded the separately admitted Codex operation described above; that operation does not grant standing authority for another run.

[Q218A bounded source/config preparation](docs/Q218A-source-preparation.md) adds a disabled-by-default explicit native adapter and frozen one-case operation recipe. Provider, syntax and generated-program operations still require the exact scoped operator admission; source/fake tests do not grant it.

[Finite safe decode diagnostics](docs/limited-safe-diagnostics.md) retain bounded rejection codes and validated metadata without raw transport/error retention or weaker validation. This cannot recover the original stopped attempt's cause or reopen it.

[Local rejected-response diagnostics](docs/local-rejected-retention.md) add bounded private capture and exact response lengths, with closed public metadata, original-deadline handling and no raw model-tool access. Historical attempts remain frozen; fresh execution requires the existing scoped gates.
