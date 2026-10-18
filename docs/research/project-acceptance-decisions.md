# Project acceptance after ticket shipment

Ticket shipment starts project-level integrated acceptance; it does not by itself complete a project or establish that the application is accepted. This note documents the controller's source behavior. It does not report an operational acceptance result.

The prior source audit is pinned to [`50cbf10580670be193d6035763e4c2b9a1a497fa`](https://github.com/Zkrausman/Squire/commit/50cbf10580670be193d6035763e4c2b9a1a497fa) (17 October 2026). This publication candidate is pinned to [`8e410c01b58d99ce6934ff80af0cb98993d9c8b0`](https://github.com/Zkrausman/Squire/commit/8e410c01b58d99ce6934ff80af0cb98993d9c8b0) (18 October 2026) and contains documentation deltas only. The relevant source and referenced fixture definitions were inspected, not executed; no source or fixture files are changed here.

## Decision and evidence

The controller enters project acceptance after a nonempty set of tickets reaches `shipped` ([run loop](../../src/controller.mjs#L267-L270)). Each configured service is checked at its observed remote branch head. A retained passing result for that same head may be reused; otherwise the controller materializes the head, runs setup, configured service checks and optional acceptance commands, and requires a clean checkout matching that head ([acceptance runner](../../src/controller.mjs#L672-L685)). Before recording completion, it rereads the service heads and rejects a changed-head result ([final head check](../../src/controller.mjs#L687-L690)). These sequential reads are not an atomic snapshot across repositories and do not continuously monitor branches after completion.

| Condition | Source behavior | Limit |
| --- | --- | --- |
| Every ticket is shipped | Starts project acceptance. An unresolved producer scope can block the phase before checks begin. | Shipped tickets alone do not mean the project is complete. |
| A configured service has no reusable passing result at its current head | Runs setup, service checks and optional acceptance commands against that head. | The result covers the configured commands; it does not automatically prove visual, browser, native or other unconfigured product behavior. |
| A passing result is retained for the same head | Reuses the stored pass without fresh setup, checks or checkout-identity validation. | Reuse is not a new observation of the commands, environment or dependency closure. |
| A check fails, the checkout is dirty, or its identity differs | Records a failed service result and blocks this acceptance pass. Services are processed serially, so a failure can leave later services unchecked. | Ticket shipment and merge history remain; failure does not establish that every service was checked. |
| A service head changes during the pass | Final head comparison rejects completion based on the earlier observations. | The sequential comparisons do not provide a simultaneous multi-repository snapshot or future monitoring. |
| Service records pass but completion or producer closure cannot be persisted | The project is not recorded complete; an acceptance producer may remain held. | Passing service records do not settle the producer or permit an implicit retry, import or refund. |
| A project is already recorded complete | The controller returns the retained completion state after checking producer scopes. | Completion is not a fresh check of current heads or application state. |

Project-level acceptance runs configured service verification; it does not create new per-criterion browser or native evidence. Existing ticket-level evidence remains tied to its own candidate and delivered observations. An unchanged branch head also does not prove an unchanged environment or complete oracle dependency coverage.

## Research card

| Field | Finding |
| --- | --- |
| Decision/output | Keep ticket shipment, project completion and application acceptance distinct. Completion requires the configured integrated acceptance path, final head agreement, and durable completion with producer closure. |
| Evidence limits | Source behavior and existing fixture definitions were inspected. No fixture or command was executed for this note. The retained same-head pass skips fresh checks; acceptance is only as broad as configured commands; branch reads are sequential; and no live project outcome is established. |
| Expected benefit | Clearer project status and fewer false completion claims. This benefit is qualitative and unmeasured. |
| Status | Source decision documented; operational outcome unestablished. |
| Dependencies and blockers | All tickets must be shipped; configured services and checks must be available; fresh checks require a clean matching checkout; observed heads must remain unchanged through the final comparison; completion and producer closure must persist. An unresolved producer can block entry or leave the project held. |
| Future acceptance and negative cases | Proposed gates for any future behavioral change, not run for this publication, include a held producer despite retained passing service records; head movement during acceptance; a failing configured check with ticket shipment preserved; same-head pass reuse without claiming a fresh run; and failed completion persistence retaining the hold. |
| Remaining effort forecast | Forecast, not elapsed effort or a guarantee: independent reviewer, 0.5–1.5 hours for source-accuracy/privacy review; documentation/release role, 0.5–1.0 hours for static link/diff checks and publication reconciliation. Combined working estimate: 1.0–2.5 person-hours, carried forward from the prior queue and subject to reassessment if review finds issues. CI duration and approval/merge latency are unknown and excluded. There is no implementation scope or implementation estimate. |

The existing [controller fixture](../../test/controller.test.mjs#L72-L83) covers project completion and service acceptance, while the [acceptance-closure failure fixture](../../test/producer-controller.test.mjs#L115-L151) covers passing service records without completion, a held scope and refused subsequent acceptance. These are source-inspected fixture definitions, not evidence of a test run for this note or exhaustive coverage of every condition above.

## Configuration and recovery boundary

Ordinary initialization rejects a changed project configuration for an existing project ID ([configuration guard](../../src/store.mjs#L183-L191)). The code also has separate guarded amendment paths for model routing and a one-time agent-call-cap increase, each with its own pause and settlement requirements; both check producer scopes before changing policy ([routing amendment](../../src/store.mjs#L235-L255), [call-cap amendment](../../src/store.mjs#L265-L302)). These paths do not authorize arbitrary scope or check changes and cannot clear a held producer. A new project is not a workaround for an unresolved producer.

`resume --retry` checks producer scopes before changing retry state and does not close an open acceptance producer ([resume guard](../../src/store.mjs#L895-L925)). Preserve the existing state and hold when acceptance outcome or closure is unresolved. This note selects no recovery procedure, implementation change or operational run.
