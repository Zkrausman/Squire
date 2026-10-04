# Explicit public project context

Projects can opt in to propagating the exact inline `goal` to every planning,
implementation, repair and fresh-review job:

```json
{
  "goal": "Public project requirements, including any public contract text",
  "publicContract": { "sha256": "<SHA-256 of the exact UTF-8 goal bytes>" }
}
```

The owner must review those bytes as public before setting the digest. The only
allowlisted input is the inline goal; this declaration cannot load paths,
directories, private answers, audits, credentials or workspace attachments.
Unknown fields fail configuration validation. Without this opt-in, existing
planner-only goal behavior remains unchanged.

Public context is limited to 32,768 UTF-8 bytes and the existing 16,000-character
goal bound. Missing goal/pin, mismatched digest and oversized input fail closed.
The controller snapshots the contract, checks its current and persisted config
before every dispatch, and records `{sha256, bytes}` in each durable
`job.started` event and runtime job metadata. It never silently drops, truncates,
reloads or replaces the approved context. A changed declaration requires a new
project admission under the existing immutable-config rules.

The public block supplies requirements for review; it grants no additional
ticket ownership, sandbox permission, command, budget or mutation authority.
Response schemas, required checks, exact-candidate verification and fresh review
are unchanged. This change adds no artifact-schema gate and does not establish a
performance gain; that requires a separately admitted paired benchmark.
