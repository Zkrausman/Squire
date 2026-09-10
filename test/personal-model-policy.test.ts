import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APPROVED_PERSONAL_MODEL_POLICY,
  resolvePhaseProfiles,
  resolvePlanSelection,
  selectPlanBucket,
  validateModelPolicy,
} from "../src/personal/model-policy.js";
import { defaultConfigPath, loadPersonalMvpConfig, resolveConfigPath } from "../src/personal/config.js";

const policy = APPROVED_PERSONAL_MODEL_POLICY;

test("approved personal policy has exact fixed profiles and two Plan buckets", () => {
  assert.deepEqual(policy.plan, [
    { provider: "openai-codex", model: "gpt-6-astra", thinking: "medium" },
    { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  ]);
  assert.deepEqual(policy.implement, { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "max" });
  assert.deepEqual(policy.review, { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" });
  assert.deepEqual(policy.test, { provider: "openai-codex", model: "gpt-5.6-terra", thinking: "high" });
  assert.deepEqual(policy.retro, { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" });
});

test("Plan assignment is stable, identity-bound, and reaches both equal buckets", () => {
  const pairs = [
    ["example/repo", "AIDEV-1"],
    ["example/repo", "AIDEV-2"],
  ] as const;
  const selections = pairs.map(([repository, ticket]) => resolvePlanSelection(repository, ticket));
  assert.deepEqual(selections.map(selection => selection.bucket), ["b", "a"]);
  assert.deepEqual(selections.map(selection => selection.profile), [policy.plan[1], policy.plan[0]]);
  for (const [repository, ticket] of pairs) {
    const first = resolvePlanSelection(repository, ticket);
    assert.equal(selectPlanBucket(repository, ticket), first.bucket);
    assert.deepEqual(resolvePlanSelection(repository.toUpperCase(), ticket.toLowerCase()), first);
    assert.equal(resolvePlanSelection(repository, ticket, policy).bucket, first.bucket);
  }
  const resolved = resolvePhaseProfiles("example/repo", "AIDEV-1");
  assert.deepEqual(resolved.profiles.plan, resolved.planSelection.profile);
});

test("malformed model policy never falls back to a different profile", () => {
  assert.throws(() => validateModelPolicy({ ...policy, plan: [policy.plan[0]] }), /exactly two/);
  assert.throws(() => validateModelPolicy({ ...policy, test: { ...policy.test, thinking: "unsupported" } }), /thinking/);
  assert.throws(() => validateModelPolicy({ ...policy, retro: undefined }), /object|profile/);
});

test("config resolver uses per-user Windows/Linux defaults and explicit precedence", () => {
  assert.equal(defaultConfigPath("win32", { USERPROFILE: "C:\\Users\\zkrau" }), "C:\\Users\\zkrau\\.squire\\config.json");
  assert.equal(defaultConfigPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/tmp/config", HOME: "/home/user" } }), "/tmp/config/squire/config.json");
  assert.equal(defaultConfigPath({ platform: "linux", env: { HOME: "/home/user" } }), "/home/user/.config/squire/config.json");
  assert.equal(resolveConfigPath(undefined, { platform: "win32", env: { SQUIRE_CONFIG: "env\\\\config.json", USERPROFILE: "C:\\Users\\zkrau" }, cwd: "C:\\checkout" }), "C:\\checkout\\env\\config.json");
  assert.equal(resolveConfigPath("explicit.json", { platform: "win32", env: { SQUIRE_CONFIG: "ignored.json", USERPROFILE: "C:\\Users\\zkrau" }, cwd: "C:\\checkout" }), "C:\\checkout\\explicit.json");
  assert.equal(resolveConfigPath(undefined, { platform: "linux", env: { SQUIRE_CONFIG: "/override/config.json", HOME: "/home/user" } }), "/override/config.json");
  assert.equal(resolveConfigPath("explicit.json", { platform: "linux", env: { SQUIRE_CONFIG: "/ignored/config.json" }, cwd: "/checkout" }), "/checkout/explicit.json");
});

test("config paths resolve beside the selected user config, never beside a repository checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-model-policy-"));
  try {
    const user = path.join(root, "user");
    const repository = path.join(root, "repository");
    const configPath = path.join(user, "config.json");
    await mkdir(user, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      repository: { slug: "example/repo", path: "../repository", sourceRef: "main", baseBranch: "main" },
      paths: { state: "state", bridges: "bridges", staging: "staging" },
      linear: { apiKeyEnv: "LINEAR_API_KEY" },
      github: { tokenCommand: ["./token-helper"] },
      sandbox: { roleUser: "1000:1000", piExecutable: "/usr/local/bin/pi", piAgentDirectory: "/ticket/runtime/pi-agent", piAuthFile: "pi-auth.json" },
      profiles: policy,
      testCommands: ["npm test"],
    }));
    const loaded = await loadPersonalMvpConfig(configPath);
    assert.equal(loaded.repository.path, repository);
    assert.equal(loaded.paths.state, path.join(user, "state"));
    assert.equal(loaded.sandbox.piAuthFile, path.join(user, "pi-auth.json"));
    assert.equal(loaded.github.tokenCommand[0], path.join(user, "token-helper"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omitted model policy resolves to a detached copy of the approved defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-default-policy-"));
  try {
    const file = path.join(root, "config.json");
    await writeFile(file, JSON.stringify({
      repository: { slug: "example/repo", path: ".", sourceRef: "main", baseBranch: "main" },
      paths: { state: "state", bridges: "bridges", staging: "staging" },
      linear: { apiKeyEnv: "LINEAR_API_KEY" },
      github: { tokenCommand: ["token-helper"] },
      sandbox: { roleUser: "1000:1000", piExecutable: "pi", piAgentDirectory: "/ticket/runtime/pi-agent" },
      testCommands: ["npm test"],
    }));
    const loaded = await loadPersonalMvpConfig(file);
    assert.deepEqual(loaded.modelPolicy, policy);
    assert.deepEqual(loaded.profiles, policy);
    assert.notEqual(loaded.modelPolicy, policy);
    assert.notEqual(loaded.modelPolicy.plan, policy.plan);
    assert.notEqual(loaded.modelPolicy.plan[0], policy.plan[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implicit config loading works without repository config and ignores a local decoy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-implicit-config-"));
  try {
    const home = path.join(root, "home");
    const repository = path.join(root, "repository");
    const userDirectory = path.join(home, ".config", "squire");
    const configPath = path.join(userDirectory, "config.json");
    await mkdir(userDirectory, { recursive: true });
    await mkdir(repository, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      repository: { slug: "example/repo", path: path.relative(userDirectory, repository), sourceRef: "main", baseBranch: "main" },
      paths: { state: "state", bridges: "bridges", staging: "staging" },
      linear: { apiKeyEnv: "LINEAR_API_KEY" },
      github: { tokenCommand: ["token-helper"] },
      sandbox: { roleUser: "1000:1000", piExecutable: "/usr/local/bin/pi", piAgentDirectory: "/ticket/runtime/pi-agent" },
      profiles: policy,
      testCommands: ["npm test"],
    }));

    const options = { platform: "linux" as const, env: { HOME: home }, cwd: repository };
    const withoutLocalConfig = await loadPersonalMvpConfig(undefined, options);
    assert.equal(withoutLocalConfig.repository.slug, "example/repo");
    assert.equal(withoutLocalConfig.repository.path, repository);
    assert.equal(withoutLocalConfig.paths.state, path.join(userDirectory, "state"));

    await mkdir(path.join(repository, ".squire"), { recursive: true });
    await writeFile(path.join(repository, ".squire", "config.json"), JSON.stringify({ repository: { slug: "decoy/repository" } }));
    const withIgnoredDecoy = await loadPersonalMvpConfig(undefined, options);
    assert.equal(withIgnoredDecoy.repository.slug, "example/repo");
    assert.equal(withIgnoredDecoy.repository.path, repository);
    assert.equal(withIgnoredDecoy.paths.state, path.join(userDirectory, "state"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
