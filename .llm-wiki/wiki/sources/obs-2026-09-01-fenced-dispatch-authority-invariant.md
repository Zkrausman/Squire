---
type: source
title: "Observation: Fenced dispatch authority invariant"
tags:
  - AIDEV-216
  - orchestration
  - fencing
  - RPC
  - recovery
status: observation
created: 2026-09-01
updated: 2026-09-01
slug: obs-2026-09-01-fenced-dispatch-authority-invariant
relevance: high
observed_at: 2026-09-01T21:25:31.077Z
source_context: Implement remediation attempt 4
---

# ⭐ Observation: Fenced dispatch authority invariant

AIDEV-216 dispatch authority now uses monotonic fencing tokens and renewable lease horizons covering the configured role deadline. Dispatch mutations, phase-result acceptance, terminalization, and Pi RPC side effects require the current token. Recovery resends an original trigger only after two complete `get_entries` snapshots have identical leaves and entries with no marker. Transition authority is loaded from the persisted Orchestrator registration, and correlated RPC responses are closed-shape and command-matched. These mechanics implement the trust and handoff policies in [Squire MVP Architecture](/sources/SRC-2026-09-01-001.md) and [AIDEV-215 Workflow and Handoff Contracts](/sources/SRC-2026-09-01-004.md).

*Relevance: high*
*Context: Implement remediation attempt 4*
*Tags: AIDEV-216 orchestration fencing RPC recovery*

## Related

- [Trusted Controller Boundary](/concepts/trusted-controller-boundary.md)
- [Immutable Handoff Validation](/concepts/immutable-handoff-validation.md)
- [Transition Remediation and Fresh Gates](/concepts/transition-remediation-and-fresh-gates.md)

---
*Observed: 2026-09-01T21:25:31.077Z*
