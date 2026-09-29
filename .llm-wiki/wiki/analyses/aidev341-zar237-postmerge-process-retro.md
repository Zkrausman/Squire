---
type: analysis
title: "AIDEV-341 pilot: ZAR-237 candidate-to-verified-merge boundary"
status: postmerge-pilot-review
source_merge: "a8c657ea01e33ea258b2e001f7265d59180ae586"
---

# ZAR-237 — Squire workflow retrospective

[Gelt PR #471](https://github.com/Zkrausman/Gelt/pull/471) for completed child [ZAR-237](https://linear.app/geltagentictrading/issue/ZAR-237/m8-keep-offline-handoff-revision-invalidation-across-owner-sessions) merged 2026-09-28T16:21:09Z as `a8c657ea01e33ea258b2e001f7265d59180ae586`. Its reviewed four-path code/test/spec/import change was published with a docs-only follow-on at head `17d629f75616f7bfe31ab2a3d2095a3a493eac72`, based on `6631ac6ea3a5a334bec9dcdd9b028261ce1cd7ed`; source and merge trees matched. Current-head [Go](https://github.com/Zkrausman/Gelt/actions/runs/36446256828), [Ubuntu Node 22 and native Windows Node 22](https://github.com/Zkrausman/Gelt/actions/runs/36446256825) checks passed. The independent read-only source review found no issues for a **scoped execution-disabled development PR**; it did not itself run tests or verify CI. Operator checks, hosted CI and source review are distinct receipts.

The Squire v0.2 run `squire-1790607325695-bc3bb1cef0` produced a retained **UNVERIFIED candidate**, not Squire-verified delivery. A prior attempt stopped at pinned-source preflight with no candidate; the subsequent run marked one unlisted command **not run** and ran no tests/build. The operator independently applied the candidate to an isolated pinned worktree, reproduced the cross-session defect with a disposable red-before test, then ran green regression and other local checks; separate independent review, publication and exact-head hosted checks preceded merge. This is a completed **Squire-assisted and independently verified ticket**, not proof that Squire's own verify/publish phases succeeded. Private run artifacts are retained outside this wiki; no raw log or ticket body is reproduced here.

## Workflow lesson

Pinning a clean source at the declared base avoids a silent base mismatch, but a candidate still needs an attributable operator-owned verification and promotion path. Track `candidate: UNVERIFIED` and blocked commands as first-class outcomes rather than treating a successful downstream merge as retroactive Squire verification. A one-file historical spec checkpoint required a docs-only follow-on and fresh exact-head CI; the earlier green head was not enough for the changed head. Keep review of the code delta and independent verification of the final Git head separately attributed. This refines [[trusted-controller-boundary]] without authorizing automatic candidate publication.

## Disposition

This is one bounded factual post-merge pilot input; the separately scoped Gelt product/test retro and wiki-only PR gates are still independent. No new Squire ticket is justified by this single unlisted-command event: the existing Squire phase-command policy and the real-pilot work in [AIDEV-341](https://linear.app/geltagentictrading/issue/AIDEV-341/squire-pilot-post-merge-dual-retros-with-gated-wiki-only-merge-and) are the relevant follow-up scopes. This page does not authorize a paid run, software merge, installation or trading. Parent ZAR-219/M8 remains open.
