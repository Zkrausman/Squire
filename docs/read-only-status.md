# Read-only status and live reservations

`status <exact-run-id>` and `status <ticket-id>` do not acquire the ticket-operation
mutex. They read bounded owner evidence and persisted state, without contacting
Linear, Git, Docker, GitHub, or a model. Reading a missing state directory does not
create it. The event watcher uses the same observation port, including its narrow
terminal-before-release exception; it does not fall back to mutation inspection.

## Authoritative evidence

New reservations retain the existing `locks/<ticket>.lock` run-ID bytes and add
an owner-published `<ticket>.lock.owner` record. It binds the ticket/run, reservation
file identity, random operation token, publishing process PID and native creation
identity. Reserve publishes this proof before its first state; claim publishes
claimant proof before atomically replacing reserved state. This is mutation-side
evidence, never a sidecar manufactured by a status reader.

The ticket-operation marker also contains exact live process identity and the
reservation identity observed while exclusively acquiring the boundary (or the
new reservation's publishing token). Observers validate any retained operation
marker rather than trying to acquire it. Windows readers use separate read-only
handles with read/write/delete sharing, regular single-link/reparse checks, a
bounded read and file-identity revalidation on local fixed NTFS. Process identity
uses native creation time and signaled-exit checking through an independently
opened process handle, not PID existence. Linux uses regular no-follow handle
reads and boot ID plus `/proc` start time and non-zombie process state.

Status brackets two complete selected-ticket state reads with owner snapshots.
Changed snapshots receive at most three attempts; contradictory, missing-required,
malformed, unreadable, dead/reused-process or mismatched evidence stays ambiguous.
A reserved launch's null controller PID is expected: before claim the publisher
is the reserving parent, while a claimant can publish proof immediately before the
started-state replacement only while that exact claimant operation token is still
live. Failed/abandoned claim proof alone cannot authorize reserved state. Once claimed, the state's controller PID must match
the exact claimant proof. Multiple running states fail for **both** selectors.
Historical terminal lookup validates the *replacement* running owner, not the
historical controller. Completed abandon is readable once reservation absence
is stable, even while the abandoning operation is still releasing its handle.

A successful status returns the authoritative record under verified owner evidence.
`owner evidence unreadable or inconsistent` is a sanitized diagnostic, not the
normal consequence of a live controller retaining the operation file. Retry a
changing snapshot; if ambiguity persists, inspect the selected data root, state,
logs and exact controller identity. Older active reservations without the new
proof cannot be upgraded by a reader and fail closed. Terminal history without
a reservation and lightweight embedded read ports remain supported.

## Safety and validation

Observation is **not recovery authority**. Never delete, rewrite, release or steal
a reservation based on status, a responsive PID, or an old proof. Mutation
acquisition, exact-content release, and delayed-release/replacement fencing remain
independent. A crash can intentionally leave stranded evidence requiring the
existing operator recovery procedure. This change authorizes no intervention in
another active run.

`personal-owner-observation.test.ts` launches a separate real owner retaining the
production operation handle and a reservation reader handle. Test-only barriers
cover reserve, before/after claim-state publication, and completed abandon;
independent CLI processes exercise both selectors and compare all state/lock/event
bytes. It runs in the Windows Node 24-only launch matrix ([prospective policy](node-runtime-support.md)) as well as
on Linux. Linux success does not prove Windows behavior: **every native Windows
job must pass on the newly published exact PR head before merge**. Prior failed
candidates are evidence only, not accepted implementations.
