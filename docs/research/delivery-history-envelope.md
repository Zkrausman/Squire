# Retained delivery history and passive inspection limits

Source basis: the implementation and fixture references below are pinned to the [source revision](https://github.com/Zkrausman/Squire/commit/50cbf10580670be193d6035763e4c2b9a1a497fa).

**Decision:** retain the existing fail-closed inspection bounds and treat complete-history readability as bounded, rather than guaranteed throughout a long delivery. The current writer can append routine repeated observations faster than a reader's fixed node budget permits. This is a source-derived envelope, not an observed failed delivery or a measured performance result; it grants no authority to compact, delete or raise limits.

## Append and traversal facts

[The writer](../../src/delivery-evidence.mjs#L69-L84) publishes a fresh UUID receipt for each recorded fact and links the prior reference. It validates that immediate predecessor but does not deduplicate equal facts or truncate the retained chain. [PR reads](../../src/delivery.mjs#L95-L103) record publication observations; [inspection](../../src/delivery.mjs#L103-L128) may also record one merge-candidate fact and records selected required checks until the first pending or failed check. Publication, merge and postmerge add their own facts.

[The controller](../../src/controller.mjs#L540-L575) first inspects an existing publication during delivery phases, then inspects again in `waiting_ci` if the first result was not merged and the route proceeds to that branch. A scheduler pass therefore need not correspond to one receipt or one adapter inspection.

For a successful nonmerged, same-base adapter inspection reaching required-check selection, let `m` be 0 or 1 for a recorded synthetic merge-candidate observation, and let `j` be the number of required-check selections reached. Then `1 <= j <= K`, where `K` is the number of configured checks and `K >= 1` for this case, and the inspection appends `a = 1 + m + j` facts. A waiting-CI controller step reaching both inspections appends `a1 + a2`. In the stable case with no merge-candidate record and the first required check pending on both inspections, this is four facts. These formulas assume all intervening reads and records succeed; early returns, changed remote facts, errors, merge reconciliation or persistence failure change the path.

If `N0` facts already exist, `n` such stable waiting steps give `N = N0 + 4n`. For example, `N0 >= 1` and 32 such steps exceed 128 nodes. This is a symbolic count, not a generated fixture or proof that an actual run reached it. The configured [CI timeout](../../src/contracts.mjs#L197-L199) and [15-second pending delay](../../src/controller.mjs#L562-L565) do not impose a 128-fact bound. Do not convert the count into an elapsed-time estimate: request costs, scheduler waits, pauses, restarts, network errors and early exits vary.

| Reader boundary | Consequence |
| --- | --- |
| [128 references, 128 KiB per reference, 16 MiB total referenced bytes, 64 KiB output and a cooperative two-second traversal budget](../../src/inspect-delivery.mjs#L8-L12) | A node count alone does not establish success; another bound can fail first. A stalled native file operation cannot be cancelled by the cooperative time budget. |
| [Traversal follows every previous link to null before classification](../../src/inspect-delivery.mjs#L310-L341) | Historical and superseded records still consume traversal budget. A current subset cannot establish that the complete chain was verified. |
| Node, byte, time, shape or reference failure | Returns `incomplete` with an empty `facts` array, not a truncated success. Missing newest facts in that result do not prove that a remote mutation did not happen. |
| [Currentness classification](../../src/inspect-delivery.mjs#L252-L276) | Labels facts only after the complete chain is read; it does not compact the chain or waive old-link integrity. |

The [existing node-limit fixture source](../../test/inspect-delivery.test.mjs#L357-L374) covers a 129-reference chain and asserts exactly 128 reads, incomplete status and no facts. This identifies test source only; it is not a fresh test result. No end-to-end publisher/reader run, actual state usability, incident frequency or elapsed time is established here.

No source defect repair is selected. A future improvement would need a separately admitted retention/reader contract defining how authenticated history remains inspectable when summarizing or segmenting, while preserving failed and historical observations, provenance, byte bounds and fail-closed behavior. Raising a cap or dropping `previous` links without that contract is unjustified. Until then, report `node_limit_exceeded` honestly and retain private evidence; do not rerun delivery to obtain a shorter chain or imply that passive inspection controls delivery gates.

The source decision is documented; a revised retention model remains proposed and unrun. Whether actual operations reach this envelope, and at what frequency, remains operationally unestablished.
