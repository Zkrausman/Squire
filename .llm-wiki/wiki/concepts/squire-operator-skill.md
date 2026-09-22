---
type: concept
created: 2026-09-17
updated: 2026-09-17
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
`squire-operator` and `squire-bug-report` beneath the resolved Pi agent
`skills` directory. It compares bytes, preserves unrelated skills, rejects
aliases, and uses bounded replacement/rollback with ordinary owner-writable
installed modes. The skill does not invoke the command or install itself. A
fresh trusted session in another project then verifies discovery and reference
reads. Merge never installs the skill. Delegation, merge, tags, publication,
installation, deployment and real-world actions retain separate authority gates.

`test/squire-operator.test.ts` checks frontmatter, contained references, shipped
CLI grammar (including rejection of invented interfaces), command-source evidence
and seven documented stop/preservation/escalation scenarios. These static checklist
checks are not an executable policy engine or live access proof.
`scripts/validate-squire-operator.mjs` separately copies the installed global layout
into temporary HOME/settings, uses a fresh non-Squire context and the installed
Pi public loadSkills/formatSkillsForPrompt exports, and reports actual package and
version with diagnostics. It makes no model call or global install; unavailable
loader fails visibly rather than substituting Markdown parsing. Host and sandbox
Pi versions must not be presumed identical. Final owner-machine activation and
native-host/App prerequisites remain separate from this offline proof.
