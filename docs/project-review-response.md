# Complete a selected review worksheet offline

Use the keyboard form as an alternative to manually editing a
[blank worksheet](project-review-worksheet.md). Select the family, package,
independently retained manifest SHA-256, original blank worksheet, and a
fresh destination. For example, from the repository root:

```sh
node bin/squire-review-response.mjs original /absolute/original-package EXPECTED_MANIFEST_SHA256 /absolute/private/original-blank.json /absolute/private/original-completed.json
node bin/squire-review-response.mjs revision /absolute/revision-package EXPECTED_MANIFEST_SHA256 /absolute/private/revision-blank.json /absolute/private/revision-completed.json
```

Use normalized absolute paths under protected, symlink-free ancestors. Keep
the package and blank worksheet quiescent. The command verifies the package
against the retained digest and compares the selected private worksheet to
the exact blank projection of that package, including every immutable field,
view, row and null response. It rejects an edited, nonprivate, or mismatched
blank and an existing or overlapping destination. It does not search for or
select any package for you.

The terminal shows the package root, manifest digest, ordered view and diff
reference, then each row's exact old and new side references and SHA-256
values. A null old copy means an addition. Open the displayed references in a
separate local viewer, including the exact side files for binary inspection;
the form does not open or execute them. Opening or reading any evidence does
not set an attestation. Keep the terminal private; the references are not a
sanitized report.

For **each** row, answer two independent prompts with `yes` (true), `no`
(false), or a blank line (null):

- Attest this exact comparison?
- Binary inspected for this exact comparison?

The binary requirement is displayed for every row. Even a text row has a
separate binary response field under the existing worksheet contract. The
same path in multiple views gets separate prompts and responses; nothing is
copied between views, including when an original change was restored to base.
No response is inferred from verified bytes or a choice.

After the rows, supply your own decision ID and reviewer label (1–64 ASCII
letters/digits/underscores/hyphens), exact `ACCEPT`, `REVISE` or `REJECT`, and
an optional single-line note (up to 4096 UTF-8 bytes). Blank identity or choice
remains null; a blank note is omitted. Invalid line inputs re-prompt. Only an
explicit `yes` at the final save prompt creates a separate worksheet; `no`
or EOF before completing the prompts stops. The form does not authenticate
identity, validate acceptance, or fill missing answers. The form may save an
incomplete or inconsistent set of explicit responses for inspection; the
[existing decision request preparer](project-review-decision-request.md) is
still responsible for enforcing acceptance and response consistency.

After the session, the form rechecks the selected package and blank and
exclusively creates the supplied mode-0600 destination. Exit 0 prints
`PROJECT_REVIEW_RESPONSE_SAVED`; it means worksheet save only. Exit 2 means
usage, validation, input, write, or terminal failure, including declining to
save. Preserve any output after an uncertain write/acknowledgement; do not
replay or overwrite it. No decision request is created or recorded. Use the
existing request preparation, inspection, and recording commands separately
only after supplying and checking your explicit responses.

For the historical #315 synthetic original example (five rows), the fixed
REVISE input with no attestations uses ten blank row answers, three explicit
identity/choice answers, a blank note, and a final `yes`: 15 prompts and 15
line inputs. A seven-row first revision uses 19 prompts and 19 line inputs
without corrections. Each invalid answer adds another prompt and input.
These counts describe the form, replacing one worksheet JSON edit in the
proposed workflow; they do not establish elapsed-time or human usability
improvement. The independent combined workflow comparison and real reviewer
score are separate and not established by this command.
