# Durable controller events

State commits before the bounded outbox. Events describe reservation, launch generations, Implement/Verify start/completion, publication and terminal disposition. Schema version 2 permits only implement/verify phase labels and, when a versioned correction policy is bound at reservation, at most one additional logical attempt per phase. Previous accepted failed Verify evidence remains in the append-only correction ledger; events never authorize correction or publication. Events contain no ticket prose, findings, prompts, secrets, URLs or log paths. IDs are deterministic and deduplicated.

A missed outbox write does not change authoritative state. Read-only consumers synthesize current transitions from state without launching a model or repairing state. Linux uses directory notifications plus bounded timer reconciliation; Windows uses timer reconciliation only to avoid native directory-handle replacement hazards. Notification workers may deliver terminal events with bounded host delivery retries; these cannot dispatch model work.

Required filesystem integration runs on Linux and Windows. A failure emits one terminal outcome; no event authorizes another phase session. Owner observation and ticket reservation remain serialized and fail closed on ambiguity.
