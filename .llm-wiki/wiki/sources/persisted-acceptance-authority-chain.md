---
type: source
title: Persisted acceptance authority chain
status: insight
category: architecture
created: 2026-09-01
updated: 2026-09-01
slug: persisted-acceptance-authority-chain
---

# Persisted acceptance authority chain

A phase result becomes workflow authority only after exact recursive artifact/evidence validation and one compare-and-set persistence of its trusted run, handoff, attempt, session, head, status, and generation identity. Orchestrator transition requests and Review/Test gates must derive from that persisted identity rather than caller-supplied status or generic references. This connects [[immutable-handoff-validation]], [[trusted-controller-boundary]], and [[transition-remediation-and-fresh-gates]], and implements the control-plane policy cited by [[SRC-2026-09-01-001]] and [[SRC-2026-09-01-004]].

*Category: architecture*

---
*Captured: 2026-09-01*

## Related

- [Immutable Handoff Validation](/concepts/immutable-handoff-validation.md)
- [Trusted Controller Boundary](/concepts/trusted-controller-boundary.md)
- [Transition Remediation and Fresh Gates](/concepts/transition-remediation-and-fresh-gates.md)
