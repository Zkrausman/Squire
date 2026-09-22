---
type: concept
domain: operations
confidence: high
sources: []
---

# Bounded Squire observer agent

Squire packages one advertised `squire-observer` Pi agent for optional async
observation. Its fixed runtime contract is Luna
`openai-codex/gpt-5.6-luna` with minimal thinking, a fresh context, no inherited
project/global context, memory or skills, `bash` as the sole tool, and a
36000000 ms (10-hour) timeout. These controls are encoded in the agent
frontmatter, not negotiated by a wrapper or settings override.

The parent must supply an existing run ID, exact trusted Squire executable,
trusted working directory and exact config path. The agent stops rather than
resolving missing or ambiguous values. It invokes that entrypoint once for the
blocking non-model watch and once for status only after watch returns. A child
or tool timeout is `observer_timeout`, never run completion. The receipt is
limited to public terminal status, public candidate/PR data and sanitized
failure; it cannot authorize workflow, retry, publication, merge or mutation.

Direct native non-model watch remains preferred when blocking the owner
conversation is acceptable. The async child exists only to preserve
conversation availability. No scheduler, daemon, polling loop, telemetry
expansion or workflow authority is added.
