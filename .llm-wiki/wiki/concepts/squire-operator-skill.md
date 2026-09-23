---
type: concept
created: 2026-09-17
updated: 2026-09-22
domain: engineering
confidence: high
sources: []
---

# Portable Squire operator skill

`skills/squire-operator` is a self-contained Pi skill: discovery metadata and a
compact entry point in `SKILL.md`, with operations and installation/handoff
references contained beneath it. References resolve from the installed skill
directory, never the target project's cwd or a source checkout. The package is
documentation, not a controller, recovery engine or authority grant.

Cold starts establish trusted executable/configuration identity, actual target
repository/default branch, isolated committed source and original ticket baseline.
Paid launch requires visible prerequisites/approvals, exact-repository App access,
private effective data/state/bridge/staging/log paths (including SQUIRE_DATA_DIR
precedence), native template evidence and target-specific toolchain/tests. Native
sbx templates are not host Docker images. Host-only CLI availability is an external
operator check, not a requirement to install sbx or seek host access inside phases.
Read-only App probes cannot guarantee future push/publication success.

A direct owner request such as `use Squire to orchestrate ticket XYZ-123` is
visible authority for trusted cold-start preflight and launch of exactly one
initial Squire run for an existing owner-approved contract, including normal
configured App publication and required exact-head CI. It neither approves a
new/broadened contract nor bypasses preflight. The normal path is Contract →
Implement → fresh independent read-only Verify → publication and exact-head CI.
A deterministic mechanical contract-conformance defect with one obvious in-scope
correction is the narrow exception to interrupting the owner: preserve the failed
candidate and privately record the measured defect. Make an auditable narrow
contract/source condition amendment, then launch a fresh replacement under the
original bounded authority. Never repair/resume/relabel/promote the failed
candidate or retry an
unchanged condition. Escalate only for genuine scope expansion,
product/architecture tradeoffs, missing authority, security/credential ambiguity,
repeated failure without materially new evidence, or activation outside the
request. Keep failure evidence private and public reports concise; unknown evidence
stays unknown. Direct non-model `squire watch` remains preferred when blocking is
acceptable; observer receipts remain observation-only. Merge, installation,
deployment and unrelated external actions need separate authority unless clearly
included by the owner.

The public personal CLI supports run/status/watch/telemetry plus dependency-free
`--version` and `-V` aliases. The version bootstrap reads only the declared package
metadata, dispatches before the runtime/controller graph, and rejects extra or
incompatible version operands through the bounded usage error. Observation is
event-driven or bounded and non-model. Clean normal success requires exact candidate/phase evidence,
App publication, persisted terminal success and reservation release; passing phases
alone do not overcome terminal publication failure. Failed artifacts remain intact;
no output/state repair, invented resume, silent paid relaunch, personal-credential
fallback or manual failed-candidate promotion. Authorized recovery is distinguished
from clean normal success. Cumulative projectWiki accounting retains the original
ticket baseline across attempts and includes every committed changed wiki path.

Activation is a separate owner-approved post-review/merge step: from the trusted
reviewed Squire build, the owner invokes `squire install-skills`, which owns only
`squire-operator` and `squire-bug-report` beneath `skills/` and the advertised
`squire-observer` file beneath `agents/` in the resolved Pi agent directory. It
compares bytes, preserves unrelated skills/agents, rejects aliases, and uses
bounded replacement/rollback with ordinary owner-writable installed modes. The
skill does not invoke the command or install itself. A fresh trusted session in
another project then verifies skill discovery and observer advertisement and
reads the installed references. Merge never installs these resources.
Delegation, merge, tags, publication, installation, deployment and real-world
actions retain separate authority gates.

When blocking the owner conversation is acceptable, direct native non-model
`squire watch` is preferred. An async `squire-observer` child is optional and
exists only to preserve conversation availability; its one receipt is
observation, never workflow, retry, publication or merge authority. It requires
the parent-supplied existing run ID, trusted executable/cwd and exact config,
and a timeout is not run completion.

`test/squire-operator.test.ts` checks frontmatter, contained references, shipped
CLI grammar (including rejection of invented interfaces), command-source evidence,
observer guidance, the owner trigger and bounded authority, immutable mechanical
replacements, escalation, exact-head gates, failure privacy, and seven documented
stop/preservation scenarios. These static checklist checks are not an executable
policy engine or live access proof.
`scripts/validate-squire-operator.mjs` separately copies the installed global layout
into temporary HOME/settings, uses a fresh non-Squire context and the installed
Pi public loadSkills/formatSkillsForPrompt exports, and reports actual package and
version with diagnostics. It makes no model call or global install; unavailable
loader fails visibly rather than substituting Markdown parsing. Host and sandbox
Pi versions must not be presumed identical. Final owner-machine activation and
native-host/App prerequisites remain separate from this offline proof.
