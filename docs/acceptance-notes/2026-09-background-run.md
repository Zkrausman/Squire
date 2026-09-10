# AIDEV-259 background-run acceptance note

The live Linear/Docker Sandbox/GitHub environment was not provisioned in this
implementation sandbox. Consequently no live ticket, run ID, polling trace, or
PR URL is claimed here. The required live proof remains:

```bash
squire run <approved-ticket> --background
squire status <approved-ticket>
squire status <returned-run-id>
# confirm the resulting PR is open and unmerged
```

Focused automated coverage exercises detached argv/options (`windowsHide`,
ignored stdin, and no shell), a real short-lived detached Node fixture with
file-backed stdout/stderr, cross-process serialized state updates, conservative
reservation release races, pre-handoff SIGINT/SIGTERM interruption, bootstrap
failure fallback, status control escaping, orphan-reservation reporting, and
duplicate-ticket rejection. These tests verify launch options, not a human
observation that Windows displayed no console window. A provisioned
Windows/Linux run should still record that manual no-window observation and the
open, unmerged PR URL in this note.

## Preserved prior failure evidence

The recovered run reported two real-Pi startup integration failures. Those
fixtures invoke `RealPiProcessFactory` directly rather than the background
launcher, depend on the pre-provisioned absolute `/ticket/runtime` install, and
share a fixed temporary resource root guarded by live-PID ownership. Source
inspection therefore found no direct background/status code path in those
failures, but it does not prove they were environmental. They remain unresolved
evidence: reproduction in a clean, correctly provisioned environment is a
blocker, while a clean rerun would support an environmental classification.
