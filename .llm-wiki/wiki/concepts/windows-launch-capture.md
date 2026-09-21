---
type: concept
title: Windows detached launch capture
---

# Windows detached launch capture

Windows Node mode bits and unsupported POSIX no-follow flags cannot prove launch-material confidentiality or identity. Builtin prompt capture works in memory. AIDEV-284 adds read-only native custom-root capture on local NTFS, verified from the opened volume; unsupported filesystems fail closed.

The native security boundary (`native/windows-launch.cc`, `src/personal/windows-launch.ts`) creates protected material/log/phase-input children with current-user, SYSTEM and Administrators DACLs from inception. Extra readers, including inherited `CodexSandboxUsers`, are rejected. Existing unsafe objects are never repaired. Ancestor read/traverse differs from protected-child confidentiality: ancestor ownership and delete/delete-child, write attributes/EA, ACL/owner mutation threats still require validation. The exact OS TrustedInstaller service SID is trusted only for ancestor ownership/mutation, not for sensitive child reads/ownership.

Traversal and rename are relative to retained native directory handles. Reparse rejection, handle DACL/owner checks and link-count checks complement (not replace) no-delete-sharing. Reads retain the same file handle, deny concurrent writers/deleters, and preserve the immutable envelope's reservation/source/config/state binding and digest validation before child claim. Publication never overwrites an existing envelope. Node inheritance must use libuv's descriptor table: `_open_osfhandle` in an addon's private CRT can yield `spawn EBADF` despite apparently valid numbers.

Custom source capture is a distinct integrity policy, not the private material reader API. Outsider reader-only ACEs (including sandbox users) are accepted, but root/file authors and owners remain current token user/SYSTEM/Administrators; TrustedInstaller is ancestor-only. Sources are not promised confidential: never place secrets there. All outsider source writes/append/add-child, deletion, attributes/EA, ACL/owner mutations are rejected. Native leases retain the validated chain and each opened file through TypeScript manifest parsing, deduplication and selected-file capture. Repository exclusion uses a retained canonical repository handle; no source reparse path is followed. First successful native open establishes identity, followed by bounded reads and repeated ACL/metadata verification; exceptions and close release all handles. Pre-open trusted-author edits are not historical substitution detection, while unsafe substituted objects fail validation.

The mapping regression uses raw CreateFileMapping/MapViewOfFile and explicitly closes the original file handle, avoiding framework-retained handles. On tested local NTFS, capture denies that surviving writable mapping before consuming bytes; the mapper then proves it is still writable. Sharing plus owner/DACL/reparse/identity checks is the boundary, not an unsupported universal revocation/history claim. Keep the original cancellation regression unchanged: an earlier running-versus-interrupted failure was unexplained, and a later pass does not classify it as harmless or fixed. Recurrence blocks acceptance. A subsequent bounded AIDEV-284 matrix-command run also observed `credential/bootstrap failure` remaining running because terminal state rename exhausted the existing 50/100/200 ms retries with EPERM. The original test already recorded the persistence stack; a single focused rerun passed. This is a readiness blocker with unknown denial origin, not proof of harmlessness or an unrelated/pre-existing defect. Review must consider retained-handle/ancestor interactions as well as external contention; no controller retry/delay change was made.

Supported Node is `^20.17.0 || >=22.9.0`, matching node-gyp engines even for POSIX installations. Windows builds require existing Python/MSVC/Windows SDK and the locally built addon. Exact supported Node minima and Node 24 run bounded Windows CI. Missing support is an actionable error, never a mode-bit or path-only fallback. POSIX does not build/load it. Choose fresh dedicated destinations under validated safe ancestors; common TEMP or data-drive ACLs can permit extra principals to mutate ancestors. Do not weaken production policy to make fixtures pass.

The bounded `windows-launch-capture` CI gate checks real native ACLs/reparse/hardlink/replacement rejection and real detached CLI/bootstrap consuming custom capture after original sources disappear through six captured calls: supervised Requirements and Design, then Implement, Review, Test and Retro. Supervisor input/guard copies use the same protected Windows creation and cleanup; retained validated artifacts and aggregate journals are protected without changing Plan ownership, ordering or evidence lifecycle. The test-only Windows transport executable preserves the real supervisor fork without shell fallback or NODE_OPTIONS inheritance; production never loads it. No model fees, installed activation or live sandbox acceptance is implied. Pre-existing state/config/auth/bridge confidentiality remains separate; phase-input files are copied directly by the transport rather than routed through a host bridge. Host process exit/kill does not prove sandbox quiescence.

Windows ACL test probes must pin the system Windows PowerShell executable and its system Utility/Security module paths. GitHub's `pwsh` shell exports PowerShell 7 module paths through Node; forwarding them to Windows PowerShell 5 can select an incompatible Security module and fail `Get-Acl` autoload. `-NoProfile` alone does not isolate module discovery. A conflicting inherited-path regression protects the shared helper used by CLI fixtures; production transport environment filtering is unchanged. Keep matrix fail-fast disabled to retain evidence from all supported Node versions.

