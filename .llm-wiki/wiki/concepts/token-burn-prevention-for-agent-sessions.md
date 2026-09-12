# Token-burn prevention for agent sessions

Squire run monitoring is an event-consumption problem, not another agent turn.
The Run Controller writes authoritative persisted JSON state and, after each
committed meaningful transition, publishes a bounded sanitized event to its
per-run outbox. The event has a stable run/ticket identity, state revision,
timestamp, transition type, and bounded phase/attempt/outcome values. It has no
prompt, transcript, credential, title, error, or unbounded log payload.

A host consumer such as `squire watch` blocks on state/outbox **directory**
notifications. Watching a directory is required because state and outbox files
are atomically replaced; watching one inode can miss a Windows rename. The
consumer debounces duplicate/coalesced notifications, deduplicates deterministic
event IDs, and performs a bounded non-LLM reconciliation against authoritative
state after startup and when notifications may have been missed. It exits at
terminal state and never launches Pi or any model merely because a run is idle.

The crash contract is state-first: state replacement is the authority and
outbox publication may lag or be lost after a crash. Consumers therefore accept
at-least-once replay and synthesize only transitions supported by persisted
state when an event is missing. New state records retain bounded, append-only
exact Review/Test remediation-attempt evidence, so a historical attention event
is tied to the actual phase attempt. Legacy aggregate remediation counts are
not enough to reconstruct that mapping and are handled conservatively. A
background reservation that fails before the child claims it emits reservation
and terminal-failure evidence without inventing a run-started transition. The
bounded outbox is not a replacement for state.

Production is separate from consumption. The Run Controller is the only state
writer. `RunNotificationWorker` is a provider-neutral host adapter with a fixed
attention/terminal allowlist, bounded delivery timeout/retries, and an atomic
checkpoint written only after successful delivery. It exposes sanitized event
objects and does not embed prompts or invoke a model. Pi conversation wake-up
and future Discord delivery are integrations over this contract, not event
producers; Discord formatting/delivery remains explicitly deferred.
