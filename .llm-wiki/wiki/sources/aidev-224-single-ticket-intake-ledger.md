---
type: source
title: Single-ticket intake and durable workflow ledger
status: insight
category: architecture
created: 2026-09-06
updated: 2026-09-06
slug: aidev-224-single-ticket-intake-ledger
---

# Single-ticket intake and durable workflow ledger

AIDEV-224 is implemented at commit `584d1a3de59e70eb5a88a8e72d172b3a0c77ed5b` from the frozen base. The implementation combines authoritative one-issue Linear intake, create-once canonical normalized-ticket artifacts, deterministic contract/physical branch projections, and a transactional WAL-backed trusted-controller ledger. SQLite projections enforce CAS, leases, terminal fencing, resource/delivery/webhook uniqueness, cleanup journaling, and append-only operator errors. Startup uses complete two-pass observations across Linear, Sandbox, Herdr, process, Git, and GitHub with opaque side-effect permits. Later Sandbox/Herdr/publication/approval/UI behavior remains strict ports only; merge stays human-only. Verification: `/ticket/evidence/implement/1/verification.md`; result: `/ticket/artifacts/implement/1/result.json`.

*Category: architecture*

---
*Captured: 2026-09-06*

## Related

_Add links to related pages._
