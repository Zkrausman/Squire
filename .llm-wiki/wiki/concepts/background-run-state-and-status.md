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

The launch binds the child to the SHA-256 of the exact selected config bytes and to persisted repository slug, absolute repository path, source ref, base branch, and log paths. The child rejects changed identity and uses the independently passed original state directory for its lifecycle store. Thus config-load, config-identity, state-path, and other bootstrap failures can still record terminal evidence against the reservation. During preparation the Docker adapter resolves the configured source ref once, pins that commit into a temporary clone-visible ref, and compare-deletes only its own temporary ref; this guarantees an exact sandbox base for that preparation, not a pre-reservation snapshot of a mutable remote ref.

JSON updates use a per-run directory lock around the version check and atomic replacement. This supplies cross-process serialization: only one proposed version `N+1` can follow version `N`; a stale writer fails instead of replacing newer workflow state. A lock left by a crashed writer is intentionally ambiguous and fails closed. Reserve and release also pass through a short-lived per-ticket operation boundary, so an old release cannot overlap a replacement reservation. Ticket reservation locks are not opportunistically reclaimed; empty or malformed ownership records are ambiguous. Only the exact owner may release after its readable terminal state exists, preventing an old releaser from deleting a new owner's lock.

Before child handoff, SIGINT or SIGTERM aborts startup, persists `interrupted` evidence, and releases the reservation. After handoff, the child owns interruption and terminal persistence. A forced kill or power loss can still leave an ambiguous reservation; this no-daemon design does not infer liveness or automatically reclaim it.

`status` reads only persisted state and reservation ownership. A reservation that does not match exactly one readable active state is reported as ambiguous even if an older terminal state exists. Human-readable output escapes CR, LF, C0, C1, and ESC from external strings, including ticket titles, errors, profile values, URLs, and log paths.

Implement may update this committed project wiki when a ticket requires architectural documentation. Review, Test, and especially Retro do not mutate it; Retro remains read-only and only publishes lessons/follow-ups through the PR evidence path.
