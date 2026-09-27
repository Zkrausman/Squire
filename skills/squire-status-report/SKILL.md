---
name: squire-status-report
description: Produce an evidence-linked Squire hot-path status report when the owner asks for a status, progress, catch-up, or what shipped across services. Report every hot-path ticket in a table per service, with separate blockers and owner asks.
---

# Squire hot-path status report

Use this skill for owner-requested status reports. It is a **read-only reporting guide**, not a Squire run, ticket queue, permission to merge or install, or authority to execute an order. Do not launch work merely to compose the report. Keep existing serial gates and owner approvals intact.

## Scope and evidence

1. State the **as-of time and timezone** and coverage window. Default to **since the last reliably dated status report, with at least the preceding 24 hours**. If the last report cannot be established, use the preceding 24 hours and say so. Do not guess a last-report time or silently omit a longer known gap.
2. For **every service on the current hot path**, identify its active, next gated/queued, blocked, and **verified shipped within the window** tickets. Follow known serial dependencies and include all hot-path tickets even when no run is active. Ask or disclose incomplete scope if the ticket list cannot be verified. A dashboard's active-run/recent-receipt view is not a backlog, and direct-Pi work may not appear there. Historical tickets outside the hot path are included only if they shipped in the window or materially changed a current gate.
3. Reconcile available **read-only** evidence: ticket status and dependencies; source/PR merge SHA and timestamp; exact-head review/CI; Squire run receipts; direct-Pi work; installed version when relevant. Give each source its observation time. If a source is inaccessible or stale, explicitly say what could not be checked and base claims only on verified evidence. Never claim a failed API read proves ticket/broker state, invent a receipt, expose credentials/private logs, or copy raw ticket bodies into the report.
4. Distinguish **shipped** (verified merge and applicable delivery gates), **merged but not installed**, **candidate/draft PR**, **local tests**, **active work**, **queued**, and **blocked**. A process exit, model assertion, synthetic fixture, green local test, or draft PR is not shipment. Broker facts require broker evidence; report pending owner approval without interpreting it as authorization. If the ticket tracker and Git evidence disagree, show the disagreement, not a blended status.

## Required owner-facing format

Use this compact structure, adding one section per service. Each table contains **one row per hot-path ticket and one row per other ticket verified shipped in the coverage window**; deduplicate tickets appearing in both sets. Sort shipped-in-window items by most recent shipment, then active and dependency order. Keep links to evidence in the row or a short reference below it.

```markdown
# Squire status — <as-of date/time and timezone>
Coverage: <since last reliable report timestamp through as-of; at least 24h, or explicit fallback>
Evidence checked: <source(s) and observed times>; unavailable/stale: <source(s) or none>

## <Service name>
| Ticket | State / gate | Change in window | Evidence / next gate |
|---|---|---|---|
| <linked ID> | Shipped <merge SHA/time> / Active / Draft / Queued / Blocked | <concrete delta or “No verified change”> | <linked receipt and immediate dependency> |

**Blockers:** <what prevents progress, including missing evidence; or “None known”>
**Owner asks:** <precise decision, consequence, and whether work on this service can continue; or “None”>

## <Next service name>
...same table and two lines...
```

A service with no verified shipments still gets its full hot-path table; do not print a misleading empty shipped summary. Never label work `UNVERIFIED` as a product-status badge. For a long window, summarize older shipment detail with links without dropping ticket rows. If there are no tickets on a service's hot path, state how that was established rather than omitting the service.

## Decision and freshness rules

- Put owner asks only where a **real decision** is needed. Include exact scope (for example, merging an offline-only PR is not installing it; a trade needs its own fresh exact-order, owner-present confirmation). Do not convert broad orchestration approval into a specific high-impact authorization.
- Mention what can advance without the owner, particularly when one service is blocked and another is not. Do not declare both blocked without checking each service separately.
- Use timestamps and receipt links sufficient to reconstruct the window. When an external system cannot be read, say `not checked` rather than `none`. Do not overwrite or discard failed/incomplete attempts to make a timeline look cleaner.
- End with at most one short cross-service **Next** sentence if it adds information not in the tables. Favor the tables and the per-service blockers/owner asks over narrative.
