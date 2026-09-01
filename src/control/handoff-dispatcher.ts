import type { DispatchRecord } from "./domain.js";
const ORDER = ["prepared", "sent", "accepted", "settled", "result_accepted"] as const;
export function advanceDispatch(record: DispatchRecord, next: DispatchRecord["state"]): DispatchRecord {
  const currentIndex = ORDER.indexOf(record.state); const nextIndex = ORDER.indexOf(next);
  if (nextIndex === currentIndex) return record;
  if (nextIndex !== currentIndex + 1) throw new Error("dispatch state must advance exactly once");
  return { ...record, state: next };
}
export function triggerPrompt(triggerPath: string, marker: string): string {
  if (!/^\/ticket\/artifacts\/handoffs\/[a-z]+\/\d+\/trigger\.json$/.test(triggerPath)) throw new Error("non-canonical trigger path");
  return `${marker} Execute the controller-validated phase trigger at ${triggerPath}.`;
}
