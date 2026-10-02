# Orchestrator is the owner-facing interface

Owner requirement, 2026-09-30: the owner interacts only with the orchestrator, never directly with Squire.

## Responsibilities

The orchestrator receives goals and steering, researches/plans, admits structured execution slices, owns dependency and ownership maps, dispatches through Squire, monitors durable evidence, mirrors actual transitions to Linear, resolves infrastructure failures and replans bounded unresolved outcomes. It reports verified completion or a concrete decision/blocker requiring the owner.

Squire is the internal execution and delivery engine. It owns isolated worker sessions, protected checks, candidate identity, fresh reviews, immutable checklist evidence, bounded repair/rebase counters, local or authorized remote publication, expected-head merge and postmerge verification. The orchestrator must use these gates, not bypass them.

## Interaction contract

- The owner supplies a goal, preferences or corrections in conversation. No Squire command, ticket-state maintenance, worker supervision or routine retry action is required from the owner.
- Routine model/catalog setup, test harness repairs, local process restarts and task decomposition are orchestrator work within existing authorization.
- Replanning records predecessor project/slice IDs, immutable evidence, unresolved criteria, changed approach and new bounded scope. It never resets an exhausted counter or treats an unmerged candidate as delivered.
- Outcome completion requires all child evidence plus actual integration acceptance. Linear checkboxes and implementation claims alone are insufficient.
- Future harness/API adapters implement the same typed planning, execution, review and evidence boundary. Codex subscription execution remains the active adapter.

## Current implementation limit

The StickyCanvas trial currently uses this chat and its scheduled heartbeat as coordinator, with Squire's durable engine underneath. Structured contracts, parallel isolated implementation and serialized delivery are implemented. A standalone durable orchestrator service that performs admission, automatic bounded replanning and Linear reconciliation without relying on the chat remains framework work; do not claim it complete from this trial or this document.
