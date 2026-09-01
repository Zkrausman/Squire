# AIDEV-216 orchestration control plane

This package is the trusted, strict-TypeScript mechanics layer between Squire's independent Pi roles and future infrastructure adapters. The controller validates; the Pi Orchestrator decides requested transitions.

## Public boundaries

- `WorkflowStore` is transactional and compare-and-set based. It records state/head/version preconditions, exact role sessions, immutable attempts, dispatch generations, accepted-result and transition identities, retry counters, gates, and terminal errors. Only `test/support/in-memory-workflow-store.ts` implements it here.
- `PiProcessFactory`, `GitHeadObserver`, `ImmutableArtifactReader`, and `Clock` isolate processes, Git, filesystems, and time.
- AIDEV-224 exclusively owns one-ticket intake, SQLite schema/migrations/adapter, and startup reconciliation. This package contains no SQL or production in-memory fallback.
- Sandbox/Herdr, bare-worktree/bundle, and delivery adapters remain with AIDEV-223/AIDEV-217, AIDEV-222, and AIDEV-225/226.

## Five independent Pi RPC processes

Orchestrator, Plan, Implement, Review, and Test are five top-level OS processes, never phase-switches or subagents. First launch uses exactly one role directory:

```text
/ticket/sessions/orchestrator/<timestamp>_<sessionId>.jsonl
/ticket/sessions/plan/<timestamp>_<sessionId>.jsonl
/ticket/sessions/implement/<timestamp>_<sessionId>.jsonl
/ticket/sessions/review/<timestamp>_<sessionId>.jsonl
/ticket/sessions/test/<timestamp>_<sessionId>.jsonl
```

At run startup, the controller resolves the currently selected Pi and pi-llm-wiki installations once and commits a `runtime-resolution` observation containing each exact version and installation identity plus the resolved Pi executable. There is no required repository-wide exact version pin; the legacy optional `pi.version` v1 field is advisory and does not select or reject a runtime. The same resolved Pi executable is used by all five sessions, and an active run is never upgraded in place.

After `get_state`, the controller registers the complete canonical JSONL path and returned ID atomically. Every restart uses `--session <exact recorded file>`; `--continue`, `--resume`, `--fork`, `--clone`, partial IDs, cross-role paths, and replacement registrations are forbidden. Launches run from `/ticket/workspace`, use the run-resolved installation and configured provider/model, and verify the handshake.

RPC stdout uses a `StringDecoder`, LF-only framing, optional trailing-CR stripping, deterministic request IDs, and bounded line, buffer, rendered, and stderr storage. A successful `prompt` response means accepted only. Completion requires `agent_settled` and separately discovered immutable result validation.

## Trusted validation and transitions

References are canonical beneath `artifacts/` or `evidence/`. The safe reader rejects escapes, symlinks, non-regular or missing files, oversized data, digest mismatch, and an inode/size/mtime race. Consumption order is exact bytes/path/SHA-256, explicit v1 schema allowlist and closed structural validation, then semantic and trusted run/handoff/phase/attempt/session/head context. Duplicate result acceptance fails closed.

The graph follows the committed v1 contracts. A phase envelope's `requestedTransition` is advice; a separate exact Orchestrator session request is required. Trusted operator/system commands use their own `operator_cancel`, `system_failure`, or `retention_expired` origin and a null phase result. A failed envelope cannot invent the schema-absent `phase_failed` trigger.

## Idempotency, remediation, and finite lifecycle

Dispatch keys are `(runId, handoffId, targetSessionId)` and persist `prepared → sent → accepted → settled → result_accepted`. Recovery acquires a lease, checks for a valid immutable result first, resumes the exact JSONL, uses stable `get_entries` cursors to find the trigger marker, and sends either the never-recorded trigger once or one bounded continuation—not the original trigger again.

Review/Test remediation creates a new immutable Implement handoff and monotonically increments its attempt while preserving the registered Implement session ID/file. Implement must produce a newly observed head. Any head mutation—including project-wiki edits—invalidates old gates. Both remediation routes force fresh Review then fresh Test at one frozen head; publishing requires both current-generation gate artifacts.

Defaults are finite: two process launches per attempt, 5-second RPC command/abort grace, 10-second SIGTERM grace, then SIGKILL. Cancellation order is `clear_queue`, `abort_retry`, `abort`, grace, SIGTERM, grace, SIGKILL. Configured role deadlines and review/test/total remediation budgets cap work. A compare-and-set terminal outcome wins races; late results are audit-only and cannot reopen a terminal run.

## Project-wiki maintenance boundary

The committed `.llm-wiki` is Squire's native OKF v0.2 company/project knowledge vault. Maintain it only from the target worktree. Capture durable committed architecture/contract sources, synthesize cross-linked cited concepts, and run native lint/status checks. Never mix a personal/host vault, secrets, temporary paths, raw session transcripts, or routine run status into project knowledge. Wiki edits change Git head and therefore occur before the Review/Test head is frozen; later wiki maintenance requires fresh gates.
