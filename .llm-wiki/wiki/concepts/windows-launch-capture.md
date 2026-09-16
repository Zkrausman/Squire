---
type: concept
title: Windows detached launch capture
---

# Windows detached launch capture

Windows Node mode bits and unsupported POSIX no-follow flags cannot prove launch-material confidentiality or identity. Builtin prompt capture works in memory; custom roots must explicitly fail closed until native prompt traversal is supported.

The launch-only native boundary (`native/windows-launch.cc`, `src/personal/windows-launch.ts`) creates protected material/log/phase-input children with current-user, SYSTEM and Administrators DACLs from inception. Extra readers, including inherited `CodexSandboxUsers`, are rejected. Existing unsafe objects are never repaired. Ancestor read/traverse differs from protected-child confidentiality: ancestor ownership and delete/delete-child, write attributes/EA, ACL/owner mutation threats still require validation. The exact OS TrustedInstaller service SID is trusted only for ancestor ownership/mutation, not for sensitive child reads/ownership.

Traversal and rename are relative to retained native directory handles. Reparse rejection, handle DACL/owner checks and link-count checks complement (not replace) no-delete-sharing. Reads retain the same file handle, deny concurrent writers/deleters, and preserve the immutable envelope's reservation/source/config/state binding and digest validation before child claim. Publication never overwrites an existing envelope. Node inheritance must use libuv's descriptor table: `_open_osfhandle` in an addon's private CRT can yield `spawn EBADF` despite apparently valid numbers.

Windows builds require existing Python/MSVC/Windows SDK and the locally built addon. Missing support is an actionable error, never a mode-bit or path-only fallback. POSIX does not build/load it. Choose fresh dedicated destinations under validated safe ancestors; common TEMP or data-drive ACLs can permit extra principals to mutate ancestors. Do not weaken production policy to make fixtures pass.

The bounded `windows-launch-capture` CI gate checks real native ACLs/reparse/hardlink/replacement rejection and real detached CLI/bootstrap consuming builtin capture through all five stubbed Pi phases. No model fees, installed activation or live sandbox acceptance is implied. Pre-existing state/config/auth/bridge confidentiality remains separate; phase-input files are copied directly by the transport rather than routed through a host bridge. Host process exit/kill does not prove sandbox quiescence.

Authority: `docs/personal-mvp.md` (Windows capture boundary). Regression seams: `test/personal-windows-launch.test.ts`, `test/personal-launch-material.test.ts`, `test/personal-background-status.test.ts`.

Related: [Immutable layered prompt policy](/concepts/immutable-layered-prompt-policy.md), [Background state and status](/concepts/background-run-state-and-status.md).
