# Operations: stop gates first

## Cold-start preflight

Record sanitized evidence privately; record identities and paths, never tokens,
auth-file contents, environment dumps or whole secret-bearing configurations.

- **Trust and routing.** Locate the approved Squire executable and its source/build
  identity, rather than trusting the first PATH hit. A source build uses the
  trusted checkout's `npm ci --ignore-scripts --no-audit --no-fund` then
  `npm run build`; its entry is `dist/src/personal/cli.js`. Inspect that version's
  CLI/config schema before use. `squire --version` and `squire -V` report the
  package version without loading runtime integrations; there is no public
  Squire health command.
  Read target repository instructions (including AGENTS.md), safety constraints,
  status and remotes; verify the intended hosting repository and actual remote
  default branch. Never assume `main`; `master` or another branch may be correct.
  Resolve the approved source to a commit SHA and use that as `repository.sourceRef`.
  Preserve the original ticket baseline through the single candidate.
- **Isolation.** Do not reset, clean, stash or commit the owner's dirty checkout.
  Keep unrelated changes out of the source. Use an approved isolated source
  checkout pinned to the verified SHA when needed. Squire bundles the committed
  source into an isolated ticket sandbox, not the worktree's uncommitted files.
  Verify `repository.path`, `slug`, `sourceRef` and `baseBranch` agree. A copied
  legacy `.squire.json`/`squire.json` binary/version/health/sync descriptor is not
  proof of a current personal-MVP configuration.
- **Configuration and privacy.** Explicit `--config` wins over `SQUIRE_CONFIG`,
  then the per-user default (`~/.config/squire/config.json`, or XDG_CONFIG_HOME's
  `squire/config.json`; Windows `%USERPROFILE%\.squire\config.json`). Inspect
  only relevant nonsecret fields. `SQUIRE_DATA_DIR` overrides JSON `dataDirectory`.
  Without either, data defaults to XDG_STATE_HOME's `squire` or
  `~/.local/state/squire`; Windows uses `%LOCALAPPDATA%\Squire` with a home
  fallback. Do not assume these defaults or inherited environment are private.
  Explicit `paths.state`, `paths.bridges`, `paths.staging` can override children
  of the data root and resolve relative to the selected config file. Check each
  effective destination, symlink resolution and access permissions, plus
  `<dataDirectory>/logs`, external redirected stdout/stderr and evidence files.
  Require private operator-owned locations outside repositories/shared sync
  folders. Repo-containment rejection is not a confidentiality guarantee. Stop
  for unsafe paths; obtain an approved private destination, not shared ACL edits.
- **App access.** Inspect the trusted `github.tokenCommand` implementation and
  its intended installation/repository selection without printing its output.
  Use an approved host-side secret-safe read-only probe for the exact target
  repository with that App installation token; retain only sanitized target,
  installation identity, permissions and result. Check installation repository
  access, metadata/contents access and intended contents/PR write permissions,
  applicable rules and branch restrictions. A copied helper aimed at another
  repository is a stop, not an invitation to use a personal token. Read-only
  checks do not establish that a future push or PR creation will succeed: token
  expiry, rules and service failures remain possible. Host delivery credentials
  stay out of sandbox/model context; the sandbox auth file is model-only.
- **Runtime and approval.** Verify the host runs Node.js 24 (`>=24 <25`) before
  invoking Squire; other majors fail before config/provider/model work. Node 22
  import/build/test/workflow validation in governed ticket phases is bootstrap
  compatibility only, not production support. Do not upgrade host/global runtimes
  without owner approval. Verify configured `sandbox.template`, role user,
  sandbox-internal `piExecutable`/`piAgentDirectory`, model-only auth availability
  (not contents), approved policy and budgets. Confirm the actual template has
  the target toolchain and repository-specific test commands. Read the target's
  manifests, CI and instructions rather than copying another project's tests.
  For the Squire source package the normal Linux command is `npm test`; this is
  not a default for other projects. Require visible prerequisite completion and
  an existing owner-approved ticket contract before paid phases. The direct owner
  request `use Squire to orchestrate ticket XYZ-123` is the authority for trusted
  cold-start preflight, launch of exactly one initial Squire run, and its normal
  configured App publication/exact-head CI; do not request a second mechanical
  run/publication confirmation. It does not approve a new or broadened contract or
  waive any preflight stop. Without the direct request or other visible applicable
  run authority, or if release/dependency gates are missing or unresolved stops
  remain, block launch.

