
/** The values accepted by the personal Pi phase runner. */
export const PHASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PhaseThinkingLevel = (typeof PHASE_THINKING_LEVELS)[number];

export interface PhaseProfile {
  readonly provider: string;
  readonly model: string;
  readonly thinking: PhaseThinkingLevel;
}

export interface PersonalModelPolicy { readonly implement: PhaseProfile; readonly verify: PhaseProfile; }
export type ResolvedPhaseProfiles = PersonalModelPolicy;
export const APPROVED_PERSONAL_MODEL_POLICY: PersonalModelPolicy = Object.freeze({
  implement: Object.freeze({ provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max" }),
  verify: Object.freeze({ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }),
});
export function validateModelPolicy(value: unknown, label = "modelPolicy"): PersonalModelPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "implement,verify") throw new Error(`${label}: migrate to exactly implement and verify profiles; retired phase profiles are not supported`);
  const v = value as Record<string, unknown>;
  return { implement: validatePhaseProfile(v["implement"]), verify: validatePhaseProfile(v["verify"]) };
}
export function resolvePhaseProfiles(_repository: string, _ticket: string, policy = APPROVED_PERSONAL_MODEL_POLICY): { profiles: ResolvedPhaseProfiles } { return { profiles: validateModelPolicy(policy) }; }

/** Validate and detach one provider/model/thinking triple. */
export function validatePhaseProfile(value: unknown, label = "phase profile"): PhaseProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const keys = ["provider", "model", "thinking"];
  if (Object.keys(object).length !== keys.length || Object.keys(object).some(key => !keys.includes(key))) throw new Error(`${label} fields are invalid`);
  const provider = profileText(object["provider"], `${label}.provider`);
  const model = profileText(object["model"], `${label}.model`);
  const thinking = object["thinking"];
  if (typeof thinking !== "string" || !(PHASE_THINKING_LEVELS as readonly string[]).includes(thinking)) throw new Error(`invalid ${label}.thinking`);
  return { provider, model, thinking: thinking as PhaseThinkingLevel };
}

export function isPhaseThinkingLevel(value: unknown): value is PhaseThinkingLevel {
  return typeof value === "string" && (PHASE_THINKING_LEVELS as readonly string[]).includes(value);
}

function profileText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a safe non-empty string`);
  return value;
}
