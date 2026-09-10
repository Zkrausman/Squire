---
type: concept
created: 2026-09-10
updated: 2026-09-10
domain: engineering
confidence: high
sources: []
---

# Background run state and status

A background Squire run is a detached one-shot controller, not a daemon. The invoking process first creates a durable per-ticket reservation and version-1 JSON state, then launches the installed CLI with ignored stdin, append-only file-backed stdout/stderr, `detached: true`, `windowsHide: true`, and `shell: false`. It returns the run ID after the operating system confirms spawn. The detached child is the sole lifecycle writer after that handoff.

The launch binds the child to the SHA-256 of the exact selected config bytes and to persisted repository slug, absolute repository path, source ref, base branch, and log paths. `modelPolicy` and `dataDirectory` are the canonical JSON configuration names; `SQUIRE_DATA_DIR` is the only data-root environment override, while `paths.state`, `paths.bridges`, and `paths.staging` remain narrow compatibility paths. The child rejects changed identity and receives the exact state-store directory through private bootstrap transport, rather than rediscovering a data root. Thus config-load, config-identity, state-path, and other bootstrap failures can still record terminal evidence against the reservation. During preparation the Docker adapter resolves the configured source ref once, pins that commit into a temporary clone-visible ref, and compare-deletes only its own temporary ref; this guarantees an exact sandbox base for that preparation, not a pre-reservation snapshot of a mutable remote ref.

JSON updates use a per-run directory lock around the version check and atomic replacement. This supplies cross-process serialization: only one proposed version `N+1` can follow version `N`; a stale writer fails instead of replacing newer workflow state. A lock left by a crashed writer is intentionally ambiguous and fails closed. Every `.json` state filename must be a valid run ID and must match the record's `runId`. The reserved-to-started claim and unclaimed bootstrap-failure transition combine that per-run CAS with the existing short-lived per-ticket operation boundary, so ownership and state transition are one operation. Reserve and release also pass through the ticket boundary, so an old release cannot overlap a replacement reservation. Ticket reservation locks are not opportunistically reclaimed; empty or malformed ownership records are ambiguous. Only the exact owner may release after its readable terminal state exists, preventing an old releaser from deleting a new owner's lock.

Before child handoff, SIGINT or SIGTERM aborts startup, persists `interrupted` evidence, and releases the reservation. The parent re-resolves configured state and log destinations immediately before reservation and rejects destinations then resolving inside the repository. On POSIX, log opening also refuses a final-component symlink; these checks do not claim race-free ancestor or hardlink protection. After handoff, the child must own the exact reservation before claiming the persisted reserved state, and bootstrap fallback terminalization requires the same ownership. A forced kill or power loss can still leave an ambiguous reservation; this no-daemon design does not infer liveness or automatically reclaim it.

`status` reads only persisted state and reservation ownership. A reservation that does not match exactly one readable active state is reported as ambiguous even if an older terminal state exists, whether the selector is a ticket or an individual run ID. Human-readable output escapes CR, LF, C0, C1, and ESC from external strings, including ticket titles, errors, profile values, URLs, and log paths.

Implement may update this committed project wiki when a ticket requires architectural documentation. Review, Test, and especially Retro do not mutate it; Retro remains read-only and only publishes lessons/follow-ups through the PR evidence path.
