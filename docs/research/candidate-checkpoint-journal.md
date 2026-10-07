# Candidate checkpoint journal contract

This package records controller-owned candidate ref updates. It does not import provider results or settle an interrupted producer.

## Invariant

For each checkpoint that creates a commit, Squire first validates its caller and workspace, stages the allowed change, writes the tree and prepares the exact commit object. Before changing a branch ref, it durably records one immutable intent containing:

- project, ticket and producer-scope identity;
- checkpoint purpose (`implementation`, `automatic_recovery`, `partial_recovery`, or `interrupted_candidate_verification`);
- managed workspace and its in-workspace Git directory, generation, branch ref and base;
- expected parent, staged tree, prepared commit and changed paths;
- full project-policy digest;
- the known physical job ID and/or explicit recovery-admission ID.

The prepared object freezes parent, tree, message, author/committer identity and timestamp. The branch ref changes with compare-and-swap from the recorded parent to the recorded commit. A stale, detached, missing, or mismatched ref fails closed. No retry of the ref update is implicit. Squire rereads the worktree, index and repository identity immediately before CAS, but Git CAS does not lock those filesystem facts. A mutation in the final check-to-CAS interval can therefore leave the ref at the prepared commit before the post-CAS identity check detects the mismatch; that outcome remains an unprojected intent with an open producer fence.

After the ref update, one SQLite transaction projects the matching journal row and the ticket outcome/event. It checks the project, ticket, workspace generation, policy, parent, tree, job/recovery identity and active producer scope. The journal row is immutable after projection. A failed or conflicting projection rolls back both journal projection and ticket update; the durable intent and open producer scope remain.

Normal physical-job `candidate.json` evidence references the journal operation and exact commit/tree. Existing version-1 evidence remains readable. Historical artifacts are never rewritten.

## Deterministic acceptance cases

1. A successful checkpoint prepares the recorded commit, persists intent before the ref CAS, then atomically projects its journal and ticket outcome.
2. Intent insert failure leaves the original branch ref unchanged.
3. Journal/ticket projection failure after ref mutation leaves the candidate intent unprojected, the ticket projection unchanged, and the producer scope open. Reopen and another producer attempt remain blocked.
4. A competing ref update after intent causes compare-and-swap failure. Squire preserves the competing ref and the unprojected intent; it does not overwrite, adopt, or retry it.
5. Missing or wrong producer, policy, generation, workspace, Git directory, branch, parent, tree, job reservation or recovery identity fails closed. Protected-path and ownership checks include both sides of renames and deletions.
6. A changed index, unstaged/untracked path, workspace root, Git directory or branch detected before CAS leaves the branch ref untouched and the producer fenced.
7. A mutation in the final check-to-CAS interval is detected after CAS; the branch may already point to the prepared commit, but the intent remains unprojected and the producer fenced.
8. Reprojection, incompatible duplicate intent, and conflicting candidate evidence fail closed. Reopening does not automatically adopt or replay anything.

Tests use only disposable local Git/SQLite fixtures. No live provider or benchmark is involved.

## Explicit limits

An intent or prepared commit is evidence, not authority to replay or adopt a job result, perform manual recovery, release a producer fence, or refund usage. Manual recovery still requires the existing one-time admission and exact evidence. PID liveness and timestamps do not establish OS process identity; process-tree settlement remains unproven. Unknown or conflicting accounting remains unknown. Verification, fresh review, publication, CI, merge and postmerge gates still apply.
