# Policy amendments and retained evidence

Source analysis is complete. This decision is based on Squire source at `50cbf10580670be193d6035763e4c2b9a1a497fa` (17 October 2026), reconciled against documentation baseline `8e410c01b58d99ce6934ff80af0cb98993d9c8b0` (18 October 2026); runtime source under `src/` is unchanged between those pins. It documents existing guarded model-routing and call-cap amendments. It proposes no new amendment or implementation.

## Decision card

| Field | Decision record |
| --- | --- |
| Decision and output | Retain the existing phase-scoped routing invalidation and keep full-project delivery identity distinct from configured-check/criterion identity. Preserve historical receipts without treating them as current admission. |
| Qualitative benefit | Avoids blanket revalidation where the executable consumer uses narrower identities, while preventing old full-config delivery facts from being presented as current after a configuration change. A cap increase preserves spent calls and prior ticket state. No benefit was measured. |
| Evidence and status | Source behavior and existing fixture definitions are documented. The negative cases below are proposed and unrun. No amendment execution, runtime readiness, evidence acceptance, project acceptance, or savings result is established. |
| Dependencies and blockers | Existing guarded amendment admissions, delivery inspection, criterion resolution, checkpoint identity, and durable-config handoff remain authoritative. Execution and benchmark/comparison holds remain in force. |
| Preparation-checkpoint forecast | Artifact preparation: 0.25–0.75 author hours; review: 0.5–1.5 reviewer hours; static/receipt checks: 0.25–0.75 documentation hours; later publication/reconciliation: 0.5–1.0 release hours; total: 1.5–4.0 active person-hours. These are forecasts, not owner labor or elapsed time. Research is complete; no further research or implementation is included. |

## Decision being resolved

When an explicitly authorized model-routing or operational call-cap amendment changes durable configuration, which retained evidence remains byte-valid, which inspection facts become historical, and which executable consumers require fresh evidence? A retained receipt does not by itself retain current admission, and fields named `policyDigest` do not all cover the same policy.

The decision is to **retain the existing scoped invalidation and describe each evidence consumer by its own identity scope**. No global receipt-invalidation rule or blanket permission to reuse evidence follows from a field name. Source preservation, inspection currentness, and executable gate acceptance are separate questions.

## Source-backed identity findings

