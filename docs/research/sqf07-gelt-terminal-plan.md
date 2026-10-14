# SQF07 — Gelt terminal activity and controls

## Planning acceptance and current dependencies

The corrected three-outcome decomposition is accepted by the Gelt owner as **text planning only**.

This document persists that accepted text with the supplied dependency updates. All new SQF07 contracts/checks remain **PROPOSED_NOT_RUN**. Documentation persistence does not authorize implementation or execution.

- **G05:** the pure rules core merged in PR 9, merge `75c993007c68342e9a4929adb95d2f13aa803924`, with integrated checks **PASS**, according to the supplied owner receipt. Genuine market-shadow acceptance remains incomplete.
- **G06:** the simulator upgrade is authorized and contract review is underway; it is **not runtime accepted**. RuntimeCodex is no longer required under the approved pivot.
- **G07:** remains dependent on the applicable accepted G06 contracts and integrated acceptance.

```text
G05 pure rules core [MERGED; integrated checks PASS]
  genuine market-shadow acceptance [INCOMPLETE]
  → G06 simulator upgrade [AUTHORIZED; contract review underway;
                          NOT RUNTIME ACCEPTED]
      → T1 Truthful activity projection [HELD on accepted G06 contracts]
      → T2 Runner-bound pause/resume [HELD on accepted G06 contracts]
T1 + T2 + G03 accepted terminal shell
  → T3 Integrated terminal activity and controls [HELD]
G07 remains dependent; upstream code/check success is not runtime acceptance.
```

## Accepted planning outcomes — implementation held

1. **T1 — Truthful live activity projection**

   Deliver distinct timestamped data, decision/evidence, rejection, order and observed-fill views, labelled simulated and linked using G06’s accepted synthetic identifiers.

   Preserve known missing, unavailable and corrupt read errors, plus authoritative session expiry, as distinct states. **Uncertain execution remains UNKNOWN and fenced**; read failures must not collapse into execution UNKNOWN.

   Proposed checks cover durable-event linkage, distinct error/expiry presentation, UNKNOWN preservation, protected-session and generation guards, and rejection of stale responses. Recorded fixture evidence remains explicitly fixture-only.

2. **T2 — Runner-bound pause/resume**

   Pause blocks new decision scheduling/admission and fences late decision returns from creating orders. **It must not cancel or erase effects admitted before pause.** Subsequent fills and status observations continue to reconcile and display.

   Resume creates no duplicate tick/order and never automatically reissues unresolved work. Reload/reconnect neither redispatches nor clears UNKNOWN.

   Proposed checks cover the admission boundary, late-return fencing, preservation and reconciliation of pre-pause admitted effects, repeated controls, duplicate prevention and UNKNOWN across pause/resume/reconnect.

3. **T3 — Integrated terminal activity and controls**

   Reuse the retained G03 terminal to display T1 activity and T2 acknowledged controls for one selected simulated run. Show read errors, authoritative expiry, execution UNKNOWN and paused scheduling distinctly; continue displaying post-pause observations of previously admitted effects.

   Proposed checks cover loading/disconnect, run switching and late responses, control acknowledgements, continued fill/status updates while paused, and protected-browser evidence bound to the exact genuine G06 run.

All three implementation outcomes remain held on G06’s actual accepted identity/read/control contracts; T3 also depends on T1, T2 and accepted G03. G03 proves the recorded fixture shell, not autonomous execution.

## Ownership and holds

The Gelt owner retains sole source and acceptance-check authority, with serialized shared-store/transport edits. Original independent and adversarial review roles, exact-head checks, ordinary merge and separate integrated acceptance remain unchanged. G05 producer/MCP/probe/runtime holds remain unchanged except for the explicitly supplied merged pure rules core status and approved G06 simulator pivot above; neither establishes genuine market-shadow acceptance.

No framework, store, real-trade routing or per-trade human approval is added. If G06 cannot enforce an obligation, return the specific contract gap rather than substitute polling controls or fixture proof.

Acceptance and dependency statuses above are attributed to the supplied owner receipts, not independently rerun evidence. Squire owns this documentation only.
