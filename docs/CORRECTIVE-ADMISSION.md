# Bounded corrective admission

The orchestrator can admit one additional implementation attempt for a structured ticket after a failed independent review exhausts its original budget. This is an explicit recovery transition, recorded separately from the immutable original ticket. The owner continues to interact only with the orchestrator.

## Admission

`authorize-correction project.json correction.json` requires a paused project with no live controller or unsettled ticket jobs. The supplied project policy and candidate SHA must match durable state. The ticket must be unmerged, unpublished, and blocked by an execution or repair budget. Evidence must be a failed fresh review, or a completed implementation and actual required-check failure bound to the exact candidate head, tree and configured check policy. Missing receipts, partial implementations and stopped, timed-out or truncated checks cannot establish an application failure.

The correction JSON contains `ticketId`, `expectedHeadSha`, a narrow `outcome`, `instructions`, and additional regression `checklist` items. Every item contains `id`, `assertion`, `steps`, and `evidence`. Newly planner-generated base contracts remain limited to eight criteria. An explicitly configured inherited base contract may contain up to ten criteria so a successor can retain all predecessor requirements. A single correction may add one or two uniquely identified criteria, bounded by the remaining room up to ten combined. For an exact application-verification failure already covered by a full eight- or ten-item base checklist, the additional list may be empty. A full ten-item base may also use an empty additional list after an exact failed review only when the required corrective regression is already represented in that base contract; the original ten criteria remain intact. A nine-item base with a failed review still requires one additional item. Passing review must provide evidence for every exact original and corrective criterion. Ownership, original acceptance, service authority, runtime, required checks, and project call budget remain unchanged.

`configure-agent-budget project.json budget.json` separately records one finite operational call-cap increase. It requires expected configuration and old cap, a paused and quiescent project, a larger cap no greater than 100, and an explicit reason. Spent calls, per-ticket attempt/repair ceilings, contracts and evidence remain preserved. Mandatory fresh reviews after corrections or base changes consume calls, so the orchestrator must account for them explicitly.

## Evidence and ceilings

Admission preserves the original candidate, original review and blocker, policy/contract/review digests, workspace identity, and prior attempt/repair/rebase counters. It records explicit ceilings of one additional implementation attempt and one additional repair. Each ticket can receive this admission once in its lifetime.

The ticket returns to repair with fresh verification and review required. The reviewer must establish every original and corrective criterion at the new candidate. Local delivery still requires expected-head merge and postmerge verification. Delivery evidence references both the original contract and the correction admission. A correction instruction or worker completion claim cannot authorize merge.

If the correction fails, the ticket stops again with all evidence preserved. The orchestrator must investigate the narrower remaining outcome and change its plan meaningfully; another identical admission or a silent budget reset is rejected.

## Separately planned successors

A distinct remaining boundary may be planned as a new bounded Squire ticket. The successor inherits the exhausted candidate's complete review scope and every original and corrective criterion, and adds deterministic acceptance for its changed approach. Its attempts and evidence belong to its own project; predecessor counters remain preserved.

`adopt-corrective-delivery project.json fulfillment.json` can fulfill an exhausted predecessor only from a successor that Squire has already verified, freshly reviewed, locally merged and checked after merge. The target must be paused and quiescent. Repository authority, protected paths, setup and required checks must match; all inherited criteria and ownership must be preserved. The audit record retains both candidate histories and source delivery identity. Actual prototype acceptance remains required by the original project; a leaf successor's delivery does not complete its outcome parent.

## Interrupted logical attempts

`recover-interrupted-implementation project.json recovery.json` accepts `ticketId`, `expectedWorkspace`, `expectedBaseSha`, and `expectedBeforeAgentHead`. It requires a paused, quiescent project, a blocked `runtime_failed` ticket with a stopped or timed-out implementation process receipt, no completed implementation or delivery, and matching durable workspace/base/pre-agent identities. The controller checkpoints existing dirty work through the normal ownership and protected-path checks; it does not launch an agent or change budgets. The recovery record preserves the receipt, blocker, counters, and candidate identity. A failed or completed recovery cannot be repeated for that ticket.

For a timed-out implementation after its one corrective attempt is already consumed, `checkpoint-interrupted-candidate project.json checkpoint.json` accepts `ticketId`, `expectedWorkspace`, `expectedBaseSha`, `expectedBeforeAgentHead`, `expectedHeadSha`, `expectedTreeSha`, `expectedCorrectionAdmissionId`, `expectedCorrectionDigest`, `expectedBlockerDigest`, and `expectedProcessReceiptDigest`. It requires a paused, quiescent project and the exact blocked implementation timeout receipt and consumed correction ceilings. This is a one-time checkpoint admission, not another implementation continuation: it preserves the prior implementation metadata and all counters, snapshots the blocker/receipt/history in an audit record, and records `implementationCompleted: false`. The controller checkpoints through the normal protected-path and owned-path checks, then enters `verifying` with stale verification and review cleared. Resume without `--retry` runs the complete fresh verification and independent review. If either fails, the exhausted correction ceiling blocks further implementation; retrying this checkpoint is rejected.

`continue-interrupted project.json continuation.json` accepts `ticketId`, `expectedHeadSha`, and `instructions`. It requires a paused, quiescent project, a recovered unmerged partial candidate with exact durable identity, and no completed implementation metadata. One continuation is allowed per ticket. The partial candidate, failed review, verification, blocker and counters remain in its audit record. The physical continuation consumes the project call budget while preserving the logical attempt and repair counts. Completion must pass all original checks, fresh exact-head review and delivery gates.

## Canonical managed checkout bytes

Managed clones use local `core.autocrlf=false` and `core.eol=lf` before materializing source. Existing managed candidates may be normalized only after proving the exact HEAD/tree and a clean working tree under the prior configuration. Normalization resets that same HEAD and checks its identity again. Dirty partial work is rejected and preserved. This keeps pinned asset and license integrity checks meaningful on Windows.

## StickyCanvas trial

The first use targets three independently reproduced defects: new windows admitted during shutdown, multiline bullet projection/selection corruption, and disposal after an invalid newer drawing capture. Historical candidates and reviewer evidence remain in the trial state and predecessor snapshots. This transition does not release the rewritten Squire framework or complete the prototype's visual and live integration acceptance.
