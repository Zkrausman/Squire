---
type: synthesis
title: AIDEV-222 isolated Git workspace
created: 2026-09-03
updated: 2026-09-03
---

# AIDEV-222 isolated Git workspace

AIDEV-222 owns a trusted TypeScript Git workspace for one run: a private bare repository at `/ticket/git/repo.git`, exactly one linked worktree at `/ticket/workspace`, and deterministic branch `squire/<ticket-id>-<run-id>`. The immutable Git workspace spec/manifests are a separate `urn:squire:git-workspace:v1:*` contract family; published normalized-ticket v1 remains unchanged.

`GitWorkspaceService` reuses the merged [trusted controller boundary](/concepts/trusted-controller-boundary.md) generic lease, preparation lease, terminal fence, and CAS surfaces rather than creating a duplicate lifecycle. Unknown Git child ownership, resource substitution, unsafe refs/config/alternates/submodules, or partial state fail closed. Offline status/commit are supported after independent readiness verification. Bundle export is single-feature-ref, descriptor/digest-bound, offline-verified, create-once, and host publication remains downstream. Disposal accepts an already-held terminal fence, is identity-checked and idempotent; a private disposal identity/completion-marker journal preserves cleanup proof across manifest removal. It never completes global teardown or touches AIDEV-228 runtime/footer state.

Implementation is in `src/git/`; architecture details are in `docs/aidev-222-git-workspace.md`. Evidence: [[sources/obs-2026-09-03-aidev-222-git-workspace-implementation-completed]] and [[sources/aidev-222-isolated-git-workspace]].
