---
type: concept
domain: operations
confidence: high
sources: []
---

# Local Squire bug reporting

The portable `squire-bug-report` Pi skill is a bounded local reporting aid, not
an extension of Squire's ticket, workflow, recovery, or publication authority.
When a Squire product bug is encountered or strongly suspected, the session
makes a bounded semantic decision to report before ending the turn; this is not
deterministic detection. Ordinary target-repository failures, expected behavior,
user error and duplicates are false-positive boundaries. Its bundled Node helper
is the only report validator and writes one closed JSON object with `version`,
`id`, `createdAt`, `sessionId`, `reason`, and `context`. The session binding
comes only from `PI_SESSION_ID`; the helper creates the ID and timestamp,
applies the documented reason/context bounds, and refuses missing session
identity.

Reports live in the per-user `.squire/bug-reports/inbox` under `USERPROFILE` on
Windows or `HOME` on POSIX. The helper creates missing directories, requests
private POSIX modes, and uses exclusive file creation so it never overwrites a
report. This is application-level no-overwrite behavior, not OS immutability or
an ACL subsystem. There is no path override, hard-link or staging protocol,
inbox consumer, network call, ticket automation, or Squire launch.

The list command is deliberately metadata-only: filename, creation timestamp,
session ID, and reason are exposed while context remains undisplayed. Context is
human guidance rather than a secret scanner: record observed/expected behavior,
useful repository/ticket/run IDs, and impact, while excluding secrets,
credentials, prompts/transcripts, environment dumps, private artifact paths,
and large outputs. Inbox capture is not ticket creation: the skill is local-only,
never contacts Linear or GitHub, creates tickets automatically, launches Squire,
or installs itself.
