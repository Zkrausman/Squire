# Squire replacement — partial SQ-01

The previous Squire implementation is retired from the current working tree. Its Git history remains intact, and the source custodian verified a private snapshot and restoration of both canonical history and the divergent dirty checkout before this replacement. The private historical `squire-benchmarks` repository is unchanged.

This first replacement slice implements only a pure library from the owner-approved Lore plan: JobSpec validation, terminal-only JobRecord validation, immutable lifecycle values and the unambiguous success path. It is **partial SQ-01**, not a usable task runner. No CLI, process launcher, provider adapter, artifact reader, telemetry writer or automatic publication is included.

With Node24, run `npm test`. No install or dependencies are needed. The selected tests run in one Node test process and launch no child processes, models, authentication flows, apps or benchmark workloads.

```js
import {createLifecycle, advanceLifecycle} from './src/lifecycle.mjs';

// Caller supplies the explicit spec; this module generates no identities or budgets.
const submitted = createLifecycle(spec);
const running = advanceLifecycle(submitted, 'RUNNING');
```

See [the current contract boundary](docs/SQ-01.md) before using these APIs. In particular, caller-supplied record fields and digest strings are assertions, not observations or custody proof. The host child-output incident remains unresolved. Runtime qualification and every existing diagnostic/no-rerun hold remain separate from these pure tests. Benchmarking and hill climbing are deferred.
