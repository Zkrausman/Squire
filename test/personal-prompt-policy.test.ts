import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { capturePromptSet, validatePromptSelection } from "../src/personal/prompt-policy.js";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "squire-prompts-"));
  const root = path.join(base, "host", "prompts");
  const repository = path.join(base, "repo");
  await mkdir(root, { recursive: true }); await mkdir(repository);
  const manifest = { version: 1, id: "custom", phases: Object.fromEntries(["plan", "implement", "review", "test", "retro"].map(p => [p, `${p}.md`])), subphases: { requirements: "requirements.md", "implementation-design": "implementation-design.md" } };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  for (const name of [...Object.values(manifest.phases), ...Object.values(manifest.subphases)]) await writeFile(path.join(root, name), name);
  return { base, root, repository, selection: { version: 1 as const, id: "custom", root, plan: ["requirements" as const, "implementation-design" as const] } };
}

test("closed prompt selection rejects unknown authority, IDs and duplicates", () => {
  for (const value of [{ version: 1, id: "default", plan: ["shell"] }, { version: 1, id: "default", plan: ["requirements", "requirements"] }, { version: 1, id: "default", plan: [], tools: ["bash"] }, { version: 2, id: "default", plan: [] }]) assert.throws(() => validatePromptSelection(value));
});

test("prompt capture rejects missing/malformed manifests, files and repository paths/aliases", async () => {
  const f = await fixture();
  try {
    const captured = await capturePromptSet(f.selection, f.repository);
    assert.equal(Buffer.from(captured.phases.plan, "base64").toString(), "plan.md");
    assert.throws(() => { (captured.phases as {plan: string}).plan = "mutated"; });
    await rm(path.join(f.root, "plan.md")); await assert.rejects(capturePromptSet(f.selection, f.repository));
    await writeFile(path.join(f.root, "manifest.json"), "{}"); await assert.rejects(capturePromptSet(f.selection, f.repository));
    await rm(path.join(f.root, "manifest.json")); await assert.rejects(capturePromptSet(f.selection, f.repository));
    await assert.rejects(capturePromptSet({ ...f.selection, root: f.repository }, f.repository), /repository/);
    await symlink(f.repository, path.join(f.base, "alias"));
    await assert.rejects(capturePromptSet({ ...f.selection, root: path.join(f.base, "alias") }, f.repository));
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test("manifest authority, traversal, repository file aliases and writable sources fail closed", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repository, "policy.md"), "repository-controlled");
    await rm(path.join(f.root, "plan.md"));
    await symlink(path.join(f.repository, "policy.md"), path.join(f.root, "plan.md"));
    await assert.rejects(capturePromptSet(f.selection, f.repository), /unsafe prompt file/);
    await rm(path.join(f.root, "plan.md"));
    await link(path.join(f.repository, "policy.md"), path.join(f.root, "plan.md"));
    await assert.rejects(capturePromptSet(f.selection, f.repository), /unsafe prompt file/);
    await rm(path.join(f.root, "plan.md")); await writeFile(path.join(f.root, "plan.md"), "host guidance");
    await chmod(path.join(f.root, "plan.md"), 0o666);
    await assert.rejects(capturePromptSet(f.selection, f.repository), /unsafe prompt file/);
    await chmod(path.join(f.root, "plan.md"), 0o600);
    for (const manifest of [
      { version: 1, id: "other", phases: {}, subphases: {} },
      { version: 1, id: "custom", phases: { plan: "../repo/policy.md" }, subphases: {} },
      { version: 1, id: "custom", phases: {}, subphases: {}, tools: ["bash"] },
      { version: 1, id: "custom", phases: {}, subphases: { shell: "plan.md" } },
    ]) { await writeFile(path.join(f.root, "manifest.json"), JSON.stringify(manifest)); await assert.rejects(capturePromptSet(f.selection, f.repository)); }
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

for (const ancestor of [false, true]) for (const restore of [false, true]) test(`real pre-pin replacement ancestor=${ancestor} restore=${restore} cannot substitute bytes`, async () => {
  const f = await fixture();
  const target = ancestor ? path.dirname(f.root) : f.root;
  let replaced = false;
  try {
    await assert.rejects(capturePromptSet(f.selection, f.repository, {
      async beforePin(directory) {
        if (directory !== target || replaced) return;
        replaced = true;
        await rename(target, `${target}.old`);
        await mkdir(f.root, { recursive: true });
        await writeFile(path.join(f.root, "manifest.json"), "substitute");
      },
      async afterPin(directory) {
        if (directory === target && restore) { await rm(target, { recursive: true }); await rename(`${target}.old`, target); }
      },
    }), /changed|identity/);
    assert.equal(replaced, true);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

for (const truncate of [false, true]) test(`same-inode mutation during pinned read fails closed truncate=${truncate}`, async () => {
  const f = await fixture();
  try {
    await assert.rejects(capturePromptSet(f.selection, f.repository, { async duringRead(name) { if (name === "plan.md") await writeFile(path.join(f.root, name), truncate ? "" : "hostile"); } }), /changed/);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
