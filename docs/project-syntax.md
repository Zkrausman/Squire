# Explicit selected-project-file syntax evidence

`executeProjectSyntax` provides a bounded syntax observation for one explicitly
selected Node 24 ES module. It shares the private child mechanics in
`limited-generated-executor.mjs` with the historical Q218 and single-JavaScript
wrappers. Those wrappers retain their original fixed source paths and contracts.
No additional runtime source dependency is introduced for those profiles.

```js
import {executeProjectSyntax} from '../src/project-syntax.mjs';

const evidence = await executeProjectSyntax({
  project_dir: '/explicit/project-root',
  source_path: '/explicit/project-root/src/main.mjs',
  timeout_ms: 5000,
  deadline_ms: originalDeadline
}, {spawn, clock, abortSignal});
```

This example describes an interface, not execution authority. The caller must
separately authorize any invocation. No global spawn, clock, filesystem,
provider operation or launch default is supplied. Importing the module launches
nothing. The optional `abortSignal` is caller supplied; `clock` must supply
cooperative `now()` and `schedule(delay, callback)` ports. Scheduling must return
a cancellation function and must not invoke its callback inline.

The specification is closed: required fields are `project_dir`, `source_path`
and `timeout_ms`; only `deadline_ms` is optional. It is captured synchronously
before injected callbacks. Proxies, accessors, custom prototypes, symbols,
`toJSON` and other extra properties reject without invoking them. Ordinary
objects and null-prototype data objects are accepted.

`project_dir` must be an absolute normalized nonroot path. `source_path` must be
an absolute normalized strict descendant ending exactly in `.mjs`. The relative
source path preserves ASCII bytes and casing and follows the existing project
path rules: at most 256 characters, seven segments and 64 characters per segment,
using only ASCII letters, digits, `.`, `_`, `-` and `/`. Empty, dot and traversal
segments, backslashes, controls and DOS device components reject. Components
named `stage-manifest.json`, `export-manifest.json` or `package-manifest.json`
reject case-insensitively. The first component cannot be `project`, `evidence`
or `frames`, case-insensitively. This single-file interface builds no collision
inventory.

`timeout_ms` is a positive safe integer at most 5000. A supplied `deadline_ms`
must be a nonnegative safe integer in the injected clock's time domain. The
effective deadline is the earlier of that original deadline and start time plus
the timeout. An already aborted signal or already expired deadline prevents
spawn. Invalid clock observations or scheduling behavior cannot establish a
successful syntax observation.

The sole command uses pinned `NODE_RUNTIME.path` with exactly
`['--check', source_path]`, `cwd: project_dir`, `shell: false`,
`detached: false`, ignored stdin and piped stdout/stderr. It uses the existing
`programEnvironment(source_path)` mechanism: only `PATH=/bin:/usr/bin`,
`LANG=C.UTF-8` and its path-derived `TMPDIR` are supplied. In particular, TMPDIR
is the `.tmp` child of the source path's third enclosing directory; this API
does not redefine that historical mapping or create the directory.
There is no script, eval, import, loader, installation or extra-arguments mode.

The result preserves the existing execution-evidence shape. `OBSERVED_EXIT`
records a direct-child exit, including a nonzero exit, rather than declaring a
functional PASS. EOF and direct-child exit are separate observations.
`io_state.io_drained` requires both stream EOFs and no observed I/O failure.
Exit before EOF permits the existing 500ms drain interval; incomplete drain
withholds complete I/O evidence.

Stdout and stderr each retain the existing 65,536-byte observation cap, with
overflow represented by the bounded 65,537-byte counter. Timeout and abort use
the existing signal attempts, 1000ms TERM grace and 1000ms KILL observation
wait. A child awaiting its spawn event has the existing 2000ms allocation wait.
These bounds require a responsive parent event loop and cooperative injected
ports. They do not provide a hard bound against a blocking port.

Signal acceptance does not establish termination. Direct-child exit does not
establish descendant shutdown. An unsettled child uses the existing retained
child and passive `late_observations()` mechanism; a late exit does not rewrite
the settled result. `runtime_admitted` remains false, `descendant_guarantee`
remains `NONE`, and `workspace_reuse` remains `NOT_AUTHORIZED`. There is no
automatic retry, cleanup, workspace recycling or new execution service.

Source identity is caller supplied and is not verified by a syntax exit. This
API performs no filesystem reads and makes no claim that input bytes were
immutable, that paths resolve without symlinks, or that a selected artifact's
contents stayed unchanged. An upper layer must bind the actual selected
artifact before and after any separately authorized invocation. Syntax evidence
does not establish task correctness, provenance, installation, dependency
availability, native qualification or functional acceptance.

`test/project-syntax.test.mjs` is a standalone fake-only test file using
EventEmitter children, streams and injected clocks. It never spawns Node,
contacts a provider, reads generated source or executes a program. Package
exports, test-list integration, full ordinary CI and independent review remain
separate custodian work.
