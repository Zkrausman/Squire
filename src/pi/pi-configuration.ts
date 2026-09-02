import type { Role } from "../control/domain.js";
import profileDefaults from "./pi-profile-defaults.json" with { type: "json" };

/** Pi accepts this closed set of thinking levels. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

export interface PiModelProfile {
  provider: string;
  model: string;
  thinking: PiThinkingLevel;
}

/** A role profile as accepted by the controller boundary. */
export interface PiRoleConfig {
  provider: string;
  model: string;
  /** Omitted only for legacy v1 callers; normalized controller input always has it. */
  thinking?: PiThinkingLevel;
  instructionsPath: string;
  timeoutSeconds?: number;
}

export type EffectivePiRoleConfig = Omit<PiRoleConfig, "thinking"> & { thinking: PiThinkingLevel };
export type PiWikiProfile = PiModelProfile;
export type PiWikiProfileInput = Omit<PiModelProfile, "thinking"> & { thinking?: PiThinkingLevel };

const roleDefaults = profileDefaults.roles as Record<Role, PiModelProfile>;
const wikiDefault = profileDefaults.wiki as PiModelProfile;

/** The only defaults used when legacy documents omit additive profile fields. */
export const DEFAULT_PI_ROLE_PROFILES: Readonly<Record<Role, PiModelProfile>> = Object.freeze(
  Object.fromEntries(Object.entries(roleDefaults).map(([role, profile]) => [role, Object.freeze({ ...profile })])) as Record<Role, PiModelProfile>,
);
export const DEFAULT_PI_WIKI_PROFILE: PiWikiProfile = Object.freeze({ ...wikiDefault });

// Short aliases make the configuration boundary convenient without introducing a
// second source of default values.
export const DEFAULT_PI_PROFILES = DEFAULT_PI_ROLE_PROFILES;
export const DEFAULT_WIKI_PROFILE = DEFAULT_PI_WIKI_PROFILE;
export const DEFAULT_PI_WORKFLOW_PROFILES: Readonly<{ roles: Readonly<Record<Role, PiModelProfile>>; wiki: PiWikiProfile }> = Object.freeze({
  roles: DEFAULT_PI_ROLE_PROFILES,
  wiki: DEFAULT_PI_WIKI_PROFILE,
});

export function isPiThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

export function normalizeRoleConfig(role: Role, config: PiRoleConfig): EffectivePiRoleConfig {
  const thinking = config.thinking ?? DEFAULT_PI_ROLE_PROFILES[role].thinking;
  if (!isPiThinkingLevel(thinking)) throw new Error(`invalid Pi thinking level for ${role}`);
  if (!isSafeProfilePart(config.provider)) throw new Error(`missing or unsafe Pi provider for ${role}`);
  if (!isSafeProfilePart(config.model)) throw new Error(`missing or unsafe Pi model for ${role}`);
  return { ...config, thinking };
}

export function normalizeWikiProfile(profile?: PiWikiProfileInput | null): PiWikiProfile {
  const value = profile ?? DEFAULT_PI_WIKI_PROFILE;
  const thinking = value.thinking ?? DEFAULT_PI_WIKI_PROFILE.thinking;
  if (!isPiThinkingLevel(thinking)) throw new Error("invalid Pi thinking level for project wiki");
  if (!isSafeProfilePart(value.provider)) throw new Error("missing or unsafe project-wiki provider");
  if (!isSafeProfilePart(value.model)) throw new Error("missing or unsafe project-wiki model");
  return { provider: value.provider, model: value.model, thinking };
}

/** Minimal structural shape used by workflow-config normalization. */
export interface WorkflowPiConfigInput {
  version?: string;
  roles: Record<Role, PiRoleConfig>;
  wiki?: PiWikiProfileInput;
}

/**
 * Normalize additive v1 profile fields before schema validation/controller use.
 * The returned object is a fresh shallow/deep-enough copy and never mutates the
 * persisted document. Provider/model and role operational fields remain caller
 * supplied; only omitted thinking levels and the new wiki profile are defaulted.
 */
export function normalizeWorkflowConfig<T extends { pi: WorkflowPiConfigInput }>(config: T): T {
  if (!config || typeof config !== "object" || !config.pi || typeof config.pi !== "object" || Array.isArray(config.pi)) return config;
  const rawRoles = config.pi.roles;
  const roles = rawRoles && typeof rawRoles === "object"
    ? Object.fromEntries(
      (Object.entries(rawRoles) as Array<[string, PiRoleConfig]>).map(([role, roleConfig]) => [
        role,
        roleConfig && typeof roleConfig === "object" && roleConfig.thinking === undefined && role in DEFAULT_PI_ROLE_PROFILES
          ? { ...roleConfig, thinking: DEFAULT_PI_ROLE_PROFILES[role as Role].thinking }
          : roleConfig,
      ]),
    )
    : rawRoles;
  const wiki = config.pi.wiki ?? { ...DEFAULT_PI_WIKI_PROFILE };
  return {
    ...config,
    pi: {
      ...config.pi,
      roles,
      wiki,
    },
  } as T;
}

export function wikiModelRef(profile: PiModelProfile): string {
  return `${profile.provider}/${profile.model}`;
}

function isSafeProfilePart(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}
