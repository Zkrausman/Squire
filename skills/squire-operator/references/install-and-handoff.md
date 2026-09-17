# Installation and new-session handoff

## Explicit activation gate

Review the whole skill directory as executable guidance. Merging a PR does not
install or activate it. Only after review/merge **and owner install approval**:

1. Locate the trusted reviewed source and its exact commit. Locate the installed
   Pi package and its official `docs/skills.md`; verify supported discovery for
   that actual version, not an assumed match with another machine's Pi.
2. Choose one global destination: `~/.pi/agent/skills/squire-operator` (recommended)
   or `~/.agents/skills/squire-operator`. Expand `~` using the native user's home;
   these are portable locations, not literal backslash-escaped paths.
3. Check that the destination does not already exist, including symlinks. If it
   exists, stop for an explicitly reviewed replacement plan. Create only missing
   parent directories and copy the **entire** `skills/squire-operator` directory
   to that destination, refusing overwrite. Include `SKILL.md` and `references/`;
   do not copy just the entry file or symlink back into a mutable checkout.
4. Open a fresh trusted Pi session in a different project, or use Pi's `/reload`
   resource reload in an existing session (verify support in installed Pi docs).
   Check that startup skill metadata advertises `squire-operator` without a
   collision/warning. Ask it to read the skill, or use `/skill:squire-operator`,
   then resolve and read both references from the **installed** directory. This
   verification authorizes no ticket launch or paid workflow by itself.

Global discovery advertises the description at startup and loads the body on
demand. Project `.pi/skills` and `.agents/skills` discovery requires a trusted
project; simply adding `skills/` to an arbitrary repository does not globally
activate it. Pi packages can also export skills, but this directory needs no
package install, upgrade, auto-run hook or runtime dependency. Duplicate names
can shadow this copy; stop and resolve explicitly rather than overwrite another
skill. Delegation skills do not replace this operating checklist.

## Offline discovery proof (maintainers)

From the trusted Squire source, `node scripts/validate-squire-operator.mjs` copies
the directory into a temporary global installed layout, starts a fresh non-Squire
project context with isolated HOME/settings/environment, and imports the actual
installed Pi public `loadSkills` and `formatSkillsForPrompt` exports. It asserts
startup metadata, zero diagnostics and installed-relative reference readability.
No model/session launch, live service, paid phase, owner skill writes or global
upgrade is involved. It reports the resolved package path/name/version; it must
fail visibly if the supported loader is inaccessible. An optional first argument
is the trusted installed Pi package directory when automatic local/runtime
resolution cannot find it. The parser/checklist tests are not a substitute for
this loader proof. `npm test` includes the proof and targeted offline checks.

This proof is not final activation. After owner-approved real installation,
repeat the fresh-session discovery/read checks on the destination machine and
record its actual Pi version; sandbox and host versions can differ. Native host
sbx availability, App access and future push success are not established by the
offline proof.

## Copyable new-session handoff

Fill all fields from evidence; unresolved fields mean STOP, not permission to
infer defaults. Keep private locations private and omit secrets/session history.

```text
Use the installed squire-operator skill and read its two references.
Target: <verified repository slug, absolute checkout, instructions, default/base branch>
Squire: <trusted executable/build source and commit; actual Pi package/version>
Source: <isolated committed SHA>; original ticket baseline: <SHA, never reset on retry>
Ticket and scope: <ID, goal, exclusions; mirror is not routing authority>
Config: <private absolute path and nonsecret identity/digest>; effective data/state/bridge/staging/log paths: <verified private paths, environment precedence checked>
Preflight: <App target/permissions probe, native template/tools, target testCommands, evidence locations; future push unproven>
Prerequisites/authority: <visible approvals and stop gates; authorized budget/run/App publication scope>
Evidence: <private state/log locations; current run ID/candidate/phase/CI evidence if a run exists, otherwise none>
Wiki: <cumulative disposition from original baseline through final HEAD, every changed path or concrete no-update reason>
Limits: no delegation, merge, tags, installation/deployment or real-world actions without separate authority; no secrets, state/output repair, resume, failed-candidate publication or silent paid relaunch.
Next authorized action: <one bounded action; unresolved prerequisites mean stop and ask>
Failed/recovery history: <sanitized evidence location and explicit recovery authority, or none; never promote a failed candidate>
```
