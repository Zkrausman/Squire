# Protected phase-input transport (AIDEV-303)

## Delivered boundary

The personal runtime moves **all** ticket/task JSON and the **entire effective system prompt** off argv and environment. “File-backed input” does not mean just the phase JSON while configurable policy, cumulative findings or correction reports remain positional arguments. Core → captured phase → captured subphase composition and effective-prompt digests are unchanged. Pi receives `--system-prompt /run/squire-input-<uuid>/system.txt` (Pi's supported file form) and exact task JSON on stdin. Policy is not demoted to user-message authority.

Production inventory:

| Boundary / route | Transport |
| --- | --- |
| Foreground or detached controller bootstrap | Existing protected captured launch material; no prompt recapture or variable task argv |
| Controller → deterministic Plan supervisor | Closed version-1 immutable artifact reference and trusted binding over private IPC; child independently reopens the protected chunks before using input/options |
| Supervisor → Requirements / Implementation Design | Same protected artifact store and stdin guard used by normal phases; validated Requirements content/digest travels in Design task bytes |
| Legacy Plan, Implement, Review, Test, Retro | `SandboxPiPhaseRunner` → `launchProtected` → fixed root guard → non-root Pi |
| Review/Test remediation and staged escalation attempts | Same runner, fresh transport UUID and immutable chunks per invocation; original baseline/cumulative evidence remains task data |
| Report-only correction, including another allowed correction | Same transport, fresh producer/context, no tools or inherited session; schema, original report, diagnostics and evidence references only in payload |
| Recovery | No new resume/recovery route is introduced. Existing fresh dispatches use these adapters; retained artifacts are not restart authority |

The older `src/pi` RPC topology is not an executable personal CLI delivery route. This change does not activate or redesign that scaffold.

## Protocol and protection

`phase-input-transport.ts` uses the **existing** report-evidence primitives: Linux pinned fd-relative, no-follow exact reads, current-owner/private modes and identity revalidation; Windows native local-NTFS current-owner/protected DACL, handle-relative no-reparse traversal, one-link regular files, retained read/ancestor leases and deny-write/delete sharing. There is no ordinary-Node-filesystem Windows fallback. Missing native capability fails closed.

Version 1 binds a fresh UUID, run, phase, optional Plan subphase, attempt, producer, original baseline, expected HEAD and exact profile digest. The canonical manifest binds exact total byte length/SHA-256 and each chunk's canonical contained path, filesystem identity, byte length and SHA-256. Ownership/security policy is fixed by version 1 and its existing backend, not selectable by task data. A guard bundle additionally binds effective prompt and data lengths/digests, selected CLI profile/tools, environment, control endpoint and deadline; captured launch/policy identity remains in the protected input. Unknown envelope/reference fields and mismatching bindings are rejected.

Artifacts are exclusive-create and fully flushed before their manifest is published. No reference is returned for a partial write. Host validation occurs before preparation and again after preparation immediately before dispatch. The root guard receives the canonical bundle on `sbx exec -i` stdin and its SHA-256 as a bounded argv selector. It verifies the digest, schema, lengths and task/profile/run/phase/attempt/head binding before publishing or spawning Pi. It creates a fresh root-owned runtime directory, writes readonly files with exclusive/no-follow opens, and reopens/checks identity, ownership, length and digest. Task stdin comes from validated in-memory bytes; the system file cannot be replaced by the non-root model because its ancestors and file are root-controlled. Repo mutation and publication remain behind existing exact-HEAD and independent acceptance gates.

Only fixed reviewed bootstrap source, executable/OS selectors, bounded sandbox identities and a digest cross the host command line. Host transports use the existing PATH/HOME/Windows OS allowlist, not inherited credentials, `NODE_OPTIONS` or task-derived environment. Pi gets its separate cleared allowlist. There are no host artifact paths in `sbx cp` input launches. Validated Plan output artifacts/journals also cross stdin, not host-private copy-path arguments.

## Capacity, failure and operations

* Maximum canonical bundle: **64 MiB**. It is stored in at most 64 exclusive **1 MiB** chunks; existing report evidence retains its **2 MiB** limit.
* Host argv has a conservative **24,000 UTF-16-unit quoting estimate** on both platforms; environment has a 24,000-unit bound. Pi selectors have an 8,000-character aggregate bound and 1,024-character per-argument bound. Effective policy/task bytes never count toward argv.
* `CommandPort.byteInput === true` and exact Buffer stdin are mandatory. `NodeCommandRunner` implements the protocol, closes stdin, absorbs early-reader EPIPE and preserves exact stdout evidence. Unsupported adapters, artifact stores, oversized input or ambiguous references fail before model work; there is no compact-prompt or weak filesystem fallback.
* `phase_transport` is an **infrastructure** failure, not a repository implementation finding or retry-eligible model failure. Native `ENAMETOOLONG` and guard validation exit 78 are infrastructure failures. Sanitized diagnostics expose transport/schema, bounded size/digest prefix when available, validation state and required authorization, not payloads or host artifact paths. Legacy state remains readable; absence of a transport manifest is not invented proof.
* Root cancellation endpoints persist a stop request. The guard sends TERM then KILL after two seconds; `done` is written only after observed child close. The adapter independently polls for up to ten seconds (15-second command bound). Local sbx exit is not remote termination proof. Missing close proof blocks acceptance and requires operator inspection.

Protected manifests/chunks under the configured staging root's `phase-transport/` survive success, failed spawn, cancellation and controller exit. A publication crash can leave unreferenced partial chunks; these are evidence, never consumable manifests. Native lease release closes handles, **not files**. Remote root-owned input/control directories remain sandbox evidence. Retention consumes disk and contains private ticket/report material: keep staging outside the repository, private, and within the operator's run-retention policy. Do not put raw manifests, prompts or transcripts in status, project wiki or PRs. Inspect retained evidence through authorized private access; never edit failed bytes to retry. Repair capability/configuration and obtain explicit authorization for a **fresh attempt/run**. No Gelt run, failed-state repair, publication or recovery is authorized by this change.

## Evidence and explicit deferrals

`personal-phase-transport.test.ts` covers >1 MiB production route inputs and >100 KiB captured policy, exact referenced consumption, real child argv/environment, native Windows `GetCommandLineW` inspection via the test executable shim, fresh identities, binding/schema/digest/length/traversal/replacement rejection and prelaunch no-publication gates. Linux root-guard fixtures inspect actual non-root child argv/environment and readonly prompt-file consumption. Existing report-evidence race/ACL/ownership tests, correction crash/charge tests, strict results and Plan cancellation tests remain in force. Windows tests are mandatory in the supported Node 20.17.0/22.9.0/24 CI matrix; Linux execution is not a claim that Windows CI or a live provider/sandbox run was observed.

AIDEV-308 owns exhaustive generation ledgers and hostile filesystem-history/ACL/hardlink/crash/delete-on-close matrices beyond the reused protections. Privileged or hostile same-UID host-controller processes and universal sandbox quiescence after forced host death are not newly solved. AIDEV-304 owns the final minimal invariant prompt graph. Neither deferral permits reintroducing variable prompt/task bytes in argv or environment.