## Native sandbox boundary

The native `sbx` template store is not the host Docker image store. A missing
host Docker image does not prove a native template is missing. An external
operator must verify the configured template and toolchain through the installed
native interface or retained verified creation evidence. Do not substitute an
image, unsafe fallback, nested sbx installation, shared-template modification or
ACL change. Sandbox phases need not have the host's sbx executable; do not seek
host access from inside them.

These are **argv shapes**, not instructions to create a second ticket sandbox:

```text
sbx create --name <sandbox> --template <template> shell <bridge-path>
sbx exec -u <role-user> -w /ticket/workspace <sandbox> <command> <arg>...
```

Squire's workspace uses exactly `create`, optional `--template`, `shell` and a
bridge path, then native `cp`/`exec`; the phase runner uses `exec -u ... -w ...`.
Do not rewrite this as `docker sandbox` or an invented template-list command.
On Windows launch the native executable with an argument array (`shell: false`,
e.g. Python `subprocess.run([exe, "exec", "-u", role, "-w",
"/ticket/workspace", sandbox, command], check=True)`). Avoid Git Bash/MSYS path
rewriting of `/ticket/...` and `sandbox:/...`; do not concatenate shell strings.

Command evidence: the shipped `src/personal/docker-sandbox.ts` and
`src/personal/pi-phase-runner.ts` construct these argv. External operator native
help verified `sbx --help`, `sbx create --help`, `sbx exec --help`, the `shell`
agent and exec `-u/--user`, `-w/--workdir`. The create `--name`/`--template` and
`cp` details are source-backed here, not independently host-help-tested by this
skill's offline tests. Confirm any version-dependent native flags on the host
before launch; do not claim Linux sandbox tests establish host availability.

## Authorized normal run and observation

For the owner request `use Squire to orchestrate ticket XYZ-123`, launch exactly
one initial run **from the running trusted owner-facing Pi session**, after its
verified Squire launch extension is installed and loaded, with:

```text
/squire-run TICKET-ID --config ABSOLUTE_PATH
```

`TICKET-ID` is the existing owner-approved Linear contract. The command captures
the actual session's Pi package, CLI and model-store identity and starts the
bounded Contract → Implement → fresh independent read-only Verify workflow
through a private parent-owned channel. Normal delivery uses configured App
publication, then verifies required external CI at the exact PR head. It rejects
missing model IDs or a runtime it cannot authenticate. Direct `squire run` is **not**
a supported operator launch: it fails without the bridge; never invent an identity
from an environment variable, caller-authored JSON or a CLI flag.
Reopening a fresh Pi session after an upgrade binds only *later* runs to the new
runtime.

Use the trusted Squire executable for observation only. `RUN-ID` is the exact
returned launch ID; `CONFIG` is the same verified absolute config path:

```sh
squire watch RUN-ID --config CONFIG
squire status RUN-ID --config CONFIG
squire status TICKET-ID --config CONFIG
```

No resume/recovery command or invented flags. A background launch returning an
ID is reservation/spawn evidence, not success. Keep configuration/environment
path selection consistent when observing; retain the launch-time effective paths
if current configuration later changes.

Use one event-driven non-model `watch`; it exits at terminal state, but its exit
code is not the run's success verdict. When blocking the owner conversation is
acceptable, direct native non-model `squire watch` is preferred. Use the installed
`squire-observer` only when preserving the owner conversation is useful. Its one
watcher receipt is observation only and grants no workflow, retry, publication or
merge authority. A child/tool timeout is observer timeout, never run completion.
No model status polling or unbounded watchdog loops.

A deterministic mechanical contract-conformance defect that has one obvious
correction inside the approved scope does not require interrupting the owner for
a mechanical choice. Preserve the failed candidate immutably; privately record
the measured defect and evidence. Make only a narrow, auditable amendment to the
contract/source condition, then launch a fresh replacement candidate under the
original bounded orchestration authority and run fresh independent Verify. This
is not a repair, resume, relabel, promotion or retry of the failed candidate, and
never repeat an unchanged condition. Escalate only for genuine scope expansion, product/architecture tradeoffs,
missing authority, security/credential ambiguity, repeated failure without
materially new evidence, or activation outside the request. Other failures remain
terminal: preserve and report them without an unauthorized retry. Do not silently
broaden the ticket. Keep detailed failure evidence private; report concise
sanitized public facts and leave unknown evidence unknown.

