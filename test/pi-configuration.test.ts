import assert from "node:assert/strict";
import test from "node:test";
import { ROLES, type Role } from "../src/control/domain.js";
import {
  DEFAULT_PI_ROLE_PROFILES,
  DEFAULT_PI_WIKI_PROFILE,
  PI_THINKING_LEVELS,
  normalizeRoleConfig,
  normalizeWorkflowConfig,
  normalizeWikiProfile,
} from "../src/pi/pi-configuration.js";

test("AIDEV-228 defaults are explicit and independently addressable", () => {
  assert.deepEqual(DEFAULT_PI_ROLE_PROFILES, {
    orchestrator: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    plan: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    implement: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max" },
    review: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" },
    test: { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "high" },
  });
  assert.deepEqual(DEFAULT_PI_WIKI_PROFILE, { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" });
  assert.deepEqual(PI_THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

  const roles = Object.fromEntries(ROLES.map(role => [role, normalizeRoleConfig(role, {
    provider: `provider-${role}`,
    model: `model-${role}`,
    instructionsPath: `/ticket/config/${role}.md`,
  })]));
  assert.equal(roles["implement"]!.thinking, "max");
  assert.equal(roles["review"]!.thinking, "medium");
  assert.equal(normalizeWikiProfile().model, "gpt-5.6-luna");
});

test("legacy v1 profile fields normalize without mutating the persisted document", () => {
  const legacy = {
    schemaVersion: 1,
    pi: {
      roles: Object.fromEntries(ROLES.map(role => [role, {
        provider: "legacy-provider",
        model: "legacy-model",
        instructionsPath: `/ticket/config/${role}.md`,
      }])) as Record<Role, { provider: string; model: string; instructionsPath: string }>,
    },
  };
  const normalized = normalizeWorkflowConfig(legacy);
  assert.equal((normalized.pi.roles.implement as { thinking?: string }).thinking, "max");
  assert.deepEqual((normalized.pi as typeof legacy.pi & { wiki?: unknown }).wiki, DEFAULT_PI_WIKI_PROFILE);
  assert.equal(Object.hasOwn(legacy.pi, "wiki"), false);
  assert.equal(Object.hasOwn(legacy.pi.roles.implement!, "thinking"), false);
});

test("unknown thinking levels fail closed at the Pi configuration boundary", () => {
  assert.throws(() => normalizeRoleConfig("plan", {
    provider: "p",
    model: "m",
    thinking: "turbo" as never,
    instructionsPath: "/ticket/config/plan.md",
  }), /thinking/);
  assert.throws(() => normalizeWikiProfile({ provider: "p", model: "m", thinking: "turbo" as never }), /thinking/);
});
