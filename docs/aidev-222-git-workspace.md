# AIDEV-222 Isolated Git Workspace

AIDEV-222 owns the trusted, ticket-local Git boundary for one workflow run. It
starts from a controller-created immutable workspace spec and creates exactly
one private bare repository at `/ticket/git/repo.git`, one linked worktree at
`/ticket/workspace`, and the derived branch
`squire/<ticket-id>-<run-id>`. The recorded full base object ID is the only
source for the initial branch head.

## Authority and lifecycle

`GitWorkspaceService` uses the existing `WorkflowStore` generic lease and
`RunQuiescenceAuthority` preparation lease. It does not introduce a second
workflow lifecycle or terminal fence. Git operation intent and command identity
are persisted in `RunSnapshot.gitWorkspace`; a command with an unknown child
identity blocks recovery rather than being replaced. Every filesystem boundary
is rechecked against the merged preparation/terminal authority.

The service validates the immutable spec, requires an injected closed
repository-source authorizer, rejects private/DNS-resolved destinations and
unapproved redirects, and imports only the literal base
`refs/heads/<base-branch>`. Fetch explicitly disables redirects. It rejects
shallow/partial/alternate/graft/replace state, and verifies object closure,
config, paths, hooks, worktree metadata, and a clean initial status. It never
force-adopts a repository, uses a shared alternate, invokes a shell string, or
inherits Git configuration or credentials.

After readiness, `status` and `commit` are offline operations. Commits use the
local Squire identity, disable verification hooks/signing, and advance only the
recorded feature ref. Repository content remains untrusted: tracked symlinks,
attributes, submodules, and repository files are not followed as controller
paths. `PiRunner` requires the service's readiness port before any role child
can spawn; AIDEV-228's run-local agent directory and trusted footer remain
separate from the Git paths.

## Contracts and bundle handoff

The separate closed contract family is:

- `urn:squire:git-workspace:v1:workspace-spec`
- `urn:squire:git-workspace:v1:workspace-manifest`
- `urn:squire:git-workspace:v1:bundle-manifest`

Contract bytes are canonical, create-once, digest-bound, and read through the
existing immutable artifact reader. `normalized-ticket` v1 is deliberately
unchanged; the workspace spec is the AIDEV-222 branch authority until a
later intake contract resolves reconciliation.

Bundle export requires the caller's publishing/gate policy, a specific expected
head, and a ready workspace. It passes exactly the full feature ref to
`git bundle create`, holds the staging descriptor, streams its SHA-256, and
verifies the advertised ref, base ancestry, object format, offline fetch, and
strict object closure from the held bytes. The destination and bundle manifest
are exclusive publications; an existing or substituted digest is never
repaired. Published bundles are owner-non-writable and are reverified from
held descriptors before persistence and again during retained disposal;
artifact children are journaled with exact identity and digest. Host transfer
and GitHub publication belong to AIDEV-225.

## Retention and disposal

`markRetained` records immutable success/failure retention deadlines. The
component disposer accepts an already-held merged `RunTerminalFence`; it never
acquires or completes that fence. It proves quiescence around every rename and
delete, moves only identity-matched Git roots into a private fence-token
namespace, removes them without following symlinks or crossing filesystems,
and leaves Pi runtime/session/footer state and other runs untouched. A private
disposal identity contains authenticated snapshots of the exact contract bytes
and per-target completion markers, preserving the validated resource proof
after the artifact manifest itself is removed; recovery never trusts a mutable
journal alone. Repeating the same disposal under the same held fence is safe. Sandbox setup, scheduling,
publication, and merge remain owned by AIDEV-223 through AIDEV-226.
