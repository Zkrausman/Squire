# Producer boundary compositions before generated exploration

## Decision and evidence status

Source assessment: 17 October 2026, pinned to Squire [`50cbf10580670be193d6035763e4c2b9a1a497fa`](https://github.com/Zkrausman/Squire/commit/50cbf10580670be193d6035763e4c2b9a1a497fa).

Defer a generated model-based testing harness. Existing producer fixtures cover substantial transition, reopen, accounting and persistence-failure behavior. Two narrower compositions merit proposed deterministic fixtures: late-terminal replay after lease turnover, and sealed-inventory observation after lease turnover. Their purpose is to retain explicit regression evidence for the distinction between recording a fact and possessing authority to advance work.

This is a source-derived decision. The compositions below are hypothetical and unexecuted; no defect, additional coverage result or delivery benefit is established.

## Existing obligations and fixture coverage

| Obligation and bounded assertion | Implementation | Existing fixture evidence | Remaining composition question |
| --- | --- | --- | --- |
| Only `registered → supervisor` and `supervisor → target` claims are permitted. A consumed claim cannot be reused. | [Claim validation and conditional update](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/operation-store.mjs#L124) | [Wrong identity and duplicate claims](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/operation-store.test.mjs#L45); [invalid progression](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/operation-store.test.mjs#L59) | Recheck the selected claim refusal after turnover, late terminal replay and reopen together. |
| Matching terminal evidence is recordable after lease turnover. Exact canonical duplication returns without replacing evidence; conflicting evidence refuses. This does not grant closure authority. | [`finishOperation`](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/operation-store.mjs#L140) | [Canonical duplicate/conflict](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/operation-store.test.mjs#L69); [turnover and late terminal](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/operation-store.test.mjs#L86) | Those named fixtures separately establish duplication and turnover; they do not directly demonstrate their combined sequence. |
| Reservation, project call increment and event can commit or roll back together through the caller's transaction. A reservation alone is not a call-counter increment. | [Reservation insertion](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/operation-store.mjs#L107); [Store update transaction](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/store.mjs#L202) | [Reservation/debit/event rollback](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/operation-store.test.mjs#L107) | Retain one committed reservation and debit through each proposed composition; do not infer provider usage. |
| Reopen preserves retained operation, project and event facts. It grants no replacement authority. | [Durable operation reads and ownership guards](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/operation-store.mjs#L66) | [Four phase-boundary reopen cases](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/operation-store.test.mjs#L27) | Preserve the same selected facts after composed transitions, including refused conflicting terminal evidence. |
| Seal creation requires healthy current producer context and unchanged lease ownership. A seal remains non-admitting. | [Seal creation/replay](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/operation-store.mjs#L192) | [Seal replay](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/sealed-inventory.test.mjs#L39); [context and turnover refusal](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/sealed-inventory.test.mjs#L61) | A previously captured seal must not be recaptured through stale ownership after turnover and reopen. |
| Sealed comparison checks current ownership; failure returns explicit unknown/non-admitting fields. Matching metadata cannot release the producer. | [Comparison and caught failure](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/operation-store.mjs#L218) | [Matching replay cannot close/import](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/sealed-inventory.test.mjs#L44); [partial/conflicting metadata](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/sealed-inventory.test.mjs#L96) | Compare the old seal after turnover while separately exercising exact terminal duplication. |
| Lane and resource rules have deliberate exceptions. An unresolved or sealed lane does not universally forbid independent lanes. | [Scope admission predicates](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/operation-store.mjs#L75) | [Independent unresolved lane](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/operation-store.test.mjs#L162); [independent sealed lane](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/test/sealed-inventory.test.mjs#L102) | Assert replacement refusal only for the same held lane in these fixtures. |

The coverage assessment inspected the operation, producer-controller, sealed-inventory, checkpoint-settlement and candidate-journal fixture sources, with targeted searches for the involved APIs. Absence of a direct composition in that bounded search is not proof of repository-wide absence or faulty behavior.

## Two proposed, unexecuted compositions

### Late terminal replay after turnover

Create one project, producer scope and physical-job reservation using `Store.update`, incrementing `agentCalls` and recording its event in that transaction. Register the reserved operation and claim both launch phases. Release the fixture's lease and acquire a replacement lease for the same resource; close and reopen the disposable Store.

Call `finishProcess(grant, 'target', terminalRecord)` using the original matching grant, then repeat the identical record. Submit a conflicting record with a different exit code and require refusal. Reopen again. Require:

- Canonical terminal bytes still equal the first accepted record.
- The committed call counter, reservation association and prior events are retained.
- The old scope remains unclosed.
- A repeated target claim and closure through the old scope refuse.
- `beginProducer` for the same held lane under the replacement lease refuses.

The late first terminal deliberately changes retained evidence. It must not be classified as an unauthorized launch or mistaken for scope settlement.

### Sealed observation after turnover

Prepare one reserved target operation with canonical terminal evidence. In the required healthy producer context, capture its inventory seal and matching synthetic comparison inputs using the existing fixture pattern. Release and reacquire the same fixture lease resource, then reopen.

Require the old scope's comparison to return `status: 'unknown'`, blocker `durable_inventory_unavailable`, and `admission`, `settlement` and `import` all `not_evaluated`. Replaying seal creation through a fresh producer-context wrapper for that old scope must refuse.

Separately, `finishProcess` with the identical terminal record must still return without replacing the canonical record; a conflicting record must refuse. These terminal calls do not require current lease ownership. Require retained seal bytes, terminal bytes, reservation association, counter and events to remain unchanged by this selected replay/conflict/inspection sequence, with closure and same-lane replacement still refused.

This combines existing seal, ownership and canonical-terminal rules. It does not authenticate the synthetic host metadata or establish descendant settlement.

## Assert selected facts, not universal purity

Use the public Store APIs named in the [Store wrappers](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/store.mjs#L164). Scope closure is exercised through `Store.update(..., completedScope)`, not an invented public `closeScope` method.

Do not assert that every refused operation changes nothing. [Transaction failures](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/store.mjs#L193) deliberately mark an active producer context's `lifecycle.persistenceFailed`; other controller paths may retain diagnostic evidence. The proposed assertions concern specified durable rows, project counters and event lists at these exact Store boundaries. Use fresh context wrappers where healthy context is required.

Lease turnover here means invoking the fixture lease's release function, then `Store.lease` on the same resource. It does not mean killing a controller or proving OS identity. [Lease implementation](https://github.com/Zkrausman/Squire/blob/50cbf10580670be193d6035763e4c2b9a1a497fa/src/store.mjs#L220).

## Why generated exploration is deferred

[Claessen and Hughes](https://research.chalmers.se/en/publication/170517) establish specification-based testing of imperative state using algebraic, model-based and pre/postcondition properties. [Hughes's FMCAD tutorial](https://www.cs.utexas.edu/~hunt/FMCAD/fmcad11/papers/inv8.pdf) explains shrinking and warns against reproducing implementation mistakes in the specification.

[fast-check's official documentation](https://fast-check.dev/docs/advanced/model-based-testing/) and [public implementation](https://github.com/dubzzz/fast-check) provide an inspectable JavaScript option with command preconditions, assertions, shrinking and executable examples. Its model should simplify the contract rather than copy the implementation. Command replay requires the failing `seed` and `path` passed to `assert`, plus `replayPath` passed to `commands`; retain the executed action list and exact dependency/model versions as well. A seed alone does not reproduce command execution history.

These sources justify considering the technique. They do not demonstrate that a generated harness would improve this project. The two identified compositions fit ordinary fixtures, so adding a framework now lacks sufficient incremental benefit. Reconsider only when a later admitted change exposes materially broader ordering obligations that deterministic cases cannot economically cover.

Test-impact selection is the runner-up, but no measured test-cost bottleneck was established here, and existing declared-input limitations do not supply a complete dependency graph. Neither approach has a demonstrated savings result.

## Proposed future pilot

**PC1 — retain two producer composition regressions.**

- **State:** `PROPOSED_NOT_RUN`; owner unassigned.
- **Artifact:** two deterministic fixture cases, their narrow invariant comments and a documentation result update. No new dependency, generator, runtime mechanism or authority change.
- **Dependencies:** separate implementation/execution admission; an isolated disposable Store fixture route compatible with the repository's supported Node version. This does not depend on, or satisfy, OS identity, descendant settlement or authenticated producer acceptance. Existing Herdr admission conditions remain unchanged.
- **Proposed bounds:** exactly the two scenario families above; repeat each final reopen/assertion block three times, following existing fixture convention. These are finite regression bounds, not an exhaustive-coverage or performance threshold.
- **Acceptance:** both sequences assert their explicit accepted/refused outcomes and selected durable facts; existing relevant fixtures remain passing under the authorized validation route; independent review checks the evidence/authority exceptions and documents actual outcomes. A passing fixture is local controller evidence only.
- **Stop/no-adoption:** if equivalent direct coverage already exists, retain it and close this addition without a new harness. If expected behavior is ambiguous or the authorized fixture route is unavailable, stop with the exact source discrepancy or environment blocker. Do not weaken assertions, substitute a live route or add recovery behavior.
- **Full remaining effort:** 3–5 author person-hours for fixture implementation, focused authorized validation and bounded correction; 1–2 reviewer person-hours; 0.5–1 documentation person-hours: 4.5–8 person-hours total. These are prospective estimates based on two existing fixture seams, not measured duration. CI/calendar latency and any later publication route remain unknown and separately gated.

The research decision and its accuracy review can close locally while this pilot remains proposed and held. Expected benefit is clearer regression evidence at authority boundaries; no defect count, time saving, provider saving or application-delivery improvement has been measured.

Preserve all existing source, privacy, publication and no-rerun holds; historical closed-incomplete results; the independently graded larger-baseline prerequisite for comparative claims; recovery → readiness → accepted-delivery ordering; fixed-role subscription single-host operation; and existing Herdr admission conditions. This note authorizes no implementation, execution or publication.
