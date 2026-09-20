---
type: concept
domain: engineering
confidence: high
---

# Protected phase-input transport

The personal delivery runtime uses one version-1 protected-artifact/stdin protocol for legacy Plan, supervised Requirements/Design, Implement, Review, Test, Retro, remediation, staged attempts and report-only correction. Every invocation gets fresh immutable identities; retained failed bytes never authorize resume or get rewritten for a new attempt.

The host reuses report evidence's Linux fd-relative/private-owner and Windows native NTFS retained-handle/protected-DACL primitives. A canonical manifest binds run, phase/subphase, attempt, producer, original baseline, expected HEAD and profile digest, plus exact total and per-chunk lengths/SHA-256/filesystem identity. At most 64 one-MiB chunks carry a 64-MiB canonical bundle; reports retain their separate two-MiB bound. Artifact capabilities, binding and conservative 24,000-unit argv/environment capacities fail closed before model work. There is no weaker Windows filesystem fallback.

The Plan controller sends a bounded reference/binding over private IPC instead of the input/options object; its supervisor independently reopens and validates the protected chunks. Every model adapter then sends the validated bundle over `sbx exec -i` stdin to a fixed root guard. Only reviewed fixed bootstrap source, bounded selectors and the bundle digest remain in host argv. The guard checks digest/schema/length/run/phase/head/profile consistency before spawning a model. It publishes fresh readonly root-controlled files outside the writable repository and independently reopens/checks them.

**All-content file-backed input** includes the entire effective system prompt, not only JSON. Pi receives `--system-prompt /run/squire-input-<uuid>/system.txt` and exact task JSON on stdin. Core → captured phase → subphase system precedence and digests are preserved without moving trusted layers into a user message. No ticket, cumulative feedback, test commands, findings, captured custom policy or correction report bytes go in argv/environment. Host transports retain only the OS allowlist; Pi uses its separate cleared runtime environment.

Transport rejection is infrastructure (`phase_transport`), not an implementation finding or retryable model result. Status/errors expose bounded transport/schema/size/digest-prefix/validation metadata and fresh-authorization instructions; manifests remain private staging evidence. Existing result schemas, exact-HEAD checks, independent Review/Test, correction charges and publication gates are unchanged. Root guards certify child close; local sbx exit alone is not sufficient and unobserved termination blocks acceptance.

Host chunks/manifests and remote root-controlled inputs persist across failed launches/cancellation; native lease release closes handles but deletes no artifacts. Partial publication may leave unreferenced chunks, never a consumable incomplete manifest. Replacement/revalidation fixtures must target a chunk from the actual launch reference, not directory enumeration: the store also contains independently named probes and manifests that are not consumed as payload chunks. Operators retain these under the run retention policy, outside the repository, and inspect them only through authorized private access. Historical state remains readable without fabricated transport proof. No Gelt rerun, failed-state repair or publication is authorized.

AIDEV-308 retains exhaustive generation ledgers and hostile filesystem-history/ACL/hardlink/crash/delete-on-close matrices beyond the reused protection. Hostile privileged/same-UID controller processes and universal sandbox quiescence are not newly solved. AIDEV-304 retains final minimal invariant prompt architecture. These deferrals do not permit variable argv transport.

Implementation: `src/personal/phase-input-transport.ts`, `command.ts`, `pi-phase-runner.ts`, `plan-supervisor*.ts`. Operator inventory/capacities: `docs/phase-input-transport.md`. Tests: `test/personal-phase-transport.test.ts` plus existing report-evidence, Plan and correction suites. Native Windows CI inspects actual `GetCommandLineW`; Linux root fixtures inspect actual non-root Pi stand-in argv/environment and readonly prompt consumption. Offline fixtures are not live provider/rollout evidence.
