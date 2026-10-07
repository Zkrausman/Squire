# Choosing the next outcome by value and effort

Planning method, based on the [roadmap at `3335ba5`](https://github.com/Zkrausman/Squire/blob/3335ba528b9af884c9ff17c6e6af40c43579a46e/docs/roadmap/README.md). This adds a manual selection rule and a qualitative shortlist; it does not implement runtime scheduling or demonstrate performance gains.

At each decision boundary, choose the feasible outcome with the strongest expected incremental benefit relative to its full remaining constrained effort. Include prerequisites and verification, explain why it beats the next alternative, and use a stable tie-break when evidence cannot distinguish them. The aim is dependable accepted delivery with less owner recovery work.

Use a short card for the few credible next outcomes. Do not score every roadmap bullet or build a second scheduler. A ratio is a decision aid: dependencies, shared benefits and real deadlines can make a greedy sequence inferior to a complete outcome package.

## Eligibility before ranking

Compare feasible outcome packages with unfinished internal prerequisites included in their cost. Mark each next slice ready, blocked, held, done or superseded; only ready slices enter execution. A ready slice requires authority for the specific action, satisfied immediate dependencies, a suitable execution route and room within the applicable time, call, resource and repository-writer limits. A selected package can therefore start with a ready prerequisite, without pretending the whole package is already dependency-complete. Record external blockers and holds explicitly rather than assign them a low score.

Safety, privacy, evidence and permission requirements are pass/fail gates. Benefit cannot outweigh them. Restored capacity, a planning date or a high ranking grants no new authority. Independently useful authorized work can proceed around a blocked item only when it neither depends on the missing result nor widens scope.

The [execution hold](README.md#historical-results-and-execution-hold) remains in force. The original v0.1 baseline stays closed-incomplete; the separate manual harness completion stays unscored. Future optimization/comparison still requires the separately authorized, completed and independently graded larger baseline. Pith comparisons additionally retain their [output-fidelity prerequisite](factory-acceptance.md#a5-add-a-comparison-report-and-freeze-the-experiment). Documentation publication and ordinary repository CI do not authorize implementation, new fixtures, probes, model calls, demonstrations or benchmark runs.

## Compare complete outcomes

State what becomes useful or decidable and what evidence closes it. For example, retaining one explainable interrupted candidate is an outcome; adding one receipt field is only a fragment unless it is independently useful.

Include the unfinished prerequisites needed to reach the outcome, then execute its first ready dependency. Do not credit both a prerequisite and its downstream package with the same full benefit. Once a shared foundation exists, compare additional benefit against remaining marginal effort. Count plausible near-term reuse, not the entire imagined future roadmap.

Small useful outcomes can compete, but splitting tickets must not manufacture extra value. Repeated tiny tasks with negligible aggregate benefit must not indefinitely displace an important complete outcome. Prefer a smaller complete version of that outcome where possible; consider the consequence of delaying it.

## Benefit and full remaining cost

Choose a common forecast horizon for the comparison, such as the next admitted owner outcome and an explicitly stated period of expected use. Describe benefit in its natural unit: recovery minutes avoided, repeated failed starts reduced, a specific delivery enabled or a consequential delay avoided. Label estimates and their sources. Historical failures justify investigation but do not establish today's incident frequency or a change's future payoff.

Where supported, estimate recurrence from exposure, avoidable fraction and impact. Do not count the same incident repeatedly as saved time, reduced interruptions and faster delivery unless these are distinct consequences. An accepted capability and saved owner minutes do not automatically share a unit. Until a defensible trade-off exists, compare them qualitatively. Arbitrary point labels divided by hours are not measured ROI.

Full remaining cost includes discovery, implementation, meaningful validation, integration, independent review, documentation/rollout, likely rework, necessary owner decisions and maintenance over the same horizon. Include failed approaches and cleanup. Keep these visible separately:

- Active effort by relevant role, including owner attention.
- Critical-path elapsed time to a verified useful result.
- Calls, known usage and other resource ceilings.
- Maintenance and reversal costs.

For a numeric ratio, use a consistent binding time budget as the denominator. Declare any conversion before combining owner hours, worker hours or other resources; there is no default equivalence. Keep the other costs as constraints or tie-breaks. Do not add parallel elapsed time to summed effort, count waiting as owner labor, infer missing usage as zero or invent API-dollar savings from subscription usage. The [operator time ledger](factory-operator-workflow.md) already distinguishes effort, elapsed time and observation gaps.

When the units are defensible:

**Priority estimate = expected incremental benefit / expected full remaining constrained effort.**

If benefit is conditional on success, first account for the probability of the useful effect. If it is already an expected value, do not discount it again by a confidence percentage. Record evidence confidence separately with a reason and plausible benefit/effort ranges. Confidence in evidence is not itself a calibrated success probability.

Prefer a winner that remains attractive across reasonable assumptions. If uncertainty can reverse the ranking, show a tie or conditional order; seek the cheapest fact that could resolve it. Do not invent estimates or use decimal scores to hide uncertainty.

## Research and decision checkpoints

Research earns priority by changing a named upcoming decision. State the uncertain decision, which plausible findings would change the action, the avoidable cost or lost value at stake, and the cheapest sufficient evidence with a stopping condition. Credit the improvement in the decision, less research cost; do not credit a memo with the full payoff of all implementation it describes. If every plausible answer leaves the next action unchanged, stop or defer the study. Unknown execution facts become explicit future verification requirements.

At a decision boundary:

1. Refresh the few candidate cards. Exclude done/superseded outcomes and packages with no authorized, ready next slice from execution selection; retain conditional plans separately.
2. Eliminate dominated choices: no more benefit, at least as much full cost, and no compensating evidence or deadline advantage.
3. Select the strongest robust value/effort outcome, considering dependencies and real cost of delay. Record the runner-up and decisive assumption.
4. For practical ties, prefer less owner attention, stronger evidence/lower downside, an earlier verified outcome, lower maintenance/reversal cost, then the existing committed order.
5. Commit to the next meaningful checkpoint and its closing evidence.

Re-rank when an outcome closes, a material finding or dependency changes, or the agreed checkpoint arrives. At that point compare remaining benefit and cost, including switching and restart cost; sunk effort does not justify continuing a poor choice. Do not thrash mid-task over small estimate changes. Contain a genuine safety, authority or evidence-preservation problem immediately within existing authority.

Stop a slice when its closing evidence is sufficient, its exploration budget is exhausted, its benefit disappears or the next action needs missing authority or environment access. Preserve an inconclusive result where appropriate. An empty useful research queue is acceptable; calendar space is not a reason to repeat a survey.

## Initial qualitative shortlist

Current documents do not provide comparable full-package effort ranges, incident frequency or owner recovery minutes. The following is a source-backed starting judgment, not a measured ratio or delivery promise.

During the research-only period, work toward one implementable admission packet:

1. **Freeze the first recovery example.** Resolve operation/candidate/manifest identity ownership, one interruption/replay case, completed-result import and the conservative R4 settlement cut. Include applicable [T2 collector/path constraints](factory-trust-boundaries.md). Close with one schema/example set and negative cases; list unknown host facts. This resolves the most immediate ambiguity in the [first owner outcome](factory-recovery.md#dependency-sequence-and-small-implementation-slices).
2. **Resolve one route's readiness decision.** Inspect the intended platform's policy/process-identity contract, define unsupported/unknown cases and specify bounded future integration evidence. Move a specific question ahead of item 1 if its answer could invalidate that packet. Stop once it supports the [P0-P3 boundary](factory-runtime-preflight.md#small-dependency-ordered-implementation-plan); do not execute probes to fill research gaps.
3. **Freeze one acceptance/admission example.** Map a public-safe outcome's criteria to ticket/project phase and independently controlled evidence. Separate retained candidate, delivery and criterion acceptance; premerge review cannot depend on postmerge-only evidence. Include authority, budget, environment and verification prerequisites. An unchosen task stays an explicit decision; any generic example stays illustrative. Reuse [A2/A3](factory-acceptance.md#a2-add-immutable-check-and-artifact-references).
4. **Challenge that packet once.** Estimate complete remaining work, compare passive O1/O2 against the critical-path package, and resolve the one uncertainty most likely to change the choice. Stop when admission is decision-ready. Update the existing contracts rather than produce another general roadmap audit.

After separate implementation admission, retain the roadmap's first three owner outcomes in order: one explainable interrupted candidate (R0-R3 plus necessary R4 settlement), one avoidable wasted call refused (P0-P3 on that foundation), then one auditable accepted change (R5, A2/A3 and the applicable R7 route). Their required safety and task-specific capability gates remain attached to each package.

[Passive O1/O2 visibility and decisions](factory-operator-workflow.md#bounded-implementation-slices) is a genuine challenger because it can use current state with explicit unknowns. Pull it forward only when evidence of recurring owner burden and a defensible full-effort estimate justify changing the committed order. Optional notification transport is not required for that value. A [BP1 fixture or A5 report](factory-benchmark-portfolio.md) belongs ahead of delivery only when it serves the chosen next decision and its gates are satisfied.

Keep dashboards, hosted metrics, default vector retrieval, skill/team optimization, learned routing and a scheduling solver behind their [existing prerequisites](../roadmap/README.md#other-retained-commitments). Do not repeat completed status or feasibility research without a changed decision. Ranking a cross-project task does not expand its accepted scope, including any separately admitted Pith fidelity slice.

## Minimal decision record

- Outcome, closing evidence and next-slice ready/blocked/held status with reason.
- Dependencies included and next executable slice.
- Expected benefit, horizon, sources and plausible range.
- Full remaining effort range; owner attention, elapsed time and resource constraints.
- Evidence confidence and largest decision-changing uncertainty.
- Runner-up, decisive assumption and checkpoint/stop rule.
- Actual outcome, effort, rework and substantive owner interventions after completion.

Fill unknowns only for leading candidates; do not delay an obvious bounded decision to manufacture precision. Record owner minutes only when supplied or under an agreed measurement method. Compare forecast with actual effort and whether the intended outcome was demonstrated, then adjust similar estimates and overconfident ranges. More tickets or research pages are not substitutes for less owner work per verified outcome.
