# Squire 0.1 — experimental local baseline

This is an archival release, not a passing product benchmark or a completion claim. Owner authorized merging the current implementation and preserving failures. Owner subsequently authorized publication to GitHub and closure of superseded PRs. The complete original archive remains private locally.

## Results

| Major benchmark | Accepted | Outcome | Calls | Unknown usage calls |
| --- | --- | --- | --- | --- |
| Scribble Blackjack Shooter v2 | No | 3/8 tickets delivered; input integration timed out twice; no playable desktop application | 9 | 2 |
| Local Job Queue v1 | No | Generated ownership globs rejected by strict ticket validation; no implementation | 1 | 0 |
| Local Log Explorer v1 | No | Generated ownership globs rejected by strict ticket validation; no implementation | 1 | 0 |

Total: **0/3 accepted, 11 calls, 2 calls with unknown usage**. The game's 27 delivered component tests passed; this does not constitute gameplay acceptance. Per-run independent grades, original results, configs, inputs, identities and timing are in `majors/`. `major-summary.json` and `baseline-r1.json` retain the denominator and frozen conditions.

Microbenchmark construction is **in progress**, through Squire project `mbuild1`. None of the eight microbenchmark families has a scored baseline yet. Construction costs are separate. The owner reconfirmed completing calibrated microbenchmark runs before any hill climbing. Subsequent results will be appended in a later local commit; this snapshot must not be represented as a complete combined baseline.

The previous Codex Status Report trial remains stopped and unaccepted. Historical StickyCanvas and original six-case evaluation evidence are retained separately from these new major runs.

## Runtime identity

Major runs used immutable pretrial2 runtime source SHA-256 `da9cdcc98cb943c6fa1a92cca37186ac16d1961a2ccf974e0c73e9a75c40adca`, subscription Luna xhigh implementation and latest Sol medium planning/review; 48 calls per original goal, 900-second individual job timeouts, up to four tickets, two implementation attempts, one ordinary repair and three rebases. There was no overall goal deadline. No scored originals were rescued or rewritten after failure.

This repository also preserves subsequent controller/recovery changes present in the owner's local rewrite checkout. **The current repository source is not claimed to be identical to the frozen benchmark runtime.** Both original v01 and pretrial2 snapshots are preserved inside the evidence archive with their identities. Package label 0.1.0 is the new experimental release/program label; the older historical `v0.1.0` Git tag is preserved. Local tag `squire-0.1-baseline-20261002` preserves the original private snapshot. GitHub tag `squire-0.1-20261002` identifies the public snapshot.

## Evidence and canvases

The split archive `evidence.tar.gz.part001` and subsequent parts preserves experiment scripts, reports, native job outputs, JSON checkpoints/events, interrupted work, fixture/oracle inputs and runtime snapshots. Verify its SHA-256 using `evidence-archive.json`; `evidence-manifest.json` lists individual file hashes. Extract into disposable scratch: archived absolute paths identify the original machine and are not a portability guarantee. Read the archive's `squire-evals/HANDOFF.md` for chronology. Live microconstruction files were copied at a point in time; their copied state is not a live controller lease or coherent database backup.

Reproducible dependencies, Electron binaries, Git object stores, live SQLite files and control credentials are omitted. Public publication also excludes browser profiles, crash dumps and runtime compile caches that can hold process-memory credentials. These omissions are listed in the public manifest; all original results remain preserved privately. Exported state/events and available source artifacts are retained. Original source evidence outside the repository remains intact.

`../../canvases/` contains the benchmark suite, extensible SDLC architecture, vision drafts and disposable StickyCanvas fixture. Existing architecture/benchmark canvases also remain in their original repository paths. Historical canvas copies are retained in the evidence archive. The final benchmark canvas has four pages: the three major products and the proposed micro suite.

## Local use

Node 24.14+ in the Node 24 series, Git and subscription-authenticated Codex CLI are required. From the repository:

```powershell
npm ci --ignore-scripts
npm run check
npm test
node bin/squire.mjs --help
```

GitHub publication is owner-authorized; no hill-climbing treatment is part of this archival merge.

Release source verification: syntax checks passed and all **81 regression tests passed** (see `verification.json`). These checks do not override the failed product benchmark grades.

## Reassemble public evidence

Run `node docs/releases/0.1/reassemble.mjs PATH_TO_NEW_ARCHIVE.tar.gz`, then extract that archive into disposable scratch. The tool verifies every part and combined archive SHA-256 and refuses to overwrite an existing file. Public archive contains 51,118 files; the original private archive contains 62,466 files.
