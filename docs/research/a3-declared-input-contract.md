# A3 declared-input verification: frozen implementation boundary

Admitted follow-on to the [source-only assurance brief](a3-oracle-assurance.md), pinned to baseline `05729b4745b122e0f3bdcfe472d35bd248a90f93`. This document freezes the small implementation contract before code changes. Acceptance cases below are requirements, not execution receipts.

## Contract and limits

- Only owner-supplied `execution.version: 2` may optionally add `declaredInputs: {version: 1, root: ABSOLUTE_DIRECTORY, files: [{path: RELATIVE_FILE, sha256: LOWERCASE_SHA256}]}`. The planner remains unable to confer version-2 authority. Omission preserves existing behavior and output; version 1 cannot opt in.
- The list contains 1–32 unique files; each file is at most 1 MiB and their combined size is at most 4 MiB. Paths are bounded (root 4096 characters, file 500), nonempty, NUL-free, and must already be normalized. Relative files use forward slashes, have no empty, `.` or `..` components, absolute/drive paths, backslashes or hidden components. The root must be canonical, absolute and disjoint from the managed project root. Files must resolve exactly beneath that root, with no symlink/alias, nonregular or multiply linked files. The root cannot name credential/control directories (`.ssh`, `.aws`, `.gnupg`, `.codex`, `.agents`, `.git` components). This is an explicit owner-reviewed inventory, not permission to discover or collect private files.
- Reject unknown fields, malformed digests, duplicate paths, invalid versions and out-of-bound lists at configuration validation. Revalidate the manifest shape at the filesystem gate as defense against malformed persisted state. Read only listed files; apply bounded metadata-before/after, no-follow file reads. Do not execute, import or crawl them. Check the aggregate bound before reading file contents.
- Reuse the existing definition gates before worker dispatch and during current candidate/delivered criterion resolution. Missing, changed, denied or unsafe listed files block without falling back to entry-only evidence. Denials use a distinct fixed blocker; errors expose neither raw paths nor contents. A matching entry alone cannot override a declared-input failure.
- The existing full execution contract digest binds list membership, root, paths and expected digests to A2 candidate/delivered evidence. Add an explicit manifest digest only to opt-in A3 proof and accepted-criteria projections, with `label: "declared inputs verified"`, `dependencyCoverage: "UNKNOWN"` and `loaderEnvironment: "UNKNOWN"`. Keep historical evidence untouched. Never copy file bytes, file lists, root paths or environment values into these projections or errors.
- Owner review establishes the list's relevance and completeness assumptions. Unlisted helpers/data, dynamic loads, Node runtime and effective loader environment remain UNKNOWN. No atomic load-time, same-user isolation, complete dependency closure or process-settlement guarantee is added.

## File boundary

Implementation is limited to `src/contracts.mjs`, `src/criterion-evidence.mjs`, the small optional projection at `src/controller.mjs`, focused deterministic tests, `docs/criterion-evidence.md`, this contract and a minimal roadmap status link. A small dedicated verifier module/test is allowed if it keeps the filesystem boundary clear. No changes to process launch, loaders, permissions, the existing A2 manifest/storage format or planner authority. If another behavior or security boundary is required, stop that dependent portion and report it.

## Deterministic acceptance cases

1. Existing version-1 and entry-only version-2 fixtures keep their behavior and omit the new assurance projection. Valid inline/file-entry opt-in manifests verify without executing listed files.
2. Change only a listed helper while the entry stays frozen: refuse before worker spend and when resolving otherwise valid candidate or delivered observations. Missing and wrong-digest files also fail closed.
3. Alter list membership, root, path or expected digest after A2 evidence is bound: current proof refuses the contract mismatch. Wrong-head and tampered observation references retain their existing rejection behavior. Successful opt-in delivery projects the manifest digest, narrow label and both UNKNOWN fields.
4. Reject malformed/unknown fields, duplicate paths, traversal, hidden paths, root overlap, symlinks/aliases, hardlinks, directories and size/count limits. Check denied and changed-during-read paths deterministically with mocked filesystem dependencies if feasible; do not change real permissions or retry an actual denial.
5. An unlisted file change does not create a false completeness claim; the narrow label and UNKNOWN coverage stay explicit. Error/projection serialization contains no listed contents, raw paths or ambient environment values.

Use new deterministic fixtures and the supported direct-module runner locally. Existing blocked child-spawn tests and held inference/probe studies are not retried. Fresh ordinary Linux CI supplies the complete-suite publication gate. Independent Sol medium validation/review must cover exact final files; Luna xhigh owns implementation.
