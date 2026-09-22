---
name: squire-bug-report
description: When a Squire product bug is encountered or strongly suspected, record a bounded local report before ending the turn for human triage; never create tickets, launch work, or make network calls.
---

# Squire bug reporting

This is a small portable Pi skill, not a ticketing system, recovery path, or
permission grant. Whenever you encounter or strongly suspect a bug in Squire
itself, use this skill before ending the turn to make a bounded semantic report
decision; record only when appropriate. Do not claim deterministic bug detection.
Do not use it for ordinary target-repository failures, expected behavior, user error,
or a duplicate of an existing report. A report is optional when those false-
positive boundaries apply; it is never created automatically by this helper.

The report is local inbox capture for later human triage. Inbox capture is not ticket creation. It does not contact Linear or GitHub, start Squire, resume a run, or install itself globally.

The skill directory includes `bug-report.mjs`. Resolve that file from this
installed skill directory, not from the current project checkout. For example:

```sh
node <installed-squire-bug-report-directory>/bug-report.mjs create \
  --reason "short description of the suspected bug" \
  --context "Observed: ... Expected: ... IDs: ... Impact: ..."
```

The helper reads the real `PI_SESSION_ID` environment variable and stops if it
is missing; never supply a session ID as an argument. It creates the fixed local
inbox under `%USERPROFILE%\.squire\bug-reports\inbox` on Windows or
`$HOME/.squire/bug-reports/inbox` on POSIX. Do not pass a path override. The
helper generates the report ID and timestamp, creates the inbox when needed, and
uses exclusive creation so it never replaces an existing report.

Keep `reason` concise (1–500 characters) and `context` bounded (1–4,000
characters); both are required when recording. Include observed and expected
behavior, useful repository/ticket/run IDs, and impact. Do not include secrets,
credentials, raw prompts or transcripts, environment dumps, private artifact
paths, or large outputs. Do not copy an entire log into the report. The helper
requires the real `PI_SESSION_ID` and does not accept caller-supplied session,
reason/context omissions, or an inbox path override.

For the metadata-only inbox view, use:

```sh
node <installed-squire-bug-report-directory>/bug-report.mjs list
```

List output contains only filename, creation timestamp, session ID, and reason;
context is not displayed. On POSIX the helper requests mode `0700` for newly
created inbox directories and `0600` for newly created report files. It does not
claim OS-level immutability, add ACL machinery, create hard links or staging
files, consume reports, or automate ticket creation.
