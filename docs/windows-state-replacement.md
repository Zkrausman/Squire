# Windows state-file atomic replacement

## Scope and mechanism

This patch targets main `44485971e7febe77d48505e76debced34ebb9d45`, not PR30's preserved `90143b9412b2c8a1ae4c895e8551c0f5401caba6`. It does not merge/rewrite PR30 or import its custom-prompt changes. Main already includes PR33's independent detached-process cleanup and PR31's staged-policy validation; both remain intact.

Only `JsonRunStateStore` existing-state replacement uses the new Windows native operation. This includes ordinary state updates, terminal records, source binding and child claims; it is not a terminal-status special case. Exclusive initial creation and the shared **outbox** rename path are unchanged. Outbox publication remains best-effort after state commit and may still encounter a held-reader legacy-rename failure. The retry seam remains available for tests; retry count and delays are unchanged.

The state writer still creates a unique sibling temporary, writes, syncs and closes it inside the existing per-run version/CAS boundary. The native addon then retains every ancestor directory without delete sharing, opens source and destination relative to that pinned parent, rejects reparses, nonregular objects, hardlinks and read-only files, and atomically replaces the existing destination using `SetFileInformationByHandle(FileRenameInfoEx)` with only `REPLACE_IF_EXISTS | POSIX_SEMANTICS`. The zero-initialized, correctly sized filename buffer includes a terminating WCHAR; its length excludes the terminator. No invalidated diagnostic implementation was copied.

The Win32 destination is an absolute name derived from the retained canonical parent (Win32 requires a null RootDirectory). Directory pinning prevents ancestor replacement until completion. Source access excludes surviving source writers and source rename. This does not introduce an ACL repair or a new confidentiality policy for existing state roots: the existing OS access controls and Squire state-store ownership boundaries still apply. Hostile same-user mutation of a state directory remains outside those boundaries; no claim of protection against arbitrary privileged writers is added.

Existing readers with delete sharing may continue reading the old file. New readers see the fully published replacement. Readers denying delete sharing, genuine access denial, and read-only targets still fail. Native failures preserve `code`, `errno`, `win32Code`, `syscall`, and the TypeScript caller adds source/destination paths. Controller original-error/secondary-persistence-error reporting is unchanged. Failure cannot release a running reservation or fabricate a terminal record.

## Unsupported behavior

Support is deliberately restricted to local fixed NTFS volumes and same-directory replacement of two existing distinct regular files. UNC, device/DOS aliases, alternate streams, reparses, hardlinks, cross-directory paths and non-NTFS volumes are rejected. No capability fallback to legacy rename or unlink-before-rename exists. If the OS/filesystem does not support FileRenameInfoEx/POSIX replacement, its native failure is surfaced; there is no silent success or weakening. This restricts Windows state replacement on formerly unqualified storage: such deployments must use supported local NTFS. Linux retains its existing rename behavior.

This promises atomic visibility, not new power-loss durability guarantees beyond the existing write/sync/publication sequence.

## Causal regressions

`personal-windows-state-replace.test.ts` runs actual OS operations with readers synchronized before terminal publication, not injected rename exceptions:

- Legacy `fs.rename` through the existing seam exhausts four attempts with EPERM, leaving running/version 1 and exact reservation ownership.
- Native credential failure/cancellation publishes failed/interrupted version 2 with endedAt and the original error while the ordinary Node reader stays open. The held reader reads exact old bytes; a fresh open reads valid new JSON.
- A test-only PowerShell FileStream denies delete sharing, signals readiness before publication and waits for explicit release. Both terminal transitions fail with EBUSY/Win32 32, retaining exact state bytes and reservation. PowerShell is not used in the production replacement path.
- Boundary tests retain source/destination on rejection. Existing cross-process CAS, old-owner replacement, child claim and immutable-state tests remain mandatory.

The Windows CI matrix includes these tests on Node 24 only (`>=24 <25`); see [migration and prospective gate-policy boundary](node-runtime-support.md). Historical multi-version observations remain evidence, not current runtime support. Local isolated Node distributions do not change global runtimes. A focused matrix is not a claim that every Windows test or filesystem has been exercised; unsupported-API/other-filesystem availability must be reported explicitly.

## Separate dispositions

1. **Demonstrated open-reader EPERM mechanism:** candidate tests establish whether the native replacement fixes this controlled mechanism.
2. **Historical EPERM incident:** the denying actor is still unknown; this patch does not identify it.
3. **Historical cancellation observation:** independently unresolved; controlled cancellation regression is not attribution.
4. **Detached-log EBUSY:** separate PR33 fix; not credited to this primitive.

Original investigation and invalidated-buffer evidence remain outside the repository. No historical state is repaired, no elevated tracing is introduced, and PR30 remains subject to its own exact-head integration/security acceptance.
