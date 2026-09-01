import type { DispatchRecord } from "./domain.js";
export type RecoveryAction = "accept_existing_result" | "resume_without_replay" | "send_original_once" | "bounded_recovery_prompt" | "fail";
export function chooseRecovery(record: DispatchRecord, resultValid: boolean, markerObserved: boolean, maxRecoveryPrompts = 1): RecoveryAction {
  if (resultValid) return "accept_existing_result";
  if (record.state === "result_accepted") return "resume_without_replay";
  if (!markerObserved && record.state === "prepared") return "send_original_once";
  if (markerObserved && record.recoveryPrompts < maxRecoveryPrompts) return "bounded_recovery_prompt";
  return "fail";
}
