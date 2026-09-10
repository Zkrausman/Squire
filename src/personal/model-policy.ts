import { createHash } from "node:crypto";

/** The values accepted by the personal Pi phase runner. */
export const PHASE_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PhaseThinkingLevel = (typeof PHASE_THINKING_LEVELS)[number];

export interface PhaseProfile {
  readonly provider: string;
  readonly model: string;
  readonly thinking: PhaseThinkingLevel;
}

/** The two equally weighted Plan choices. Index zero is bucket A, index one B. */
export interface PersonalModelPolicy {
  readonly plan: readonly [PhaseProfile, PhaseProfile];
  readonly implement: PhaseProfile;
  readonly review: PhaseProfile;
  readonly test: PhaseProfile;
  readonly retro: PhaseProfile;
}

export type PlanBucket = "a" | "b";

/**
 * Versioned evidence for the one Plan choice made when a run is created.
 *
 * The identity is deliberately independent of run IDs, attempts, branches,
 * timestamps, and machine paths. It is the canonical repository slug and
 * ticket identifier separated by NULs and prefixed with the algorithm version.
 */
export interface PlanSelection {
  readonly version: "sha256-lsb-v1";
  readonly identity: string;
  readonly repository: string;
  readonly ticketId: string;
  readonly digest: string;
  readonly bucket: PlanBucket;
  readonly profile: PhaseProfile;
}

export type ResolvedPhaseProfiles = Readonly<{
  plan: PhaseProfile;
  implement: PhaseProfile;
  review: PhaseProfile;
  test: PhaseProfile;
  retro: PhaseProfile;
}>;

export const PLAN_SELECTION_VERSION = "sha256-lsb-v1" as const;

const ASTRA_MEDIUM: PhaseProfile = Object.freeze({ provider: "openai-codex", model: "gpt-6-astra", thinking: "medium" });
const SOL_HIGH: PhaseProfile = Object.freeze({ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" });
const LUNA_MAX: PhaseProfile = Object.freeze({ provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max" });
const SOL_MEDIUM: PhaseProfile = Object.freeze({ provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" });
const TERRA_HIGH: PhaseProfile = Object.freeze({ provider: "openai-codex", model: "gpt-5.6-terra", thinking: "high" });

/** The approved personal Squire model policy. */
export const APPROVED_PERSONAL_MODEL_POLICY: PersonalModelPolicy = Object.freeze({
  plan: Object.freeze([ASTRA_MEDIUM, SOL_HIGH] as const),
  implement: LUNA_MAX,
  review: SOL_MEDIUM,
  test: TERRA_HIGH,
  retro: SOL_MEDIUM,
});

// Public aliases keep the policy name discoverable without creating another
// mutable source of defaults.
export const DEFAULT_PERSONAL_MODEL_POLICY = APPROVED_PERSONAL_MODEL_POLICY;
export const DEFAULT_MODEL_POLICY = APPROVED_PERSONAL_MODEL_POLICY;
export const APPROVED_MODEL_POLICY = APPROVED_PERSONAL_MODEL_POLICY;
export const DEFAULT_PHASE_MODEL_POLICY = APPROVED_PERSONAL_MODEL_POLICY;

/** Return a validated, detached policy suitable for persisting in run state. */
export function validateModelPolicy(value: unknown, label = "model policy"): PersonalModelPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const keys = ["plan", "implement", "review", "test", "retro"];
  if (Object.keys(object).length !== keys.length || Object.keys(object).some(key => !keys.includes(key))) throw new Error(`${label} fields are invalid`);
  const plan = object["plan"];
  if (!Array.isArray(plan) || plan.length !== 2) throw new Error(`${label}.plan must contain exactly two buckets`);
  const first = validatePhaseProfile(plan[0], `${label}.plan.a`);
  const second = validatePhaseProfile(plan[1], `${label}.plan.b`);
  return {
    plan: [first, second],
    implement: validatePhaseProfile(object["implement"], `${label}.implement`),
    review: validatePhaseProfile(object["review"], `${label}.review`),
    test: validatePhaseProfile(object["test"], `${label}.test`),
    retro: validatePhaseProfile(object["retro"], `${label}.retro`),
  };
}

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

/**
 * Canonicalize the only identities allowed to influence Plan assignment.
 * Repository slugs are owner/name and are case-folded; Linear identifiers are
 * case-folded to upper case. The separators make the identity unambiguous
 * for every valid slug and ticket identifier.
 */
export function canonicalPlanIdentity(repository: string, ticketId: string): { readonly repository: string; readonly ticketId: string; readonly identity: string } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("repository must be owner/name");
  if (!/^[A-Za-z][A-Za-z0-9]+-[1-9][0-9]*$/u.test(ticketId)) throw new Error("invalid Linear ticket identifier");
  const canonicalRepository = repository.toLowerCase();
  const canonicalTicket = ticketId.toUpperCase();
  return {
    repository: canonicalRepository,
    ticketId: canonicalTicket,
    identity: `${PLAN_SELECTION_VERSION}\u0000${canonicalRepository}\u0000${canonicalTicket}`,
  };
}

/** Compute the stable, equal-weight Plan bucket for a repository/ticket pair. */
export function selectPlanBucket(repository: string, ticketId: string): PlanBucket {
  const selection = resolvePlanSelection(repository, ticketId);
  return selection.bucket;
}

/** Resolve all five profiles exactly once for a newly created run. */
export function resolvePhaseProfiles(repository: string, ticketId: string, policy: PersonalModelPolicy = APPROVED_PERSONAL_MODEL_POLICY): { readonly profiles: ResolvedPhaseProfiles; readonly planSelection: PlanSelection } {
  const checked = validateModelPolicy(policy);
  const planSelection = resolvePlanSelection(repository, ticketId, checked);
  return {
    profiles: {
      plan: { ...planSelection.profile },
      implement: { ...checked.implement },
      review: { ...checked.review },
      test: { ...checked.test },
      retro: { ...checked.retro },
    },
    planSelection,
  };
}

/** Resolve the selected Plan bucket and retain its hash evidence. */
export function resolvePlanSelection(repository: string, ticketId: string, policy: PersonalModelPolicy = APPROVED_PERSONAL_MODEL_POLICY): PlanSelection {
  const identity = canonicalPlanIdentity(repository, ticketId);
  const digest = createHash("sha256").update(identity.identity, "utf8").digest("hex");
  // The low bit of the first digest byte gives two equal-size outcomes.
  const bucket: PlanBucket = (Number.parseInt(digest.slice(0, 2), 16) & 1) === 0 ? "a" : "b";
  const checked = validateModelPolicy(policy);
  const profile = checked.plan[bucket === "a" ? 0 : 1];
  return {
    version: PLAN_SELECTION_VERSION,
    identity: identity.identity,
    repository: identity.repository,
    ticketId: identity.ticketId,
    digest,
    bucket,
    profile: { ...profile },
  };
}

/** Convenience accessor when callers need only the selected model triple. */
export function selectPlanProfile(repository: string, ticketId: string, policy: PersonalModelPolicy = APPROVED_PERSONAL_MODEL_POLICY): PhaseProfile {
  return resolvePlanSelection(repository, ticketId, policy).profile;
}

export const selectPlan = resolvePlanSelection;

function profileText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be a safe non-empty string`);
  return value;
}
