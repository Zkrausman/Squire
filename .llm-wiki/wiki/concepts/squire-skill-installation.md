---
type: concept
domain: operations
confidence: high
sources: []
---

# Explicit packaged Pi skill installation

Squire skill/agent activation is an owner-approved, explicit operation,
separate from running a ticket, merging a change, or a skill's own guidance.
The public `squire install-skills` command runs before Squire configuration and
provider initialization and owns exactly the packaged `squire-operator` and
`squire-bug-report` skill directories plus the named `squire-observer` agent
file. It resolves the Pi agent root from `PI_CODING_AGENT_DIR`, or
`%USERPROFILE%\.pi\agent` on Windows and `$HOME/.pi/agent` on POSIX, then
installs skills below `skills/` and the observer below `agents/`.

Each invocation compares regular-file bytes and reports `installed`,
`refreshed`, or `current` in fixed skill/agent order. It never discovers
plugins or arbitrary skills/agents, executes helpers, exposes file contents, or
changes unrelated skills/agents. Packaged and owned destination
aliases/symlinks and unsafe agent roots fail closed. An owned skill or observer
refresh is built in a sibling temporary location with ordinary owner-writable
installed modes, swapped as one bounded replacement, and rolled back/cleaned
on failure; incomplete work is nonzero and is never reported as success. The
command is idempotent when the owned bytes are unchanged.

The operator skill documents the command as an external owner action. Merge
and skill use never imply installation or activation.
