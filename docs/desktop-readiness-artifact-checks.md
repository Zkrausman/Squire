# Desktop readiness and artifact checks

This page describes two explicit APIs in
[`acceptance/project-entrypoint.mjs`](../acceptance/project-entrypoint.mjs):

1. A readiness gate for the existing large desktop observation generation
   path.
2. A separate, read-only resolver for candidate stage, artifact and owner
   fixture-check evidence.

They accept different evidence and serve different purposes. Neither evaluates
task correctness or qualifies a native application. Importing the entrypoint
does not run either operation. The existing default, dry-run and legacy routes
retain their behavior; these APIs are not new command-line or package-export
routes.

## Public APIs

| Purpose | API |
| --- | --- |
| Native readiness-gated generation | `runProjectDesktopCodingLargeObservationNativeWithReadiness(configBytes, admission, readinessContextBytes, selectedRouteBytes, abortSignal)` |
| Injected readiness-gated generation | `runProjectDesktopCodingLargeObservationWithReadinessWithPorts(configBytes, admission, readinessContextBytes, selectedRouteBytes, abortSignal, ports)` |
| Native read-only artifact checks | `verifyProjectArtifactChecks(configBytes, artifactContextBytes, abortSignal)` |
| Injected read-only artifact checks | `verifyProjectArtifactChecksWithPorts(configBytes, artifactContextBytes, abortSignal, ports)` |

The injected readiness API uses the existing large-desktop port shape. The
artifact API accepts its own `ArtifactPorts` shape: `fs` with `open`, `mkdir`,
`lstat`, `chmod`, `readdir` and `realpath`; `uid`; `readBytes`; `verifyFile`;
and `reads` with `lstat` and `readChunks`. These are trusted injected functions,
captured with their receivers. The artifact resolver is read-only: `mkdir` and
`chmod` are present for port validation and reuse of the existing stage
verifier, and must not be called by this check.

The native artifact wrapper supplies fixed filesystem and reader functions.
That wrapper does not run an application or consumer check. The readiness
wrapper can continue into the existing generation path after its gate passes;
it does not run the supplied desktop fixture or checker. Either operation
requires its separately authorized inputs. This page does not authorize an
operation.

## Source trust and bootstrap

Both public wrappers validate and copy bounded input data, capture closed
ports, and verify the source pins required for the implementation before
loading the corresponding lazy helper. Each call verifies the pins again,
including when the helper is already present in the module cache. The imports
are fixed literals; callers cannot select a path, loader or importer.

The readiness path verifies the configured runtime and source identities,
then the four fixed companions: readiness evidence, artifact-check evidence,
artifact verifier and job record. The artifact path verifies every
`config.source_pins` identity in sorted order, followed by those same four
companions. It does not add the generation runtime pins to the artifact
resolver's source loop.

The expected hashes are caller-supplied pins. They must describe the intended
current source set; old preparation hashes are not live launch authority.
Verification checks bytes against those expectations, but does not
cryptographically authenticate who supplied them. The source tree must remain
quiescent under owner custody. Verification and module import do not provide
an atomic guarantee against a hostile host changing files between those
steps.

For the artifact API, malformed bootstrap input or failed source verification
produces the fixed `INVALID_ARTIFACT_CONTEXT` error. Cancellation before source
trust is established can produce `OPERATION_ABORTED`. The wrapper does not
load an unverified helper to construct a sidecar. After successful bootstrap,
valid candidate evidence failures are reduced by the resolver to a sidecar;
the wrapper does not replace that result with an outer cancellation error.

The readiness API uses its own fixed errors: invalid captured input is
`INVALID_READINESS_CONTEXT`, failed evidence preflight is
`READINESS_EVIDENCE_BLOCKED`, and pre-trust cancellation is
`OPERATION_ABORTED`. These errors do not fabricate a candidate result.

Direct imports of
[`src/desktop-readiness-evidence.mjs`](../src/desktop-readiness-evidence.mjs)
or
[`src/project-artifact-check-evidence.mjs`](../src/project-artifact-check-evidence.mjs)
bypass the public pre-import source verification guarantee. They are internal
helpers, not substitutes for the public entrypoint.

## Readiness-gated generation

The caller provides the configuration bytes, matching admission, readiness
context, and selected route bytes. The validator accepts only the fixed
Broadway route: backend `broadway`, GDK type `GdkBroadwayDisplay`, display name
`Broadway`, `GDK_BACKEND=broadway`, and `BROADWAY_DISPLAY=:41`. The caller
supplies an `XDG_RUNTIME_DIR` path; the session fields bind the loopback
`127.0.0.1:8121` route, the socket path `${XDG_RUNTIME_DIR}/broadway42.socket`,
and caller-supplied controller/server process identities and socket device and
inode values. The selected route represents the caller-selected future
observer route; it is separate from the generator's environment. The context
binds the route, configuration, definitions, proof, terminal record, source
pins and probe-artifact witness. All structures are closed and bounded, and
numeric fields are checked as safe integers. The caller must supply separately
authorized owner evidence. This API does not start a Broadway server, observer,
browser, fixture or application, and accepts no arbitrary display backend or
X11 fallback.

The proof, terminal, process identities and socket identity values are supplied
claims. The implementation validates their shapes and cross-document
bindings. It physically checks pinned runtime executable, typelib and library
bytes; source, proof, terminal and definition file bytes; and probe-artifact
bytes. It does not independently observe operating-system processes or stat
and attribute the Broadway socket. It therefore establishes no live process
or socket ownership, display focus or session liveness, and does not perform
the claimed GUI observation or run the fixture application. The prospective
desktop descriptor remains `NOT_QUALIFIED`.

