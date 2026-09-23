import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { test } from "node:test";
import { captureOwnerPiIdentity, requireOwnerModels, validateOwnerPiIdentity, verifyRunningParentPi, assertSandboxPiIdentity, executableCodeDigest, phaseModelsDigest, modelConfigDigest, type OwnerPiIdentity } from "../src/personal/runtime-parity.js";
import { APPROVED_PERSONAL_MODEL_POLICY } from "../src/personal/model-policy.js";

const identity: OwnerPiIdentity = {
  schema: 1, pid: process.pid, cliPath: process.execPath, version: "0.87.0", manifestSha256: "a".repeat(64), cliSha256: "b".repeat(64), codeTreeSha256: "d".repeat(64), modelConfigPath: path.resolve("models.json"), modelConfigSha256: null, phaseModelsSha256: "e".repeat(64), modelStorePath: path.resolve("models-store.json"), modelStoreSha256: "c".repeat(64),
  models: ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol"], extensions: [],
};

test("owner Pi catalog must include both configured phase models", () => {
  requireOwnerModels(identity, APPROVED_PERSONAL_MODEL_POLICY);
  assert.throws(() => requireOwnerModels({ ...identity, models: ["openai-codex/gpt-6-luna", "openai-codex/other"] }, APPROVED_PERSONAL_MODEL_POLICY), /lacks.*gpt-6-sol/);
  assert.throws(() => validateOwnerPiIdentity({ ...identity, extensions: [{ name: "host-extension" }] }), /invalid owner Pi identity/);
});

test("running Pi acquisition rejects an unbound CLI instead of trusting an environment alias", async () => {
  await assert.rejects(captureOwnerPiIdentity(undefined, { getAvailable: () => [] }, APPROVED_PERSONAL_MODEL_POLICY), /CLI path unavailable/);
  await assert.rejects(captureOwnerPiIdentity(process.execPath, { getAvailable: () => [] }, APPROVED_PERSONAL_MODEL_POLICY), /running Pi package cannot be established/);
});

test("owner phase-model overrides are rejected while unrelated providers remain private", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "squire-model-config-"));
  const file = path.join(dir, "models.json");
  try {
    assert.equal(await modelConfigDigest(file), null);
    await writeFile(file, JSON.stringify({ providers: { meta: { models: [] } } }));
    assert.match(await modelConfigDigest(file) ?? "", /^[a-f0-9]{64}$/u);
    await writeFile(file, JSON.stringify({ providers: { "openai-codex": { models: [] } } }));
    await assert.rejects(modelConfigDigest(file), /overrides cannot be reproduced/);
    await writeFile(file, "{}");
    await assert.rejects(modelConfigDigest(file), /model providers invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the phase metadata and imported executable bytes are part of parity", async () => {
  const models = [{ provider: "openai-codex", id: "gpt-6-luna", contextWindow: 100 }, { provider: "openai-codex", id: "gpt-6-sol", contextWindow: 100 }];
  const digest = phaseModelsDigest(models, APPROVED_PERSONAL_MODEL_POLICY);
  assert.notEqual(digest, phaseModelsDigest([{ ...models[0]!, contextWindow: 200 }, models[1]!], APPROVED_PERSONAL_MODEL_POLICY));
  const dir = await mkdtemp(path.join(os.tmpdir(), "squire-executable-code-"));
  try {
    await writeFile(path.join(dir, "cli.js"), "import './cli-runtime.js';");
    await writeFile(path.join(dir, "cli-runtime.js"), "export const value=1;");
    const original = executableCodeDigest(dir);
    await writeFile(path.join(dir, "cli-runtime.js"), "export const value=2;");
    assert.notEqual(original, executableCodeDigest(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("caller-authored process identity cannot impersonate the running Pi package", async () => {
  await assert.rejects(verifyRunningParentPi(identity), /parent Pi executable changed|parent Pi package mismatch/);
});

test("sandbox package and actual models must match the owner identity", async () => {
  const manifest = Buffer.from(JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: identity.version }));
  const { createHash } = await import("node:crypto");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const cli = Buffer.from("cli");
  const bound = { ...identity, manifestSha256: digest(manifest), cliSha256: digest(cli) };
  await assertSandboxPiIdentity(bound, manifest, cli, identity.models, APPROVED_PERSONAL_MODEL_POLICY);
  await assert.rejects(assertSandboxPiIdentity(bound, manifest, Buffer.from("different"), identity.models, APPROVED_PERSONAL_MODEL_POLICY), /does not match/);
  await assert.rejects(assertSandboxPiIdentity(bound, manifest, cli, ["openai-codex/gpt-6-luna"], APPROVED_PERSONAL_MODEL_POLICY), /sandbox Pi lacks/);
});