For any candidate, Verify is fresh, independent and read-only: its input and
output must both equal the Implement candidate SHA, it must pass, and every
configured test command must be represented. Publish only that verified SHA via
the configured App path; required hosted CI must pass at the exact published PR
head, which must equal the candidate SHA. A changed/mismatched head or missing,
failed or inconclusive gate is not success. Do not merge or bypass gates. Before
reporting clean normal success:

1. Read persisted `<state>/<run-id>.json` and phase evidence, not just an outbox,
   PR link, transcript or all-green phase summary. Verify run/ticket/repository,
   source SHA, config binding, attempts, input/output HEADs and complete results.
2. Match final Implement output to the candidate SHA. Verify must pass with input and output bound to that same SHA and every configured test command represented. Verify is source-read-only. External CI is separate; verify required CI on the exact PR head and do not describe local tests as hosted CI.
3. Verify App-authored PR identity, intended base, branch and exact published
   head; do not merge. Persisted status/lifecycle must be `completed`, with
   end timestamp, PR URL and no terminal error. Publication failure after passing
   phases is still failure, not normal success.
4. Verify the ticket reservation was released: no owned record remains at
   `<state>/locks/<lowercase-ticket-id>.lock`. Read-only inspection plus ticket
   status must not show an active/ambiguous owner. Never delete it as a shortcut.
   A terminal record alone does not prove release; a later different owner is a
   separate run and must not be touched.
5. Keep the original ticket baseline for cumulative `projectWiki` disposition
   through final HEAD, not a partial working diff. Every changed committed
   `.llm-wiki` path must be reported; a no-update result needs a concrete durable
   knowledge reason. Only the target worktree's wiki is eligible, never a personal
   or host vault; exclude transcripts, routine status, secrets and unrelated notes.

## Failure triage and concrete cold-start cases

Preserve original state, logs, phase outputs, sandbox and candidate. Classify as
preflight/authority, infrastructure/auth, phase/contract, test/product, or terminal
publication/persistence failure. Give the owner concise sanitized facts and a
bounded next decision. Do not repair phase JSON/state, resume, relabel or promote a
failed candidate; invent evidence; manually publish a failed candidate; silently
substitute personal credentials; or retry an unchanged condition. A fresh
replacement is covered by the original request only for the narrowly defined
mechanical correction above. Other new runs need separate applicable authority.
Ambiguous reservations require external owner investigation of controller
ownership/liveness before separately authorized cleanup, never an automatic
retry or kill by guessed PID.

These offline scenarios are checklist contracts, not live push or recovery proof:

| Scenario | Required decision and evidence | Forbidden shortcut |
| --- | --- | --- |
| Wrong repository token scope | STOP; verify exact target installation access and sanitized read-only probe before launch; future push remains unproven. | Personal-token substitution or token dump. |
| Unsafe inherited/default log path | STOP; resolve SQUIRE_DATA_DIR before dataDirectory, all paths overrides and log redirects; obtain private outside-repo destinations. | Assuming JSON/defaults are effective or changing shared ACLs. |
| Copied test command/toolchain | STOP; verify target manifests/CI/instructions and actual template tools, then approve target-specific testCommands. | Copying a Go command into a Node project or weakening tests. |
| Docker image absent | VERIFY native sbx template evidence on the host; Docker absence alone is inconclusive; hold launch until verified. | Unsafe image fallback, nested sbx or shared-template edits. |
| Dirty checkout | PRESERVE uncommitted files; verify approved committed SHA and pin isolated source; keep original baseline. | Reset/clean/stash or importing unrelated work. |
| Missing prerequisite approval | STOP paid launch; obtain visible prerequisite evidence and explicit owner approval. | Treating the skill or inherited conversation as authority. |
| Terminal publication failure | FAILED even when phases passed; preserve state/logs/sandbox/candidate, check exact head, terminal error and reservation release, then escalate. | Repairing JSON/state, manual candidate publication or silent rerun. |

Evidence inventory for maintainers: public grammar/build from
`src/personal/cli.ts` and `package.json`; precedence/paths from
`src/personal/config.ts`; native argv from the two runner files above; exact-head,
publication and release from `controller.ts`, `github-publisher.ts`,
`json-run-state.ts` in `src/personal`; watching from `docs/run-events.md`.
These are provenance identifiers in the trusted Squire source, not required
relative links or dependencies on a source checkout after installation.
