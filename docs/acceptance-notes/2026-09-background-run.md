# AIDEV-259 background-run acceptance note

## Implement evidence (2026-09-11)

The focused background/status suite ran on Linux after the launch-identity and
source-before-workspace fixes:

```text
node --test dist/test/personal-background-status.test.js
37 passed, 0 failed

npm test
399 passed, 1 skipped, 0 failed
```

The real-process fixtures verified that a short-lived parent returns before its
detached child completes and that both inherited file-backed logs survive the
parent exit. The status fixture verified exact historical run-ID lookup beside
a readable active replacement, while ticket lookup still selects the active
replacement. The tests also cover detached argv/options (`windowsHide`,
ignored stdin, and no shell), serialized state updates, conservative
reservation races, pre-handoff SIGINT/SIGTERM interruption, bootstrap failure
fallback, status control escaping, orphan-reservation reporting, duplicate-ticket
rejection, and closed configuration/source-ref validation. These are Linux
automated observations; they do not claim a manual Windows no-window
observation.

## Live Linear/Docker/GitHub evidence

No authorized live ticket was run from this implementation sandbox. It has no
per-user Squire configuration, Linear credential, Pi executable, or GitHub
installation-token helper/authentication, so there is no genuine ticket ID,
background run ID, completion-polling trace, or open unmerged PR URL to record.
The live acceptance gate remains pending on the provisioned host. The required
operator evidence is:

```bash
squire run <approved-ticket> --background
squire status <approved-ticket>       # record launching/preparing progress
squire status <returned-run-id>       # poll through completed
# record the resulting open, unmerged PR URL and Windows no-window observation
```

This committed note records repository-verifiable coverage and the live
acceptance procedure; it is not current-run completion evidence. Launch and
no-window behavior are observed when the run starts, and progress polling is
observed while it runs. Completion, the open/unmerged PR identity, and
post-publication CI follow later. After publication, record the complete
evidence package externally against the Linear ticket or PR; never mutate the
accepted branch solely to backfill that evidence.

## Preserved prior failure evidence

The recovered run reported two real-Pi startup integration failures. Those
fixtures invoke `RealPiProcessFactory` directly rather than the background
launcher, depend on the pre-provisioned absolute `/ticket/runtime` install, and
share a fixed temporary resource root guarded by live-PID ownership. Source
inspection therefore found no direct background/status code path in those
failures, but it does not prove they were environmental. They remain unresolved
evidence: reproduction in a clean, correctly provisioned environment is a
blocker, while a clean rerun would support an environmental classification.
