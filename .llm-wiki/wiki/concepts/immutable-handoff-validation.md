---
type: concept
created: 2026-09-01
updated: 2026-09-01
domain: engineering
confidence: high
sources: [sources/SRC-2026-09-01-004, sources/SRC-2026-09-01-001]
---

# Immutable handoff validation

Each attempt has a new immutable phase input and a short trigger bound to its exact bytes by SHA-256. A result attests to that input and binds run, handoff, phase, attempt, target/actual [session identity](/concepts/five-session-pi-rpc-topology.md), and observed Git heads. [Contract source](/sources/SRC-2026-09-01-004.md)

Validation order is filesystem-safe path and exact bytes/digest, explicit v1 schema identity and closed structural shape, semantic consistency, then trusted controller context. Missing, changed, escaped, stale, substituted, contradictory, or duplicate artifacts fail closed before Orchestrator consumption or state mutation. [Architecture source](/sources/SRC-2026-09-01-001.md)

Dispatch persists a deterministic operation identity and monotonic states. Recovery inspects immutable results and stable session entries before deciding whether to send once or continue, supporting [fresh remediation gates](/concepts/transition-remediation-and-fresh-gates.md).
