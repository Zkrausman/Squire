---
type: synthesis
created: 2026-09-01
updated: 2026-09-02
confidence: high
sources: [sources/SRC-2026-09-01-001, sources/SRC-2026-09-01-002, sources/SRC-2026-09-01-009, sources/SRC-2026-09-01-010, sources/SRC-2026-09-02-001]
---

# AIDEV-216 and AIDEV-224 ownership boundary

AIDEV-216 owns the [trusted transition mechanics](/concepts/trusted-controller-boundary.md), Pi RPC/session runner, safe artifact validation, idempotent attempt coordination, finite lifecycle policy, and a transactional persistence **interface** plus test adapter. AIDEV-224 owns one-ticket intake, concrete SQLite schema/migrations/adapter, and startup reconciliation. [Architecture](/sources/SRC-2026-09-01-001.md)

This split was the architecture review's only initial ownership concern and was accepted after correction. [Independent review](/sources/SRC-2026-09-01-002.md) AIDEV-216 therefore must not ship SQL, migrations, a production in-memory fallback, Linear intake, or automatic startup reconciliation. It defines allocation/identity persistence ports, an explicit runner cleanup operation, and test adapters: a non-cooperative process stays `termination_failed` and blocked until an injected supervisor seam resolves and reaps it; observed exit then authorizes exact-token compensation. A terminated uncertain first-session spawn remains `failed` rather than authorizing another session. AIDEV-224 supplies durable adapters and startup invocation without weakening [allocation fencing](/sources/SRC-2026-09-01-009.md), [settlement cleanup](/sources/SRC-2026-09-01-010.md), or [termination-failure ownership](/sources/SRC-2026-09-02-001.md). The boundary should be preserved through [epic wiki maintenance](/analyses/epic-boundary-project-wiki-maintenance.md).
