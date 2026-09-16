import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capturePromptSet, type CaptureHooks } from "../src/personal/prompt-policy.js";

async function fixture(run: (root: string, repo: string, capture: (hooks: CaptureHooks) => ReturnType<typeof capturePromptSet>) => Promise<void>) {
  const base = await mkdtemp(path.join(os.tmpdir(), "squire-pin-"));
  const root = path.join(base, "host", "prompts"), repo = path.join(base, "repo");
  await mkdir(root, { recursive: true }); await mkdir(repo);
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({ version: 1, id: "custom", phases: { plan: "phase.md", implement: "phase.md", review: "phase.md", test: "phase.md", retro: "phase.md" }, subphases: {} }));
  await writeFile(path.join(root, "phase.md"), "ORIGINAL HOST BYTES\n");
  try { await run(root, repo, hooks => capturePromptSet({ version: 1, id: "custom", root, plan: [] }, repo, hooks)); }
  finally { await rm(base, { recursive: true, force: true }); }
}

test("replacement before ancestor pin cannot become the descendant's new trust snapshot", async () => fixture(async (root, _repo, capture) => {
  let fired = false;
  await assert.rejects(capture({ async beforePin(directory) {
    if (directory !== path.dirname(root)) return;
    fired = true;
    await rename(root, `${root}.old`); await mkdir(root);
  } }), /identity changed/);
  assert.equal(fired, true);
}));

for (const restore of [false, true]) test(`final-file replacement at real open boundary restore=${restore} fails closed`, async () => fixture(async (root, _repo, capture) => {
  await assert.rejects(capture({
    async beforeFileOpen(name) { if (name === "phase.md") { await rename(path.join(root, name), path.join(root, "original.md")); await writeFile(path.join(root, name), "SUBSTITUTED BYTES"); } },
    async afterFileOpen(name) { if (name === "phase.md" && restore) { await rm(path.join(root, name)); await rename(path.join(root, "original.md"), path.join(root, name)); } },
  }), /changed/);
}));

for (const ancestor of [false, true]) test(`replacement during pinned read ancestor=${ancestor} cannot supply replacement bytes`, async () => fixture(async (root, _repo, capture) => {
  const target = ancestor ? path.dirname(root) : root;
  await assert.rejects(capture({ async duringRead(name) {
    if (name !== "phase.md") return;
    await rename(target, `${target}.old`); await mkdir(root, { recursive: true });
    await writeFile(path.join(root, name), "SUBSTITUTED BYTES");
  } }), /identity changed/);
}));

test("transient root rename and restore with no effect on pinned file bytes is not substitution", async () => fixture(async (root, _repo, capture) => {
  const captured = await capture({ async duringRead(name) {
    if (name !== "phase.md") return;
    await rename(root, `${root}.old`); await mkdir(root);
    await writeFile(path.join(root, name), "SUBSTITUTED BYTES");
    await rm(root, { recursive: true }); await rename(`${root}.old`, root);
  } });
  assert.equal(Buffer.from(captured.phases.plan, "base64").toString(), "ORIGINAL HOST BYTES\n");
}));
