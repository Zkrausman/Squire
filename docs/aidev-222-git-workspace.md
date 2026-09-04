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

The constructor requires a runtime-authenticated
`TrustedFilesystemIsolationAuthority` issued by the narrow
`composeTrustedFilesystemIsolationAuthority` composition boundary. At issuance,
trusted composition pre-opens the procfs root, the mount-namespace nsfs
handle, and `/proc/self/mountinfo`; it retains their non-substitutable kernel
references, records exact `fstat` identities, and reads bounded live topology
only from the held mountinfo descriptor. Operations revalidate those descriptor
identities and read the same descriptors without reopening a procfs pathname;
descriptor errors, closure/staleness, malformed data, or overflow fail closed.
The token's class, constructor secret, identity set, descriptors, and
root/mount observation are private; a JavaScript lookalike, stale token,
cross-root token, or unavailable namespace evidence fails closed. The explicit
`closeTrustedFilesystemIsolationAuthority` owner lifecycle is idempotent, and
closed authorities cannot authorize a constructor or side effect. AIDEV-223
composes this boundary only after its sandbox/openat2-or-equivalent setup has
proved ticket containment, same-filesystem bind-mount resistance, and
descriptor/path swap resistance. Node's descriptor and `st_dev` checks remain
defense in depth and are not the production mount proof.

The trusted controller process and each untrusted phase process are separate
security principals. AIDEV-222 consumes the already-composed authority; it
neither creates a namespace nor provisions controller/phase identities.
Namespace creation, principal separation, and identity provisioning belong to
AIDEV-223.

The service validates the immutable spec, requires an injected closed
repository-source authorizer, rejects private/DNS-resolved destinations and
unapproved redirects, binds the authorizer's public DNS answer set to Git's
libcurl `http.curloptResolve` transport configuration while retaining TLS
hostname validation, and imports only the literal base
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
held descriptors before persistence and again during retained disposal. The
retained verifier creates its scratch repository beneath the private,
fence-owned disposal directory, not beneath the run control/repository roots,
so workspace-first disposal remains retryable after restart; artifact children
are journaled with exact identity and digest. Host transfer and GitHub
publication belong to AIDEV-225.

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
journal alone. Repeating the same disposal under the same held fence is safe. Sandbox setup, scheduling, publication, and merge remain owned by AIDEV-223
through AIDEV-226. AIDEV-223 also owns the concrete OS isolation proof, namespace creation, and
controller/phase principal and identity provisioning; it composes the narrow
authority required before this component may perform production Git side
effects.
