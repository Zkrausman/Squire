# Squire replacement — core, execution candidate and artifact verifier

The previous Squire implementation is retired from the current working tree. Its Git history remains intact, and the source custodian verified a private snapshot and restoration of both canonical history and the divergent dirty checkout before this replacement. The private historical `squire-benchmarks` repository is unchanged.

This replacement implements the pure SQ-01 library from the owner-approved Lore plan and independently reviewed internal contract: JobSpec validation, final-only JobRecord validation, immutable lifecycle values, permanent cancellation and guarded settlement/final emission. SQ-02 adds a metadata-only execution wrapper and Linux Node launcher candidate, exercised here only through injected operations. It requires supplied owned-group controls; no native descendant observer or signalling implementation is supplied. It is not a usable task runner. SQ-04 adds a physical local artifact verifier with real temporary-file tests. No CLI, provider adapter, telemetry writer or automatic publication is included.

With Node24, run `npm test`. No install or dependencies are needed. The selected tests run in one Node test process, with injected process operations and owned temporary file fixtures. They launch no child processes, models, authentication flows, apps or benchmark workloads.

```js
import {createLifecycle, advanceLifecycle} from './src/lifecycle.mjs';

// Caller supplies identities, budgets and observations; no phase executes here.
const submitted = createLifecycle(spec);
const canceled = advanceLifecycle(submitted, 'EVENT_USER_ABORT');
// canceled.lifecycle_status === 'TERMINAL_SETTLEMENT'
// canceled.terminal_intent === 'CANCELED'; canceled.record === null
```

See [the pure core contract](docs/SQ-01.md) and [SQ-02 source and acceptance boundary](docs/SQ-02.md), plus [SQ-04 physical verification](docs/SQ-04.md) before using these APIs. The pure core treats supplied observations and digests as assertions; SQ-04 reads actual bytes within its documented staging-tree limits. Neither supplies trusted custody. The approved amendment represents unobserved post-spawn settlement as UNKNOWN in fail-closed final records; pre-spawn settlement remains null. This grants no cleanup assurance or retry. The host child-output incident remains unresolved; all runtime and diagnostic holds remain. Benchmarking and hill climbing are deferred.

The owner-approved conditional [systemd manager custody source contract](docs/SQ-02-manager-custody.md) adds injected service interfaces and synthetic tests. It has no real manager transport or host qualification and is separate from the legacy process-group candidate.

The [asynchronous observation bridge](docs/SQ-02-observation-bridge.md) consumes one injected event at a time after custody acknowledgement. It supplies no bus transport, service creation or runtime qualification.

The injected [deadline driver](docs/SQ-02-deadline-driver.md) drives the original custody budget while observation reads are idle. This is fake-tested scheduling source, not host qualification or a runnable native task coordinator.
