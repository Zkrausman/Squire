# Courier handoff metadata foundation

`src/courier-handoff.mjs` provides two pure APIs:

```js
import {
  assessCourierHandoff,
  prepareCourierHandoff
} from 'squire/courier-handoff';

const prepared = prepareCourierHandoff(requestData);
const assessment = assessCourierHandoff(prepared, suppliedObservations);
```

The APIs copy closed own-data records, reject accessors, proxies, cycles, symbols,
unknown fields and contradictions, then freeze their results. Object input uses
the existing `snapshotReceiptData` limits. UTF-8 JSON byte input uses the existing
`parseReceiptJson` duplicate-key, depth, string, array and byte limits. Neither
shared helper's limits or behavior are changed.

## Request and preparation

A request has schema `squire3.courier_handoff_request.v1` and exactly these
fields:

- `executable` and `cwd`: absolute normalized POSIX paths.
- `outer_argv`: the complete literal outer argument vector, including
  `executable` at index zero.
- `inner_node_argv`: a separate literal vector or `null`; it is never appended
  to the outer command.
- `requested_identity`: `{model, effort}` using the exported finite enums.
- `bindings`: exactly `wrapper`, `instruction`, and `manifest` references.
- `required_read_groups`: arrays of read references, grouped to fit the parser.
- `recovery_reference`: one reference or `null`; no named session is required.

Each reference is `{reference_id, sha256, byte_count}`. The identity digest binds
all three fields. A digest correlates metadata; it does not authenticate the
referenced bytes or anonymize a sensitive object. Read grouping is only a bounded
transport shape: the request identity uses a canonical sorted set. Repeated
identical references are idempotent; a repeated identity with different fields
rejects.

`prepareCourierHandoff` returns `safe_summary` separately from `private_command`.
The summary contains request and reference digests, requested model/effort,
binding digests, and grouped required-read digests. The private command uses
POSIX single-quoted arguments inside `(cd … && exec …)` text made only from the
literal outer argv and cwd. Empty arguments, spaces, apostrophes, dollar signs,
backticks, parentheses, shell metacharacters and newlines are preserved safely.
The surrounding parentheses scope the `cd` and inner `exec` to a subshell when
a POSIX-compatible shell evaluates the command, so they do not change or
replace the calling shell. This assumes a POSIX-compatible shell evaluates the
text as a command. Placeholder patterns, NUL, malformed Unicode, non-absolute
paths, and argv[0] mismatches reject. The command is data only; the module
never invokes a shell or any process and provides no signal-delivery,
descendant-settlement or recovery guarantees.

## Assessment

`assessCourierHandoff(prepared, observations)` requires the observation's
request and reference digests to match the prepared record. The returned
`squire3.courier_handoff_assessment.v1` is a finite immutable metadata record.
It keeps separate:

- requested and reported model/effort;
- dispatch observation, process-start observation and terminal result;
- stdout and stderr raw capture identities, and the derived final artifact's
  own digest, origin raw digest and transform reference;
- whole-byte equality, bounded excerpt, complete JSON-value equality, explicit
  missing, unknown and unreported read coverage;
- recovery reference and reported context state, plus review mode, prior result,
  candidate and context identities, and a `SAME`/`CHANGED` candidate relation
  for continuations in the same context;
- outer environment removals and wrapper environment removals;
- explicit denial and quota observations, transport uncertainty, evidence
  completeness, tool outcome and estimate availability.

Read observations may be a subset of required reads; absent items are reported
as `NOT_REPORTED`. Unknown or missing coverage stays incomplete. Unknown,
missing, empty and zero remain distinct. Whole-byte exact coverage must match
both digest and byte count. Excerpt and JSON-value-equality claims are recorded
as supplied metadata, not recomputed from artifact contents. Each present final
artifact binds a supplied raw stream identity and transform reference. An
`IDENTITY` transform must preserve the raw stream digest and byte count; other
transform kinds remain supplied claims, and metadata does not prove derivation.
Captured empty output and captured no-candidate results are never marked as
usable candidates.

All malformed input fails with the constant `CourierHandoffError` code and
message `INVALID_INPUT`. The safe assessment omits argv, paths, raw text, raw
errors and reference IDs. Its digests may still correlate sensitive objects.

The assessment reports `runtime_admitted: false`, `task_correctness:
NOT_EVALUATED`, and external review-acceptance, delivery, merge, installation
and use stages as `EXTERNAL_NOT_ASSESSED`. It does not infer denial or quota from
tool failure, capability error, timeout, missing files, low allowance, absent
candidate or incomplete evidence. It has no replay or recovery command.

## Bounds

| Input or record | Bound |
|---|---:|
| Object/JSON input | 262,144 bytes, using existing shared intake behavior |
| Outer or inner argv | 64 entries; 256 UTF-8 bytes per entry; 512 bytes total |
| Private command | 4,039 UTF-8 bytes |
| Required read groups | 16 groups × 64 items = 1,024 items |
| Reference byte count | 262,144 per reference |
| Required-read byte counts | 64 MiB total |
| Three bindings and recovery reference | 1 MiB total |
| Raw stdout / stderr metadata byte count | 4 MiB / 4 MiB |
| Derived final metadata | 262,144 bytes |
| Environment-removal counts | 1,024 each |

These are input and projection bounds, not claims about a runtime, worker count,
host capability or task performance.

The argv and command limits are coupled: the 4,039-byte maximum is the longest
POSIX-quoted command possible with the cwd and argv bounds above, including 64
argv entries and two bytes for the enclosing subshell parentheses. It fits the
shared object-snapshot string limit of 4,096 characters. Raw stdout/stderr
bounds apply to supplied metadata counters; this module does not allocate or
retain raw capture storage.

## Actual consumer boundary and limitations

The intended first consumer is a private, owned-file, no-inference adapter for
preparing and assessing the independent-review handoff for this authorized
change, after separate source tests. The adapter does not launch work. The owner
must separately verify genuine current context, action authority and exact bytes
before any normal authorized reviewer launch.

This module cannot establish that supplied identities or observations are true,
authenticate current context, validate task semantics, establish full descendant
settlement, or accept a review. A reported native terminal result, digest,
coverage claim, denial, quota observation or ACK cannot promote permission,
runtime admission, correctness, delivery, merge, installation or use. Those
stages remain external evidence. No actual consumer use or runtime admission is
claimed by this foundation.