| Source | Identity or mutation observed | Bounded implication |
| --- | --- | --- |
| [Model-routing amendment](../../src/store.mjs#L235-L257) | Checks expected full configuration and existing guards, validates the replacement runtime, persists the updated configuration hash, and for selected unmerged candidate phases sets `verifying` while clearing verification and review. | Invalidation is phase-scoped, not universal erasure. Old receipts remain. The reset applies only to listed phases with a head and no merge SHA; blocked or shipped tickets and merged candidates do not match that loop. |
| [Call-cap amendment](../../src/store.mjs#L259-L298) | A guarded increase changes `limits.maxAgentCalls` and the full configuration digest; it records old/new digests and spent calls. This transaction does not contain the routing method's verification/review reset loop. | An increased cap is not a refund or reset. Full-configuration identity changes even if service checks and ticket execution text do not. This observation alone proves neither a runtime defect nor a need to rerun everything. |
| [Delivery evidence binding](../../src/delivery-evidence.mjs#L47-L56) and [inspection context](../../src/inspect-delivery.mjs#L95-L107) | Both use the digest of full project configuration. [Currentness comparison](../../src/inspect-delivery.mjs#L127-L133) also compares candidate/base/tree, generation, and branch; [classification](../../src/inspect-delivery.mjs#L252-L276) labels nonmatching records historical. | With otherwise matching candidate identities, a pre-amendment delivery record has an older configuration digest and is historical to that inspection. This is source-derived classification, not an observed operational result. It neither rewrites the receipt nor proves a remote event was undone. |
| [Configured-check binding](../../src/controller.mjs#L400-L408) | Uses the service-check digest separately from execution-contract digest, correction admission, and candidate/job identities. The [criterion consumer](../../src/criterion-evidence.mjs#L70-L78) checks those current identities. | Check/criterion evidence has a narrower policy scope than delivery inspection. An unchanged check digest alone is insufficient: contract, candidate, correction, process, and reader gates still apply. No actual proof resolution was performed. |

## Amendment-impact matrix

| Case | What source changes or preserves | Decision |
| --- | --- | --- |
| Routing change; unmerged head in `verifying`, `review_ready`, `reviewing`, `publishing`, `waiting_ci`, or `merging` | Explicitly resets phase to `verifying` and clears verification/review; preserves counters, candidate, and historical receipt files. | The former review cannot advance that candidate through the ordinary delivery gate; fresh verification/review is required. This is an explicit state transition, not proof that fresh checks ran. |
| Routing change; blocked/shipped ticket, or ticket with merge SHA | Does not match the reset loop. The transaction does not universally clear `criterionEvidence`, `acceptedCriteria`, or saved project acceptance. Existing admission guards still apply. | Do not infer universal revalidation or retroactive change to delivered outcomes. Current executable consumers and ordinary transitions remain authoritative; retained fields are not fresh observations. |
| Call-cap increase | The [source fixture](../../test/store.test.mjs#L449-L460) requires ticket state to remain identical while the config digest and cap change and spent calls remain. | Preserve usage and prior outcomes. Old full-config delivery facts classify historical to current inspection; this amendment implements no broad ticket-verification reset. |
| Candidate checkpoint | The [journal projection](../../src/candidate-journal.mjs#L113-L139) binds full configuration and its original owner/phase. The [producer-scope guard](../../src/store.mjs#L157-L160) blocks other unresolved scopes while allowing the active producer-context scope, as used by the guarded runtime-configuration producer. | Retained journal identity is not silently rebound. This decision supplies no route for adopting an old intent after a config change. |
| Version-2 criterion resolution | Checks current check policy, contract/correction, and candidate/process/artifact identities; [checkpoint diagnostics](../../src/criterion-evidence.mjs#L70-L97) separately permit stale/unresolved checkpoint-link issues. | A stale journal diagnostic is not an automatic veto on otherwise current command proof and is not permission to adopt the journal. Unchanged check bytes do not waive the rest of the resolver. |
| CLI config handoff fails after durable amendment | The [CLI](../../bin/squire.mjs#L48-L74) commits the amendment before writing/renaming its temporary project JSON. Runtime configuration follows its producer; budget configuration uses the guarded Store method. | Durable config and the old project file can disagree. Stop and reconcile the file with the authorized canonical durable policy; do not replay an amendment, bypass the expected-config digest, or reset evidence. This is a **source failure window, not a reproduced incident**. |

The [routing fixture](../../test/store.test.mjs#L30-L45) covers one publishing-phase invalidation and counter preservation; the cap fixture covers preserved ticket state. These are inspected test definitions, not test results. The bounded source inventory did not establish a dedicated fixture for every phase and cross-consumer combination or for both CLI file-write failure windows.

## Proposed negative cases and acceptance criteria

These cases are proposed for separately authorized validation; none was run or added.

| Proposed case | Acceptance criterion |
| --- | --- |
| Stale expected configuration | The amendment is rejected before changing durable policy. |
| Old delivery digest after amendment | Inspection classifies the old full-config record as historical and retains its original receipt bytes. |
| Unchanged check digest with mismatched contract or correction admission | Criterion resolution rejects the proof because all bound identities must match. |
| Mismatched candidate journal link | The stale/unresolved checkpoint condition remains a separate diagnostic; no old journal row is adopted, and otherwise current command evidence is judged by its own gates. |
| Post-commit project-file handoff failure | The durable change remains authoritative; reconciliation repairs the stale project file without replaying the amendment or resetting evidence. |

## Scope and remaining gates

The operational rule is consumer-specific: preserve original bytes and history, distinguish full-project policy identity from check policy, and let the actual current gate decide admissibility. Existing routing and cap amendments remain exceptions through their guarded interfaces, not permission to edit frozen project JSON directly.

This source decision establishes neither amendment success, project acceptance, actual use, nor runtime readiness. It proposes no implementation and makes no savings claim. Existing execution and benchmark/comparison holds remain, including the closed-incomplete historical baseline.
