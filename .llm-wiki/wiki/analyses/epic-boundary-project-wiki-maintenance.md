---
type: analysis
created: 2026-09-01
updated: 2026-09-01
confidence: high
sources: [sources/SRC-2026-09-01-001, sources/SRC-2026-09-01-002, sources/SRC-2026-09-01-004, sources/SRC-2026-09-01-006, sources/SRC-2026-09-01-007]
---

# Epic-boundary project wiki maintenance

Maintain Squire's native OKF v0.2 vault as durable project architecture, not ticket scratch space. Capture committed design/review sources immutably, synthesize one page per stable concept, cross-link ownership and invariants, cite source packets, and flag contradictions rather than silently overwriting history. [Architecture](/sources/SRC-2026-09-01-006.md) · [Review](/sources/SRC-2026-09-01-002.md) · [Contracts](/sources/SRC-2026-09-01-007.md)

At an epic boundary, update the [AIDEV-216/AIDEV-224 assignment](/syntheses/aidev-216-and-aidev-224-ownership-boundary.md), [trusted controller boundary](/concepts/trusted-controller-boundary.md), and [handoff/gate invariants](/concepts/transition-remediation-and-fresh-gates.md) only when accepted sources change. Exclude secrets, session transcripts, temporary paths, and routine run status. Never merge a personal or host vault into this project vault.

Wiki edits are repository mutations. Complete and lint intended updates before freezing the Implement output head; any later wiki edit invalidates current-head Review/Test gates and requires fresh gates.