Authority: `docs/personal-mvp.md` (Windows capture boundary). Regression seams: `test/personal-windows-launch.test.ts`, `test/personal-launch-material.test.ts`, `test/personal-background-status.test.ts`.

Related: [Immutable layered prompt policy](/concepts/immutable-layered-prompt-policy.md), [Background state and status](/concepts/background-run-state-and-status.md).

## Report evidence and bounded correction

`native/windows-report-evidence.h` extends the existing Chain/Policy/Snapshot boundary for `WindowsReportEvidence`, behind the shared Linux/Windows report reference protocol. It accepts Buffers and returns tagged native leases plus filesystem identity, never decoded report authority. Private directories/files require current-token ownership and an explicitly protected DACL in addition to the existing principal checks. Local NTFS, canonical handle-path containment, no reparses, one-link regular files, a 2 MiB limit and repeated security/metadata checks are mandatory. Exclusive write/flush is followed by identity-and-byte-verified read-lease acquisition before a reference can be published. Partial crash artifacts have no accepted reference.

Every independent read opens relative to retained ancestors, checks the creation-bound identity, reads exact bounded bytes and rechecks security and metadata. Files deny write/delete sharing through controller continuation and persistence; directory sharing alone is not treated as integrity proof. Explicit phase-finally release and native GC/process teardown release handles but retain evidence files. Capability preflight exercises the native backend before charging correction; unsupported platforms/filesystems/addons and string-only transports have no fallback. Correction eligibility, no-tools execution, the original deadline and independent Review/Test remain unchanged.

`personal-windows-report-evidence.test.ts` covers native security/mutation/lease/crash probes; `personal-windows-report-correction.test.ts` runs the production runner/controller with deterministic command bytes, distinct verified generations and charged cancellation/crash behavior. Linux runs the shared fixtures; the published PR’s exact-head Windows matrix on all three supported Node versions is the authoritative merge gate, not an in-sandbox Windows execution requirement.

## Read-only live-owner observation

`native/windows-owner-observation.h` is distinct from immutable launch/report leases: it opens separate read-only, share-read/write/delete handles on local fixed NTFS, rejects reparse/nonregular/multilink or oversized records, reads through the opened handle, and revalidates file identity. Descendant opens are relative to retained ancestor handles. Exact process evidence uses `OpenProcess` query/synchronize access, native creation time and a zero-time exit check; it never closes an owner's handle or grants mutation/recovery authority. Operation and reservation proof bytes are published by writers, not observers. This boundary intentionally coexists with a legitimate operation handle; it does not relax the exclusive-create mutation mutex or exact-content release rules.

The real-process `personal-owner-observation.test.ts` belongs in every existing Windows launch matrix version. Reserve, claimant-proof-before-state, claim and abandon barriers exercise both independent CLI selectors, including the historical-terminal/replacement regression in the background suite. All configured Windows jobs on the new published exact head remain required before merge; Linux fixture success is not native Windows evidence.

## Launch-retry fixture lifecycle

Launch-retry production fixtures use `launchTestRoot` and native host path joins,
not POSIX-shaped temporary evidence paths on Windows. The same private input,
report-evidence canonical-containment and ACL boundaries apply to each generation;
existing destination collisions must preserve their bytes and never launch or
unlink another writer's input. JSON CAS races and failed/retrying/reserved/
dispatched/returned crash boundaries belong in every supported Windows gate.

Foreground/detached launch-material fixtures stub Linear at the network `fetch`
boundary instead of relying on one ESM prototype identity across Windows URL
spellings. They accept exactly one initial ticket query and reject every other
network request, including post-terminal activity. Incomplete telemetry is
explicitly exercised without suppressing its warning. Config/manifest deletion,
captured prompt/digest parity, reservation cleanup and actual detached child exit
remain required before fixture completion/cleanup. No extra controller retry or
external ticket request is authorized by telemetry/state publication diagnostics.

## Historical private artifacts and ACL fixtures

Historical imports reuse the native report evidence lease's current-owner,
protected-DACL, local-NTFS, no-reparse/link and retained-handle identity checks.
`openHistorical` is read-only with a separate 64 MiB source bound; it does not
raise the 2 MiB report creation bound or weaken permission rejection.

PowerShell `FileSystemRights` string casts accept abbreviations and can resolve
ambiguous names differently across runtimes. The shared test `grant` helper now
requires an exact full enum name (case-sensitive) or numeric value before
`Enum.Parse`. Use `Read`, `ReadData`, `ReadAndExecute`, etc., never `R`. The
cross-platform public-permission regression verifies the actual public read ACE
before asserting rejection and runs unconditionally in Windows Node 20/22/24.
Keep workflow commands and their executable validator contract synchronized.
