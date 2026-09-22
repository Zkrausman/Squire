---
name: squire-bug-report
description: Record suspected Squire bugs in a local per-user inbox for later human triage without creating tickets, launching work, or making network calls.
---

# Squire bug reporting

This is a small portable Pi skill, not a ticketing system, recovery path, or
permission grant. Use it only to record a suspected Squire bug for a human to
triage later. It does not contact Linear or GitHub, start Squire, resume a run,
or install itself globally.

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
characters). Include observed and expected behavior, useful repository/ticket/
run IDs, and impact. Do not include secrets, credentials, raw prompts or
transcripts, environment dumps, private artifact paths, or large outputs. Do
not copy an entire log into the report.

For the metadata-only inbox view, use:

```sh
node <installed-squire-bug-report-directory>/bug-report.mjs list
```

List output contains only filename, creation timestamp, session ID, and reason;
context is not displayed. On POSIX the helper requests mode `0700` for newly
created inbox directories and `0600` for newly created report files. It does not
claim OS-level immutability, add ACL machinery, create hard links or staging
files, consume reports, or automate ticket creation.
