/** Stable Plan input boundary name used by controller integrations. */
export * from "./plan-input-validator.js";
export * from "./plan-trigger-validator.js";
export { PlanInputValidator as PlanInputLoader } from "./plan-input-validator.js";

import type { ContractReference } from "../control/domain.js";
import type { PlanAttemptContext, ValidatedPlanInput } from "./domain.js";
import { PlanInputValidator } from "./plan-input-validator.js";

export function loadPlanInput(reference: ContractReference, context: PlanAttemptContext, loader: PlanInputValidator): Promise<ValidatedPlanInput> {
  return loader.validate(reference, context);
}
