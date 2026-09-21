# Durable Squire run events

Runtime: Node.js 24 only (`>=24 <25`). Both Linux and Windows filesystem
event gates remain required; see [runtime/check policy](node-runtime-policy.md).


Squire has two separate responsibilities:

1. The **Run Controller** is the authoritative state writer. It validates and
   atomically replaces `<state>/<run-id>.json`, advancing its `version` one
   revision at a time.
2. A host **event consumer** observes a bounded outbox and reconciles with that
   state. `squire watch <ticket-or-run>` is the built-in filesystem consumer;
   provider-neutral notification workers can deliver the same contract to a
   future integration.

The outbox is `<state>/events/<run-id>.json`. It contains a bounded JSON array
of versioned, deterministic events. Events include only the run/ticket identity,
state revision, timestamp, event type, and bounded phase/attempt/outcome
fields. Titles, descriptions, prompts, transcripts, credentials, URLs, errors,
and logs are intentionally absent. New state records also retain bounded
`remediationAttempts` arrays for Review and Test. Each entry is the exact phase
attempt whose committed result requested remediation; the arrays are
counter-consistent and append-only. The field is absent from legacy v1 state,
and consumers never map an old aggregate remediation count onto a historical
phase attempt. The event schema is
[`contracts/run-events/v1/run-event.schema.json`](../contracts/run-events/v1/run-event.schema.json).

## Production and crash consistency

The controller commits state first and publishes the corresponding event after
the state replacement has been durably written. A publication failure never
rolls back or changes the already-committed state. Consequently the contract is
state-first and at-least-once: an outbox record may be delayed, duplicated, or
lost after a crash, and an event may be replayed after a restart. Event IDs are
stable hashes of the semantic transition, not of a delivery attempt. A
reserved background launch publishes `run_reserved`; only its committed
reserved-to-started claim publishes `run_started`. A reservation terminalized
before that claim therefore never appears to have started.

Consumers sort by state revision, deduplicate by event ID, and reconcile from
authoritative state before and after installing watchers. If an outbox record
is malformed or missing, the consumer synthesizes only the bounded transitions
supported by that state: latest phase results and exact remediation-attempt
evidence can identify Review/Test attention, while a legacy aggregate counter
cannot. It uses the same semantic event IDs. It watches the
containing state and event directories, not an individual file handle, so
Windows rename-based atomic replacement is observed. Duplicate/coalesced OS
notifications are debounced; a low-frequency reconciliation timer is only a
bounded missed-event fallback, not an LLM or busy polling loop. Terminal state
causes the consumer to exit.

The outbox is bounded by both record count and serialized bytes. Retention can
drop old notifications, so state reconciliation is required and persisted state
is never replaced by the outbox.

## Consumption and adapters

The watch path constructs only configuration, the JSON state reader, and the
filesystem consumer. It never contacts Linear, Docker, Git, GitHub, Pi, or a
model while waiting. It prints sanitized one-line transition records and exits
or quiesces on terminal success/failure.

`RunNotificationWorker` is a provider-neutral host adapter. Its fixed allowlist
contains attention and terminal events only. It passes the sanitized event
object to an adapter, applies bounded timeout/retry behavior, and atomically
writes a per-consumer checkpoint only after successful delivery. A crash before
the checkpoint causes replay, preserving at-least-once semantics. The local
Test result is represented by `phase_completed`; this controller does not claim
an external CI observation. A future CI producer must persist authoritative CI
state before adding a CI-specific event. A future Pi conversation wake-up or
other integration may consume this adapter contract; it must not embed prompts
or invoke a model during idle waiting.

Discord delivery and formatting are deliberately deferred. A Discord adapter,
if added later, must sit above this event contract and must not become another
state writer.

### Report-format correction events

`report_correction_observed`, `report_correction_launched`,
`report_correction_accepted` and `report_correction_stopped` are distinct from
phase completion, model-stage attempts and implementation remediation. They carry
`phase: "implement"`, the actual phase `attempt`, and a bounded `correction`
object `{sequence, maximum, used, remaining}`. `sequence` is the append-only ledger
position and participates in deterministic event identity, so repeated calls and
observations cannot collapse into one event. Charges are persisted before dispatch.
Events contain no reports, paths, prompts or diagnostics: consult the state's
`reportCorrections` ledger and referenced host evidence for those. Event pruning
never restores correction allowance or changes a historical terminal run.
