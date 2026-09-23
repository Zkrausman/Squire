---
name: squire-operator
description: Orchestrate an owner-approved Squire ticket from a fresh trusted session, including cold-start preflight, bounded delivery, non-model watching, exact-head checks, and failure handling; not merge, activation, or recovery authority.
---

# Squire operator

This is an operating guide, not an executable controller or permission grant.
Read [operations](references/operations.md) before a launch or failure decision;
read [installation and handoff](references/install-and-handoff.md) when moving to
a fresh session. Resolve these paths against this installed skill directory,
not the current project.

## Owner-facing use

In a fresh trusted session, say: `use Squire to orchestrate ticket XYZ-123`.
For an existing owner-approved ticket contract, this authorizes trusted
cold-start preflight and launch of exactly one Squire run. It does not approve a
new contract or waive any preflight gate. Do not ask again for ordinary
mechanical decisions; a fresh replacement is allowed only under the narrow
immutable-correction policy below.

1. Establish the trusted Squire build, target repository and actual default
   branch, exact isolated source SHA, configuration and original ticket baseline.
   Preserve dirty checkouts. A ticket mirror is not repository-routing authority.
2. Stop before paid phases until App scope, private effective paths, native
   template/toolchain, target tests and visible prerequisites/approvals are proven.
   Never request or dump secrets.
3. The direct request authorizes the standard Contract → Implement → fresh
   independent read-only Verify → configured App publication and exact-head CI
   path, through the verified `/squire-run TICKET-ID --config ABSOLUTE_PATH`
   command in the running owner-facing Pi session (never unauthenticated direct
   `squire run`). Watch events without model polling. Check exact-head evidence,
   persisted terminal state and reservation release.
4. For a deterministic mechanical contract-conformance defect with one obvious
   in-scope correction, preserve the failed candidate and follow the narrow fresh
   replacement policy described in operations. Escalate other failures at the
   boundaries stated there.
5. Never repair, resume, relabel or promote a failed candidate; retry an unchanged
   condition; invent evidence; or silently broaden the ticket. Keep failure
   evidence private and report concise public facts.
6. Hand off facts and next authorized action, not inherited conversation context.

## Optional async observation

For a background run, default to the dedicated async `squire-observer` child so the owner-facing orchestrator conversation remains usable. Supply the exact trusted executable, working directory, existing run ID and config path. The child performs one native blocking watch followed by one public status and returns one bounded receipt; do not poll with a model. An open watch tool call is expected and is not by itself grounds to nudge or interrupt the observer. Use direct native `squire watch` in the parent only when the owner explicitly requests a blocking conversation, or after observer infrastructure fails and the owner approves that fallback; never silently block the orchestrator.

A watcher receipt is observation only. It grants no workflow authority and cannot authorize a retry, recovery, publication, merge, or any other action. A timeout or observer failure is not run completion; consult persisted Squire status for workflow decisions.

Honor repository safety instructions and owner stop gates. The direct request
covers only the normal configured App publication and exact-head CI for the
approved ticket; merge, tags, installation, deployment, delegation and unrelated
external actions require separate applicable authority unless the owner request
clearly includes them. This skill grants no authority, and using or merging it
never installs or activates it.