Before admission is consumed, the wrapper performs the readiness preflight,
including evidence and scope checks. The generation scope must still be
absent; evidence and probe paths must remain outside it, including after
canonical-path checks. This preflight does not create the generation scope.
Only after preflight and final synchronous binding, freshness and abort checks
does the wrapper consume the existing shared admission fence and mark the
entrypoint fence. No asynchronous wait separates those consuming steps.

After consumption, a final freshness and abort guard runs immediately before
the existing backend spawn call. A late failure keeps the consumed markers;
there is no refund or retry. The existing generation counters count attempts
at their existing seams. In particular, `direct_child_invocations.generation`
is an attempt count, not evidence that a physical producer call occurred.
If a backend call throws, child creation remains unknown unless observed
separately. These APIs do not change `project-runner.mjs` or its counter
semantics.

## Read-only artifact evidence

The artifact API binds `artifactContextBytes` to the exact configuration bytes
and validated configuration. It then:

1. Verifies the candidate stage with the existing large-project stage
   verifier and binds its manifest to the candidate context.
2. Verifies each declared staged artifact or delivered copy using the existing
   artifact verifier and bounded file adapter.
3. Reads and binds each required definition and check receipt in requirement
   order.
4. Returns a closed sidecar and its canonical bytes.

Delivered copies must be byte-identical to their referenced staged artifacts.
This slice does not support transformed or remuxed copies. Check receipts must
bind the job, exact configuration, stage manifest, artifact subset, definition,
policy and check identity. Every required check must have the role
`trusted_owner_fixture`; a `candidate_test` cannot satisfy independent
required coverage.

The result is a frozen `{sidecar, bytes}` container. The sidecar is
deep-frozen; `bytes` is a `Uint8Array` containing canonical encoding no larger
than 65,536 bytes. The operation does not persist, publish or export it.
Callers own any separately authorized private persistence. Relative artifact
names remain in the sidecar and may themselves be private; absolute roots and
raw exception text are not projected.

Coverage has three meanings:

| Coverage | Meaning |
| --- | --- |
| `BLOCKED` | Physical verification or evidence binding is unresolved, or the operation was aborted or encountered a bounded IO failure. |
| `DECLARED_CHECKS_FAILED` | Required receipts are valid and bound, but at least one reports a qualified negative, blocked or explicit not-run outcome. |
| `DECLARED_CHECKS_PASSED` | The nonempty required set has valid bound passed receipts and the declared candidate bytes were physically verified. |

These labels describe evidence coverage only. Even declared-passed coverage
does not mean the application works, the checks were independently
authenticated, or task correctness was evaluated. The fixed sidecar retains
`task_correctness: NOT_EVALUATED`, `task_outcome_evaluated: false`, and
`provenance_authenticity: TRUSTED_CALLER_EVIDENCE_NOT_CRYPTOGRAPHICALLY_ESTABLISHED`.
Encoding caller-provided valid data alone authenticates nothing.

## Bounds and limits

| Data or operation | Bound |
| --- | --- |
| Configuration and evidence context | 65,536 bytes each |
| Selected route | 16,384 bytes |
| Proof, terminal and check-receipt documents | 65,536 bytes each |
| Readiness fixture and observer definitions | 1 MiB each; at most 2 MiB combined across these two pins (also subject to a 16 MiB sum guard) |
| Artifact required-check definitions | Up to 16 definitions; 1 MiB each; 16 MiB combined |
| Four fixed companion source pins | 1 MiB each; 4 MiB combined |
| Readiness runtime pins | 64 MiB each; 256 MiB combined |
| Probe-artifact witness | At most 16 files; 64 MiB each; 4 MiB combined |
| Candidate artifacts | At most 16; 64 MiB each; 128 MiB combined |
| Encoded sidecar | 65,536 bytes |

Artifact-file verification allows the verifier's real one-byte EOF check after
each declared payload: at most 16 additional bytes across the invocation.
This allowance applies to artifact witness reads, not stage reads.

The stage verifier is reused unchanged. Its 4 MiB project limit describes the
accepted decoded package; it is not a total physical-read or memory bound.
Stage file reads can reach the classification cap plus one byte before a
declared-size mismatch is rejected. Its directory inventory materializes
`readdir()` results before checking them, without a bounded enumeration
guarantee. Callers must provide quiescent, owner-managed staging; this slice
does not change the walker.

Filesystem IO is cooperative and may block; abort signals do not preempt a
blocked host call. Process identities in the route and terminal, and socket
device and inode values, are trusted caller or fixture claims whose shapes and
bindings are checked; they are not independent live process or socket
observations. The API establishes no server ownership, focus, continuous
session liveness or all-descendant process custody. No claim of product
correctness, native qualification, provenance, durability or benchmark
acceptance follows from these bounds or results. Historical application or
game outcomes are separate evidence and do not change these limits.

## Tests and CI

The public wrapper integration tests and the two internal evidence test files
use synthetic ports. They exercise source, validation, resolver and IO behavior
under those supplied ports; they do not run a native desktop fixture, checker,
provider or generated application.

The CI project-suite command explicitly runs
[`test/desktop-readiness-evidence.test.mjs`](../test/desktop-readiness-evidence.test.mjs)
and
[`test/project-artifact-check-evidence.test.mjs`](../test/project-artifact-check-evidence.test.mjs)
alongside the existing project tests. The `npm test` script has its own
explicit file list and does not include these two files. A passing unit suite
does not itself establish native, product, provenance or benchmark acceptance.
