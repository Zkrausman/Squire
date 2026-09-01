---
type: concept
created: 2026-09-01
updated: 2026-09-01
domain: engineering
confidence: high
sources: [sources/SRC-2026-09-01-004, sources/SRC-2026-09-01-001, sources/persisted-acceptance-authority-chain, sources/stable-history-trigger-resend-proof]
---

# Immutable handoff validation

Each attempt has a new immutable phase input and a short trigger bound to its exact bytes by SHA-256. A result attests to that input and binds run, handoff, phase, attempt, target/actual [session identity](/concepts/five-session-pi-rpc-topology.md), and observed Git heads. [Contract source](/sources/SRC-2026-09-01-004.md)

Validation order is filesystem-safe path and exact bytes/digest, explicit v1 schema identity and closed structural shape, semantic consistency, then trusted controller context. Phase-result acceptance applies that pipeline transitively to every artifact and evidence reference and atomically persists the accepted result identity; Test evidence requires unique command IDs, exactly one complete record per configured required command, successful required commands and no failures on pass, and a blocking failure on remediation. Missing, changed, escaped, stale, substituted, contradictory, duplicate, or partially valid artifact graphs fail closed before Orchestrator consumption or state mutation. [Architecture source](/sources/SRC-2026-09-01-001.md) · [Acceptance authority insight](/sources/persisted-acceptance-authority-chain.md)

Dispatch persists a deterministic operation identity and monotonic states. Recovery uses two complete `get_entries` snapshots with the same leaf to prove a marker absent before resending the original short trigger ([recovery insight](/sources/stable-history-trigger-resend-proof.md)); a present marker permits only bounded continuation. Correlated Pi responses require a closed envelope, the pending command identity, boolean success, and command-specific data before they resolve. Recovery inspects immutable results and stable session entries before deciding whether to send once or continue, supporting [fresh remediation gates](/concepts/transition-remediation-and-fresh-gates.md).
